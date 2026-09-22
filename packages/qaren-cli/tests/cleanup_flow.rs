mod common;

use qaren::commands::cleanup::cleanup;
use qaren::exec::Spawned;
use qaren::exec::{CmdOutput, MockRunner};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::runrecord::{
    AdbServerResource, FarmResource, IosSimResource, MetroResource, Phase, RunRecord,
    TunnelResource,
};

const LSTART: &str = "Wed Aug 12 16:01:00 2026";

fn ios_ready_record(repo: &std::path::Path) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::ios_scenario_yaml(8791),
        "iosrun1",
        Phase::Ready,
    );
    record.resources.ios_simulator = Some(IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: "qaren-iosrun1".to_string(),
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

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

fn sim_list_json(name: &str, state: &str) -> String {
    format!(r#"{{"devices":{{"rt":[{{"udid":"AAAA-1111","name":"{name}","state":"{state}"}}]}}}}"#)
}

#[test]
fn ios_happy_cleanup_then_idempotent_rerun() {
    let repo = common::temp_repo();
    ios_ready_record(&repo).save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // metro group: leader alive+matching, port owned by a child of the group
    // -> TERM, KILL, leader gone, port free
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    // simulator: present with matching name, booted -> shutdown + delete
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&sim_list_json("qaren-iosrun1", "Booted")),
    );
    mock.expect_run("simctl shutdown AAAA-1111", CmdOutput::success(""));
    mock.expect_run("simctl delete AAAA-1111", CmdOutput::success(""));

    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(receipt.cleanup.get("metro").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("simulator").unwrap(), "removed");
    assert_eq!(mock.remaining(), 0);

    let reloaded = RunRecord::load(&repo, "iosrun1").unwrap();
    assert_eq!(reloaded.phase, Phase::Cleaned);

    // Second run: everything already gone -> cleaned again, no kill attempted.
    let mut mock2 = MockRunner::new();
    mock2.expect_run("ps", CmdOutput::failed(1, ""));
    mock2.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    mock2.expect_run(
        "simctl list",
        CmdOutput::success(r#"{"devices":{"rt":[]}}"#),
    );
    let receipt2 = cleanup(&mut mock2, &repo, "iosrun1");
    assert_eq!(receipt2.result, ReceiptResult::Cleaned);
    assert_eq!(receipt2.cleanup.get("metro").unwrap(), "absent");
    assert_eq!(receipt2.cleanup.get("simulator").unwrap(), "absent");
    assert!(
        !mock2.calls.iter().any(|c| c.program.contains("kill")),
        "idempotent rerun must not kill"
    );
}

#[test]
fn refuses_foreign_named_simulator() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.metro = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&sim_list_json("Someone-Elses-Sim", "Booted")),
    );
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .cleanup
        .get("simulator")
        .unwrap()
        .starts_with("refused"));
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::OwnershipUnproven
    );
    assert_eq!(
        mock.calls.len(),
        1,
        "the list probe must be the only command against a foreign sim"
    );
    let reloaded = RunRecord::load(&repo, "iosrun1").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn refuses_pid_with_changed_birth_identity() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // leader pid alive but with a different lstart -> pid reused -> absent, no kill
    mock.expect_run("ps", CmdOutput::success("Thu Aug 13 09:00:00 2026\n"));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(receipt.cleanup.get("metro").unwrap(), "absent");
    assert!(
        !mock.calls.iter().any(|c| c.program.contains("kill")),
        "reused pid must not be killed"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "the port probe must run before declaring absent"
    );
}

#[test]
fn kills_group_via_port_when_leader_died_but_children_own_port() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::failed(1, "")); // leader dead
    mock.expect_run("lsof", CmdOutput::success("6001\n")); // child owns port
    mock.expect_run("ps", CmdOutput::success("5000\n")); // child pgid == recorded pgid
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, "")); // leader still dead
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    ); // port now free
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.cleanup.get("metro").unwrap(), "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(
        mock.remaining(),
        0,
        "post-kill verification probes must run"
    );
}

