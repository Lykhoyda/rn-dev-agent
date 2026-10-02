mod common;

use qaren::exec::{CmdOutput, CmdSpec, MockRunner, PipedChild, Runner, Spawned};
use qaren::publish::{publish, PrRunRecord, Publication};
use qaren::receipt::ReceiptResult;
use qaren::record::VideoStatus;
use qaren::redact::MachineIdentity;
use std::path::{Path, PathBuf};

const RUN: &str = "check-20261002T101500Z";
const TESTED: &str = "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00";
const COMMIT: &str = "beef0000beef0000beef0000beef0000beef0000";

// Plays git's worktree add/remove on disk.
struct Git(MockRunner);

impl Runner for Git {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        if spec.args.starts_with(&["worktree".into(), "add".into()]) {
            std::fs::create_dir_all(&spec.args[3]).unwrap();
        }
        if spec.args.starts_with(&["worktree".into(), "remove".into()]) {
            let _ = std::fs::remove_dir_all(spec.args.last().unwrap());
        }
        self.0.run(spec)
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.0.spawn_group(spec, log)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
}

fn machine() -> MachineIdentity {
    MachineIdentity {
        hostname: Some("qa-mac".into()),
        home: Some("/Users/qa".into()),
    }
}

fn run_dir(cross_repository: bool) -> (PathBuf, PathBuf, PathBuf) {
    let repo = common::temp_repo();
    let runs = repo.join("runs");
    let dir = runs.join(RUN);
    for sub in ["blocks", "media", "screenshots"] {
        std::fs::create_dir_all(dir.join(sub)).unwrap();
    }
    let pr = PrRunRecord {
        number: 12,
        url: "https://github.com/o/r/pull/12".into(),
        head_ref_oid: TESTED.into(),
        head_ref_name: "feat/tasks".into(),
        is_cross_repository: cross_repository,
        repo_root: repo.clone(),
        app_rel: "test-app".into(),
        platform: "ios".into(),
        app_id: "com.rndevagent.testapp".into(),
        device: "qaren-check".into(),
        plan_sha256: "e".repeat(64),
        video: VideoStatus::Available,
        tested_older_commit: false,
        blocks: vec!["tasks".into()],
    };
    std::fs::write(dir.join("pr.json"), serde_json::to_vec(&pr).unwrap()).unwrap();
    std::fs::write(
        dir.join("ledger.json"),
        serde_json::json!({
            "verdict": "FAIL", "path": "walk", "blocks": [],
            "steps": [{"block": "plan", "line": 1, "attempt": 1, "kind": "check", "resolvedBy": "exact",
                       "t": 1, "outcome": "fail", "screenshot": "screenshots/01.png"}],
            "jev": {"calls": 0, "medianMs": 0}, "llmTurns": 0, "escapes": 0, "recoveries": 0,
            "failure": {"step": 1, "seen": "no Tasks", "screenshot": "screenshots/01.png"}
        })
        .to_string(),
    )
    .unwrap();
    std::fs::write(dir.join("plan.md"), "✓ \"Tasks\"\n").unwrap();
    std::fs::write(dir.join("blocks/tasks.yaml"), "steps: []\n").unwrap();
    std::fs::write(dir.join("media/video.mp4"), "mp4").unwrap();
    std::fs::write(dir.join("screenshots/01.png"), "png").unwrap();
    let verdict = repo.join("verdict.md");
    std::fs::write(&verdict, "The Tasks tab is missing after the change.\n").unwrap();
    (runs, dir, verdict)
}

fn view(labels: &str) -> CmdOutput {
    CmdOutput::success(&format!(
        r#"{{"number":12,"url":"https://github.com/o/r/pull/12","headRefOid":"{TESTED}","headRefName":"feat/tasks","isCrossRepository":false,"labels":[{labels}]}}"#
    ))
}

