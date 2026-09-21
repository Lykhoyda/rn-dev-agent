mod common;

use rn_qa::commands::prepare::{prepare, PrepareArgs};
use rn_qa::exec::{CmdOutput, MockRunner, Spawned};
use rn_qa::failure::FailureCode;
use rn_qa::receipt::ReceiptResult;
use rn_qa::runrecord::{Phase, RunRecord};

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";
const LSTART: &str = "Wed Aug 12 16:01:00 2026";

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn write_scenario(repo: &std::path::Path, yaml: &str) -> std::path::PathBuf {
    let path = repo.join("scenario.yaml");
    std::fs::write(&path, yaml).unwrap();
    path
}

fn prepare_args(
    scenario_path: &std::path::Path,
    dry_run: bool,
    android_home: Option<String>,
) -> PrepareArgs {
    PrepareArgs {
        scenario_path: scenario_path.to_path_buf(),
        dry_run,
        android_home,
        // Per-test lock root keeps parallel tests from contending on the
        // shared build-serialization lock name.
        lock_root: scenario_path.parent().unwrap().join(".locks"),
    }
}

fn script_validation(mock: &mut MockRunner, repo: &std::path::Path, tools: &[&str]) {
    script_validation_porcelain(mock, repo, tools, "");
}

fn script_validation_porcelain(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    tools: &[&str],
    porcelain: &str,
) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(porcelain));
    for tool in tools {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
}

const IOS_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];
const ANDROID_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "ssh", "java"];

#[test]
fn ios_prepare_happy_path_produces_ready_receipt_and_record() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n")); // self lstart
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n")); // self command
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_spawn(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // metro lstart
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n")); // metro command
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // liveness probe
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n")); // port owner pgid
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    // Provenance recheck immediately before ready: unchanged sha, still clean.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));

    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(receipt.run_id.starts_with("ios-simulator-"));
    let device = receipt.device.unwrap();
    assert_eq!(device.ios_udid.as_deref(), Some(UDID));
    assert_eq!(
        device.ios_name.as_deref(),
        Some(format!("rn-qa-{}", receipt.run_id).as_str())
    );
    let metro = receipt.metro.unwrap();
    assert_eq!(metro.port, 8791);
    assert_eq!(metro.endpoint, "http://127.0.0.1:8791");
    assert_eq!(metro.pid, Some(6000));
    let candidate = receipt.candidate.unwrap();
    assert_eq!(candidate.git_sha, "b".repeat(40));
    assert!(!candidate.git_dirty);
    assert!(candidate.lockfile_sha256.is_some());
    assert!(receipt.timings_ms.contains_key("total"));
    assert_eq!(receipt.commands_executed, mock.calls.len() as u64);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Ready);
    let sim = record.resources.ios_simulator.as_ref().unwrap();
    assert_eq!(sim.udid, UDID);
    assert_eq!(sim.name, format!("rn-qa-{}", receipt.run_id));
    let metro = record.resources.metro.as_ref().unwrap();
    assert_eq!(metro.spawned.pgid, 6000);
    assert_eq!(metro.identity.as_ref().unwrap().started_at, LSTART);

    // The create call must carry the run-scoped name and the build must pin
    // the exact simulator and port as adjacent option pairs.
    let create = mock
        .calls
        .iter()
        .find(|c| c.label == "simctl-create")
        .unwrap();
    assert_eq!(create.args[2], format!("rn-qa-{}", receipt.run_id));
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-ios")
        .unwrap();
    let device_pos = build.args.iter().position(|a| a == "--device").unwrap();
    assert_eq!(build.args[device_pos + 1], UDID);
    let port_pos = build.args.iter().position(|a| a == "--port").unwrap();
    assert_eq!(build.args[port_pos + 1], "8791");
}