#[test]
fn refuses_corrupt_pgid() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    if let Some(metro) = &mut record.resources.metro {
        metro.spawned.pgid = 1;
    }
    record.save(&repo).unwrap();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt.cleanup.get("metro").unwrap().contains("pgid"));
    assert!(mock.calls.is_empty());
}

#[test]
fn android_cleanup_stops_only_own_lease() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun1",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun1".to_string(),
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
    let run_dir = RunRecord::run_dir(&repo, "androidrun1");
    std::fs::create_dir_all(&run_dir).unwrap();
    let vendor_key = run_dir.join("nuc-adbkey");
    std::fs::write(&vendor_key, "FAKEKEY").unwrap();
    record.resources.adb_server = Some(AdbServerResource {
        spawned: Spawned {
            pid: 7100,
            pgid: 7100,
        },
        identity: Some(common::identity(7100, LSTART)),
        server_port: 15037,
        log: repo.join("adb-server.log"),
    });
    record.resources.adb_vendor_key = Some(vendor_key.clone());
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // adb connection: server identity alive -> disconnect through it
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run(
        "disconnect 127.0.0.1:5555",
        CmdOutput::success("disconnected 127.0.0.1:5555\n"),
    );
    // adb server group: alive matching, port owned by the group -> TERM/KILL
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("7100\n"));
    mock.expect_run("ps", CmdOutput::success("7100\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    // tunnel: alive matching, port owned by the group -> TERM/KILL -> dead, port free
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("7000\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    // farm: lease is ours -> stop
    mock.expect_run("~/bin/android-farm status", CmdOutput::success(
        "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-androidrun1 claimed_at=x state=device\nslot=2 avd=Pixel_10_Pro serial=emulator-5556 adb_port=5557 lease=free state=down\n",
    ));
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "androidrun1");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("adb_server").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("adb_vendor_key").unwrap(), "removed");
    assert!(
        !vendor_key.exists(),
        "the fetched vendor key must be deleted"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn tunnel_cleanup_reaps_live_forward_via_local_port_when_identity_missing() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun4",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // No identity -> leader unprovable; the recorded local port must still
    // prove the group: the listener's pgid equals the recorded tunnel pgid.
    mock.expect_run("lsof", CmdOutput::success("7050\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    ); // port free after kill
    let receipt = cleanup(&mut mock, &repo, "androidrun4");
    assert_eq!(
        receipt.result,
        ReceiptResult::Cleaned,
        "cleanup: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.cleanup.get("tunnel").unwrap(), "removed");
    assert_eq!(
        mock.remaining(),
        0,
        "the port probe and post-kill verification must run"
    );
}

#[test]
fn tunnel_cleanup_leaves_foreign_listener_on_local_port() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun5",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("8123\n"));
    mock.expect_run("ps", CmdOutput::success("9999\n")); // foreign pgid
    let receipt = cleanup(&mut mock, &repo, "androidrun5");
    // Without a recorded identity, a foreign listener proves nothing about the
    // spawned group; the honest answer is unresolved, never absent.
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(
        !mock.calls.iter().any(|c| c.program.contains("kill")),
        "a foreign listener on the tunnel port must never be killed"
    );
    assert_eq!(
        mock.remaining(),
        0,
        "the port ownership probe must run before judging the group"
    );
}

#[test]
fn identity_missing_with_free_port_is_unresolved_not_absent() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun6",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // A free port does not prove a just-spawned, not-yet-bound group is gone.
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    let receipt = cleanup(&mut mock, &repo, "androidrun6");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert!(!mock.calls.iter().any(|c| c.program.contains("kill")));
}

#[test]
fn cleanup_retains_farm_lease_when_tunnel_unproven() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun7",
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun7".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    // Tunnel port probe is inconclusive -> tunnel unresolved -> the lease must
    // be retained: releasing it would let the next lease share a port with a
    // possibly-live foreign forward.
    mock.expect_run("lsof", CmdOutput::failed(2, "lsof: internal error"));
    // The port-keyed lease gate re-probes and is equally inconclusive.
    mock.expect_run("lsof", CmdOutput::failed(2, "lsof: internal error"));
    let receipt = cleanup(&mut mock, &repo, "androidrun7");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert!(
        receipt
            .cleanup
            .get("farm_lease")
            .unwrap()
            .starts_with("refused"),
        "farm lease must be retained while the tunnel is unproven: {:?}",
        receipt.cleanup
    );
    assert!(
        !mock.calls.iter().any(|c| c.program == "ssh"),
        "no farm command may run while the tunnel is unproven"
    );
    let reloaded = RunRecord::load(&repo, "androidrun7").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

fn tunnel_and_farm_record(repo: &std::path::Path, run_id: &str) -> RunRecord {
    let mut record = common::base_record(
        repo,
        &common::android_scenario_yaml(8792),
        run_id,
        Phase::Failed,
    );
    record.resources.tunnel = Some(TunnelResource {
        spawned: Spawned {
            pid: 7000,
            pgid: 7000,
        },
        identity: None,
        local_port: 5555,
        log: repo.join("tunnel.log"),
    });
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: format!("qaren-{run_id}"),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record
}

fn farm_status_leased_by(run_id: &str) -> CmdOutput {
    CmdOutput::success(&format!(
        "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-{run_id} claimed_at=x state=device\n"
    ))
}

#[test]
fn farm_lease_is_released_when_unresolved_tunnel_port_is_proven_free() {
    let repo = common::temp_repo();
    tunnel_and_farm_record(&repo, "androidrun20")
        .save(&repo)
        .unwrap();

    let mut mock = MockRunner::new();
    // No identity and a free port: the group stays unresolved (never guessed
    // absent), but the forwarded port is positively free.
    mock.expect_run("lsof", free_port());
    mock.expect_run("lsof", free_port()); // port-keyed lease gate
    mock.expect_run(
        "~/bin/android-farm status",
        farm_status_leased_by("androidrun20"),
    );
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "androidrun20");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(
        receipt.cleanup.get("farm_lease").unwrap(),
        "removed",
        "a provably free forwarded port cannot expose the next lease: {:?}",
        receipt.cleanup
    );
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CleanupIncomplete
    );
    assert_eq!(mock.remaining(), 0);
    let reloaded = RunRecord::load(&repo, "androidrun20").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn farm_lease_is_released_after_the_recorded_group_owning_the_port_is_killed() {
    let repo = common::temp_repo();
    tunnel_and_farm_record(&repo, "androidrun21")
        .save(&repo)
        .unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("7050\n"));
    mock.expect_run("ps", CmdOutput::success("7000\n")); // listener is in our group
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("lsof", free_port()); // post-kill verification
    mock.expect_run(
        "~/bin/android-farm status",
        farm_status_leased_by("androidrun21"),
    );
    mock.expect_run(
        "~/bin/android-farm stop 1",
        CmdOutput::success("stopped slot=1 serial=emulator-5554\n"),
    );

    let receipt = cleanup(&mut mock, &repo, "androidrun21");
    assert_eq!(receipt.cleanup.get("tunnel").unwrap(), "removed");
    assert_eq!(receipt.cleanup.get("farm_lease").unwrap(), "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(
        mock.calls.iter().filter(|c| c.program == "lsof").count(),
        2,
        "a clean tunnel outcome already proves the port; no extra probe"
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn farm_lease_is_retained_when_the_tunnel_port_has_a_foreign_owner() {
    let repo = common::temp_repo();
    tunnel_and_farm_record(&repo, "androidrun22")
        .save(&repo)
        .unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("lsof", CmdOutput::success("8123\n"));
    mock.expect_run("ps", CmdOutput::success("9999\n")); // foreign pgid
    mock.expect_run("lsof", CmdOutput::success("8123\n")); // lease gate: still occupied

    let receipt = cleanup(&mut mock, &repo, "androidrun22");
    assert!(receipt
        .cleanup
        .get("tunnel")
        .unwrap()
        .starts_with("unresolved"));
    assert!(
        receipt
            .cleanup
            .get("farm_lease")
            .unwrap()
            .starts_with("refused"),
        "an occupied forwarded port must keep the slot held: {:?}",
        receipt.cleanup
    );
    assert!(
        !mock.calls.iter().any(|c| c.program == "ssh"),
        "no farm command may run while the forwarded port is occupied"
    );
    assert!(!mock.calls.iter().any(|c| c.program.contains("kill")));
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn post_kill_indeterminate_port_probe_is_unresolved() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n")); // not a zombie
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, "")); // leader gone
    mock.expect_run(
        "lsof",
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
    ); // post-kill port probe times out: survival cannot be excluded
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert!(receipt
        .cleanup
        .get("metro")
        .unwrap()
        .starts_with("unresolved"));
    assert_eq!(receipt.result, ReceiptResult::Failed);
    let reloaded = RunRecord::load(&repo, "iosrun1").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn cleanup_recovers_pending_simulator_by_run_scoped_name() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.metro = None;
    // A crash between the pending-allocation save and the udid fill leaves an
    // empty udid; the run-scoped name is the recovery key.
    record.resources.ios_simulator.as_mut().unwrap().udid = String::new();
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(&sim_list_json("qaren-iosrun1", "Booted")),
    );
    mock.expect_run("simctl shutdown AAAA-1111", CmdOutput::success(""));
    mock.expect_run("simctl delete AAAA-1111", CmdOutput::success(""));
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.cleanup.get("simulator").unwrap(), "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
}

