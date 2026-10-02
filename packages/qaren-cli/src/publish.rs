use crate::core::Ledger;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::github::{self, PrInfo, NEEDS_QA};
use crate::receipt::{Receipt, ReceiptResult};
use crate::record::{self, VideoStatus};
use crate::redact::{redact_machine, MachineIdentity};
use crate::report::{self, PrRun, ReportInput};
use crate::runrecord::{validate_run_id, RunRecord};
use crate::timefmt;
use crate::worktree;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

// `<run_dir>/pr.json`: what `qaren pr` tested, for `qaren publish`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PrRunRecord {
    pub number: u64,
    pub url: String,
    pub head_ref_oid: String,
    pub head_ref_name: String,
    pub is_cross_repository: bool,
    pub repo_root: PathBuf,
    pub app_rel: String,
    pub platform: String,
    pub app_id: String,
    pub device: String,
    pub plan_sha256: String,
    pub video: VideoStatus,
    #[serde(default)]
    pub tested_older_commit: bool,
    #[serde(default)]
    pub blocks: Vec<String>,
}

// `<run_dir>/publication.json`, rewritten atomically after every step so a rerun resumes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publication {
    #[serde(default)]
    pub rendered: bool,
    // Set before the create call: a lost outcome is reconciled by the comment marker, never re-posted blind.
    #[serde(default)]
    pub comment_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub comment_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback_commit: Option<String>,
    #[serde(default)]
    pub blocks_comment_attempted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writeback: Option<String>,
}

const PUBLICATION: &str = "publication.json";
const COMMENT_BODY: &str = "comment.md";
const BLOCKS_BODY: &str = "blocks-comment.md";