#[test]
fn android_prepare_happy_path_leases_tunnels_and_pins_serial() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success(
            "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n",
        ),
    );
    // farm adb port preflight on this host
    mock.expect_run("lsof", free_port());
    // MockRunner's clock is fixed until the first sleep, so the run id (and
    // therefore the echoed lease holder) is deterministic.
    let expected_holder = format!(
        "rn-qa-nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n")); // listener pgid == tunnel pgid
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run(
        "ps",
        CmdOutput::success("adb -L tcp:127.0.0.1:15037 nodaemon server\n"),
    );
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n")); // listener pgid == server pgid
    mock.expect_run(
        "connect 127.0.0.1:5555",
        CmdOutput::success("connected to 127.0.0.1:5555\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 get-state",
        CmdOutput::success("device\n"),
    );
    mock.expect_spawn(
        "expo run:android",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:android\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pidof",
        CmdOutput::success("12345\n"),
    );
    // Provenance recheck immediately before ready: unchanged sha, still clean.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let device = receipt.device.unwrap();
    assert_eq!(device.farm_slot, Some(1));
    assert_eq!(
        device.farm_lease_holder.as_deref(),
        Some(format!("rn-qa-{}", receipt.run_id).as_str())
    );
    assert_eq!(device.remote_serial.as_deref(), Some("emulator-5554"));
    assert_eq!(device.local_adb_serial.as_deref(), Some("127.0.0.1:5555"));
    assert_eq!(device.tunnel_local_port, Some(5555));

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Ready);
    assert_eq!(
        record.resources.farm.as_ref().unwrap().holder,
        format!("rn-qa-{}", receipt.run_id)
    );
    assert!(record
        .resources
        .adb_path
        .as_ref()
        .unwrap()
        .ends_with("platform-tools/adb"));
    let server = record.resources.adb_server.as_ref().unwrap();
    assert_eq!(server.server_port, 15037);
    assert!(
        record.resources.app_install.is_none(),
        "no hashed artifact means no install provenance can be claimed"
    );
    let vendor_key = record.resources.adb_vendor_key.as_ref().unwrap();
    assert!(vendor_key.ends_with("nuc-adbkey"));
    let key_meta = std::fs::metadata(vendor_key).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        key_meta.permissions().mode() & 0o777,
        0o600,
        "vendor key must be private"
    );

    // Every adb invocation must either name the loopback endpoint positionally
    // (connect/disconnect) or pin it with -s; the build must carry ANDROID_SERIAL.
    let start = mock.calls.iter().find(|c| c.label == "farm-start").unwrap();
    assert_eq!(
        start.args.last().unwrap(),
        &expected_holder,
        "farm start must claim our holder"
    );
    for call in mock.calls.iter().filter(|c| {
        (c.program.ends_with("/adb") || c.program == "adb") && c.label != "adb-private-server"
    }) {
        let pinned = (call.args.first().map(|a| a == "-s").unwrap_or(false)
            && call
                .args
                .get(1)
                .map(|a| a == "127.0.0.1:5555")
                .unwrap_or(false))
            || (matches!(
                call.args.first().map(String::as_str),
                Some("connect") | Some("disconnect")
            ) && call
                .args
                .get(1)
                .map(|a| a == "127.0.0.1:5555")
                .unwrap_or(false));
        assert!(pinned, "unpinned adb call: {}", call.rendered());
    }
    let build = mock
        .calls
        .iter()
        .find(|c| c.label == "expo-run-android")
        .unwrap();
    assert!(build
        .env
        .contains(&("ANDROID_SERIAL".to_string(), "127.0.0.1:5555".to_string())));
    assert!(
        build.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:15037".to_string()
        )),
        "the build must route adb through the run-owned server"
    );
    assert!(build.args.contains(&"8792".to_string()));
}

#[test]
fn occupied_metro_port_fails_before_any_allocation() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", CmdOutput::success("4321\n"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::MetroPortOccupied
    );
    assert_eq!(receipt.run_id, "none", "no run may exist before allocation");
    assert!(!repo.join(".rn-qa").exists());
}

