use crate::commands::cleanup::Outcome;
use crate::exec::{CmdOutput, CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::github::PrInfo;
use sha2::{Digest, Sha256};
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
    let run_ref = format!("refs/qaren/pr/{:x}", Sha256::digest(wt_arg.as_bytes()));
    let refspec = format!("pull/{}/head:{run_ref}", pr.number);
    let fetch = git(
        runner,
        "git-fetch-pr",
        repo_root,
        &["fetch", "origin", &refspec, "--no-write-fetch-head"],
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
        &["rev-parse", &run_ref],
        20,
    );
    git(
        &mut crate::exec::CleanupRunner(runner),
        "git-fetch-ref-remove",
        repo_root,
        &["update-ref", "-d", &run_ref],
        20,
    );
    crate::cancel::ensure_running(runner, "pr")?;
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
    let mut cleanup_runner = crate::exec::CleanupRunner(runner);
    let runner: &mut dyn Runner = &mut cleanup_runner;
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

pub fn copy_blocks(app_root: &Path, slugs: &[String], dest: &Path) -> (Vec<String>, Vec<String>) {
    let qaren = app_root.join(".qaren");
    let actions = qaren.join("actions");
    let corpus_ok = is_real(&qaren, true) && is_real(&actions, true);
    let mut copied = Vec::new();
    let mut refused = Vec::new();
    for slug in slugs {
        let source = (safe_slug(slug) && corpus_ok)
            .then(|| crate::actions::action_path(&actions, slug).ok().flatten())
            .flatten();
        let ok = source.is_some_and(|source| {
            is_real(&source, false)
                && std::fs::create_dir_all(dest).is_ok()
                && std::fs::copy(&source, dest.join(source.file_name().unwrap())).is_ok()
        });
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
            "rev-parse refs/qaren/pr/",
            CmdOutput::success(&format!("{}\n", "a".repeat(40))),
        );
        mock.expect_run("update-ref -d", CmdOutput::success(""));
        mock.expect_run("worktree add --detach", CmdOutput::success(""));
        add(
            &mut mock,
            Path::new("/repo"),
            &pr(),
            Path::new("/runs/r/wt"),
        )
        .unwrap();
        assert_eq!(
            mock.calls[3].args,
            ["worktree", "add", "--detach", "/runs/r/wt", &"a".repeat(40)]
        );
        assert_eq!(mock.calls[3].cwd.as_deref(), Some(Path::new("/repo")));
    }

    #[test]
    fn a_fetched_head_other_than_the_viewed_one_refuses_before_any_worktree() {
        let mut mock = MockRunner::new();
        mock.expect_run("fetch", CmdOutput::success(""));
        mock.expect_run(
            "rev-parse refs/qaren/pr/",
            CmdOutput::success(&"b".repeat(40)),
        );
        mock.expect_run("update-ref -d", CmdOutput::success(""));
        let failure = add(
            &mut mock,
            Path::new("/repo"),
            &pr(),
            Path::new("/runs/r/wt"),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::PrWorktreeFailed);
        assert_eq!(mock.calls.len(), 3);
    }

    #[test]
    fn cancellation_during_ref_cleanup_prevents_worktree_creation() {
        let mut mock = MockRunner::new();
        mock.expect_run("fetch", CmdOutput::success(""));
        mock.expect_run("rev-parse", CmdOutput::success(&"a".repeat(40)));
        mock.expect_run("update-ref -d", CmdOutput::success(""));
        mock.cancel_after = Some(("update-ref -d".into(), "received SIGTERM".into()));
        let failure = add(
            &mut mock,
            Path::new("/repo"),
            &pr(),
            Path::new("/runs/r/wt"),
        )
        .unwrap_err();
        assert_eq!(failure.code, FailureCode::RunCancelled);
        assert_eq!(mock.calls.len(), 3);
        assert_eq!(mock.remaining(), 0);
    }

    struct ConcurrentFetch(std::sync::Arc<std::sync::Barrier>);

    impl Runner for ConcurrentFetch {
        fn execute(&mut self, spec: &CmdSpec, _interruptible: bool) -> CmdOutput {
            let output = std::process::Command::new(&spec.program)
                .args(&spec.args)
                .current_dir(spec.cwd.as_ref().unwrap())
                .output()
                .unwrap();
            if spec.label == "git-fetch-pr" {
                self.0.wait();
            }
            CmdOutput {
                exit_code: output.status.code(),
                stdout: String::from_utf8(output.stdout).unwrap(),
                stderr: String::from_utf8(output.stderr).unwrap(),
                ..Default::default()
            }
        }
        fn spawn_group_unchecked(
            &mut self,
            _: &CmdSpec,
            _: &Path,
        ) -> std::io::Result<crate::exec::Spawned> {
            unreachable!()
        }
        fn spawn_piped_unchecked(
            &mut self,
            _: &CmdSpec,
            _: &Path,
        ) -> std::io::Result<crate::exec::PipedChild> {
            unreachable!()
        }
        fn sleep(&mut self, _: std::time::Duration) {
            unreachable!()
        }
        fn now_epoch_ms(&self) -> u64 {
            0
        }
        fn commands_executed(&self) -> u64 {
            0
        }
    }

    #[test]
    fn concurrent_pr_fetches_verify_their_own_heads() {
        let root =
            std::env::temp_dir().join(format!("qaren-concurrent-fetch-{}", std::process::id()));
        let origin = root.join("origin");
        let repo = root.join("repo");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        let git = |cwd: &Path, args: &[&str]| {
            let output = std::process::Command::new("git")
                .args(args)
                .current_dir(cwd)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8(output.stdout).unwrap().trim().to_string()
        };
        git(&origin, &["init"]);
        let mut first = pr();
        let mut second = pr();
        second.number = 13;
        for info in [&mut first, &mut second] {
            git(
                &origin,
                &[
                    "-c",
                    "user.name=Test",
                    "-c",
                    "user.email=test@example.com",
                    "-c",
                    "commit.gpgsign=false",
                    "commit",
                    "--allow-empty",
                    "-m",
                    &format!("PR {}", info.number),
                ],
            );
            info.head_ref_oid = git(&origin, &["rev-parse", "HEAD"]);
            git(
                &origin,
                &[
                    "update-ref",
                    &format!("refs/pull/{}/head", info.number),
                    &info.head_ref_oid,
                ],
            );
        }
        git(&repo, &["init"]);
        git(
            &repo,
            &["remote", "add", "origin", origin.to_str().unwrap()],
        );
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let wt1 = root.join("run1/wt");
        let wt2 = root.join("run2/wt");
        std::thread::scope(|scope| {
            let a = scope.spawn(|| add(&mut ConcurrentFetch(barrier.clone()), &repo, &first, &wt1));
            let b =
                scope.spawn(|| add(&mut ConcurrentFetch(barrier.clone()), &repo, &second, &wt2));
            a.join().unwrap().unwrap();
            b.join().unwrap().unwrap();
        });
        assert_eq!(git(&wt1, &["rev-parse", "HEAD"]), first.head_ref_oid);
        assert_eq!(git(&wt2, &["rev-parse", "HEAD"]), second.head_ref_oid);
        assert!(git(&repo, &["for-each-ref", "refs/qaren/pr/"]).is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn slugs_cannot_escape_the_actions_directory() {
        assert!(safe_slug("login-flow_2.v1"));
        for bad in ["", "../x", "a/b", ".hidden", "x y"] {
            assert!(!safe_slug(bad), "{bad}");
        }
    }

    #[test]
    fn failed_walks_preserve_saved_actions_using_canonical_wire_identifiers() {
        let root = std::env::temp_dir().join(format!("qaren-canonical-block-{}", std::process::id()));
        let app = root.join("app");
        let actions = app.join(".qaren/actions");
        std::fs::create_dir_all(&actions).unwrap();
        let bytes = b"appId: com.example.app\n---\n# id: alice\n# intent: alice\n- assertVisible: { text: Hello }\n";
        std::fs::write(actions.join("alice.yaml"), bytes).unwrap();
        let ledger: crate::core::Ledger = serde_json::from_value(serde_json::json!({
            "verdict": "FAIL", "path": "walk",
            "blocks": [{"key": "•••", "outcome": "pass", "source": "discovered"}],
            "blocksWritten": ["alice"], "steps": [],
            "jev": {"calls": 0, "medianMs": 0},
            "llmTurns": 0, "escapes": 0, "recoveries": 0
        }))
        .unwrap();
        let dest = root.join("blocks");
        let (copied, refused) =
            copy_blocks(&app, ledger.blocks_written.as_deref().unwrap(), &dest);
        assert_eq!(copied, ["alice"]);
        assert!(refused.is_empty());
        std::fs::remove_dir_all(&app).unwrap();
        assert_eq!(std::fs::read(dest.join("alice.yaml")).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copied_blocks_keep_the_unique_extension_and_exact_bytes() {
        let root = std::env::temp_dir().join(format!("qaren-block-ext-{}", std::process::id()));
        let app = root.join("app");
        let actions = app.join(".qaren/actions");
        std::fs::create_dir_all(&actions).unwrap();
        let bytes = b"# patched block\r\nsteps: []\r\n\n";
        for (slug, ext) in [("tasks", "yml"), ("control", "yaml")] {
            std::fs::write(actions.join(format!("{slug}.{ext}")), bytes).unwrap();
        }
        for ext in ["yaml", "yml"] {
            std::fs::write(actions.join(format!("ambiguous.{ext}")), bytes).unwrap();
        }
        let dest = root.join("blocks");
        let (copied, refused) = copy_blocks(
            &app,
            &["tasks".into(), "control".into(), "ambiguous".into()],
            &dest,
        );
        assert_eq!(copied, ["tasks", "control"]);
        assert_eq!(refused, ["ambiguous"]);
        assert_eq!(std::fs::read(dest.join("tasks.yml")).unwrap(), bytes);
        assert_eq!(std::fs::read(dest.join("control.yaml")).unwrap(), bytes);
        assert!(!dest.join("tasks.yaml").exists());
        assert!(!dest.join("control.yml").exists());
        std::fs::remove_dir_all(root).unwrap();
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
