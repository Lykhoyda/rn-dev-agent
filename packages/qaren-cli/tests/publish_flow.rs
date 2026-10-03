mod common;

use qaren::exec::{CmdOutput, CmdSpec, MockRunner, PipedChild, Runner, Spawned};
use qaren::publish::{publish, PrRunRecord, Publication};
use qaren::receipt::ReceiptResult;
use qaren::record::{VideoPublication, VideoStatus};
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
        ..Default::default()
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
        video_publication: VideoPublication::Eligible,
        video_withholding_reason: None,
        tested_older_commit: false,
        blocks: vec!["tasks".into()],
        identity_values: Vec::new(),
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
    script_commit_extension(mock, "yaml");
}

fn script_commit_extension(mock: &mut MockRunner, extension: &str) {
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
        &format!("git add -f -- test-app/.qaren/actions/tasks.{extension}"),
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
    std::fs::remove_file(&verdict).unwrap();
    std::fs::remove_file(dir.join("comment.md")).unwrap();

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
    use std::os::fd::AsRawFd;
    let held = std::fs::File::create(dir.join("publish.lock")).unwrap();
    assert_eq!(
        unsafe { libc::flock(held.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
        0
    );
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

const SECRET: &str = "Hunter2Fixture!Synth";

fn edit_pr(dir: &Path, change: impl FnOnce(&mut serde_json::Value)) {
    let path = dir.join("pr.json");
    let mut pr: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    change(&mut pr);
    std::fs::write(path, serde_json::to_vec(&pr).unwrap()).unwrap();
}

fn calls_named(runner: &MockRunner, label: &str) -> usize {
    runner.calls.iter().filter(|c| c.label == label).count()
}

#[test]
fn the_raw_plan_is_never_published() {
    let (runs, dir, verdict) = run_dir(false);
    std::fs::write(
        dir.join("plan.md"),
        format!("fill password with \"{SECRET}\"\n"),
    )
    .unwrap();
    edit_pr(&dir, |pr| pr["blocks"] = serde_json::json!([]));
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    assert!(!body.contains(SECRET), "{body}");
    assert!(body.contains("- ✗ line 1: \n"), "{body}");
}

#[test]
fn blocks_from_a_walk_that_is_not_eligible_are_withheld() {
    for eligibility in [
        Some(serde_json::json!("withheld-fill")),
        Some(serde_json::json!("withheld-privacy")),
        Some(serde_json::json!("unknown")),
        None,
    ] {
        let (runs, dir, verdict) = run_dir(false);
        std::fs::write(
            dir.join("blocks/tasks.yaml"),
            format!("steps:\n  - inputText: \"{SECRET}\"\n"),
        )
        .unwrap();
        edit_pr(&dir, |pr| match &eligibility {
            Some(value) => pr["videoPublication"] = value.clone(),
            None => {
                pr.as_object_mut().unwrap().remove("videoPublication");
            }
        });
        let mut runner = Git(MockRunner::new());
        script_comment_and_label(&mut runner.0);

        let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());

        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{eligibility:?}: {:?}",
            receipt.failure
        );
        assert_eq!(runner.0.remaining(), 0, "{eligibility:?}");
        assert_eq!(calls_named(&runner.0, "git-commit-blocks"), 0);
        assert_eq!(calls_named(&runner.0, "git-push-blocks"), 0);
        assert_eq!(
            calls_named(&runner.0, "gh-pr-comment"),
            1,
            "only the QA comment"
        );
        assert!(!dir.join("blocks-comment.md").exists());
        assert_eq!(
            receipt.outcomes["writeback"],
            "withheld tasks: the walk was not eligible for publication"
        );
        assert!(
            dir.join("blocks/tasks.yaml").is_file(),
            "kept for the operator"
        );
    }
}

#[test]
fn an_eligible_parameterised_block_is_committed_byte_identical() {
    let (runs, dir, verdict) = run_dir(false);
    let source = "steps:\n  - inputText: ${PASSWORD}\n    into: \"Password\"\n";
    std::fs::write(dir.join("blocks/tasks.yaml"), source).unwrap();
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
    assert_eq!(runner.1, [source]);
    assert_eq!(receipt.outcomes["writeback"], format!("committed {COMMIT}"));
}

#[test]
fn a_block_the_redaction_would_change_is_withheld_never_rewritten() {
    for content in [
        "steps:\n  - open: /Users/qa-fixture-user/x\n".to_string(),
        "steps:\n  - device: emulator-5554\n".to_string(),
        "steps:\n  - key: |\n      -----BEGIN PRIVATE KEY-----\n      FAKEFIXTUREBODY\n      -----END PRIVATE KEY-----\n".to_string(),
    ] {
        let (runs, dir, verdict) = run_dir(false);
        std::fs::write(dir.join("blocks/tasks.yaml"), &content).unwrap();
        edit_pr(&dir, |pr| pr["identityValues"] = serde_json::json!(["emulator-5554"]));
        let mut runner = Staged(Git(MockRunner::new()), Vec::new());
        script_comment_and_label(&mut runner.0 .0);

        let receipt = publish(&mut runner, &runs, RUN, &verdict, &fixture_machine());

        assert_eq!(receipt.result, ReceiptResult::Published, "{:?}", receipt.failure);
        assert!(runner.1.is_empty(), "nothing staged for {content}");
        assert_eq!(calls_named(&runner.0 .0, "git-commit-blocks"), 0);
        assert!(!dir.join("blocks-comment.md").exists());
        assert_eq!(
            receipt.outcomes["writeback"],
            "withheld tasks: the block carries a secret or machine identity"
        );
        assert_eq!(std::fs::read_to_string(dir.join("blocks/tasks.yaml")).unwrap(), content);
    }
}

fn fixture_machine() -> MachineIdentity {
    MachineIdentity {
        hostname: Some("qa-fixture-host".into()),
        home: Some("/Users/qa-fixture-user".into()),
        username: Some("qa-fixture-user".into()),
        values: Vec::new(),
    }
}

#[test]
fn the_runs_identity_values_and_tool_vocabulary_never_reach_the_comment() {
    let (runs, dir, verdict) = run_dir(false);
    edit_pr(&dir, |pr| {
        pr["blocks"] = serde_json::json!([]);
        pr["identityValues"] = serde_json::json!(["emulator-5554", "R58M00SYNTH0", "8081", "8791"]);
    });
    let mut ledger: serde_json::Value =
        serde_json::from_slice(&std::fs::read(dir.join("ledger.json")).unwrap()).unwrap();
    ledger["failure"]["seen"] = serde_json::json!(
        "qa-fixture-user saw emulator-5554 and R58M00SYNTH0 via 127.0.0.1:8081 on port 8791 using xcrun simctl and adb -s; build 180812 kept"
    );
    std::fs::write(dir.join("ledger.json"), ledger.to_string()).unwrap();
    let mut runner = Git(MockRunner::new());
    script_comment_and_label(&mut runner.0);

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &fixture_machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
    let tokens: Vec<&str> = body
        .split(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
        .collect();
    for leak in [
        "qa-fixture-user",
        "emulator-5554",
        "R58M00SYNTH0",
        "8081",
        "8791",
    ] {
        assert!(!tokens.contains(&leak), "{leak} leaked:\n{body}");
    }
    for phrase in ["xcrun simctl", "adb -s"] {
        assert!(!body.contains(phrase), "{phrase} leaked:\n{body}");
    }
    assert!(
        body.contains("180812"),
        "a longer token is left alone:\n{body}"
    );
}

#[test]
fn withheld_or_unknown_eligibility_never_uploads_video() {
    for eligibility in [
        None,
        Some(serde_json::json!("withheld-fill")),
        Some(serde_json::json!("withheld-privacy")),
        Some(serde_json::json!("future-status")),
        Some(serde_json::json!({"invalid": true})),
        Some(serde_json::Value::Null),
    ] {
        let (runs, dir, verdict) = run_dir(false);
        let path = dir.join("pr.json");
        let mut pr: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pr["blocks"] = serde_json::json!([]);
        if let Some(value) = eligibility {
            pr["videoPublication"] = value;
        } else {
            pr.as_object_mut().unwrap().remove("videoPublication");
        }
        std::fs::write(&path, serde_json::to_vec(&pr).unwrap()).unwrap();
        let mut runner = Git(MockRunner::new());
        script_comment_and_label(&mut runner.0);
        let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());
        assert_eq!(
            receipt.result,
            ReceiptResult::Published,
            "{:?}",
            receipt.failure
        );
        let comment = runner
            .0
            .calls
            .iter()
            .find(|c| c.label == "gh-pr-comment")
            .unwrap();
        assert!(!comment.args.iter().any(|arg| arg.contains("video.mp4")));
        let body = std::fs::read_to_string(dir.join("comment.md")).unwrap();
        assert!(body.contains("Video withheld:"));
        assert!(!body.contains("Video of the walk is attached"));
        assert!(dir.join("media/video.mp4").is_file());
        assert_eq!(runner.0.remaining(), 0);
    }
}

#[test]
fn publishing_an_older_head_retains_the_qa_request_and_receipt() {
    let (runs, dir, verdict) = run_dir(false);
    let path = dir.join("pr.json");
    let mut pr: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    pr["blocks"] = serde_json::json!([]);
    std::fs::write(path, serde_json::to_vec(&pr).unwrap()).unwrap();
    let mut runner = Git(MockRunner::new());
    runner.0.expect_run(
        "gh pr comment",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-1"),
    );
    let mut current: serde_json::Value =
        serde_json::from_str(&view(r#"{"name":"needs-qa"}"#).stdout).unwrap();
    current["headRefOid"] = serde_json::json!(COMMIT);
    runner
        .0
        .expect_run("gh pr view", CmdOutput::success(&current.to_string()));
    let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());
    assert_eq!(receipt.result, ReceiptResult::Published);
    assert_eq!(receipt.outcomes["label"], "retained-head-changed");
    assert_eq!(
        publication(&dir).label.as_deref(),
        Some("retained-head-changed")
    );
    assert!(!runner
        .0
        .calls
        .iter()
        .any(|c| c.args.contains(&"--remove-label".into())));
    assert_eq!(runner.0.remaining(), 0);
}

#[test]
fn an_abandoned_empty_or_partial_lock_does_not_block_publication() {
    for content in ["", "not-a-pid", "12"] {
        let (runs, dir, verdict) = run_dir(false);
        std::fs::write(dir.join("publish.lock"), content).unwrap();
        let path = dir.join("pr.json");
        let mut pr: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        pr["blocks"] = serde_json::json!([]);
        std::fs::write(path, serde_json::to_vec(&pr).unwrap()).unwrap();
        let mut runner = Git(MockRunner::new());
        script_comment_and_label(&mut runner.0);
        assert_eq!(
            publish(&mut runner, &runs, RUN, &verdict, &machine()).result,
            ReceiptResult::Published
        );
        assert_eq!(
            std::fs::read_to_string(dir.join("publish.lock")).unwrap(),
            content
        );
    }
}

struct Uploads {
    runner: Git,
    bodies: Vec<(String, String)>,
}

impl Runner for Uploads {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        if spec.label == "gh-pr-comment" {
            let at = spec
                .args
                .iter()
                .position(|arg| arg == "--body-file")
                .unwrap();
            let file = &spec.args[at + 1];
            let body = std::fs::read_to_string(spec.cwd.as_ref().unwrap().join(file)).unwrap();
            self.bodies.push((file.clone(), body));
        }
        self.runner.run(spec)
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.runner.spawn_group(spec, log)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.runner.spawn_piped(spec, log)
    }
    fn sleep(&mut self, d: std::time::Duration) {
        self.runner.sleep(d)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.runner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.runner.commands_executed()
    }
}

#[test]
fn retry_regenerates_an_unposted_walk_comment_with_current_privacy() {
    let (runs, dir, verdict) = run_dir(false);
    edit_pr(&dir, |pr| pr["blocks"] = serde_json::json!([]));
    std::fs::write(&verdict, "qa-fixture-user saw the missing Tasks tab.").unwrap();
    let mut first = Git(MockRunner::new());
    first
        .0
        .expect_run("gh pr comment", CmdOutput::failed(1, "offline"));
    assert_eq!(
        publish(
            &mut first,
            &runs,
            RUN,
            &verdict,
            &MachineIdentity::default()
        )
        .result,
        ReceiptResult::Failed
    );
    assert!(publication(&dir).rendered);
    assert!(std::fs::read_to_string(dir.join("comment.md"))
        .unwrap()
        .contains("qa-fixture-user"));
    std::fs::write(dir.join("plan.md"), "Fill password with raw-plan-secret").unwrap();
    let mut second = Uploads {
        runner: Git(MockRunner::new()),
        bodies: Vec::new(),
    };
    second
        .runner
        .0
        .expect_run("gh pr view 12", CmdOutput::success(r#"{"comments":[]}"#));
    script_comment_and_label(&mut second.runner.0);
    let receipt = publish(&mut second, &runs, RUN, &verdict, &fixture_machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(second.runner.0.remaining(), 0);
    assert_eq!(second.bodies.len(), 1);
    let (file, body) = &second.bodies[0];
    assert_eq!(file, "comment.md");
    assert!(body.starts_with(&format!("<!-- qaren-run: {RUN} -->")));
    assert!(body.contains(r"\<user\> saw the missing Tasks tab."));
    assert!(!body.contains("qa-fixture-user"));
    assert!(!body.contains("raw-plan-secret"));
}

#[test]
fn retry_regenerates_unposted_blocks_through_the_current_block_gate() {
    let (runs, dir, verdict) = run_dir(true);
    edit_pr(&dir, |pr| {
        pr["blocks"] = serde_json::json!(["tasks", "safe"])
    });
    std::fs::write(
        dir.join("blocks/tasks.yaml"),
        "name: qa-fixture-user\nsteps: []\n",
    )
    .unwrap();
    std::fs::write(dir.join("blocks/safe.yaml"), "name: Safe\nsteps: []\n").unwrap();
    let mut first = Git(MockRunner::new());
    script_comment_and_label(&mut first.0);
    first
        .0
        .expect_run("gh pr comment", CmdOutput::failed(1, "offline"));
    assert_eq!(
        publish(
            &mut first,
            &runs,
            RUN,
            &verdict,
            &MachineIdentity::default()
        )
        .result,
        ReceiptResult::Failed
    );
    assert!(publication(&dir).blocks_comment_attempted);
    assert!(std::fs::read_to_string(dir.join("blocks-comment.md"))
        .unwrap()
        .contains("qa-fixture-user"));
    let posted_walk = std::fs::read(dir.join("comment.md")).unwrap();
    let mut second = Uploads {
        runner: Git(MockRunner::new()),
        bodies: Vec::new(),
    };
    second
        .runner
        .0
        .expect_run("gh pr view 12", CmdOutput::success(r#"{"comments":[]}"#));
    second.runner.0.expect_run(
        "gh pr comment",
        CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2"),
    );
    let receipt = publish(&mut second, &runs, RUN, &verdict, &fixture_machine());
    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(second.runner.0.remaining(), 0);
    assert_eq!(second.bodies.len(), 1);
    let (file, body) = &second.bodies[0];
    assert_eq!(file, "blocks-comment.md");
    assert!(body.starts_with(&format!("<!-- qaren-run: {RUN} blocks -->")));
    assert!(body.contains("name: Safe\nsteps: []"));
    assert!(!body.contains("tasks.yaml"));
    assert!(!body.contains("qa-fixture-user"));
    assert_eq!(std::fs::read(dir.join("comment.md")).unwrap(), posted_walk);
    assert!(receipt.outcomes["writeback"].contains("withheld tasks"));

    let mut again = Git(MockRunner::new());
    assert_eq!(
        publish(&mut again, &runs, RUN, &verdict, &fixture_machine()).result,
        ReceiptResult::Published
    );
    assert!(again.0.calls.is_empty());
}

// The exact shape Phase 4's serializer writes for an eligible walk (qaren-core blocks.test.ts golden).
fn producer_block(plan_hash: &str) -> String {
    [
        "appId: com.example.app",
        "---",
        "# id: onboarding-to-the-tasks-tab",
        "# intent: Onboarding to the tasks tab",
        "# status: active",
        "# appId: com.example.app",
        "# plan: onboarding-to-the-tasks-tab",
        &format!("# planHash: {plan_hash}"),
        "# platform: ios",
        "",
        "# 1. Tap \"onboarding-skip\"",
        "- tapOn: { id: \"onboarding-skip\" }",
        "# 2. Tap \"onboarding-done\"",
        "- tapOn: { id: \"onboarding-done\" }",
        "# 3. Wait for \"Welcome\" to appear",
        "- extendedWaitUntil: { visible: { text: \"Welcome\" }, timeout: 15000 }",
        "# ✓ \"Welcome\"",
        "- assertVisible: { text: \"Welcome\" }",
        "# 4. Tap \"tab-tasks\"",
        "- tapOn: { id: \"tab-tasks\" }",
        "",
    ]
    .join("\n")
}

#[test]
fn a_block_in_the_producers_format_from_an_eligible_walk_is_committed_byte_identical() {
    let (runs, dir, verdict) = run_dir(false);
    let slug = "onboarding-to-the-tasks-tab";
    let source = producer_block(&"3f".repeat(32));
    std::fs::write(dir.join(format!("blocks/{slug}.yaml")), &source).unwrap();
    edit_pr(&dir, |pr| {
        pr["blocks"] = serde_json::json!([slug]);
        pr["identityValues"] = serde_json::json!([
            "qaren-check",
            "1DC408C4-51DA-4C4F-ACA1-39881C916FDD",
            "8081"
        ]);
    });
    let mut runner = Staged(Git(MockRunner::new()), Vec::new());
    script_comment_and_label(&mut runner.0 .0);
    let mock = &mut runner.0 .0;
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
        &format!("git add -f -- test-app/.qaren/actions/{slug}.yaml"),
        CmdOutput::success(""),
    );
    mock.expect_run(
        &format!("git commit -m qaren: save block {slug}"),
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
    mock.expect_run("git push origin", CmdOutput::success(""));

    let receipt = publish(&mut runner, &runs, RUN, &verdict, &fixture_machine());

    assert_eq!(
        receipt.result,
        ReceiptResult::Published,
        "{:?}",
        receipt.failure
    );
    assert_eq!(runner.1, [source]);
    assert_eq!(receipt.outcomes["writeback"], format!("committed {COMMIT}"));
}

#[test]
fn patched_blocks_keep_their_extension_through_preservation_and_publication() {
    struct ExistingBlock {
        git: Git,
        extension: &'static str,
        bytes: Vec<u8>,
        written: bool,
    }
    impl Runner for ExistingBlock {
        fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
            if spec.label == "git-worktree-add" {
                let actions = Path::new(&spec.args[3]).join("test-app/.qaren/actions");
                std::fs::create_dir_all(&actions).unwrap();
                std::fs::write(
                    actions.join(format!("tasks.{}", self.extension)),
                    "old block",
                )
                .unwrap();
            }
            if spec.label == "git-add-blocks" {
                let actions = spec.cwd.as_ref().unwrap().join("test-app/.qaren/actions");
                assert_eq!(
                    std::fs::read(actions.join(format!("tasks.{}", self.extension))).unwrap(),
                    self.bytes
                );
                let other = if self.extension == "yml" {
                    "yaml"
                } else {
                    "yml"
                };
                assert!(!actions.join(format!("tasks.{other}")).exists());
                self.written = true;
            }
            self.git.run(spec)
        }
        fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
            self.git.spawn_group(spec, log)
        }
        fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
            self.git.spawn_piped(spec, log)
        }
        fn sleep(&mut self, d: std::time::Duration) {
            self.git.sleep(d)
        }
        fn now_epoch_ms(&self) -> u64 {
            self.git.now_epoch_ms()
        }
        fn commands_executed(&self) -> u64 {
            self.git.commands_executed()
        }
    }
    for extension in ["yml", "yaml"] {
        for fallback in [false, true] {
            let (runs, dir, verdict) = run_dir(fallback);
            let app = runs.parent().unwrap().join("patched-app");
            let actions = app.join(".qaren/actions");
            std::fs::create_dir_all(&actions).unwrap();
            let bytes = b"# patched block\r\nsteps: []\r\n\n";
            std::fs::write(actions.join(format!("tasks.{extension}")), bytes).unwrap();
            std::fs::remove_file(dir.join("blocks/tasks.yaml")).unwrap();
            let (copied, refused) =
                qaren::worktree::copy_blocks(&app, &["tasks".into()], &dir.join("blocks"));
            assert_eq!(copied, ["tasks"]);
            assert!(refused.is_empty());
            assert_eq!(
                std::fs::read(dir.join(format!("blocks/tasks.{extension}"))).unwrap(),
                bytes
            );
            let mut runner = ExistingBlock {
                git: Git(MockRunner::new()),
                extension,
                bytes: bytes.to_vec(),
                written: false,
            };
            script_comment_and_label(&mut runner.git.0);
            if fallback {
                runner.git.0.expect_run(
                    "gh pr comment 12",
                    CmdOutput::success("https://github.com/o/r/pull/12#issuecomment-2\n"),
                );
            } else {
                script_commit_extension(&mut runner.git.0, extension);
                runner
                    .git
                    .0
                    .expect_run("git push origin", CmdOutput::success(""));
            }
            let receipt = publish(&mut runner, &runs, RUN, &verdict, &machine());
            assert_eq!(
                receipt.result,
                ReceiptResult::Published,
                "{:?}",
                receipt.failure
            );
            assert_eq!(runner.git.0.remaining(), 0);
            if fallback {
                let comment = std::fs::read_to_string(dir.join("blocks-comment.md")).unwrap();
                assert!(comment.contains(&format!("` test-app/.qaren/actions/tasks.{extension} `")));
                assert!(comment.contains("# patched block\r\nsteps: []"));
                assert!(!runner.written);
            } else {
                assert!(runner.written);
                assert_eq!(
                    publication(&dir).writeback.as_deref(),
                    Some(format!("committed {COMMIT}").as_str())
                );
            }
        }
    }
}