#[test]
fn cleanup_pending_simulator_absent_when_create_never_ran() {
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.metro = None;
    record.resources.ios_simulator.as_mut().unwrap().udid = String::new();
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "simctl list",
        CmdOutput::success(r#"{"devices":{"rt":[{"udid":"BBBB-2222","name":"Someone-Elses-Sim","state":"Booted"}]}}"#),
    );
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_eq!(receipt.cleanup.get("simulator").unwrap(), "absent");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert_eq!(
        mock.calls.len(),
        1,
        "a foreign-named simulator must never be touched during name recovery"
    );
}

#[test]
fn cleanup_save_failure_downgrades_cleaned_to_failed() {
    use std::os::unix::fs::PermissionsExt;
    let repo = common::temp_repo();
    let mut record = ios_ready_record(&repo);
    record.resources.ios_simulator = None;
    record.save(&repo).unwrap();

    let run_dir = RunRecord::run_dir(&repo, "iosrun1");
    std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    // Environments that bypass mode bits (root, permissive ACLs) cannot
    // exercise this failure path; skip rather than flake.
    if std::fs::write(run_dir.join(".mode-probe"), b"x").is_ok() {
        let _ = std::fs::remove_file(run_dir.join(".mode-probe"));
        std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
        eprintln!("skipping: filesystem does not enforce directory modes here");
        return;
    }

    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700)).unwrap();

    assert_eq!(
        receipt.result,
        ReceiptResult::Failed,
        "an unpersisted cleaned phase must not report cleaned"
    );
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUpdateFailed
    );
    assert!(receipt
        .failure
        .as_ref()
        .unwrap()
        .next_action
        .contains("cleanup"));
}

