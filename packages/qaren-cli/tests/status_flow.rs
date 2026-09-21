mod common;

use rn_qa::commands::status::status;
use rn_qa::exec::Spawned;
use rn_qa::exec::{CmdOutput, MockRunner};
use rn_qa::failure::FailureCode;
use rn_qa::receipt::ReceiptResult;
use rn_qa::runrecord::{
    FarmResource, IosSimResource, MetroResource, Phase, RunRecord, TunnelResource,
};

const LSTART: &str = "Wed Aug 12 16:01:00 2026";

fn ios_ready_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record =
        common::base_record(repo, &common::ios_scenario_yaml(8791), run_id, Phase::Ready);
    record.resources.ios_simulator = Some(IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: format!("rn-qa-{run_id}"),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    record.resources.metro = Some(MetroResource {
        port: 8791,
        endpoint: "http://127.0.0.1:8791".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record
}

#[test]
fn ready_run_with_all_probes_passing_reports_ready() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run1").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"rn-qa-run1","state":"Booted"}]}}"#,
        ),
    );
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/path/to/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );

    let receipt = status(&mut mock, &repo, "run1");
    assert_eq!(receipt.result, ReceiptResult::Ready);
    assert_eq!(receipt.outcomes.get("metro_responding").unwrap(), "pass");
    assert_eq!(receipt.outcomes.get("app_running").unwrap(), "pass");
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn ready_run_with_dead_metro_reports_failed() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run2").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"rn-qa-run2","state":"Booted"}]}}"#,
        ),
    );
    mock.expect_run("simctl get_app_container", CmdOutput::success("/path\n"));
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );

    let receipt = status(&mut mock, &repo, "run2");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("metro_port_owned").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("metro_responding").unwrap(),
        "inconclusive"
    );
    assert_eq!(receipt.outcomes.get("app_running").unwrap(), "pass");
    assert!(receipt.next_action.contains("cleanup"));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn foreign_simulator_gates_app_probes_and_reports_failed() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run3").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"foreign-sim","state":"Booted"}]}}"#,
        ),
    );

    let receipt = status(&mut mock, &repo, "run3");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("simulator_booted").unwrap(), "fail");
    assert_eq!(receipt.outcomes.get("app_probes").unwrap(), "inconclusive");
    assert_eq!(
        mock.remaining(),
        0,
        "app probes must not run against a foreign simulator"
    );
}

#[test]
fn cleaned_run_reports_cleaned_without_probes() {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run4",
        Phase::Cleaned,
    )
    .save(&repo)
    .unwrap();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "run4");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(mock.calls.is_empty());
}

#[test]
fn failed_run_echoes_recorded_failure() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run5",
        Phase::Failed,
    );
    record.failure = Some(rn_qa::failure::Failure::new(
        "build",
        FailureCode::BuildFailed,
        "xcodebuild exploded",
        "rn-qa cleanup run5 --json",
    ));
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "run5");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::BuildFailed
    );
}

#[test]
fn interrupted_prepare_is_failed_with_interrupted_code() {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run6",
        Phase::Building,
    )
    .save(&repo)
    .unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::failed(1, "")); // prepare pid dead
    let receipt = status(&mut mock, &repo, "run6");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::Interrupted
    );
}

#[test]
fn live_prepare_reports_working() {
    let repo = common::temp_repo();
    common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run7",
        Phase::Building,
    )
    .save(&repo)
    .unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    let receipt = status(&mut mock, &repo, "run7");
    assert_eq!(receipt.result, ReceiptResult::Working);
}

#[test]
fn android_unreachable_farm_reports_unknown() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "run8",
        Phase::Ready,
    );
    record.resources.metro = Some(MetroResource {
        port: 8792,
        endpoint: "http://127.0.0.1:8792".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "rn-qa-run8".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: Some(common::identity(7000, LSTART)),
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.adb_local_serial = Some("127.0.0.1:5555".to_string());
    record.resources.adb_path = Some(repo.join("adb"));
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run("ssh", CmdOutput::failed(255, "ssh: timed out"));

    let receipt = status(&mut mock, &repo, "run8");
    assert_eq!(receipt.result, ReceiptResult::Unknown);
    assert_eq!(
        receipt.outcomes.get("farm_lease_held").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "adb must not be addressed when the lease is unproven"
    );
}

fn android_ready_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::android_scenario_yaml(8792),
        run_id,
        Phase::Ready,
    );
    record.resources.metro = Some(MetroResource {
        port: 8792,
        endpoint: "http://127.0.0.1:8792".to_string(),
        spawned: Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, LSTART)),
        log: repo.join("build.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: format!("rn-qa-{run_id}"),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: Some(common::identity(7000, LSTART)),
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.adb_local_serial = Some("127.0.0.1:5555".to_string());
    record.resources.adb_path = Some(repo.join("adb"));
    record.resources.adb_server = Some(rn_qa::runrecord::AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: Some(common::identity(7100, LSTART)),
        server_port: 15037,
        log: repo.join("adb-server.log"),
    });
    record.resources.adb_vendor_key = Some(repo.join("nuc-adbkey"));
    record
}

