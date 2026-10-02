mod common;

use qaren::commands::cleanup::Outcome;
use qaren::exec::{CmdOutput, MockRunner, Spawned};
use qaren::record::{self, Target, VideoStatus};
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

    record::start(&mut mock, &mut record, &root, &Target::Ios { udid: "U" }).unwrap();

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

    let status =
        record::start(&mut mock, &mut record, &root, &Target::Ios { udid: "U" }).unwrap_err();

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
            command: "xcrun".into(),
        }),
        kind: RecorderKind::IosSimulator,
        device: "U".into(),
        output: PathBuf::from("raw.mov"),
        device_path: None,
        adb: None,
    });
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("/bin/kill -INT 7100", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("Z\n"));

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
        device_path: None,
        adb: None,
    });
    let outcome = record::stop(&mut MockRunner::new(), &mut record, &root);
    assert!(matches!(outcome, Outcome::Unresolved(_)));
    assert!(record.resources.recorder.is_some());
}
