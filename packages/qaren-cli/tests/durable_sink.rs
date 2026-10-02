mod common;

use qaren::failure::{Failure, FailureCode};
use qaren::receipt::{Receipt, ReceiptResult};
use qaren::redact::PRIVATE_KEY_WITHHELD;
use qaren::runrecord::{Phase, RunRecord};

const BODY: &str = "FAKEKEYBODY";

fn raw_failure() -> Failure {
    Failure {
        phase: "allocate".to_string(),
        code: FailureCode::TunnelFailed,
        detail: format!("{BODY}1 -----end private key-----"),
        evidence: vec!["clean".to_string(), format!("PRIVATE KEY {BODY}2")],
        next_action: format!("<redacted private key> {BODY}3"),
    }
}

#[test]
fn run_json_and_receipts_withhold_key_strings_a_writer_did_not_redact() {
    let dir = common::temp_repo();
    let mut record = common::base_record(
        &dir,
        &common::ios_scenario_yaml(8793),
        "sinkrun",
        Phase::Failed,
    );
    record.failure = Some(raw_failure());
    record.save(&dir).unwrap();
    let mut receipt = Receipt::new(
        "prepare",
        "sinkrun",
        ReceiptResult::Failed,
        "allocate",
        String::new(),
    );
    receipt.failure = Some(raw_failure());
    receipt.next_action = format!("Private Key {BODY}4");
    let recorded = std::fs::read_to_string(RunRecord::path(&dir, "sinkrun")).unwrap();
    for durable in [recorded, receipt.to_json()] {
        assert!(!durable.contains(BODY), "{durable}");
        assert!(durable.contains(PRIVATE_KEY_WITHHELD), "{durable}");
        assert!(durable.contains("\"clean\""), "{durable}");
    }
    let reloaded = RunRecord::load(&dir, "sinkrun").unwrap();
    assert_eq!(reloaded.failure.unwrap().detail, PRIVATE_KEY_WITHHELD);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unsafe_lock_roots_are_refused_before_acquisition() {
    use qaren::commands::prepare::{prepare, PrepareArgs};
    use qaren::exec::MockRunner;
    use qaren::scenario::Platform;
    let dir = common::temp_repo();
    let locks = dir.join("PrIvAtE KeY qa/locks");
    let mut runner = MockRunner::new();
    let failure = qaren::lease::acquire(&mut runner, &locks, Platform::Ios, "device", "run", None)
        .unwrap_err();
    assert!(!locks.parent().unwrap().exists());
    assert!(!failure.detail.contains("PrIvAtE"));
    let receipt = prepare(
        &mut runner,
        &PrepareArgs {
            scenario_path: dir.join("missing.yaml"),
            dry_run: false,
            android_home: None,
            lock_root: locks.clone(),
            runs_root: dir.join("runs"),
        },
    );
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert!(!dir.join("runs").exists());
    runner
        .environment
        .insert("HOME".into(), dir.to_string_lossy().into_owned());
    runner.environment.insert(
        "QAREN_LOCK_ROOT".into(),
        locks.to_string_lossy().into_owned(),
    );
    assert!(qaren::native_suite::recover(&mut runner, "native-ios-1").is_err());
    assert!(runner.calls.is_empty());
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["prepare", "missing.yaml", "--json"])
        .current_dir(&dir)
        .env("HOME", &dir)
        .env("QAREN_LOCK_ROOT", &locks)
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    assert!(!locks.parent().unwrap().exists());
    assert!(!String::from_utf8_lossy(&output.stdout).contains("PrIvAtE"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn unsafe_recovery_paths_are_never_masked_or_cleared() {
    use qaren::exec::MockRunner;
    let dir = common::temp_repo();
    let base = common::base_record(
        &dir,
        &common::ios_scenario_yaml(8793),
        "paths",
        Phase::Failed,
    );
    let unsafe_path = dir.join("PRIVATE KEY qa/resource");
    let path = unsafe_path.to_string_lossy().into_owned();
    let mut owned = serde_json::to_value(&base).unwrap();
    owned["resources"]["lease"] = serde_json::json!({
        "run_id": "paths", "token": "token", "holder": "owner", "lock_dir": dir.join("locks/device")
    });
    owned["resources"]["usb_device"] =
        serde_json::json!({"serial": "usb", "holder": "owner", "lock_dir": dir.join("locks/usb")});
    owned["resources"]["build_lock"] =
        serde_json::json!({"holder": "owner", "lock_dir": dir.join("locks/build")});
    for (resource, port) in [
        ("metro", "port"),
        ("tunnel", "local_port"),
        ("adb_server", "server_port"),
    ] {
        owned["resources"][resource] = serde_json::json!({
            "spawned": {"pid": 100, "pgid": 100}, "identity": null,
            "log": dir.join("log"), "endpoint": "endpoint",
        });
        owned["resources"][resource][port] = serde_json::json!(8793);
    }
    owned["build"] = serde_json::json!({
        "decision": "reuse", "fingerprint": "fp", "reason": "reason",
        "artifact": {"path": dir.join("app"), "sha256": "sha", "kind": "app_bundle"},
    });
    for pointer in [
        "/candidate/repo_root",
        "/candidate/project_root",
        "/scenario_path",
        "/resources/lease/lock_dir",
        "/resources/usb_device/lock_dir",
        "/resources/build_lock/lock_dir",
        "/resources/metro/log",
        "/resources/tunnel/log",
        "/resources/adb_server/log",
        "/build/artifact/path",
    ] {
        let mut value = owned.clone();
        *value.pointer_mut(pointer).unwrap() = serde_json::json!(path);
        let record: RunRecord = serde_json::from_value(value).unwrap();
        assert!(record.save(&dir).is_err(), "{pointer}");
        let file = RunRecord::path(&dir, "paths");
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        let original = serde_json::to_string(&record).unwrap();
        std::fs::write(&file, &original).unwrap();
        let mut runner = MockRunner::new();
        let receipt = qaren::commands::cleanup::cleanup(&mut runner, &dir, "paths");
        assert_eq!(receipt.result, ReceiptResult::Refused, "{pointer}");
        assert!(runner.calls.is_empty());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        assert!(!receipt.to_json().contains(&path));
    }
    for field in ["adb_vendor_key", "adb_path"] {
        let mut value = owned.clone();
        value["resources"][field] = serde_json::json!(path);
        let record: RunRecord = serde_json::from_value(value).unwrap();
        assert!(record.save(&dir).is_err(), "{field}");
    }
    assert!(matches!(
        qaren::buildplan::release_lock(&unsafe_path, "owner", "paths"),
        qaren::buildplan::ReleaseOutcome::Refused(_)
    ));
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn ownership_sinks_refuse_unsafe_paths_and_keep_safe_identity() {
    use qaren::buildplan::{
        save_json, ArtifactKind, CachedArtifact, DepsPrewarm, NativeCacheState,
    };
    let dir = common::temp_repo();
    let unsafe_path = dir.join("private key/cache");
    let state = NativeCacheState {
        schema: qaren::buildplan::CACHE_SCHEMA.into(),
        platform: "ios".into(),
        app_id: "app".into(),
        worktree_root: dir.clone(),
        fingerprint: "fp".into(),
        built_at: "now".into(),
        candidate_sha: "sha".into(),
        lockfile_sha256: "sha".into(),
        generated_native_dirs: Vec::new(),
        artifact: Some(CachedArtifact {
            path: unsafe_path.clone(),
            sha256: "sha".into(),
            kind: ArtifactKind::AppBundle,
        }),
    };
    let dest = dir.join("state/cache.json");
    assert!(save_json(&dest, &state).is_err());
    assert!(!dest.parent().unwrap().exists());
    let mut value = serde_json::to_value(&state).unwrap();
    value["artifact"]["path"] = serde_json::json!(dir.join("app"));
    value["worktree_root"] = serde_json::json!(unsafe_path);
    assert!(save_json(&dest, &value).is_err());
    let prewarm = DepsPrewarm {
        schema: qaren::buildplan::PREWARM_SCHEMA.into(),
        worktree_root: dir.clone(),
        project_root: unsafe_path,
        lockfile_sha256: "sha".into(),
        at: "now".into(),
    };
    assert!(save_json(&dest, &prewarm).is_err());
    let record = common::base_record(
        &dir,
        &common::ios_scenario_yaml(8793),
        "safe",
        Phase::Failed,
    );
    record.save(&dir).unwrap();
    let loaded = RunRecord::load(&dir, "safe").unwrap();
    assert_eq!(loaded.candidate.project_root, record.candidate.project_root);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn resolved_paths_and_native_recovery_refuse_without_mutation() {
    use qaren::exec::MockRunner;
    let dir = common::temp_repo();
    let unsafe_dir = dir.join("private key qa");
    std::fs::create_dir(&unsafe_dir).unwrap();
    let alias = dir.join("alias");
    std::os::unix::fs::symlink(&unsafe_dir, &alias).unwrap();
    assert!(qaren::redact::validate_operational_path(&alias.join("future/locks")).is_err());
    let mut runner = MockRunner::new();
    runner
        .environment
        .insert("HOME".into(), dir.to_string_lossy().into_owned());
    let suite_dir = dir.join(".qaren/native-suites/native-ios-1");
    std::fs::create_dir_all(&suite_dir).unwrap();
    let record = serde_json::json!({
        "schema": "qaren-native-suite/1", "run_id": "native-ios-1", "device_id": "device",
        "owner": {"pid": 100, "started_at": "birth", "command": ""},
        "lock_dir": unsafe_dir.join("lock"), "lease": null, "process": {"state": "not_spawned"},
        "suite_exit": null, "cleanup": null,
    });
    let raw = serde_json::to_string(&record).unwrap();
    let file = suite_dir.join("suite.json");
    std::fs::write(&file, &raw).unwrap();
    let error = qaren::native_suite::recover(&mut runner, "native-ios-1").unwrap_err();
    assert!(error.contains("resolve ownership manually"));
    assert!(!error.contains("private key"));
    assert!(runner.calls.is_empty());
    assert_eq!(std::fs::read_to_string(file).unwrap(), raw);
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn handoff_candidate_paths_are_refused_before_writing() {
    use qaren::handoff::{ExpectedReceipt, HandoffDocument};
    let dir = common::temp_repo();
    let record = common::base_record(
        &dir,
        &common::ios_scenario_yaml(8793),
        "handoff",
        Phase::HandedOff,
    );
    let mut doc = HandoffDocument {
        schema: qaren::handoff::HANDOFF_SCHEMA.into(),
        run_id: record.run_id.clone(),
        issued_at: record.created_at.clone(),
        candidate: record.candidate.clone(),
        platform: "ios".into(),
        device: qaren::commands::device_identity(&record),
        native_fingerprint: "fp".into(),
        fingerprint_complete: true,
        fingerprint_incompleteness: Vec::new(),
        expected_receipt: ExpectedReceipt {
            platform: "ios".into(),
            device_id: "device".into(),
            app_id: "app".into(),
            worktree_key: "key".into(),
            app_root_key: "key".into(),
        },
    };
    let dest = dir.join("handoff.json");
    for project in [false, true] {
        doc.candidate = record.candidate.clone();
        if project {
            doc.candidate.project_root = dir.join("Private Key/project");
        } else {
            doc.candidate.repo_root = dir.join("Private Key/repo");
        }
        assert!(qaren::handoff::save_document(&dest, &doc).is_err());
        assert!(!dest.exists());
    }
    doc.candidate = record.candidate;
    qaren::handoff::save_document(&dest, &doc).unwrap();
    let loaded: HandoffDocument = serde_json::from_slice(&std::fs::read(&dest).unwrap()).unwrap();
    assert_eq!(loaded.candidate.repo_root, doc.candidate.repo_root);
    std::fs::remove_dir_all(dir).unwrap();
}