#[test]
fn android_prepare_refuses_leased_slot_and_records_failure() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success("slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=other-holder state=device\n"),
    );

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::FarmSlotLeased
    );
    assert_eq!(
        mock.remaining(),
        0,
        "farm start must never run against a leased slot"
    );

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_none(),
        "no lease was claimed, none may be recorded"
    );
}

#[test]
fn android_prepare_refuses_unleased_but_running_emulator() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success(
            "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=device\n",
        ),
    );

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::FarmSlotLeased
    );
    assert_eq!(mock.remaining(), 0);
}

fn android_sdk(repo: &std::path::Path) -> std::path::PathBuf {
    let sdk = repo.join("fake-sdk");
    std::fs::create_dir_all(sdk.join("platform-tools")).unwrap();
    std::fs::write(sdk.join("platform-tools").join("adb"), "").unwrap();
    sdk
}

fn script_android_through_farm_status(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    slot_line: &str,
) {
    script_validation(mock, repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port()); // metro port
    mock.expect_run("lsof", free_port()); // adb server port
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(slot_line));
}

const FREE_SLOT_LINE: &str =
    "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n";

#[test]
fn android_prepare_fails_when_farm_adb_port_is_occupied_locally() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    // Preflight of the farm-advertised adb port on this host: occupied.
    mock.expect_run("lsof", CmdOutput::success("4321\n"));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::TunnelFailed
    );
    assert!(
        !mock.calls.iter().any(|c| c.label == "farm-start"),
        "no lease may be claimed while the local tunnel port is occupied"
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_none(),
        "no lease was claimed, none may be recorded"
    );
}

#[test]
fn android_prepare_refuses_foreign_listener_on_tunnel_port() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight: free
    let expected_holder = format!(
        "rn-qa-nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    // The port is listening, but its owner belongs to a foreign process group.
    mock.expect_run("lsof", CmdOutput::success("9999\n"));
    mock.expect_run("ps", CmdOutput::success("4242\n"));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::TunnelFailed);
    assert!(
        failure.next_action.contains("cleanup"),
        "owned resources exist, so cleanup must be the next action"
    );
    assert!(
        !mock
            .calls
            .iter()
            .any(|c| c.label == "fetch-adbkey" || c.label == "adb-connect"),
        "a foreign listener must stop the run before any adb activity"
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_some() && record.resources.tunnel.is_some(),
        "the claimed lease and spawned tunnel must stay recorded for cleanup"
    );
}

#[test]
fn android_prepare_refuses_foreign_listener_on_adb_server_port() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight: free
    let expected_holder = format!(
        "rn-qa-nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n")); // tunnel listener is ours
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run(
        "ps",
        CmdOutput::success("adb -L tcp:127.0.0.1:15037 nodaemon server\n"),
    );
    // A foreign process owns the private adb server port.
    mock.expect_run("lsof", CmdOutput::success("8888\n"));
    mock.expect_run("ps", CmdOutput::success("4242\n"));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::AdbServerFailed);
    assert!(
        failure.next_action.contains("cleanup"),
        "owned resources exist, so cleanup must be the next action"
    );
    assert!(
        !mock.calls.iter().any(|c| c.label == "adb-connect"),
        "adb connect must never run against an unproven server"
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.farm.is_some()
            && record.resources.tunnel.is_some()
            && record.resources.adb_server.is_some(),
        "the lease, tunnel, and spawned adb server must stay recorded for cleanup"
    );
}

#[test]
fn android_prepare_fails_fast_when_the_tunnel_dies_before_listening() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight: free
    let expected_holder = format!(
        "rn-qa-nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", free_port()); // nothing listening yet
    mock.expect_run("ps", CmdOutput::failed(1, "")); // ...because the tunnel already exited

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::TunnelFailed);
    assert!(
        failure
            .detail
            .contains("exited before the port started listening"),
        "a dead tunnel must be reported as such, not as a deadline: {}",
        failure.detail
    );
    assert!(
        !failure.evidence.is_empty(),
        "the tunnel log tail must be attached as evidence"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "the wait must end on the first poll, not burn the full deadline"
    );
}

