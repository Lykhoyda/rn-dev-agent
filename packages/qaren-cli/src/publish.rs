use crate::core::Ledger;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::github::{self, PrInfo, NEEDS_QA};
use crate::receipt::{Receipt, ReceiptResult};
use crate::record::{self, VideoPublication, VideoStatus};
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
    #[serde(default, deserialize_with = "video_publication")]
    pub video_publication: VideoPublication,
    #[serde(default, deserialize_with = "withholding_reason")]
    pub video_withholding_reason: Option<String>,
    #[serde(default)]
    pub tested_older_commit: bool,
    #[serde(default)]
    pub blocks: Vec<String>,
}

fn video_publication<'de, D: serde::Deserializer<'de>>(d: D) -> Result<VideoPublication, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).unwrap_or_default())
}

fn withholding_reason<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(serde_json::from_value(serde_json::Value::deserialize(d)?).ok())
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
const LOCK: &str = "publish.lock";
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

// The blocks `qaren pr` preserved, read back in full and redacted once, so neither the commit nor a
// comment can carry a secret or machine identity; missing evidence fails rather than reads as none.
fn saved_blocks(
    run_dir: &Path,
    pr: &PrRunRecord,
    machine: &MachineIdentity,
) -> Result<Vec<(String, String)>, Failure> {
    pr.blocks
        .iter()
        .map(|slug| {
            let path = run_dir.join("blocks").join(format!("{slug}.yaml"));
            let real = std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file());
            match (worktree::safe_slug(slug) && real)
                .then(|| std::fs::read_to_string(&path).ok())
                .flatten()
            {
                Some(yaml) => Ok((slug.clone(), redact_machine(&yaml, machine))),
                None => Err(failure(
                    format!("the saved block {slug} is missing or unreadable in the run directory"),
                    "re-run qaren pr to save the blocks again",
                )),
            }
        })
        .collect()
}

// `[HOST/]OWNER/REPO` a remote URL points at, for https, ssh and scp-style forms.
fn remote_repo(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("ssh://"))
        .map(|r| r.split_once('@').map_or(r, |(_, host)| host).to_string())
        .or_else(|| {
            let (_, scp) = url.split_once('@')?;
            Some(scp.replacen(':', "/", 1))
        })?;
    let rest = rest.trim_end_matches('/').trim_end_matches(".git");
    let parts: Vec<&str> = rest.split('/').collect();
    (parts.len() == 3).then(|| parts.join("/").to_ascii_lowercase())
}

// The lease authenticates the ref value only; the destination must also be the PR's repository.
fn origin_is_pr_repo(runner: &mut dyn Runner, pr: &PrRunRecord) -> bool {
    let output = git(
        runner,
        "git-push-url",
        &pr.repo_root,
        &["remote", "get-url", "--push", "origin"],
        20,
    );
    let expected = pr_info(pr).repo().map(|r| r.to_ascii_lowercase());
    output.ok() && expected.is_some() && remote_repo(output.stdout.trim()) == expected
}

