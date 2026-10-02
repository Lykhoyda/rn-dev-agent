use crate::commands::cleanup::Outcome;
use crate::exec::{CmdOutput, CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::github::PrInfo;
use std::path::{Path, PathBuf};

pub fn pr_worktree_path(run_dir: &Path) -> PathBuf {
    run_dir.join("wt")
}

pub(crate) fn git(
    runner: &mut dyn Runner,
    label: &str,
    cwd: &Path,
    args: &[&str],
    timeout: u64,
) -> CmdOutput {
    runner.run(&CmdSpec::new(label, "git", args, timeout).cwd(cwd))
}

fn failed(detail: String) -> Failure {
    Failure::new(
        "pr",
        FailureCode::PrWorktreeFailed,
        detail,
        "check that origin is the pull request's repository and that git can fetch it, then re-run",
    )
}

// Fetches the PR head from origin and checks it out detached; the fetched head must be the one gh named.
pub fn add(
    runner: &mut dyn Runner,
    repo_root: &Path,
    pr: &PrInfo,
    wt: &Path,
) -> Result<(), Failure> {
    let Some(wt_arg) = wt.to_str() else {
        return Err(failed(format!("{} is not a UTF-8 path", wt.display())));
    };
    let refspec = format!("pull/{}/head", pr.number);
    let fetch = git(
        runner,
        "git-fetch-pr",
        repo_root,
        &["fetch", "origin", &refspec],
        300,
    );
    if !fetch.ok() {
        return Err(failed(format!(
            "git fetch origin {refspec} failed: {}",
            fetch.summary()
        )));
    }
    let fetched = git(
        runner,
        "git-fetch-head",
        repo_root,
        &["rev-parse", "FETCH_HEAD"],
        20,
    );
    if !fetched.ok() || fetched.stdout.trim() != pr.head_ref_oid {
        return Err(failed(format!(
            "origin's {refspec} is {}, not the head gh reported ({}); the pull request moved or origin is another repository",
            fetched.stdout.trim(),
            pr.head_ref_oid
        )));
    }
    let added = git(
        runner,
        "git-worktree-add",
        repo_root,
        &["worktree", "add", "--detach", wt_arg, &pr.head_ref_oid],
        120,
    );
    if !added.ok() {
        return Err(failed(format!(
            "git worktree add failed: {}",
            added.summary()
        )));
    }
    Ok(())
}

enum Presence {
    Present,
    Absent,
    Unknown(String),
}

fn presence(path: &Path) -> Presence {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Presence::Present,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Presence::Absent,
        Err(e) => Presence::Unknown(format!("cannot inspect {}: {e}", path.display())),
    }
}

pub fn remove(runner: &mut dyn Runner, repo_root: &Path, wt: &Path) -> Outcome {
    let Some(wt_arg) = wt.to_str() else {
        return Outcome::Unresolved(format!("{} is not a UTF-8 path", wt.display()));
    };
    match presence(wt) {
        Presence::Unknown(why) => return Outcome::Unresolved(why),
        Presence::Present => {
            let removed = git(
                runner,
                "git-worktree-remove",
                repo_root,
                &["worktree", "remove", "--force", wt_arg],
                120,
            );
            if !removed.ok() {
                return Outcome::Unresolved(format!(
                    "git worktree remove failed: {}",
                    removed.summary()
                ));
            }
        }
        // ponytail: prune is repo-wide; it only runs when our directory is already gone (a dead owner or a partial add).
        Presence::Absent => {
            let pruned = git(
                runner,
                "git-worktree-prune",
                repo_root,
                &["worktree", "prune"],
                60,
            );
            if !pruned.ok() {
                return Outcome::Unresolved(format!(
                    "git worktree prune failed: {}",
                    pruned.summary()
                ));
            }
            return Outcome::Absent;
        }
    }
    match presence(wt) {
        Presence::Absent => Outcome::Removed,
        Presence::Present => Outcome::Unresolved(format!("{} still exists", wt.display())),
        Presence::Unknown(why) => Outcome::Unresolved(why),
    }
}

pub fn safe_slug(slug: &str) -> bool {
    !slug.is_empty()
        && !slug.starts_with('.')
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

fn is_real(path: &Path, dir: bool) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        let kind = m.file_type();
        !kind.is_symlink() && if dir { kind.is_dir() } else { kind.is_file() }
    })
}

