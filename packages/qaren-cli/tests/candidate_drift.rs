mod common;

use qaren::candidate::{resolve, verify_unchanged_with};
use qaren::exec::{CmdSpec, RealRunner, Runner};
use std::path::Path;

fn git(repo: &Path, args: &[&str]) {
    let output = RealRunner::new().run(&CmdSpec::new("git", "git", args, 20).cwd(repo));
    assert!(output.ok(), "{}", output.summary());
}

fn check_integration_drift(extra_path: Option<&str>, tracked: bool) -> bool {
    let repo = common::temp_repo();
    let write = |path: &str, contents: &str| {
        let path = repo.join("test-app").join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    };
    if tracked {
        write(extra_path.unwrap(), "original\n");
    }
    git(&repo, &["init", "-q"]);
    git(&repo, &["add", "."]);
    git(
        &repo,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-qm",
            "baseline",
        ],
    );
    let scenario = common::scenario_from(
        "schema: qaren/1\nname: drift\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: iPhone\n  runtime: iOS\n",
    );
    let mut runner = RealRunner::new();
    let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
    assert!(!baseline.git_dirty);
    write(".qaren/integration/rn-session-adapter.cjs", "integration\n");
    assert!(verify_unchanged_with(&mut runner, &baseline, true).is_ok());
    let integrated_baseline = resolve(&mut runner, &scenario, &repo).unwrap();
    assert_eq!(
        baseline.worktree_fingerprint,
        integrated_baseline.worktree_fingerprint
    );
    write(".qaren/integration/rn-session-metro.cjs", "integration\n");
    if let Some(path) = extra_path {
        write(path, "changed\n");
    }
    let result = verify_unchanged_with(&mut runner, &integrated_baseline, true);
    std::fs::remove_dir_all(&repo).unwrap();
    println!("{extra_path:?} (tracked={tracked}): {result:?}");
    result.is_ok()
}

#[test]
fn only_untracked_integration_files_are_tolerated_in_a_real_checkout() {
    let accepted = [
        check_integration_drift(None, false),
        check_integration_drift(Some(".qaren/actions/new-flow.yaml"), false),
        check_integration_drift(Some(".qaren/config.yaml"), false),
        check_integration_drift(Some(".qaren/actions/existing.yaml"), true),
    ];
    assert_eq!(accepted, [true, false, false, false]);
}