// Every existing component must be a real directory; missing ones are created. A PR controls this tree.
fn real_dir_under(root: &Path, rel: &Path) -> Result<PathBuf, String> {
    let mut at = root.to_path_buf();
    for part in rel.components() {
        let std::path::Component::Normal(name) = part else {
            return Err(format!("{} is not a plain relative path", rel.display()));
        };
        at.push(name);
        match std::fs::symlink_metadata(&at) {
            Ok(m) if m.file_type().is_dir() => {}
            Ok(_) => return Err(format!("{} is not a real directory", at.display())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&at).map_err(|e| e.to_string())?
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(at)
}

fn fence(content: &str, min: usize) -> String {
    let longest = content.split(|c| c != '`').map(str::len).max().unwrap_or(0);
    "`".repeat(min.max(longest + 1))
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
    blocks: &[(String, String)],
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
    if std::fs::symlink_metadata(&tmp).is_ok() {
        let outcome = worktree::remove(runner, repo, &tmp);
        if !outcome.clean() {
            return Err(format!(
                "an earlier writeback worktree is still present: {}",
                outcome.render()
            ));
        }
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
    let result = (|| {
        if !added.ok() {
            return Err(format!("git worktree add failed: {}", added.summary()));
        }
        let mut paths = Vec::new();
        for (slug, yaml) in blocks {
            let rel = action_rel(&pr.app_rel, slug);
            let dir = real_dir_under(&tmp, Path::new(&rel).parent().unwrap_or(Path::new("")))?;
            let dest = dir.join(format!("{slug}.yaml"));
            if std::fs::symlink_metadata(&dest).is_ok_and(|m| !m.file_type().is_file()) {
                return Err(format!("{rel} exists and is not a regular file"));
            }
            std::fs::write(&dest, yaml).map_err(|e| e.to_string())?;
            paths.push(rel);
        }
        let slugs: Vec<&str> = blocks.iter().map(|(slug, _)| slug.as_str()).collect();
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
    let removed = worktree::remove(runner, repo, &tmp);
    match (result, removed.clean()) {
        (Ok(commit), true) => Ok(commit),
        (Ok(_), false) => Err(format!(
            "the writeback worktree was not removed: {}",
            removed.render()
        )),
        (Err(e), _) => Err(e),
    }
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
    pr: &PrRunRecord,
    blocks: &[(String, String)],
    machine: &MachineIdentity,
) -> String {
    let mut out = format!("<!-- qaren-run: {run_id} blocks -->\n");
    out.push_str("These blocks were saved by the QA run but could not be pushed to the branch. Commit them to replay the walk next time.\n\n");
    out.push_str("<details><summary>Saved blocks to commit</summary>\n\n");
    // YAML is committable content, so it is fenced verbatim rather than rewritten.
    for (slug, yaml) in blocks {
        let path = action_rel(&pr.app_rel, slug);
        let tick = fence(&path, 1);
        let block = fence(yaml, 3);
        out.push_str(&format!(
            "{tick} {path} {tick}\n\n{block}yaml\n{}\n{block}\n\n",
            yaml.trim_end()
        ));
    }
    out.push_str("</details>\n");
    redact_machine(&out, machine)
}

struct PublishLock {
    _file: std::fs::File,
}

impl PublishLock {
    fn acquire(run_dir: &Path) -> Result<Self, Failure> {
        use std::os::fd::AsRawFd;
        let path = run_dir.join(LOCK);
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .map_err(|e| {
                failure(
                    format!("cannot lock {}: {e}", path.display()),
                    "re-run qaren publish",
                )
            })?;
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
            return Err(failure(
                format!(
                    "another qaren publish holds the lock or locking failed: {}",
                    std::io::Error::last_os_error()
                ),
                "wait for it to finish, then re-run qaren publish",
            ));
        }
        Ok(Self { _file: file })
    }
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
    let _lock = PublishLock::acquire(&run_dir)?;
    let pr: PrRunRecord = read_json(&run_dir.join("pr.json"))?;
    let info = pr_info(&pr);
    let state = run_dir.join(PUBLICATION);
    if std::fs::symlink_metadata(&state).is_ok() {
        *publication = read_json(&state)?;
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
                video_publication: &pr.video_publication,
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
        if pr.video_publication == VideoPublication::Eligible
            && pr.video == VideoStatus::Available
            && record::video_path(&run_dir).is_file()
        {
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
        // ponytail: a publisher killed mid-upload can leave gh running; a rerun inside that window may repost.
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
        let current = github::pr_view(runner, &pr.url, &pr.repo_root)?;
        publication.label = Some(if current.head_ref_oid != pr.head_ref_oid {
            "retained-head-changed".to_string()
        } else {
            let removed = github::remove_label(runner, &current, NEEDS_QA, &pr.repo_root)?;
            if removed { "removed" } else { "absent" }.to_string()
        });
        save(&run_dir, publication)?;
    }

    if publication.writeback.is_none() {
        let blocks = saved_blocks(&run_dir, &pr, machine)?;
        let mut needs_comment = false;
        if blocks.is_empty() {
            publication.writeback = Some("none".to_string());
        } else if pr.is_cross_repository || !origin_is_pr_repo(runner, &pr) {
            needs_comment = true;
        } else {
            let commit = match &publication.writeback_commit {
                Some(commit) => Ok(commit.clone()),
                None => commit_blocks(runner, run_id, &run_dir, &pr, &blocks),
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
                let body = blocks_comment(run_id, &pr, &blocks, machine);
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

#[cfg(test)]
mod tests {
    use super::{fence, remote_repo, PublishLock};

    #[test]
    fn descriptor_lock_excludes_contenders_and_releases_without_unlinking() {
        let dir = std::env::temp_dir().join(format!("qaren-publish-lock-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = PublishLock::acquire(&dir).unwrap();
        assert!(PublishLock::acquire(&dir).is_err());
        assert!(dir.join("publish.lock").exists());
        drop(first);
        let second = PublishLock::acquire(&dir).unwrap();
        assert!(PublishLock::acquire(&dir).is_err());
        drop(second);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn remote_urls_resolve_to_host_owner_repo() {
        for url in [
            "git@github.com:O/r.git",
            "https://github.com/o/r.git",
            "https://user:tok@github.com/o/r",
            "ssh://git@github.com/o/r.git",
        ] {
            assert_eq!(remote_repo(url).as_deref(), Some("github.com/o/r"), "{url}");
        }
        assert_eq!(remote_repo("https://github.com/o/r/extra"), None);
        assert_eq!(remote_repo("/local/path"), None);
    }

    #[test]
    fn fences_outgrow_the_content_they_wrap() {
        assert_eq!(fence("a: 1", 3), "```");
        assert_eq!(fence("x: |\n  ````\n", 3), "`````");
        assert_eq!(fence("dir`name", 1), "``");
    }
}