#[test]
fn android_cleanup_refuses_foreign_lease() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun2",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun2".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run("ssh", CmdOutput::success(
        "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=someone-else state=device\n",
    ));
    let receipt = cleanup(&mut mock, &repo, "androidrun2");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(receipt
        .cleanup
        .get("farm_lease")
        .unwrap()
        .contains("someone-else"));
    assert_eq!(
        mock.calls.len(),
        1,
        "must not issue farm stop for a foreign lease"
    );
}

#[test]
fn android_cleanup_unreachable_farm_is_unresolved_not_cleaned() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun3",
        Phase::Ready,
    );
    record.resources.farm = Some(FarmResource {
        ssh_host: "nuc".to_string(),
        farm_path: "bin/android-farm".to_string(),
        slot: 1,
        holder: "qaren-androidrun3".to_string(),
        avd: "Pixel_10a".to_string(),
        remote_serial: "emulator-5554".to_string(),
        adb_port: 5555,
    });
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    mock.expect_run(
        "ssh",
        CmdOutput::failed(255, "ssh: connect to host nuc: timed out"),
    );
    let receipt = cleanup(&mut mock, &repo, "androidrun3");
    assert_eq!(receipt.result, ReceiptResult::Failed);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::CleanupIncomplete
    );
    let reloaded = RunRecord::load(&repo, "androidrun3").unwrap();
    assert_ne!(reloaded.phase, Phase::Cleaned);
}