// Copies each saved block out of the PR worktree before it is removed. A PR controls that tree,
// so a symlinked `.qaren`, `actions` or block file is refused rather than followed.
pub fn copy_blocks(app_root: &Path, slugs: &[String], dest: &Path) -> (Vec<String>, Vec<String>) {
    let qaren = app_root.join(".qaren");
    let actions = qaren.join("actions");
    let corpus_ok = is_real(&qaren, true) && is_real(&actions, true);
    let mut copied = Vec::new();
    let mut refused = Vec::new();
    for slug in slugs {
        let source = actions.join(format!("{slug}.yaml"));
        let ok = safe_slug(slug)
            && corpus_ok
            && is_real(&source, false)
            && std::fs::create_dir_all(dest).is_ok()
            && std::fs::copy(&source, dest.join(format!("{slug}.yaml"))).is_ok();
        if ok {
            copied.push(slug.clone());
        } else {
            refused.push(slug.clone());
        }
    }
    (copied, refused)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner};

    fn pr() -> PrInfo {
        PrInfo {
            number: 12,
            url: "https://github.com/o/r/pull/12".into(),
            head_ref_oid: "a".repeat(40),
            head_ref_name: "feat/x".into(),
            is_cross_repository: false,
            labels: Vec::new(),
        }
    }

    #[test]
    fn add_fetches_the_pr_head_and_checks_out_that_exact_sha() {
        let mut mock = MockRunner::new();
        mock.expect_run("fetch origin pull/12/head", CmdOutput::success(""));
        mock.expect_run(
            "rev-parse FETCH_HEAD",
            CmdOutput::success(&format!("{}\n", "a".repeat(40))),
        );
        mock.expect_run("worktree add --detach", CmdOutput::success(""));
        add(
            &mut mock,
            Path::new("/repo"),
            &pr(),
            Path::new("/runs/r/wt"),
        )
        .unwrap();
        assert_eq!(
            mock.calls[2].args,
            ["worktree", "add", "--detach", "/runs/r/wt", &"a".repeat(40)]
        );
        assert_eq!(mock.calls[2].cwd.as_deref(), Some(Path::new("/repo")));
    }

    #[test]
    fn a_fetched_head_other_than_the_viewed_one_refuses_before_any_worktree() {
        let mut mock = MockRunner::new();
        mock.expect_run("fetch", CmdOutput::success(""));
        mock.expect_run("FETCH_HEAD", CmdOutput::success(&"b".repeat(40)));
        let failure = add(
            &mut mock,
            Path::new("/repo"),
            &pr(),
            Path::new("/runs/r/wt"),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::PrWorktreeFailed);
        assert_eq!(mock.calls.len(), 2);
    }

    #[test]
    fn slugs_cannot_escape_the_actions_directory() {
        assert!(safe_slug("login-flow_2.v1"));
        for bad in ["", "../x", "a/b", ".hidden", "x y"] {
            assert!(!safe_slug(bad), "{bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_blocks_are_refused_not_followed() {
        let root = std::env::temp_dir().join(format!("qaren-wt-{}", std::process::id()));
        let app = root.join("app");
        let actions = app.join(".qaren/actions");
        std::fs::create_dir_all(&actions).unwrap();
        std::fs::write(actions.join("real.yaml"), "steps: []\n").unwrap();
        std::fs::write(root.join("secret"), "host file").unwrap();
        std::os::unix::fs::symlink(root.join("secret"), actions.join("leak.yaml")).unwrap();
        let dest = root.join("blocks");
        let (copied, refused) = copy_blocks(
            &app,
            &["real".to_string(), "leak".to_string(), "../x".to_string()],
            &dest,
        );
        assert_eq!(copied, ["real"]);
        assert_eq!(refused, ["leak", "../x"]);
        assert!(!dest.join("leak.yaml").exists());

        let linked = root.join("linked");
        std::fs::create_dir_all(&linked).unwrap();
        std::os::unix::fs::symlink(&app.join(".qaren"), linked.join(".qaren")).unwrap();
        let (copied, _) = copy_blocks(&linked, &["real".to_string()], &root.join("blocks2"));
        assert!(copied.is_empty());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