#[test]
fn android_ready_run_with_all_probes_passing_reports_ready() {
    let repo = common::temp_repo();
    android_ready_record(&repo, "run9").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=rn-qa-run9 claimed_at=x state=device\n"),
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // tunnel identity
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // adb server identity
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie

    mock.expect_run(
        "-s 127.0.0.1:5555 get-state",
        CmdOutput::success("device\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pidof",
        CmdOutput::success("12345\n"),
    );

    let receipt = status(&mut mock, &repo, "run9");
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "outcomes: {:?}",
        receipt.outcomes
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_dead_tunnel_gates_adb_probes() {
    let repo = common::temp_repo();
    android_ready_record(&repo, "run10").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=rn-qa-run10 claimed_at=x state=device\n"),
    );
    mock.expect_run("ps", CmdOutput::failed(1, "")); // tunnel dead

    let receipt = status(&mut mock, &repo, "run10");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("tunnel_alive").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "no adb command may run over a dead tunnel"
    );
}

#[test]
fn probe_infrastructure_errors_report_unknown_not_failed() {
    let repo = common::temp_repo();
    ios_ready_record(&repo, "run11").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // lsof spawn failure -> exit_code None -> port probe inconclusive
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: None,
            stderr: "spawn lsof: not found".to_string(),
            ..Default::default()
        },
    );
    mock.expect_run(
        "simctl list",
        CmdOutput::success(
            r#"{"devices":{"rt":[{"udid":"AAAA-1111","name":"rn-qa-run11","state":"Booted"}]}}"#,
        ),
    );
    mock.expect_run("simctl get_app_container", CmdOutput::success("/path\n"));
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );

    let receipt = status(&mut mock, &repo, "run11");
    assert_eq!(receipt.result, ReceiptResult::Unknown);
    assert_eq!(
        receipt.outcomes.get("metro_port_owned").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        receipt.outcomes.get("metro_responding").unwrap(),
        "inconclusive"
    );
    assert_eq!(receipt.outcomes.get("app_running").unwrap(), "pass");
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn android_serial_port_mismatch_blocks_adb_probes() {
    let repo = common::temp_repo();
    let mut record = android_ready_record(&repo, "run12");
    // Record drift: farm says 5557 but the serial/tunnel still say 5555.
    record.resources.farm.as_mut().unwrap().adb_port = 5557;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5557 lease=rn-qa-run12 claimed_at=x state=device\n"),
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // tunnel identity
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie

    let receipt = status(&mut mock, &repo, "run12");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("adb_serial_recorded").unwrap(), "fail");
    assert_eq!(
        mock.remaining(),
        0,
        "no adb command may run on record drift"
    );
}

#[test]
fn farm_identity_drift_fails_lease_probe_despite_matching_holder() {
    let repo = common::temp_repo();
    android_ready_record(&repo, "run13").save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("5000\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    // Holder matches, but the slot was restarted with a different emulator:
    // serial and AVD drifted. The old tunnel may now reach a different device.
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10_Pro serial=emulator-5556 adb_port=5555 lease=rn-qa-run13 claimed_at=x state=device\n"),
    );

    let receipt = status(&mut mock, &repo, "run13");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(receipt.outcomes.get("farm_lease_held").unwrap(), "fail");
    assert_eq!(
        receipt.outcomes.get("device_probes").unwrap(),
        "inconclusive"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "device probes must not run through a drifted slot"
    );
}

#[test]
fn failed_run_preserves_recorded_next_action() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "run14",
        Phase::Failed,
    );
    // A pre-allocation failure records a fix-and-retry action; nothing is
    // owned, so status must not redirect automation to cleanup.
    record.failure = Some(rn_qa::failure::Failure::new(
        "deps",
        FailureCode::DepsInstallFailed,
        "pnpm install --frozen-lockfile: exit=1",
        "fix the dependency install in the candidate project, then re-run prepare",
    ));
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "run14");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.next_action,
        "fix the dependency install in the candidate project, then re-run prepare"
    );
}

#[test]
fn status_of_missing_run_is_unknown() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let receipt = status(&mut mock, &repo, "ghost");
    assert_eq!(receipt.result, ReceiptResult::Unknown);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUnavailable
    );
}
