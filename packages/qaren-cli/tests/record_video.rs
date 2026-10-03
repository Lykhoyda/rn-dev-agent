mod common;

use qaren::commands::cleanup::Outcome;
use qaren::exec::{CmdOutput, MockRunner, Spawned};
use qaren::record::{self, VideoStatus};
use qaren::runrecord::{Phase, PidIdentity, RecorderKind, RecorderResource, RunRecord};
use std::path::PathBuf;

const LSTART: &str = "Wed Aug 12 16:01:00 2026";

fn walking_record() -> (PathBuf, RunRecord) {
    let repo = common::temp_repo();
    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "check-20260812T160000Z",
        Phase::Walking,
    );
    std::fs::create_dir_all(RunRecord::run_dir(&repo, &record.run_id).join("logs")).unwrap();
    record.save(&repo).unwrap();
    (repo, record)
}

fn script_identity(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("xcrun simctl io\n"));
}

#[test]
fn ios_start_persists_the_resource_and_waits_for_recording_started() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "simctl io U recordVideo --codec h264 --force",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "Recording started\n",
    );
    script_identity(&mut mock);

    record::start(&mut mock, &mut record, &root, "U").unwrap();

    let recorder = RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .unwrap();
    assert_eq!(recorder.pid, Some(7100));
    assert_eq!(recorder.kind, RecorderKind::IosSimulator);
    assert!(recorder.output.ends_with("media/raw.mov"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ios_start_without_recording_started_is_unavailable_and_the_run_continues() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "booting\n",
    );
    script_identity(&mut mock);
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    let status = record::start(&mut mock, &mut record, &root, "U").unwrap_err();

    assert!(
        matches!(&status, VideoStatus::Unavailable(r) if r.contains("did not start")),
        "{status}"
    );
    assert!(record.resources.recorder.is_none());
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn stop_sends_sigint_and_waits_for_exit() {
    let (root, mut record) = walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: Some(7100),
        birth: Some(PidIdentity {
            pid: 7100,
            started_at: LSTART.into(),
            command: qaren::redact::OutputText::from_output("xcrun"),
        }),
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
    });
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("Z\n"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));

    assert_eq!(
        record::stop(&mut mock, &mut record, &root),
        Outcome::Removed
    );

    assert!(record.resources.recorder.is_none());
    assert_eq!(mock.remaining(), 0);
    let kill = mock
        .calls
        .iter()
        .find(|c| c.label == "recorder-interrupt")
        .unwrap();
    assert_eq!(kill.args, ["-INT", "7100"]);
}

#[test]
fn a_recorder_with_an_unproven_spawn_is_unresolved() {
    let (root, mut record) = walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: None,
        birth: None,
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
    });
    let outcome = record::stop(&mut MockRunner::new(), &mut record, &root);
    assert!(matches!(outcome, Outcome::Unresolved(_)));
    assert!(record.resources.recorder.is_some());
}

// Deletes the worktree directory when git is asked to remove it, as git would.
struct GitRemoves(MockRunner, Option<PathBuf>);