#[test]
fn vendor_key_is_recorded_before_the_adb_server_spawns() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port());
    let expected_holder = format!(
        "rn-qa-nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn_failure("server nodaemon", "fork failed");

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::AdbServerFailed
    );

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert!(
        record.resources.adb_server.is_none(),
        "the server never spawned"
    );
    let vendor_key = record
        .resources
        .adb_vendor_key
        .as_ref()
        .expect("the fetched key must be recorded independently of the server");
    assert!(vendor_key.exists(), "the key was written to the run dir");
}

// Delegating runner that snapshots the durable run record at the moment a
// labelled command fires, so persist-before-external-operation ordering is
// provable rather than assumed.
struct RecordProbeRunner {
    inner: MockRunner,
    repo: std::path::PathBuf,
    run_id: String,
    probe_label: String,
    observed: Option<String>,
}

impl rn_qa::exec::Runner for RecordProbeRunner {
    fn run(&mut self, spec: &rn_qa::exec::CmdSpec) -> CmdOutput {
        if spec.label == self.probe_label {
            self.observed = std::fs::read_to_string(RunRecord::path(&self.repo, &self.run_id)).ok();
        }
        self.inner.run(spec)
    }
    fn spawn_group(
        &mut self,
        spec: &rn_qa::exec::CmdSpec,
        log_path: &std::path::Path,
    ) -> std::io::Result<Spawned> {
        self.inner.spawn_group(spec, log_path)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.inner.sleep(duration)
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
}

#[test]
fn prepare_refuses_preexisting_run_dir_without_clobbering() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));
    // MockRunner's clock is frozen, so the run id is deterministic.
    let run_id = format!(
        "ios-simulator-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    let run_dir = RunRecord::run_dir(&repo, &run_id);
    std::fs::create_dir_all(&run_dir).unwrap();
    std::fs::write(run_dir.join("run.json"), "SENTINEL").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunAlreadyExists
    );
    assert_eq!(
        std::fs::read_to_string(run_dir.join("run.json")).unwrap(),
        "SENTINEL",
        "an existing run's record must never be clobbered"
    );
}

#[test]
fn farm_lease_is_recorded_before_start_command() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);
    let run_id = format!(
        "nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );

    let mut mock = MockRunner::new();
    script_android_through_farm_status(&mut mock, &repo, FREE_SLOT_LINE);
    mock.expect_run("lsof", free_port()); // tunnel port preflight
                                          // A crash inside `farm start` must still leave the claim discoverable, so
                                          // the pending lease has to be durable before the command runs at all.
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::failed(255, "ssh: killed"),
    );

    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: run_id.clone(),
        probe_label: "farm-start".to_string(),
        observed: None,
    };
    let receipt = prepare(
        &mut probing,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let at_start = probing
        .observed
        .expect("farm-start must have executed with a readable run record");
    let snapshot: RunRecord =
        serde_json::from_str(&at_start).expect("the durable record must be valid JSON mid-run");
    let farm = snapshot
        .resources
        .farm
        .expect("the pending lease must be durable before farm start runs");
    assert_eq!(farm.holder, format!("rn-qa-{run_id}"));
    assert_eq!(farm.slot, 1);
    assert_eq!(farm.remote_serial, "emulator-5554");
    assert_eq!(farm.adb_port, 5555);
    let record = RunRecord::load(&repo, &run_id).unwrap();
    assert!(
        record.resources.farm.is_some(),
        "the failed start must leave the lease recorded for cleanup"
    );
}

