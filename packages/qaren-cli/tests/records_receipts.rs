mod common;

use qaren::failure::FailureCode;
use qaren::receipt::{Receipt, ReceiptResult, RECEIPT_SCHEMA};
use qaren::runrecord::{validate_run_id, Phase, RunRecord, RUN_SCHEMA};

#[test]
fn run_record_round_trips() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "roundtrip1",
        Phase::Ready,
    );
    record.resources.ios_simulator = Some(qaren::runrecord::IosSimResource {
        udid: "AAAA-1111".to_string(),
        name: "qaren-roundtrip1".to_string(),
        device_type: "dt".to_string(),
        runtime: "rt".to_string(),
    });
    record.resources.metro = Some(qaren::runrecord::MetroResource {
        port: 8791,
        endpoint: "http://127.0.0.1:8791".to_string(),
        spawned: qaren::exec::Spawned {
            pid: 5000,
            pgid: 5000,
        },
        identity: Some(common::identity(5000, "Wed Aug 12 16:01:00 2026")),
        log: repo.join("build.log"),
    });
    record.save(&repo).unwrap();
    let loaded = RunRecord::load(&repo, "roundtrip1").unwrap();
    assert_eq!(loaded.schema, RUN_SCHEMA);
    assert_eq!(loaded.run_id, "roundtrip1");
    assert_eq!(loaded.phase, Phase::Ready);
    assert_eq!(loaded.candidate.app_id, "com.rndevagent.testapp");
    assert_eq!(loaded.scenario.metro.unwrap().port, 8791);
    let sim = loaded.resources.ios_simulator.as_ref().unwrap();
    assert_eq!(
        (sim.udid.as_str(), sim.name.as_str()),
        ("AAAA-1111", "qaren-roundtrip1")
    );
    let metro = loaded.resources.metro.as_ref().unwrap();
    assert_eq!(metro.spawned.pgid, 5000);
    assert_eq!(
        metro.identity.as_ref().unwrap().started_at,
        "Wed Aug 12 16:01:00 2026"
    );
    assert_eq!(loaded.prepare.as_ref().unwrap().pid, 999);
}

#[test]
fn load_rejects_embedded_run_id_mismatch() {
    let repo = common::temp_repo();
    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "realid",
        Phase::Ready,
    );
    record.save(&repo).unwrap();
    let src = RunRecord::path(&repo, "realid");
    let tampered_dir = repo.join("otherid");
    std::fs::create_dir_all(&tampered_dir).unwrap();
    std::fs::copy(&src, tampered_dir.join("run.json")).unwrap();
    let failure = RunRecord::load(&repo, "otherid").unwrap_err();
    assert_eq!(failure.code, FailureCode::RunRecordInvalid);
}

#[test]
fn load_rejects_corrupt_and_foreign_schema_records() {
    let repo = common::temp_repo();
    let dir = repo.join("corrupt1");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("run.json"), "{not json").unwrap();
    assert_eq!(
        RunRecord::load(&repo, "corrupt1").unwrap_err().code,
        FailureCode::RunRecordInvalid
    );

    let record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "schema1",
        Phase::Ready,
    );
    record.save(&repo).unwrap();
    let path = RunRecord::path(&repo, "schema1");
    let body = std::fs::read_to_string(&path)
        .unwrap()
        .replace(RUN_SCHEMA, "qaren-run/999");
    std::fs::write(&path, body).unwrap();
    assert_eq!(
        RunRecord::load(&repo, "schema1").unwrap_err().code,
        FailureCode::RunRecordInvalid
    );
}

#[test]
fn run_id_validation_blocks_traversal_and_flags() {
    assert!(validate_run_id("ios-simulator-20260812T160000Z").is_ok());
    for bad in ["", "../escape", "a/b", "-flag", "a b", "a.b"] {
        assert!(validate_run_id(bad).is_err(), "{bad:?} must be rejected");
    }
}

#[test]
fn save_refuses_invalid_run_id() {
    let repo = common::temp_repo();
    let mut record = common::base_record(
        &repo,
        &common::ios_scenario_yaml(8791),
        "ok1",
        Phase::Created,
    );
    record.run_id = "../escape".to_string();
    assert!(record.save(&repo).is_err());
}

#[test]
fn receipts_serialize_to_stable_parseable_json() {
    let mut receipt = Receipt::new(
        "prepare",
        "run1",
        ReceiptResult::Ready,
        "ready",
        "2026-08-12T16:00:00Z".to_string(),
    );
    receipt.next_action = "attach".to_string();
    receipt
        .outcomes
        .insert("build".to_string(), "ok".to_string());
    receipt.timings_ms.insert("total".to_string(), 1234);
    receipt.commands_executed = 42;
    let json = receipt.to_json();
    let value: serde_json::Value = serde_json::from_str(&json).unwrap();
    assert_eq!(value["schema"], RECEIPT_SCHEMA);
    assert_eq!(value["verb"], "prepare");
    assert_eq!(value["result"], "ready");
    assert_eq!(value["run_id"], "run1");
    assert_eq!(value["commands_executed"], 42);
    assert_eq!(value["timings_ms"]["total"], 1234);
    assert!(
        value.get("failure").is_none(),
        "absent failure must not serialize"
    );

    let parsed: Receipt = serde_json::from_str(&json).unwrap();
    assert_eq!(parsed.result, ReceiptResult::Ready);
}

#[test]
fn failure_receipts_carry_bounded_codes_and_next_action() {
    let mut receipt = Receipt::new(
        "cleanup",
        "run2",
        ReceiptResult::Refused,
        "ready",
        "2026-08-12T16:00:00Z".to_string(),
    );
    receipt.failure = Some(qaren::failure::Failure::new(
        "cleanup",
        FailureCode::OwnershipUnproven,
        "simulator renamed",
        "resolve manually",
    ));
    receipt.next_action = "resolve manually".to_string();
    let value: serde_json::Value = serde_json::from_str(&receipt.to_json()).unwrap();
    assert_eq!(value["failure"]["code"], "OWNERSHIP_UNPROVEN");
    assert_eq!(value["result"], "refused");
    assert_eq!(value["failure"]["next_action"], "resolve manually");
    assert_eq!(value["next_action"], "resolve manually");
}