impl qaren::exec::Runner for GitRemoves {
    fn run(&mut self, spec: &qaren::exec::CmdSpec) -> CmdOutput {
        if spec.args.starts_with(&["worktree".into(), "remove".into()]) {
            let _ = std::fs::remove_dir_all(spec.args.last().unwrap());
        }
        if let Some(path) = &self.1 {
            if spec.label == "ps-command" {
                std::fs::rename(path, path.with_extension("backup")).unwrap();
                std::fs::create_dir(path).unwrap();
            } else if spec.label == "recorder-abort" {
                std::fs::remove_dir(path).unwrap();
                std::fs::rename(path.with_extension("backup"), path).unwrap();
            }
        }
        self.0.run(spec)
    }
    fn spawn_group(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<Spawned> {
        self.0.spawn_group(spec, log)
    }
    fn spawn_piped(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
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

fn pr_run_record() -> (PathBuf, RunRecord, PathBuf) {
    let (root, mut record) = walking_record();
    record.resources.recorder = Some(RecorderResource {
        pid: Some(7100),
        birth: Some(PidIdentity {
            pid: 7100,
            started_at: LSTART.into(),
            command: qaren::redact::OutputText::from_output("xcrun"),
        }),
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
    });
    let wt = qaren::worktree::pr_worktree_path(&RunRecord::run_dir(&root, &record.run_id));
    std::fs::create_dir_all(&wt).unwrap();
    record.resources.pr_worktree = Some(qaren::runrecord::PrWorktreeResource {
        repo_root: root.clone(),
        path: wt.clone(),
    });
    record.save(&root).unwrap();
    (root, record, wt)
}

#[test]
fn a_dead_owners_recorder_is_stopped_and_its_worktree_removed() {
    let (root, record, wt) = pr_run_record();
    let mut mock = MockRunner::new();
    mock.expect_run("ps -p 999", CmdOutput::failed(1, "")); // owner gone
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    mock.expect_run("worktree remove --force", CmdOutput::success(""));
    let mut runner = GitRemoves(mock, None);

    let receipt = qaren::commands::cleanup::cleanup(&mut runner, &root, &record.run_id);

    assert_eq!(receipt.cleanup["recorder"], "removed");
    assert_eq!(receipt.cleanup["pr_worktree"], "removed");
    assert!(!wt.exists());
    let saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(saved.resources.recorder.is_none());
    assert!(saved.resources.pr_worktree.is_none());
    assert_eq!(runner.0.remaining(), 0);
}

#[test]
fn a_live_owners_recorder_and_worktree_are_untouched() {
    let (root, record, wt) = pr_run_record();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "ps -p 999",
        CmdOutput::success("Wed Aug 12 15:00:00 2026\n"),
    );
    mock.expect_run("ps -p 999", CmdOutput::success("S\n"));

    let receipt = qaren::commands::cleanup::cleanup(&mut mock, &root, &record.run_id);

    assert!(receipt.cleanup["recorder"].starts_with("refused"));
    assert!(receipt.cleanup["pr_worktree"].starts_with("refused"));
    assert!(wt.exists());
    let saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(saved.resources.recorder.is_some());
    assert!(saved.resources.pr_worktree.is_some());
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn failed_or_timed_out_abort_retains_ownership_until_group_absence() {
    for abort in [
        CmdOutput::failed(1, "signal failed"),
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
    ] {
        let (root, mut record) = walking_record();
        let mut mock = MockRunner::new();
        mock.expect_spawn_with_log(
            "recordVideo",
            Spawned {
                pid: 7100,
                pgid: 7100,
            },
            "",
        );
        mock.expect_run("ps", CmdOutput::failed(1, "identity unavailable"));
        mock.expect_run("ps", CmdOutput::failed(1, "identity unavailable"));
        mock.expect_run("/bin/kill -KILL -- -7100", abort);
        mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
        mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
        assert!(record::start(&mut mock, &mut record, &root, "U").is_err());
        let mut saved = RunRecord::load(&root, &record.run_id).unwrap();
        assert_eq!(saved.resources.recorder.as_ref().unwrap().pid, Some(7100));
        mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
        mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
        assert!(matches!(
            record::stop(&mut mock, &mut saved, &root),
            Outcome::Unresolved(_)
        ));
        assert!(saved.resources.recorder.is_some());
        mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        assert_eq!(record::stop(&mut mock, &mut saved, &root), Outcome::Removed);
        assert!(RunRecord::load(&root, &record.run_id)
            .unwrap()
            .resources
            .recorder
            .is_none());
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn failed_persistence_and_abort_keep_the_proven_recorder_for_teardown() {
    let (root, mut record) = walking_record();
    let mut mock = MockRunner::new();
    mock.expect_spawn_with_log(
        "recordVideo",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
        "",
    );
    script_identity(&mut mock);
    mock.expect_run(
        "/bin/kill -KILL -- -7100",
        CmdOutput::failed(1, "signal failed"),
    );
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -TERM", CmdOutput::failed(1, "signal failed"));
    mock.expect_run("/bin/kill -KILL", CmdOutput::failed(1, "signal failed"));
    mock.expect_run("ps -A", CmdOutput::success("7100 7100 S\n"));
    let mut runner = GitRemoves(mock, Some(RunRecord::path(&root, &record.run_id)));
    assert!(record::start(&mut runner, &mut record, &root, "U").is_err());
    let mut saved = RunRecord::load(&root, &record.run_id).unwrap();
    assert!(saved.resources.recorder.as_ref().unwrap().birth.is_some());
    runner
        .0
        .expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    runner.0.expect_run("ps", CmdOutput::success("S\n"));
    runner
        .0
        .expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    runner.0.expect_run("ps", CmdOutput::failed(1, ""));
    runner.0.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    assert_eq!(
        record::stop(&mut runner, &mut saved, &root),
        Outcome::Removed
    );
    assert!(RunRecord::load(&root, &record.run_id)
        .unwrap()
        .resources
        .recorder
        .is_none());
    assert_eq!(runner.0.remaining(), 0);
}