#[test]
fn simulator_allocation_is_recorded_before_create() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));
    let run_id = format!(
        "ios-simulator-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::failed(1, "boom"));

    let mut probing = RecordProbeRunner {
        inner: mock,
        repo: repo.clone(),
        run_id: run_id.clone(),
        probe_label: "simctl-create".to_string(),
        observed: None,
    };
    let receipt = prepare(&mut probing, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let at_create = probing
        .observed
        .expect("simctl-create must have executed with a readable run record");
    let snapshot: RunRecord =
        serde_json::from_str(&at_create).expect("the durable record must be valid JSON mid-run");
    let pending = snapshot
        .resources
        .ios_simulator
        .expect("the pending allocation must be durable before simctl create runs");
    assert_eq!(pending.name, format!("rn-qa-{run_id}"));
    assert_eq!(pending.udid, "", "no udid exists before create returns");
    let record = RunRecord::load(&repo, &run_id).unwrap();
    let sim = record
        .resources
        .ios_simulator
        .as_ref()
        .expect("pending allocation must survive the failed create");
    assert_eq!(sim.udid, "", "no udid may be invented for a failed create");
}

#[test]
fn candidate_drift_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_spawn(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    // Provenance recheck: HEAD moved during the build.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "d".repeat(40))));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
    assert!(
        receipt
            .failure
            .as_ref()
            .unwrap()
            .next_action
            .contains("cleanup"),
        "owned resources exist, so cleanup must be the next action"
    );
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
}

#[test]
fn android_dry_run_plans_adb_connect_and_state_check() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            true,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert!(
        receipt
            .planned_commands
            .iter()
            .any(|c| c.contains("connect 127.0.0.1:<adb_port>")),
        "the plan must include the adb connect step: {:?}",
        receipt.planned_commands
    );
    assert!(
        receipt
            .planned_commands
            .iter()
            .any(|c| c.contains("-s 127.0.0.1:<adb_port> get-state")),
        "the planned state check must stay pinned to the leased serial: {:?}",
        receipt.planned_commands
    );
}

#[test]
fn candidate_dirty_drift_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_spawn(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    // Provenance recheck: HEAD unchanged, but the worktree went dirty.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/App.tsx\0"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted
    );
}

#[test]
fn candidate_dirty_content_drift_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation_porcelain(&mut mock, &repo, IOS_TOOLS, " M test-app/App.tsx\0");
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_spawn(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    // Provenance recheck: still dirty, but a different set of modifications.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(" M test-app/Other.tsx\0"));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::CandidateDrifted);
    assert!(
        failure.detail.contains("worktree contents changed"),
        "detail: {}",
        failure.detail
    );
}

// The full mock script of a prepare that reaches the readiness recheck, with
// the validation-time and recheck-time porcelain outputs as the variables
// under test.
fn script_prepare_to_recheck(
    mock: &mut MockRunner,
    repo: &std::path::Path,
    porcelain_at_validation: &str,
    porcelain_at_recheck: &str,
) {
    script_validation_porcelain(mock, repo, IOS_TOOLS, porcelain_at_validation);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    mock.expect_spawn(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(porcelain_at_recheck));
}

// Regression for the external-worktree self-drift bug: prepare writes
// .rn-qa/runs/<run-id>/ into the candidate worktree after the cleanliness
// snapshot, so on a clean external project that does not gitignore .rn-qa
// the recheck used to see "?? .rn-qa/" and false-trigger CANDIDATE_DRIFTED.
#[test]
fn rn_qa_state_created_during_build_is_not_candidate_drift() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_recheck(&mut mock, &repo, "", "?? .rn-qa/\0");
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "rn-qa's own state dir must not count as drift: {:?}",
        receipt.failure
    );
}

#[test]
fn preexisting_rn_qa_state_does_not_mark_the_candidate_dirty() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_recheck(
        &mut mock,
        &repo,
        "?? .rn-qa/\0",
        "?? .rn-qa/runs/some-run/run.json\0",
    );
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    let candidate = receipt.candidate.unwrap();
    assert!(
        !candidate.git_dirty,
        "leftover rn-qa state from an earlier run is not candidate dirt"
    );
}

#[test]
fn untracked_file_outside_rn_qa_state_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_recheck(&mut mock, &repo, "", "?? .rn-qa/\0?? stray.txt\0");

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted,
        "an untracked file outside .rn-qa is real drift even next to rn-qa state"
    );
}