fn failure(detail: impl Into<String>, next: impl Into<String>) -> Failure {
    Failure::new("publish", FailureCode::PublishFailed, detail, next)
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, Failure> {
    let bytes = std::fs::read(path).map_err(|e| {
        failure(
            format!("cannot read {}: {e}", path.display()),
            "publish a run that `qaren pr` completed",
        )
    })?;
    serde_json::from_slice(&bytes).map_err(|e| {
        failure(
            format!("{} is unreadable: {e}", path.display()),
            "publish a run that `qaren pr` completed",
        )
    })
}

fn save(run_dir: &Path, publication: &Publication) -> Result<(), Failure> {
    let path = run_dir.join(PUBLICATION);
    let tmp = run_dir.join(format!("{PUBLICATION}.tmp"));
    let bytes = serde_json::to_vec_pretty(publication).unwrap_or_default();
    std::fs::write(&tmp, bytes)
        .and_then(|()| std::fs::rename(&tmp, &path))
        .map_err(|e| {
            failure(
                format!("cannot persist {}: {e}", path.display()),
                "fix the run directory permissions, then re-run qaren publish",
            )
        })
}

fn pr_info(pr: &PrRunRecord) -> PrInfo {
    PrInfo {
        number: pr.number,
        url: pr.url.clone(),
        head_ref_oid: pr.head_ref_oid.clone(),
        head_ref_name: pr.head_ref_name.clone(),
        is_cross_repository: pr.is_cross_repository,
        labels: Vec::new(),
    }
}

// Finds an earlier comment carrying this run's marker, so a lost create is adopted, not repeated.
fn find_marked_comment(
    runner: &mut dyn Runner,
    pr: &PrInfo,
    marker: &str,
    cwd: &Path,
) -> Result<Option<String>, Failure> {
    #[derive(Deserialize)]
    struct Comment {
        body: String,
        url: String,
    }
    #[derive(Deserialize)]
    struct Comments {
        comments: Vec<Comment>,
    }
    let repo = pr.repo().ok_or_else(|| {
        failure(
            format!("unexpected PR URL {}", pr.url),
            "re-run qaren pr for this pull request",
        )
    })?;
    let output = runner.run(
        &CmdSpec::new(
            "gh-pr-comments",
            "gh",
            &[
                "pr",
                "view",
                &pr.number.to_string(),
                "-R",
                &repo,
                "--json",
                "comments",
            ],
            60,
        )
        .cwd(cwd),
    );
    if !output.ok() {
        return Err(failure(
            format!(
                "could not list comments to confirm an earlier post: {}",
                output.summary()
            ),
            "re-run qaren publish once gh can read the pull request",
        ));
    }
    let comments: Comments = serde_json::from_str(output.stdout.trim()).map_err(|e| {
        failure(
            format!("unreadable comment list: {e}"),
            "re-run qaren publish",
        )
    })?;
    Ok(comments
        .comments
        .into_iter()
        .find(|c| c.body.starts_with(marker))
        .map(|c| c.url))
}

fn post_once(
    runner: &mut dyn Runner,
    pr: &PrInfo,
    run_dir: &Path,
    body_file: &str,
    attachments: &[(PathBuf, Option<String>)],
    attempted: bool,
    mark_attempted: &mut dyn FnMut() -> Result<(), Failure>,
) -> Result<String, Failure> {
    let body = std::fs::read_to_string(run_dir.join(body_file)).map_err(|e| {
        failure(
            format!("cannot read {body_file}: {e}"),
            "re-run qaren publish",
        )
    })?;
    let marker = body.lines().next().unwrap_or_default().to_string();
    if attempted {
        if let Some(url) = find_marked_comment(runner, pr, &marker, run_dir)? {
            return Ok(url);
        }
    }
    mark_attempted()?;
    github::comment_create(runner, pr, Path::new(body_file), attachments, run_dir)
}

use crate::worktree::git;

fn saved_blocks(run_dir: &Path) -> Vec<String> {
    let mut slugs: Vec<String> = std::fs::read_dir(run_dir.join("blocks"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let slug = name.strip_suffix(".yaml")?.to_string();
            worktree::safe_slug(&slug).then_some(slug)
        })
        .collect();
    slugs.sort();
    slugs
}

fn action_rel(app_rel: &str, slug: &str) -> String {
    let rel = format!(".qaren/actions/{slug}.yaml");
    if app_rel == "." {
        rel
    } else {
        format!("{app_rel}/{rel}")
    }
}

// Commits the blocks on the tested commit in a short-lived worktree; returns the commit sha.
fn commit_blocks(
    runner: &mut dyn Runner,
    run_id: &str,
    run_dir: &Path,
    pr: &PrRunRecord,
    slugs: &[String],
) -> Result<String, String> {
    let repo = &pr.repo_root;
    // The tested commit may be gone from the object store after a force-push; fetch it by id.
    git(
        runner,
        "git-fetch-tested",
        repo,
        &["fetch", "origin", &pr.head_ref_oid],
        300,
    );
    let tmp = run_dir.join("writeback-wt");
    if tmp.exists() {
        worktree::remove(runner, repo, &tmp);
    }
    let added = git(
        runner,
        "git-worktree-add",
        repo,
        &[
            "worktree",
            "add",
            "--detach",
            &tmp.to_string_lossy(),
            &pr.head_ref_oid,
        ],
        120,
    );
    if !added.ok() {
        return Err(format!("git worktree add failed: {}", added.summary()));
    }
    let result = (|| {
        let mut paths = Vec::new();
        for slug in slugs {
            let rel = action_rel(&pr.app_rel, slug);
            let dest = tmp.join(&rel);
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::copy(run_dir.join("blocks").join(format!("{slug}.yaml")), &dest)
                .map_err(|e| e.to_string())?;
            paths.push(rel);
        }
        let mut add_args = vec!["add", "-f", "--"];
        add_args.extend(paths.iter().map(String::as_str));
        let added = git(runner, "git-add-blocks", &tmp, &add_args, 60);
        if !added.ok() {
            return Err(format!("git add failed: {}", added.summary()));
        }
        let subject = format!("qaren: save block {}", slugs.join(", "));
        let trailer = format!("Qaren-Run: {run_id}");
        let committed = git(
            runner,
            "git-commit-blocks",
            &tmp,
            &["commit", "-m", &subject, "-m", &trailer],
            60,
        );
        if !committed.ok() {
            return Err(format!("git commit failed: {}", committed.summary()));
        }
        let head = git(runner, "git-head", &tmp, &["rev-parse", "HEAD"], 20);
        if !head.ok() {
            return Err(format!("git rev-parse failed: {}", head.summary()));
        }
        Ok(head.stdout.trim().to_string())
    })();
    worktree::remove(runner, repo, &tmp);
    result
}

fn push_with_lease(runner: &mut dyn Runner, pr: &PrRunRecord, commit: &str) -> bool {
    let refspec = format!("{commit}:refs/heads/{}", pr.head_ref_name);
    let lease = format!(
        "--force-with-lease={}:{}",
        pr.head_ref_name, pr.head_ref_oid
    );
    git(
        runner,
        "git-push-blocks",
        &pr.repo_root,
        &["push", "origin", &refspec, &lease],
        300,
    )
    .ok()
}

fn remote_head(runner: &mut dyn Runner, pr: &PrRunRecord) -> Option<String> {
    let output = git(
        runner,
        "git-ls-remote",
        &pr.repo_root,
        &[
            "ls-remote",
            "origin",
            &format!("refs/heads/{}", pr.head_ref_name),
        ],
        60,
    );
    output
        .ok()
        .then(|| output.stdout.split_whitespace().next().map(str::to_string))
        .flatten()
}

fn blocks_comment(
    run_id: &str,
    run_dir: &Path,
    pr: &PrRunRecord,
    slugs: &[String],
    machine: &MachineIdentity,
) -> String {
    let mut out = format!("<!-- qaren-run: {run_id} blocks -->\n");
    out.push_str("These blocks were saved by the QA run but could not be pushed to the branch. Commit them to replay the walk next time.\n\n");
    out.push_str("<details><summary>Saved blocks to commit</summary>\n\n");
    for slug in slugs {
        let yaml = std::fs::read_to_string(run_dir.join("blocks").join(format!("{slug}.yaml")))
            .unwrap_or_default();
        out.push_str(&format!(
            "`{}`\n\n````yaml\n{}\n````\n\n",
            action_rel(&pr.app_rel, slug),
            yaml.trim_end()
        ));
    }
    out.push_str("</details>\n");
    redact_machine(&out, machine)
}

pub fn publish(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    verdict_file: &Path,
    machine: &MachineIdentity,
) -> Receipt {
    let mut publication = Publication::default();
    let outcome = publish_inner(
        runner,
        runs_root,
        run_id,
        verdict_file,
        machine,
        &mut publication,
    );
    let (result, failure) = match outcome {
        Ok(()) => (ReceiptResult::Published, None),
        Err(f) => (ReceiptResult::Failed, Some(f)),
    };
    let mut receipt = Receipt::new(
        "publish",
        run_id,
        result,
        "publish",
        timefmt::iso8601_utc(runner.now_epoch_ms()),
    );
    if let Some(url) = &publication.comment_url {
        receipt.outcomes.insert("comment".into(), url.clone());
    }
    if let Some(label) = &publication.label {
        receipt.outcomes.insert("label".into(), label.clone());
    }
    if let Some(writeback) = &publication.writeback {
        receipt
            .outcomes
            .insert("writeback".into(), writeback.clone());
    }
    receipt.next_action = match &failure {
        Some(f) => f.next_action.clone(),
        None => "nothing left; the pull request has the QA comment".to_string(),
    };
    receipt.failure = failure;
    receipt.commands_executed = runner.commands_executed();
    receipt
}

fn publish_inner(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    verdict_file: &Path,
    machine: &MachineIdentity,
    publication: &mut Publication,
) -> Result<(), Failure> {
    validate_run_id(run_id)?;
    let run_dir = RunRecord::run_dir(runs_root, run_id);
    let pr: PrRunRecord = read_json(&run_dir.join("pr.json"))?;
    let info = pr_info(&pr);
    if let Ok(existing) = read_json::<Publication>(&run_dir.join(PUBLICATION)) {
        *publication = existing;
    }

    if !publication.rendered {
        let verdict = std::fs::read_to_string(verdict_file)
            .ok()
            .filter(|v| !v.trim().is_empty())
            .ok_or_else(|| {
                failure(
                    format!("{} is missing or empty", verdict_file.display()),
                    "write the verdict sentence to the --verdict-file, then re-run",
                )
            })?;
        let ledger: Ledger = read_json(&run_dir.join("ledger.json"))?;
        let plan = std::fs::read_to_string(run_dir.join("plan.md")).unwrap_or_default();
        let gaps = record::read_gaps(&run_dir);
        let body = report::render_pr_comment(
            &ReportInput {
                run_id,
                platform: &pr.platform,
                app_id: &pr.app_id,
                device: &pr.device,
                plan: &plan,
                ledger: &ledger,
            },
            &verdict,
            &PrRun {
                tested_sha: &pr.head_ref_oid,
                tested_older_commit: pr.tested_older_commit,
                video: &pr.video,
                plan_sha256: &pr.plan_sha256,
                gaps: &gaps,
            },
            machine,
        );
        std::fs::write(run_dir.join(COMMENT_BODY), body).map_err(|e| {
            failure(
                format!("cannot write the comment body: {e}"),
                "fix the run directory permissions, then re-run",
            )
        })?;
        publication.rendered = true;
        save(&run_dir, publication)?;
    }

    if publication.comment_url.is_none() {
        let mut attachments = Vec::new();
        if pr.video == VideoStatus::Available && record::video_path(&run_dir).is_file() {
            attachments.push((PathBuf::from("./media/video.mp4"), None));
        }
        let ledger: Option<Ledger> = read_json(&run_dir.join("ledger.json")).ok();
        if let Some(shot) = ledger.as_ref().and_then(report::failing_screenshot) {
            if run_dir.join(&shot).is_file() {
                attachments.push((
                    PathBuf::from(format!("./{shot}")),
                    Some("Failing step".to_string()),
                ));
            }
        }
        let attempted = publication.comment_attempted;
        let url = post_once(
            runner,
            &info,
            &run_dir,
            COMMENT_BODY,
            &attachments,
            attempted,
            &mut || {
                publication.comment_attempted = true;
                save(&run_dir, publication)
            },
        )?;
        publication.comment_url = Some(url);
        save(&run_dir, publication)?;
    }

    if publication.label.is_none() {
        // Fresh labels: one added after the run is still removed.
        let current = github::pr_view(runner, &pr.url, &pr.repo_root)?;
        let removed = github::remove_label(runner, &current, NEEDS_QA, &pr.repo_root)?;
        publication.label = Some(if removed { "removed" } else { "absent" }.to_string());
        save(&run_dir, publication)?;
    }

    if publication.writeback.is_none() {
        let slugs = saved_blocks(&run_dir);
        let mut needs_comment = false;
        if slugs.is_empty() {
            publication.writeback = Some("none".to_string());
        } else if pr.is_cross_repository {
            needs_comment = true;
        } else {
            let commit = match &publication.writeback_commit {
                Some(commit) => Ok(commit.clone()),
                None => commit_blocks(runner, run_id, &run_dir, &pr, &slugs),
            };
            match commit {
                Ok(commit) => {
                    publication.writeback_commit = Some(commit.clone());
                    save(&run_dir, publication)?;
                    let landed = remote_head(runner, &pr).as_deref() == Some(commit.as_str())
                        || push_with_lease(runner, &pr, &commit);
                    if landed {
                        publication.writeback = Some(format!("committed {commit}"));
                    } else {
                        needs_comment = true;
                    }
                }
                Err(_) => needs_comment = true,
            }
        }
        if needs_comment {
            if !run_dir.join(BLOCKS_BODY).is_file() {
                let body = blocks_comment(run_id, &run_dir, &pr, &slugs, machine);
                std::fs::write(run_dir.join(BLOCKS_BODY), body).map_err(|e| {
                    failure(
                        format!("cannot write the blocks comment: {e}"),
                        "fix the run directory permissions, then re-run",
                    )
                })?;
            }
            let attempted = publication.blocks_comment_attempted;
            let url = post_once(
                runner,
                &info,
                &run_dir,
                BLOCKS_BODY,
                &[],
                attempted,
                &mut || {
                    publication.blocks_comment_attempted = true;
                    save(&run_dir, publication)
                },
            )?;
            publication.writeback = Some(format!("attached {url}"));
        }
        save(&run_dir, publication)?;
    }
    Ok(())
}