fn script_comment_and_label(mock: &mut MockRunner) {
    mock.expect_run(
        "gh pr comment 12 -R github.com/o/r",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-1\n"),
    );
    mock.expect_run(
        "gh pr view https://github.com/o/r/pull/12",
        view(r#"{"name":"needs-qa"}"#),
    );
    mock.expect_run(
        "gh pr edit 12 -R github.com/o/r --remove-label needs-qa",
        CmdOutput::success(""),
    );
}

fn script_commit(mock: &mut MockRunner) {
    mock.expect_run(
        "git remote get-url --push origin",
        CmdOutput::success("git@github.com:o/r.git\n"),
    );
    mock.expect_run(
        &format!("git fetch origin {TESTED}"),
        CmdOutput::success(""),
    );
    mock.expect_run("git worktree add --detach", CmdOutput::success(""));
    mock.expect_run(
        "git add -f -- test-app/.qaren/actions/tasks.yaml",
        CmdOutput::success(""),
    );
    mock.expect_run(
        "git commit -m qaren: save block tasks",
        CmdOutput::success(""),
    );
    mock.expect_run(
        "git rev-parse HEAD",
        CmdOutput::success(&format!("{COMMIT}\n")),
    );
    mock.expect_run("git worktree remove --force", CmdOutput::success(""));
    mock.expect_run(
        "git ls-remote origin refs/heads/feat/tasks",
        CmdOutput::success(&format!("{TESTED}\trefs/heads/feat/tasks\n")),
    );
}

fn publication(dir: &Path) -> Publication {
    serde_json::from_slice(&std::fs::read(dir.join("publication.json")).unwrap()).unwrap()
}

#[test]
fn publish_comments_removes_the_label_and_pushes_the_blocks_with_the_exact_lease() {
    let (runs, dir, verdict) = run_dir(false);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner
        .0
        .expect_run("git push origin", CmdOutput::success(""));

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.0.remaining(), 0);
    let comment = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "gh-pr-comment")
        .unwrap();
    assert_eq!(comment.cwd.as_deref(), Some(dir.as_path()));
    assert!(comment.args.contains(&"./media/video.mp4".to_string()));
    assert!(comment
        .args
        .contains(&"./screenshots/01.png#Failing step".to_string()));
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(body.starts_with(&format!(
        "<!-- qaren-run: {RUN} -->\nThe Tasks tab is missing"
    )));
    let commit = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "git-commit-blocks")
        .unwrap();
    assert_eq!(
        commit.args,
        [
            "commit",
            "-m",
            "qaren: save block tasks",
            "-m",
            &format!("Qaren-Run: {RUN}")
        ]
    );
    assert!(!commit.args.iter().any(|a| a.contains("user.")));
    let push = runner
        .0
        .calls
        .iter()
        .find(|c| c.label == "git-push-blocks")
        .unwrap();
    assert_eq!(
        push.args,
        [
            "push",
            "origin",
            &format!("{COMMIT}:refs/heads/feat/tasks"),
            &format!("--force-with-lease=feat/tasks:{TESTED}"),
        ]
    );
    let done = publication(&dir);
    assert_eq!(
        done.comment_url.as_deref(),
        Some("https://github.com/o/r/pull/12#issuecomment-1")
    );
    assert_eq!(done.label.as_deref(), Some("removed"));
    assert_eq!(
        done.writeback.as_deref(),
        Some(format!("committed {COMMIT}").as_str())
    );
    assert!(!dir.join("writeback-wt").exists());

    // A rerun of a finished publication runs nothing and changes nothing.
    let before = std::fs::read(dir.join("publication.json")).unwrap();
    let mut again = Git(MockRunner::new());
    let receipt = publish(&mut again, &runs, RUN, &verdict, &machine());
    assert_eq!(receipt.result, ReceiptResult::Published);
    assert!(again.0.calls.is_empty());
    assert_eq!(std::fs::read(dir.join("publication.json")).unwrap(), before);
}

#[test]
fn a_rerun_after_the_comment_posts_no_second_comment() {
    let (runs, dir, verdict) = run_dir(false);
    let mut first = Git(MockRunner::new());
    first.0.expect_run(
        "gh pr comment",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-1\n"),
    );
    first
        .0
        .expect_run("gh pr view", CmdOutput::failed(1, "network down"));
    let receipt = publish(&mut first, &runs, RUN, &verdict, &machine());
    assert_eq!(receipt.result, ReceiptResult::Failed);

    let mut second = Git(MockRunner::new());
    second.0.expect_run("gh pr view", view(""));
    script_commit(&mut second.0);
    second
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut second, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!second.0.calls.iter().any(|c| c.label == "gh-pr-comment"));
    assert_eq!(publication(&dir).label.as_deref(), Some("absent"));
    assert_eq!(second.0.remaining(), 0);
}