#[test]
fn tracked_modification_alongside_rn_qa_state_during_build_fails_prepare() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_prepare_to_recheck(&mut mock, &repo, "", "?? .rn-qa/\0 M test-app/App.tsx\0");

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateDrifted,
        "a tracked modification is real drift even next to rn-qa state"
    );
}

#[test]
fn dry_run_plans_without_allocating() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, true, None));
    assert_eq!(receipt.result, ReceiptResult::Planned);
    assert_eq!(mock.remaining(), 0);
    assert!(!receipt.planned_commands.is_empty());
    assert!(receipt
        .planned_commands
        .iter()
        .any(|c| c.contains("expo run:ios")));
    assert!(
        !repo.join(".rn-qa").exists(),
        "dry-run must not create run records"
    );
}

#[test]
fn revision_pin_mismatch_fails_validation() {
    let repo = common::temp_repo();
    let yaml = common::ios_scenario_yaml(8791)
        .replace("revision: HEAD", &format!("revision: {}", "d".repeat(40)));
    let scenario_path = write_scenario(&repo, &yaml);

    let mut mock = MockRunner::new();
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CandidateRevisionMismatch
    );
}

#[test]
fn build_process_death_fails_with_log_evidence() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8791));

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run("simctl bootstatus", CmdOutput::success(""));
    mock.expect_spawn_with_log(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
        "CommandError: xcodebuild exited with error code 65\n",
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n"));
    mock.expect_run("ps", CmdOutput::failed(1, "")); // process died

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::BuildFailed);
    assert!(
        failure.next_action.contains("cleanup"),
        "cleanup must be the next action"
    );
    assert!(
        failure
            .evidence
            .iter()
            .any(|e| e.contains("xcodebuild exited with error code 65")),
        "the receipt must carry build log evidence: {:?}",
        failure.evidence
    );
    assert_eq!(mock.remaining(), 0, "the liveness probe must have run");
    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(
        record.resources.ios_simulator.is_some(),
        "sim must stay recorded for cleanup"
    );
}

// Every native-input change would otherwise leave another full dev client on
// disk forever; only the newest fingerprint's artifact is ever reusable.
#[test]
fn recording_a_build_prunes_older_fingerprint_artifacts_for_the_same_app() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::ios_scenario_yaml(8797));

    let products = repo
        .join("test-app")
        .join("ios")
        .join("build")
        .join("Build")
        .join("Products")
        .join("Debug-iphonesimulator");
    std::fs::create_dir_all(products.join("testapp.app")).unwrap();
    std::fs::write(products.join("testapp.app").join("binary"), b"native bits").unwrap();

    let artifacts = rn_qa::buildplan::cache_dir(&repo)
        .join("artifacts")
        .join("ios");
    let stale = artifacts.join(format!("com.rndevagent.testapp-{}", "a".repeat(16)));
    let other_app = artifacts.join(format!("com.other.app-{}", "b".repeat(16)));
    let not_a_fp_key = artifacts.join("com.rndevagent.testapp-scratch");
    for dir in [&stale, &other_app, &not_a_fp_key] {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("old.app"), b"old bits").unwrap();
    }

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, IOS_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run("simctl create", CmdOutput::success(&format!("{UDID}\n")));
    mock.expect_run(
        "simctl bootstatus",
        CmdOutput::success("Boot status: finished\n"),
    );
    // The ios/ dir is generated (untracked), so a clean build regenerates it.
    mock.expect_run("expo prebuild", CmdOutput::success(""));
    mock.expect_spawn(
        "expo run:ios",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:ios\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl get_app_container",
        CmdOutput::success("/containers/app\n"),
    );
    mock.expect_run(
        "simctl spawn",
        CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(&mut mock, &prepare_args(&scenario_path, false, None));
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );

    let state = match rn_qa::buildplan::load_state(&repo, "ios", "com.rndevagent.testapp") {
        rn_qa::buildplan::StateStatus::Loaded(state) => state,
        other => panic!("expected recorded cache state, got {other:?}"),
    };
    let cached = state.artifact.as_ref().unwrap();
    assert!(cached.path.exists(), "the new artifact must survive");
    assert!(
        !stale.exists(),
        "an older fingerprint's artifact must be pruned"
    );
    assert!(
        other_app.exists(),
        "another app's artifact must never be pruned"
    );
    assert!(
        not_a_fp_key.exists(),
        "a directory that is not a fingerprint artifact must never be pruned"
    );
}

