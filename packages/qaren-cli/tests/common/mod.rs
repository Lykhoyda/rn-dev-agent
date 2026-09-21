#![allow(dead_code)]

use qaren::candidate::Candidate;
use qaren::exec::{CmdOutput, MockRunner};
use qaren::runrecord::{Phase, PidIdentity, RunRecord, RUN_SCHEMA};
use qaren::scenario::Scenario;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

pub fn temp_repo() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "qaren-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(dir.join("test-app")).unwrap();
    std::fs::write(dir.join("test-app").join("package.json"), "{}").unwrap();
    std::fs::write(
        dir.join("test-app").join("pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
    )
    .unwrap();
    dir
}

pub fn script_tracked_file_identity(mock: &mut MockRunner, path: &str, mode: &str) {
    let oid = "a".repeat(40);
    mock.expect_run(
        "ls-tree",
        CmdOutput::success(&format!("{mode} blob {oid}\t{path}\0")),
    );
    mock.expect_run(
        "ls-files",
        CmdOutput::success(&format!("{mode} {oid} 0\t{path}\0")),
    );
}

pub fn ios_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: ios-simulator\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: {port}\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n"
    )
}

pub fn android_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: nuc-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: {port}\nandroid:\n  ssh_host: nuc\n  farm_path: bin/android-farm\n  slot: 1\n  adb_server_port: 15037\n"
    )
}

pub fn scenario_from(yaml: &str) -> Scenario {
    let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
    scenario.validate().unwrap();
    scenario
}

pub fn identity(pid: i32, started_at: &str) -> PidIdentity {
    PidIdentity {
        pid,
        started_at: started_at.to_string(),
        command: "node metro".to_string(),
    }
}

pub fn base_record(
    repo_root: &std::path::Path,
    yaml: &str,
    run_id: &str,
    phase: Phase,
) -> RunRecord {
    let scenario = scenario_from(yaml);
    RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.to_string(),
        created_at: "2026-08-12T16:00:00Z".to_string(),
        scenario,
        scenario_path: repo_root.join("scenario.yaml"),
        scenario_sha256: "0".repeat(64),
        candidate: Candidate {
            repo_root: repo_root.to_path_buf(),
            project_root: repo_root.join("test-app"),
            app_id: "com.rndevagent.testapp".to_string(),
            git_sha: "b".repeat(40),
            git_dirty: false,
            lockfile_sha256: Some("c".repeat(64)),
            worktree_fingerprint: Some(qaren::candidate::worktree_fingerprint("")),
        },
        phase,
        prepare: Some(identity(999, "Wed Aug 12 15:00:00 2026")),
        // Only phases reached after build planning carry a recorded plan,
        // matching what production records can actually contain.
        build: matches!(phase, Phase::Building | Phase::Ready | Phase::Cleaned).then(|| {
            qaren::buildplan::BuildPlan {
                decision: qaren::buildplan::BuildDecision::Clean,
                fingerprint: format!("rnfp1:{}", "e".repeat(64)),
                reason:
                    "no native cache state recorded for this worktree/app; compatibility is unprovable"
                        .to_string(),
                evidence: Vec::new(),
                artifact: None,
                regenerate_native_dir: false,
            }
        }),
        handoff: None,
        resources: Default::default(),
        failure: None,
        history: Vec::new(),
    }
}