#[test]
fn cleanup_without_record_is_refused() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "no-such-run");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordUnavailable
    );
    assert!(mock.calls.is_empty(), "no probes may run without a record");
}

#[test]
fn cleanup_rejects_traversal_run_id() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "../escape");
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::RunRecordInvalid
    );
}

#[test]
fn vendor_key_is_deleted_even_when_the_adb_server_never_spawned() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::android_scenario_yaml(8792),
        "androidrun6",
        Phase::Failed,
    );
    let run_dir = RunRecord::run_dir(&repo, "androidrun6");
    std::fs::create_dir_all(&run_dir).unwrap();
    let vendor_key = run_dir.join("nuc-adbkey");
    std::fs::write(&vendor_key, "FAKEKEY").unwrap();
    record.resources.adb_vendor_key = Some(vendor_key.clone());
    record.save(&repo).unwrap();

    let mut mock = MockRunner::new();
    let receipt = cleanup(&mut mock, &repo, "androidrun6");
    assert_eq!(receipt.cleanup.get("adb_vendor_key").unwrap(), "removed");
    assert_eq!(receipt.result, ReceiptResult::Cleaned);
    assert!(
        !vendor_key.exists(),
        "the fetched vendor key must not survive a run that died before the server spawned"
    );
}

#[test]
fn cleanup_retains_the_device_lease_until_the_metro_group_is_proven_gone() {
    let repo = common::temp_repo();
    let lock_root = repo.join(".locks");
    let mut holder = MockRunner::new();
    let lease = qaren::lease::acquire(
        &mut holder,
        &lock_root,
        qaren::scenario::Platform::Ios,
        "AAAA-1111",
        "iosrun1",
        Some(common::identity(4242, LSTART)),
    )
    .unwrap();
    let lock_dir = lease.lock_dir.clone();
    let mut record = ios_ready_record(&repo);
    record.resources.device_borrowed = true;
    record.resources.lease = Some(lease);
    record.save(&repo).unwrap();

    // Metro group: alive, TERM, KILL, and the leader survives both -> unresolved.
    let mut mock = MockRunner::new();
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("5000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let receipt = cleanup(&mut mock, &repo, "iosrun1");
    assert_ne!(receipt.result, ReceiptResult::Cleaned);
    assert!(receipt.cleanup["metro"].starts_with("unresolved"));
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert!(
        receipt.cleanup["device_lease"].starts_with("unresolved: retained: metro"),
        "{}",
        receipt.cleanup["device_lease"]
    );
    assert!(
        lock_dir.exists(),
        "the lease survives an unresolved Metro leg"
    );
    assert_eq!(mock.remaining(), 0);

    // Metro leader dead and the port free -> the lease is released.
    let mut mock2 = MockRunner::new();
    mock2.expect_run("ps", CmdOutput::failed(1, ""));
    mock2.expect_run(
        "lsof",
        CmdOutput {
            exit_code: Some(1),
            ..Default::default()
        },
    );
    let receipt2 = cleanup(&mut mock2, &repo, "iosrun1");
    assert_eq!(
        receipt2.result,
        ReceiptResult::Cleaned,
        "{:?}",
        receipt2.failure
    );
    assert_eq!(receipt2.cleanup["metro"], "absent");
    assert_eq!(receipt2.cleanup["device_lease"], "removed");
    assert!(!lock_dir.exists());
    assert_eq!(mock2.remaining(), 0);
}