#[test]
fn android_build_route_records_install_provenance_from_the_hashed_apk() {
    let repo = common::temp_repo();
    let scenario_path = write_scenario(&repo, &common::android_scenario_yaml(8792));
    let sdk = android_sdk(&repo);
    let apk = repo
        .join("test-app")
        .join("android")
        .join("app")
        .join("build")
        .join("outputs")
        .join("apk")
        .join("debug")
        .join("app-debug.apk");
    std::fs::create_dir_all(apk.parent().unwrap()).unwrap();
    std::fs::write(&apk, b"apk bits").unwrap();

    let mut mock = MockRunner::new();
    script_validation(&mut mock, &repo, ANDROID_TOOLS);
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("rn-qa prepare\n"));
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
    mock.expect_run(
        "~/bin/android-farm status",
        CmdOutput::success(
            "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\n",
        ),
    );
    mock.expect_run("lsof", free_port());
    let expected_holder = format!(
        "rn-qa-nuc-android-{}",
        rn_qa::timefmt::compact_utc(1_770_000_000_000)
    );
    mock.expect_run(
        "~/bin/android-farm start 1",
        CmdOutput::success(&format!(
            "started slot=1 serial=emulator-5554 adb_port=5555 lease={expected_holder}\n"
        )),
    );
    mock.expect_spawn(
        "ssh",
        Spawned {
            pid: 7000,
            pgid: 7000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("ssh -N\n"));
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run(
        "cat ~/.android/adbkey",
        CmdOutput::success("-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n"),
    );
    mock.expect_spawn(
        "server nodaemon",
        Spawned {
            pid: 7100,
            pgid: 7100,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run(
        "ps",
        CmdOutput::success("adb -L tcp:127.0.0.1:15037 nodaemon server\n"),
    );
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n"));
    mock.expect_run(
        "connect 127.0.0.1:5555",
        CmdOutput::success("connected to 127.0.0.1:5555\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 get-state",
        CmdOutput::success("device\n"),
    );
    // The android/ dir is generated (untracked), so a clean build regenerates it.
    mock.expect_run("expo prebuild", CmdOutput::success(""));
    mock.expect_spawn(
        "expo run:android",
        Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("node expo run:android\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pm path",
        CmdOutput::success("package:/data/app/base.apk\n"),
    );
    mock.expect_run(
        "-s 127.0.0.1:5555 shell pidof",
        CmdOutput::success("12345\n"),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run("git", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));

    let receipt = prepare(
        &mut mock,
        &prepare_args(
            &scenario_path,
            false,
            Some(sdk.to_string_lossy().into_owned()),
        ),
    );
    assert_eq!(
        receipt.result,
        ReceiptResult::Ready,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);

    let record = RunRecord::load(&repo, &receipt.run_id).unwrap();
    let install = record
        .resources
        .app_install
        .as_ref()
        .expect("a ready build through the run's own adb server is install provenance");
    assert_eq!(install.app_id, "com.rndevagent.testapp");
    assert_eq!(install.serial, "127.0.0.1:5555");
    assert_eq!(install.server_port, 15037);
    assert_eq!(install.via, "expo-run-android");
    assert_eq!(
        install.artifact.sha256,
        rn_qa::candidate::sha256_hex(b"apk bits"),
        "the provenance hash is the hash of the artifact this run built and installed"
    );
    assert_eq!(install.artifact.kind, rn_qa::buildplan::ArtifactKind::Apk);
    assert!(!install.installed_at.is_empty());
    assert!(install.removal.is_none());
}
