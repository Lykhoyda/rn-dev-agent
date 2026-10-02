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

#[test]
fn phrase_named_files_preserve_native_fingerprints_and_drift_detection() {
    for tracked in [true, false] {
        let repo = common::temp_repo();
        let project = repo.join("test-app");
        std::fs::write(project.join("app.json"), r#"{"expo":{"name":"before"}}"#).unwrap();
        std::fs::create_dir_all(project.join("ios")).unwrap();
        std::fs::write(project.join("ios/Podfile"), "platform :ios, '15.0'\n").unwrap();
        let notes = project.join("private key notes.txt");
        if tracked {
            std::fs::write(&notes, "notes").unwrap();
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
        if !tracked {
            std::fs::write(&notes, "notes").unwrap();
        }
        let scenario = common::scenario_from(&common::ios_scenario_yaml(8793));
        let mut runner = RealRunner::new();
        let baseline = resolve(&mut runner, &scenario, &repo).unwrap();
        let before = qaren::fingerprint::compute(&mut runner, &repo, &project, "ios").unwrap();
        assert!(before.complete);
        assert!(before.native_dir_in_candidate);
        assert!(before.file_count >= 2);
        assert!(verify_unchanged_with(&mut runner, &baseline, false).is_ok());
        std::fs::write(project.join("app.json"), r#"{"expo":{"name":"after"}}"#).unwrap();
        let after = qaren::fingerprint::compute(&mut runner, &repo, &project, "ios").unwrap();
        assert_ne!(before.value, after.value, "tracked={tracked}");
        assert!(after.complete);
        let changed = resolve(&mut runner, &scenario, &repo).unwrap();
        assert_ne!(
            baseline.worktree_fingerprint, changed.worktree_fingerprint,
            "tracked={tracked}"
        );
        assert!(verify_unchanged_with(&mut runner, &baseline, false).is_err());
        std::fs::remove_dir_all(repo).unwrap();
    }
}