#[test]
fn a_lost_comment_outcome_is_adopted_by_its_marker_not_reposted() {
    let (runs, dir, verdict) = run_dir(false);
    let mut first = Git(MockRunner::new());
    first.0.expect_run(
        "gh pr comment",
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
    );
    assert_eq!(
        publish(&mut first, &runs, RUN, &verdict, &machine()).result,
        ReceiptResult::Failed
    );
    assert!(publication(&dir).comment_attempted);

    let mut second = Git(MockRunner::new());
    second.0.expect_run(
        "gh pr view 12 -R github.com/o/r --json comments",
        CmdOutput::success(&serde_json::json!({"comments": [
            {"body": "unrelated", "url": "https://github.com/o/r/pull/12#issuecomment-0"},
            {"body": format!("<!-- qaren-run: {RUN} -->\nThe Tasks tab"), "url": "https://github.com/o/r/pull/12#issuecomment-7"}
        ]}).to_string()),
    );
    second
        .0
        .expect_run("gh pr view https://github.com/o/r/pull/12", view(""));
    script_commit(&mut second.0);
    second
        .0
        .expect_run("git push origin", CmdOutput::success(""));
    let receipt = publish(&mut second, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!second.0.calls.iter().any(|c| c.label == "gh-pr-comment"));
    assert_eq!(
        publication(&dir).comment_url.as_deref(),
        Some("https://github.com/o/r/pull/12#issuecomment-7")
    );
}

#[test]
fn a_rejected_lease_attaches_the_yaml_in_a_second_comment() {
    let (runs, dir, verdict) = run_dir(false);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    script_commit(&mut runner.0);
    runner.0.expect_run(
        "git push origin",
        CmdOutput::failed(1, "! [rejected] (stale info)"),
    );
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.0.remaining(), 0);
    let blocks = std::fs::read_to_string(dir.join("blocks-comment.md")).unwrap();
    assert!(blocks.contains("<details><summary>Saved blocks to commit</summary>"));
    assert!(blocks.contains("` test-app/.qaren/actions/tasks.yaml `"));
    assert!(blocks.contains("```yaml\nsteps: []\n```"));
    let done = publication(&dir);
    assert_eq!(
        done.writeback.as_deref(),
        Some("attached https://github.com/o/r/pull/12#issuecomment-2")
    );
    assert!(std::fs::read_to_string(dir.join("comment.md"))
        .unwrap()
        .contains("The Tasks tab is missing"));
}

#[test]
fn a_fork_pr_gets_the_yaml_comment_and_no_push() {
    let (runs, dir, verdict) = run_dir(true);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-3\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!runner.0.calls.iter().any(|c| c.program == "git"));
    assert!(publication(&dir)
        .writeback
        .unwrap()
        .starts_with("attached "));
}

#[test]
fn an_origin_that_is_not_the_pr_repository_gets_the_yaml_comment_and_no_push() {
    let (runs, dir, verdict) = run_dir(false);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    runner.0.expect_run(
        "git remote get-url --push origin",
        CmdOutput::success("git@github.com:someone/else.git\n"),
    );
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-4\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!runner.0.calls.iter().any(|c| c.label == "git-push-blocks"));
    assert!(publication(&dir)
        .writeback
        .unwrap()
        .starts_with("attached "));
}

// The PR controls the checked-out tree; a symlinked corpus must not redirect the write.
struct SymlinkedCorpus(Git);

impl Runner for SymlinkedCorpus {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        let output = self.0.run(spec);
        if spec.args.starts_with(&["worktree".into(), "add".into()]) {
            let wt = PathBuf::from(&spec.args[3]);
            let outside = wt.parent().unwrap().join("outside");
            std::fs::create_dir_all(&outside).unwrap();
            std::fs::create_dir_all(wt.join("test-app")).unwrap();
            std::os::unix::fs::symlink(&outside, wt.join("test-app/.qaren")).unwrap();
        }
        output
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.0.spawn_group(spec, log)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
}

