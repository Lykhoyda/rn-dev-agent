use qaren::actions;
use qaren::exec::RealRunner;
use qaren::run::{app_root_for, worktree_drift, worktree_status};
use std::path::{Path, PathBuf};
use std::process::Command;

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("qaren-blocks-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join(".qaren/actions")).unwrap();
    dir.canonicalize().unwrap()
}

fn block(slug: &str, platform: &str, hash: &str) -> String {
    format!(
        "appId: com.example.app\n---\n# id: {slug}\n# intent: {slug}\n# status: active\n# appId: com.example.app\n# plan: {slug}\n# planHash: {hash}\n# platform: {platform}\n\n# 1. Tap \"Go\"\n- tapOn: {{ id: \"go\" }}\n"
    )
}

#[test]
fn actions_list_reads_slug_platform_plan_hash_and_status() {
    let root = temp_dir("list");
    let dir = root.join(".qaren/actions");
    std::fs::write(
        dir.join("onboarding.yaml"),
        block("onboarding", "ios", "abc123"),
    )
    .unwrap();
    std::fs::write(
        dir.join("checkout.yaml"),
        block("checkout", "android", "def456"),
    )
    .unwrap();
    std::fs::write(
        dir.join("recorded.yaml"),
        "# id: recorded\n# intent: recorded flow\n- launchApp\n",
    )
    .unwrap();
    std::fs::write(dir.join("notes.txt"), "not an action").unwrap();
    std::fs::write(dir.join("headless.yaml"), "- launchApp\n").unwrap();

    let entries = actions::list(&root).unwrap();
    let json = serde_json::to_value(&entries).unwrap();
    assert_eq!(
        json,
        serde_json::json!([
            {"slug": "checkout", "platform": "android", "planHash": "def456", "status": "active"},
            {"slug": "onboarding", "platform": "ios", "planHash": "abc123", "status": "active"},
            {"slug": "recorded", "platform": null, "planHash": null, "status": null}
        ])
    );
    assert_eq!(
        actions::render(&entries),
        "checkout\tandroid\tdef456\tactive\nonboarding\tios\tabc123\tactive\nrecorded\t-\t-\t-\n"
    );
    assert_eq!(
        actions::show(&root, "onboarding").unwrap(),
        block("onboarding", "ios", "abc123")
    );
    assert!(actions::show(&root, "../escape").is_err());
    assert!(actions::show(&root, "missing").is_err());
}

#[test]
fn actions_list_is_empty_without_a_corpus_and_refuses_a_symlinked_one() {
    let root = temp_dir("empty");
    std::fs::remove_dir_all(root.join(".qaren/actions")).unwrap();
    assert!(actions::list(&root).unwrap().is_empty());
    let target = temp_dir("elsewhere");
    std::os::unix::fs::symlink(target.join(".qaren/actions"), root.join(".qaren/actions")).unwrap();
    assert!(actions::list(&root).unwrap_err().contains("symlinked"));
}

#[test]
fn the_app_root_is_the_directory_above_qaren_or_the_checked_tree() {
    let root = temp_dir("root");
    let tree = temp_dir("tree");
    assert_eq!(
        app_root_for(&root.join(".qaren/config.yaml"), &tree).unwrap(),
        root
    );
    assert_eq!(
        app_root_for(&root.join("qa/external.yaml"), &tree).unwrap(),
        tree
    );
    assert!(app_root_for(Path::new("/nonexistent-qaren/.qaren/config.yaml"), &tree).is_err());
}

fn git(dir: &Path, args: &[&str]) {
    let status = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(args)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

#[test]
fn worktree_drift_excludes_saved_blocks_and_reports_other_changed_paths() {
    let root = temp_dir("drift");
    git(&root, &["init", "-q"]);
    std::fs::write(root.join("app.ts"), "export {}\n").unwrap();
    std::fs::write(root.join("dirty.ts"), "before\n").unwrap();
    git(&root, &["add", "."]);
    git(
        &root,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "init",
        ],
    );
    std::fs::write(root.join("dirty.ts"), "already dirty\n").unwrap();
    let mut runner = RealRunner::new();
    let before = worktree_status(&mut runner, &root).unwrap();

    std::fs::write(
        root.join(".qaren/actions/onboarding.yaml"),
        "# id: onboarding\n",
    )
    .unwrap();
    std::fs::write(root.join("app.ts"), "export const changed = 1\n").unwrap();
    std::fs::create_dir_all(root.join("src")).unwrap();
    std::fs::write(root.join("src/new.ts"), "export {}\n").unwrap();
    let after = worktree_status(&mut runner, &root).unwrap();

    assert_eq!(
        worktree_drift(&before, &after),
        vec!["app.ts".to_string(), "src/new.ts".to_string()]
    );
    assert!(worktree_drift(&after, &after).is_empty());

    git(&root, &["add", "-A"]);
    git(
        &root,
        &[
            "-c",
            "user.name=t",
            "-c",
            "user.email=t@t",
            "commit",
            "-qm",
            "two",
        ],
    );
    let clean = worktree_status(&mut runner, &root).unwrap();
    git(&root, &["mv", "app.ts", "renamed file.ts"]);
    let moved = worktree_status(&mut runner, &root).unwrap();
    assert_eq!(
        worktree_drift(&clean, &moved),
        vec!["app.ts".to_string(), "renamed file.ts".to_string()]
    );
}

#[test]
fn actions_refuse_a_symlinked_action_file_instead_of_skipping_it() {
    let root = temp_dir("filelink");
    let outside = temp_dir("outside").join("secret.yaml");
    std::fs::write(&outside, "# id: secret\n# intent: outside\n").unwrap();
    std::os::unix::fs::symlink(&outside, root.join(".qaren/actions/linked.yaml")).unwrap();
    assert!(actions::show(&root, "linked").is_err());
    assert!(actions::list(&root).is_err());
}