#[test]
fn a_symlinked_corpus_in_the_pr_tree_is_refused_and_the_yaml_is_attached() {
    let (runs, dir, verdict) = run_dir(false);
    let mut runner = SymlinkedCorpus(Git(MockRunner::new()));
    let mock = &mut runner.0 .0;
    script_comment_and_label(mock);
    mock.expect_run(
        "git remote get-url --push origin",
        CmdOutput::success("https://github.com/o/r\n"),
    );
    mock.expect_run(
        &format!("git fetch origin {TESTED}"),
        CmdOutput::success(""),
    );
    mock.expect_run("git worktree add --detach", CmdOutput::success(""));
    mock.expect_run("git worktree remove --force", CmdOutput::success(""));
    mock.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-5\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert!(!dir.join("outside/actions").exists());
    assert!(!runner
        .0
         .0
        .calls
        .iter()
        .any(|c| c.label == "git-commit-blocks"));
    assert!(publication(&dir)
        .writeback
        .unwrap()
        .starts_with("attached "));
    assert_eq!(runner.0 .0.remaining(), 0);
}

#[test]
fn a_live_publisher_holds_the_run() {
    let (runs, dir, verdict) = run_dir(false);
    std::fs::write(dir.join("publish.lock"), std::process::id().to_string()).unwrap();
    let mut runner = Git(MockRunner::new());
    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(receipt
        .failure
        .unwrap()
        .detail
        .contains("another qaren publish"));
    assert!(runner.0.calls.is_empty());
    assert!(dir.join("publish.lock").exists());
}

#[test]
fn an_unreadable_publication_state_fails_closed() {
    let (runs, dir, verdict) = run_dir(false);
    std::fs::write(dir.join("publication.json"), "{not json").unwrap();
    let mut runner = Git(MockRunner::new());
    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(runner.0.calls.is_empty());
}

// Records what each `git add` stages, as the commit will contain it.
struct Staged(Git, Vec<String>);

impl Runner for Staged {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        if spec.label == "git-add-blocks" {
            let cwd = spec.cwd.clone().unwrap();
            for path in &spec.args[3..] {
                self.1
                    .push(std::fs::read_to_string(cwd.join(path)).unwrap());
            }
        }
        self.0.run(spec)
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.0.spawn_group(spec, log)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.0.spawn_piped(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.0.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.0.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.0.commands_executed()
    }
}

const TYPED_SECRET: &str = "ghp_typedSecretValue1234567890abcdef";

fn block_with_typed_secret(dir: &Path) {
    std::fs::write(
        dir.join("blocks/tasks.yaml"),
        format!(
            "steps:\n  - type: \"token={TYPED_SECRET}\" into \"Token\"\n  - type: \"{TYPED_SECRET}\"\n  - note: /Users/qa/app on qa-mac\n"
        ),
    )
    .unwrap();
}

#[test]
fn a_typed_secret_never_lands_in_the_committed_block_yaml() {
    let (runs, dir, verdict) = run_dir(false);
    block_with_typed_secret(&dir);
    let mut runner = Staged(Git(MockRunner::new()), Vec::new());
    script_comment_and_label(&mut runner.0 .0);
    script_commit(&mut runner.0 .0);
    runner
        .0
         .0
        .expect_run("git push origin", CmdOutput::success(""));

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.1.len(), 1);
    let committed = &runner.1[0];
    for leak in [TYPED_SECRET, "/Users/qa", "qa-mac"] {
        assert!(!committed.contains(leak), "{leak} committed:\n{committed}");
    }
    assert!(committed.starts_with("steps:\n"), "{committed}");
}

#[test]
fn a_typed_secret_never_lands_in_the_posted_block_yaml() {
    let (runs, dir, verdict) = run_dir(true);
    block_with_typed_secret(&dir);
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);
    runner.0.expect_run(
        "gh pr comment 12",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-6\n"),
    );

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let posted = std::fs::read_to_string(dir.join("blocks-comment.md")).unwrap();
    for leak in [TYPED_SECRET, "/Users/qa", "qa-mac"] {
        assert!(!posted.contains(leak), "{leak} posted:\n{posted}");
    }
}
