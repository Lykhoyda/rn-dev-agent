mod common;

use qaren::core::Budgets;
use qaren::exec::{CmdOutput, CmdSpec, HoldStdout, MockRunner, PipedChild, Runner, Spawned};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::run::{run, RunRequest};
use qaren::runrecord::{Phase, RunRecord};
use qaren::scenario::Platform;
use std::path::{Path, PathBuf};

const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
const LSTART: &str = "Wed Aug 12 16:01:00 2026";
const TEST_KEY: &str = "hermetic-typesafe-key";

fn probe_json() -> serde_json::Value {
    serde_json::json!({"calls":1,"medianMs":12,"inputTokens":10,"callDetails":[{
        "scope":"preflight","questionIds":["preflight"],"inputTokens":10,"ms":12,"outcome":"ok","status":200
    }]})
}

fn script_plan(mock: &mut MockRunner, repo: &Path) {
    mock.environment
        .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
    let plan = std::fs::read(repo.join("test-app/plan.md")).unwrap();
    let output = serde_json::json!({"ok":true,"prepared":{
        "hash":qaren::candidate::sha256_hex(&plan),"blocks":[]
    },"jev":probe_json()});
    mock.expect_run(
        "walk.js --preflight",
        CmdOutput::success(&output.to_string()),
    );
}
// MockRunner's clock is frozen until the first sleep, so the run id is deterministic.
fn run_id() -> String {
    format!("check-{}", qaren::timefmt::compact_utc(1_770_000_000_000))
}

fn free_port() -> CmdOutput {
    CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    }
}

// A temp app repo: <repo>/test-app is the project root with .qaren/config.yaml and a plan.
fn app_repo() -> (PathBuf, PathBuf) {
    let repo = common::temp_repo();
    let app = repo.join("test-app");
    std::fs::create_dir_all(app.join(".qaren")).unwrap();
    std::fs::write(
        app.join(".qaren").join("config.yaml"),
        "appId: com.rndevagent.testapp\nmetroPort: 8791\n",
    )
    .unwrap();
    std::fs::write(app.join("plan.md"), "1. Tap \"Tasks\"\n✓ \"Tasks\"\n").unwrap();
    (repo, app)
}

fn request(repo: &Path, app: &Path, step_seconds: u64) -> RunRequest {
    RunRequest {
        project_root: app.to_path_buf(),
        config_path: app.join(".qaren").join("config.yaml"),
        plan_file: app.join("plan.md"),
        platform: Platform::Ios,
        device: None,
        boot_device: false,
        fresh_install: false,
        runtime_dir: PathBuf::from("/runtime"),
        node: Some(PathBuf::from("/usr/local/bin/node")),
        lock_root: repo.join(".locks"),
        runs_root: repo.join("runs"),
        android_home: None,
        budgets: Budgets {
            walk_seconds: 600,
            step_seconds,
        },
    }
}

fn booted_json() -> String {
    format!(
        r#"{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{{"udid":"{UDID}","name":"qa-company-app","state":"Booted","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}}]}}}}"#
    )
}

fn df_ok() -> CmdOutput {
    CmdOutput::success(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk3 976490576 400000000 500000000 45% /\n",
    )
}

const IOS_TOOLS: &[&str] = &["git", "pnpm", "node", "lsof", "curl", "ps", "xcrun"];

// Everything up to and including the lease: preflight, device, candidate, prereqs, port, disk, self identity.
fn script_preflight(mock: &mut MockRunner, repo: &Path) {
    script_preflight_inventory(mock, repo, "simctl list devices booted", &booted_json());
}

fn script_preflight_inventory(mock: &mut MockRunner, repo: &Path, command: &str, inventory: &str) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(mock, repo);
    mock.expect_run(command, CmdOutput::success(inventory));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display()))); // toplevel of cwd
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display()))); // explicit worktree
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run("lsof", free_port());
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n")); // self lstart
    mock.expect_run("ps", CmdOutput::success("qaren check\n")); // self command
}

// deps → build plan → build → readiness → provenance recheck, then the core child spawn identity.
fn script_provision(mock: &mut MockRunner) {
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("ls-files", CmdOutput::success(""));
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
    mock.expect_run("ls-files", CmdOutput::success("")); // fingerprint recheck
}

fn script_core_identity(mock: &mut MockRunner) {
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:02:00 2026\n")); // core lstart
    mock.expect_run("ps", CmdOutput::success("node walk.js\n")); // core command
}

// Drift report (git head + status), then the Metro group teardown: alive, TERM, KILL, gone, port free.
fn script_teardown(mock: &mut MockRunner) {
    script_teardown_core(mock, CmdOutput::success("1 1 S\n6000 6000 S\n"), false);
}

fn script_teardown_core(mock: &mut MockRunner, inventory: CmdOutput, probe_dead_leader: bool) {
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
    mock.expect_run("ps -A", inventory.clone());
    if probe_dead_leader {
        mock.expect_run("ps -p 9000", CmdOutput::failed(1, ""));
        mock.expect_run("ps -A", inventory);
    }
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    mock.expect_run("lsof", free_port());
}

fn envelope(seq: u64, kind: &str, payload: &str) -> String {
    format!(
        r#"{{"v":1,"runId":"{}","seq":{seq},"type":"{kind}","payload":{payload}}}"#,
        run_id()
    )
}

fn row(line: u64, kind: &str) -> String {
    format!(
        r#"{{"block":"plan","line":{line},"attempt":1,"kind":"{kind}","resolvedBy":"exact","screenshot":"screenshots/{line:02}.png","t":{},"outcome":"pass"}}"#,
        line * 100
    )
}

fn pass_stdout() -> String {
    let rows = [row(1, "step"), row(2, "check")];
    let ledger = format!(
        r#"{{"verdict":"PASS","path":"walk","blocks":[{{"key":"plan","outcome":"pass","source":"discovered"}}],"steps":[{}],"jev":{{"calls":0,"medianMs":0}},"llmTurns":0,"escapes":0,"recoveries":0}}"#,
        rows.join(",")
    );
    format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1]),
        envelope(4, "result", &ledger)
    )
}

fn labels(mock: &MockRunner) -> Vec<String> {
    mock.calls.iter().map(|c| c.label.clone()).collect()
}

fn assert_subsequence(haystack: &[String], needles: &[&str]) {
    let mut at = 0;
    for needle in needles {
        match haystack[at..].iter().position(|l| l == needle) {
            Some(i) => at += i + 1,
            None => panic!("{needle} missing after position {at} in {haystack:?}"),
        }
    }
}

#[test]
fn check_runs_the_phases_in_order_and_ends_pass_with_a_report() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.verb, "check");
    assert_eq!(receipt.run_id, run_id());
    assert!(!labels(&mock).iter().any(|l| matches!(
        l.as_str(),
        "fresh-install-admission" | "simctl-listapps" | "simctl-uninstall" | "simctl-bootstatus"
    )));
    assert_subsequence(
        &labels(&mock),
        &[
            "node-version",
            "plan-preflight",
            "simctl-list-booted",
            "git-toplevel",
            "which",
            "lsof-port",
            "df",
            "pnpm-install",
            "git-ls-files",
            "expo-run-ios",
            "metro-status",
            "core-walk",
            "kill-group",
        ],
    );
    let ledger = receipt.ledger.as_ref().unwrap();
    assert_eq!(ledger.verdict, "PASS");
    assert_eq!(ledger.steps, 2);
    assert_eq!(ledger.jev_calls, 0);
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert_eq!(
        receipt.cleanup.get("core").map(String::as_str),
        Some("absent")
    );
    assert_eq!(receipt.cleanup["simulator"], "kept");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(receipt.outcomes["candidate_drift"], "none");

    let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
    assert!(report.starts_with("# QaReN check: PASS"));
    assert!(
        report.contains("- ✓ line 1: 1. Tap \"Tasks\"\n"),
        "{report}"
    );
    assert!(report.contains("- ✓ line 2: ✓ \"Tasks\"\n"), "{report}");
    assert!(
        report.contains("  ![line 1](screenshots/01.png)\n"),
        "{report}"
    );
    assert!(report.contains("jev.calls 0"));

    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    let evidence = record.resources.core_cleanup.as_ref().unwrap();
    assert_eq!(evidence.run_id, run_id());
    assert_eq!(evidence.pgid, 9000);
    assert_eq!(
        evidence.outcome,
        qaren::runrecord::GroupCleanupResult::Absent
    );
    assert_eq!(
        serde_json::to_value(&receipt.core_cleanup).unwrap(),
        serde_json::to_value(evidence).unwrap()
    );
    assert!(record.resources.core.is_none());
    assert!(record.resources.device_borrowed);
    assert!(
        record.resources.lease.is_none(),
        "the lease is released after teardown"
    );
    assert!(record.resources.metro.is_none());
    assert_eq!(record.resources.ios_simulator.as_ref().unwrap().udid, UDID);
    assert!(!repo
        .join(".locks")
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());

    // The child ran in the app root with the lease and Metro port in its environment.
    let core = mock.calls.iter().find(|c| c.label == "core-walk").unwrap();
    assert_eq!(core.cwd.as_deref(), Some(app.as_path()));
    assert!(core.env.iter().any(|(k, _)| k == "QAREN_DEVICE_LEASE"));
    assert!(core
        .env
        .iter()
        .any(|(k, v)| k == "QAREN_METRO_PORT" && v == "8791"));
    let request_line: serde_json::Value =
        serde_json::from_str(mock.piped_stdin_text(0).trim()).unwrap();
    assert_eq!(request_line["payload"]["appId"], "com.rndevagent.testapp");
    assert_eq!(request_line["payload"]["target"]["deviceId"], UDID);
    assert_eq!(
        request_line["payload"]["preflightCalls"],
        probe_json()["callDetails"]
    );
    assert_eq!(receipt.preflight_jev.as_ref().unwrap().calls, 1);
    for call in &mock.calls {
        assert!(!call.rendered().contains(TEST_KEY));
        assert!(!serde_json::to_string(call).unwrap().contains(TEST_KEY));
    }
    assert!(!mock.piped_stdin_text(0).contains(TEST_KEY));
    assert!(!receipt.to_json().contains(TEST_KEY));
    assert_eq!(
        request_line["payload"]["plan"],
        "1. Tap \"Tasks\"\n✓ \"Tasks\"\n"
    );
}

#[test]
fn a_deadline_overrun_fails_naming_the_walk_phase_and_still_tears_down() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    let one_row = format!("{}\n", envelope(2, "row", &row(1, "step")));
    mock.expect_spawn_piped("walk.js", 9000, &one_row, None);
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 5));

    assert_eq!(receipt.result, ReceiptResult::Fail);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
    assert_eq!(failure.phase, "walk");
    assert!(failure.detail.contains("no ledger row within 5s"));
    assert!(
        failure.detail.contains("after line 1"),
        "{}",
        failure.detail
    );
    assert_eq!(mock.remaining(), 0);
    assert!(*mock.piped_killed[0].lock().unwrap());
    assert_eq!(receipt.ledger.as_ref().unwrap().failed_step, Some(1));
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    assert!(record.resources.lease.is_none());
}

#[test]
fn a_leased_device_refuses_before_any_provisioning() {
    for boot in [false, true] {
        let (repo, app) = app_repo();
        let lock_root = repo.join(".locks");
        let mut holder = MockRunner::new();
        let held = qaren::lease::acquire(
            &mut holder,
            &lock_root,
            Platform::Ios,
            UDID,
            "check-earlier",
            Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
        )
        .unwrap();

        let mut mock = MockRunner::new();
        if boot {
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory("Shutdown"),
            );
        } else {
            script_preflight(&mut mock, &repo);
        }
        mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n")); // holder alive
        mock.expect_run("ps", CmdOutput::success("S\n"));

        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        req.boot_device = boot;
        req.device = Some(UDID.to_lowercase()).filter(|_| boot);
        let receipt = run(&mut mock, &req);

        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::DeviceBusy
        );
        assert_eq!(receipt.run_id, "none");
        assert_eq!(mock.remaining(), 0);
        assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
        assert!(!labels(&mock).iter().any(|l| matches!(
            l.as_str(),
            "fresh-install-admission"
                | "simctl-listapps"
                | "simctl-uninstall"
                | "simctl-bootstatus"
        )));
        assert!(
            !repo.join("runs").exists()
                || std::fs::read_dir(repo.join("runs"))
                    .unwrap()
                    .next()
                    .is_none()
        );
        assert_eq!(
            qaren::buildplan::read_holder(&held.lock_dir)
                .unwrap()
                .run_id,
            "check-earlier"
        );
    }
}

#[test]
fn an_unparseable_plan_refuses_before_the_device_is_touched() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.environment
        .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run(
        "walk.js --preflight",
        CmdOutput {
            exit_code: Some(4),
            stdout: r#"{"ok":false,"code":"PLAN_UNPARSEABLE","refused":[{"line":3,"text":"Frobnicate","reason":"no verb"}]}"#.to_string(),
            ..Default::default()
        },
    );
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::PlanUnparseable);
    assert!(
        failure.detail.contains("line 3: no verb"),
        "{}",
        failure.detail
    );
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn an_old_node_refuses_at_preflight() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v22.11.0\n"));
    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::NodeUnsupported
    );
}

#[test]
fn a_child_refusal_is_a_typed_refusal_with_the_child_code() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    let refusal = r#"{"verdict":"REFUSED","code":"METRO_ORIGIN_MISMATCH","message":"scriptURL port 8081 != 8791"}"#;
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", refusal)),
        Some(4),
    );
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));
    assert_eq!(receipt.result, ReceiptResult::Refused);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::MetroOriginMismatch);
    assert!(failure.detail.contains("8081"));
    assert_eq!(mock.remaining(), 0);
    assert_eq!(receipt.cleanup["device_lease"], "removed");
}

#[test]
fn an_unresolved_metro_group_retains_the_device_lease_for_cleanup() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_admission(&mut mock);
    script_app_presence(&mut mock, false);
    script_provision(&mut mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    // Drift report, then the Metro group: alive, TERM, KILL, and the leader survives both.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n6000 6000 S\n"));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // leader survived
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut mock, &req);

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(
        receipt.cleanup["metro"].starts_with("unresolved"),
        "{}",
        receipt.cleanup["metro"]
    );
    assert!(
        receipt.cleanup["device_lease"].starts_with("unresolved: retained: metro"),
        "{}",
        receipt.cleanup["device_lease"]
    );
    assert_eq!(
        receipt.next_action,
        format!("qaren cleanup {} --json", run_id())
    );
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Walking);
    assert!(
        record.resources.lease.is_some(),
        "the lease stays with the run until Metro is proven gone"
    );
    assert!(record.resources.metro.is_some());
    assert!(repo
        .join(".locks")
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());
}

#[test]
fn an_unreadable_disk_budget_fails_closed_before_any_claim() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(&mut mock, &repo);
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(&booted_json()),
    );
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run("lsof", free_port());
    mock.expect_run("df", CmdOutput::failed(1, "df: No such file or directory"));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_ne!(receipt.result, ReceiptResult::Pass);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::PrereqMissing);
    assert_eq!(failure.phase, "preflight");
    assert!(
        failure.detail.contains("df could not report"),
        "{}",
        failure.detail
    );
    assert_eq!(receipt.run_id, "none");
    assert_eq!(mock.remaining(), 0);
    assert!(!repo
        .join(".locks")
        .join(qaren::lease::lock_name(Platform::Ios, UDID))
        .exists());
}

#[test]
fn a_core_group_survivor_retains_the_device_lease() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_provision(&mut mock);
    mock.expect_spawn_piped_holding(
        "walk.js",
        9000,
        &pass_stdout(),
        Some(0),
        HoldStdout::Forever,
    );
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    assert!(
        receipt.cleanup["core"].starts_with("unresolved"),
        "{}",
        receipt.cleanup["core"]
    );
    assert_eq!(receipt.cleanup["metro"], "removed");
    assert!(
        receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"),
        "{}",
        receipt.cleanup["device_lease"]
    );
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert!(record.resources.lease.is_some());
    assert_eq!(record.phase, Phase::Walking);
}

const OTHER_UDID: &str = "76709EFC-0104-4A66-8908-F4F85A76F025";

fn booted_json_two() -> String {
    format!(
        r#"{{"devices":{{"com.apple.CoreSimulator.SimRuntime.iOS-26-5":[{{"udid":"{UDID}","name":"qa-company-app","state":"Booted","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}},{{"udid":"{OTHER_UDID}","name":"other","state":"Booted","deviceTypeIdentifier":"com.apple.CoreSimulator.SimDeviceType.iPhone-17"}}]}}}}"#
    )
}

fn script_preflight_booted(mock: &mut MockRunner, repo: &Path, booted: &str) {
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    script_plan(mock, repo);
    mock.expect_run("simctl list devices booted", CmdOutput::success(booted));
}

#[test]
fn two_booted_simulators_refuse_without_a_device_and_borrow_the_named_one_with_it() {
    let (repo, app) = app_repo();
    let mut refusing = MockRunner::new();
    script_preflight_booted(&mut refusing, &repo, &booted_json_two());
    let receipt = run(&mut refusing, &request(&repo, &app, 30));
    assert_ne!(receipt.result, ReceiptResult::Pass);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert!(receipt
        .failure
        .as_ref()
        .unwrap()
        .detail
        .contains("2 booted"));
    assert_eq!(refusing.remaining(), 0);

    let mut mock = MockRunner::new();
    script_preflight_booted(&mut mock, &repo, &booted_json_two());
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", repo.display())));
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
    for tool in IOS_TOOLS {
        mock.expect_run("which", CmdOutput::success(&format!("/usr/bin/{tool}\n")));
    }
    mock.expect_run("lsof", free_port());
    mock.expect_run("df", df_ok());
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:59:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("qaren check\n"));
    script_provision(&mut mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);

    let mut req = request(&repo, &app, 30);
    req.device = Some(OTHER_UDID.to_string());
    let receipt = run(&mut mock, &req);
    assert_eq!(
        receipt.result,
        ReceiptResult::Pass,
        "failure: {:?}",
        receipt.failure
    );
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&repo.join("runs"), &run_id()).unwrap();
    assert_eq!(
        record.resources.ios_simulator.as_ref().unwrap().udid,
        OTHER_UDID
    );
    assert!(
        repo.join(".locks")
            .join(qaren::lease::lock_name(Platform::Ios, UDID))
            .exists()
            == false
    );
}

#[test]
fn a_named_device_that_is_not_booted_refuses() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_booted(&mut mock, &repo, &booted_json());
    let mut req = request(&repo, &app, 30);
    req.device = Some(OTHER_UDID.to_string());
    let receipt = run(&mut mock, &req);
    assert_ne!(receipt.result, ReceiptResult::Pass);
    let failure = receipt.failure.as_ref().unwrap();
    assert_eq!(failure.code, FailureCode::DeviceUnavailable);
    assert!(failure.detail.contains(OTHER_UDID), "{}", failure.detail);
    assert_eq!(mock.remaining(), 0);
}

#[test]
fn boot_device_requires_ios_and_an_exact_uuid_before_any_preflight() {
    for (platform, device, expected) in [
        (
            Platform::Android,
            Some(UDID),
            FailureCode::PlatformUnsupported,
        ),
        (Platform::Ios, None, FailureCode::DeviceUnavailable),
        (
            Platform::Ios,
            Some("booted"),
            FailureCode::DeviceUnavailable,
        ),
        (
            Platform::Ios,
            Some("qa-company-app"),
            FailureCode::DeviceUnavailable,
        ),
        (
            Platform::Ios,
            Some("1DC408C4-51DA-4C4F-ACA1-39881C916FDG"),
            FailureCode::DeviceUnavailable,
        ),
    ] {
        let (repo, app) = app_repo();
        let mut req = request(&repo, &app, 30);
        req.platform = platform;
        req.device = device.map(str::to_string);
        req.boot_device = true;
        let mut mock = MockRunner::new();
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.failure.unwrap().code, expected);
        assert!(mock.calls.is_empty());
        assert!(!req.lock_root.exists());
        assert!(!req.runs_root.exists());
    }
}

#[test]
fn missing_or_rejected_key_refuses_before_device_or_lease() {
    for supplied in [false, true] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        if supplied {
            mock.environment
                .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
            mock.expect_run("walk.js --preflight", CmdOutput {
                exit_code: Some(4),
                stdout: serde_json::json!({"ok":false,"code":"JEV_UNREACHABLE","message":TEST_KEY,
                    "jev":{"calls":1,"medianMs":5,"inputTokens":0,"callDetails":[{
                        "scope":"preflight","questionIds":["preflight"],"inputTokens":null,"ms":5,"outcome":"http","status":401
                    }]}}).to_string(),
                ..Default::default()
            });
        }
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(
            receipt.failure.as_ref().unwrap().code,
            FailureCode::JevUnreachable
        );
        assert_eq!(receipt.run_id, "none");
        assert!(!repo.join(".locks").exists());
        assert!(!repo.join("runs").exists());
        assert_eq!(mock.remaining(), 0);
        assert!(!receipt.to_json().contains(TEST_KEY));
        assert!(!labels(&mock).iter().any(|l| l == "simctl-list-booted"));
    }
}

#[test]
fn walk_jev_refusals_preserve_prior_passes_and_the_complete_failure_evidence() {
    for (code, expected, status) in [
        ("JEV_AUTH_FAILED", FailureCode::JevAuthFailed, 401),
        ("JEV_REQUEST_INVALID", FailureCode::JevRequestInvalid, 422),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        let jev = serde_json::json!({"calls":2,"medianMs":25,"inputTokens":10,"callDetails":[
            probe_json()["callDetails"][0],
            {"scope":"walk","questionIds":["front"],"inputTokens":null,"ms":38,"outcome":"http","status":status}
        ]});
        let steps = serde_json::json!([
            {"block":"navigation","line":1,"attempt":1,"kind":"step","resolvedBy":"exact","t":10,"outcome":"pass","text":"Open tasks","screenshot":"screenshots/open-tasks.png"},
            {"block":"navigation","line":4,"attempt":1,"kind":"check","resolvedBy":"jev","t":20,"outcome":"pass","text":"Check home","screenshot":"screenshots/home.png"},
            {"block":"account","line":9,"attempt":1,"kind":"check","resolvedBy":"jev","t":30,"outcome":"fail","text":"Check account","reason":"judgment refused","screenshot":"screenshots/row-nine.png"}
        ]);
        let blocks = serde_json::json!([
            {"key":"navigation","outcome":"pass","source":"discovered"},
            {"key":"account","outcome":"fail","source":"discovered"}
        ]);
        let failure = serde_json::json!({"step":9,"seen":format!("{code}: distinct account screen evidence"),"screenshot":"screenshots/refusal-evidence.png"});
        let refusal = serde_json::json!({"verdict":"REFUSED","code":code,"message":"judgment refused","lease":"fixture-lease",
            "path":"walk","steps":steps,"blocks":blocks,"failure":failure,"jev":jev,"llmTurns":1,"escapes":2,"recoveries":3});
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!(
                "{}\n{}\n{}\n{}\n{}\n",
                envelope(2, "row", &row(0, "step")),
                envelope(3, "row", &steps[0].to_string()),
                envelope(4, "row", &steps[1].to_string()),
                envelope(5, "row", &steps[2].to_string()),
                envelope(6, "result", &refusal.to_string())
            ),
            Some(4),
        );
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        let receipt = run(&mut mock, &request(&repo, &app, 5));
        assert_eq!(receipt.result, ReceiptResult::Refused);
        assert_eq!(receipt.outcomes["core_exit"], "4");
        assert_eq!(receipt.failure.as_ref().unwrap().code, expected);
        assert_eq!(receipt.ledger.as_ref().unwrap().verdict, "REFUSED");
        assert_eq!(receipt.ledger.as_ref().unwrap().steps, 3);
        assert_eq!(receipt.ledger.as_ref().unwrap().failed_step, Some(9));
        assert_eq!(receipt.ledger.as_ref().unwrap().jev_calls, 2);
        assert_eq!(receipt.ledger.as_ref().unwrap().jev_input_tokens, 10);
        assert_eq!(receipt.ledger.as_ref().unwrap().jev_median_ms, 25);
        let ledger: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&receipt.artifacts["ledger"]).unwrap()).unwrap();
        assert_eq!(ledger["jev"], jev);
        assert_eq!(ledger["failure"], failure);
        assert_eq!(ledger["steps"], steps);
        assert_eq!(ledger["blocks"], blocks);
        assert_eq!(ledger["path"], "walk");
        assert_eq!(ledger["llmTurns"], 1);
        assert_eq!(ledger["escapes"], 2);
        assert_eq!(ledger["recoveries"], 3);
        let report = std::fs::read_to_string(&receipt.artifacts["report"]).unwrap();
        assert!(report.starts_with("# QaReN check: REFUSED"));
        assert!(report.contains("- ✓ line 1: Open tasks"));
        assert!(report.contains("- ✓ line 4: Check home"));
        assert!(report.contains("- ✗ line 9: Check account — judgment refused"));
        assert!(report.contains("![line 9](screenshots/row-nine.png)"));
        assert!(report.contains("![failure](screenshots/refusal-evidence.png)"));
        assert!(report.contains(&format!(
            "Step 9: {}: distinct account screen evidence",
            code.replace('_', "\\_")
        )));
        assert!(report.contains("- navigation: pass (discovered)"));
        assert!(report.contains("- account: fail (discovered)"));
        assert!(report.contains(&code.replace('_', "\\_")), "{report}");
        assert!(report.contains("jev.calls 2 · jev.medianMs 25 · jev.inputTokens 10"));
        assert!(report.contains("llmTurns 1 · escapes 2 · recoveries 3 · path walk"));
        assert_eq!(
            RunRecord::load(&repo.join("runs"), &run_id())
                .unwrap()
                .failure
                .unwrap()
                .code,
            expected
        );
        assert_eq!(mock.remaining(), 0);
    }
}

#[test]
fn invalid_preflight_payload_cannot_claim_a_device() {
    for output in [
        "not json",
        r#"{"ok":true}"#,
        r#"{"ok":true,"prepared":{"hash":"wrong","blocks":[]},"jev":{"calls":0,"medianMs":0}}"#,
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        mock.environment
            .insert("TYPESAFE_API_KEY".into(), TEST_KEY.into());
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        mock.expect_run("walk.js --preflight", CmdOutput::success(output));
        let receipt = run(&mut mock, &request(&repo, &app, 30));
        assert_eq!(receipt.failure.unwrap().code, FailureCode::JevUnreachable);
        assert!(!repo.join(".locks").exists());
    }
}

#[test]
fn fresh_install_refuses_unknown_foreign_admission_before_mutation() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        CmdOutput::success(
            &serde_json::json!({"v":1,"platform":"ios","deviceId":UDID,"status":"unknown"})
                .to_string(),
        ),
    );
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut mock, &req);
    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(receipt.failure.unwrap().phase, "fresh_install");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(mock.remaining(), 0);
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Failed);
    assert!(record.resources.lease.is_none());
}

struct LeaseObservedRunner {
    mock: MockRunner,
    repo: PathBuf,
    wire: Option<String>,
    observed: Vec<String>,
    expect_fresh_install: bool,
}

impl LeaseObservedRunner {
    fn observe(&mut self, spec: &CmdSpec) {
        if spec.label != "fresh-install-admission" && self.wire.is_none() {
            return;
        }
        let record = RunRecord::load(&self.repo.join("runs"), &run_id()).unwrap();
        let lease = record
            .resources
            .lease
            .as_ref()
            .expect("durable lease during every owned phase");
        let holder = qaren::buildplan::read_holder(&lease.lock_dir).expect("lease lock present");
        assert_eq!(holder.run_id, record.run_id);
        assert_eq!(holder.holder, lease.holder);
        assert_eq!(record.resources.ios_simulator.as_ref().unwrap().udid, UDID);
        assert!(record.resources.device_borrowed);
        if matches!(spec.label.as_str(), "simctl-install" | "expo-run-ios") {
            assert_eq!(
                record.resources.fresh_install.is_some(),
                self.expect_fresh_install
            );
        }
        if self.expect_fresh_install
            && matches!(spec.label.as_str(), "simctl-install" | "expo-run-ios")
        {
            let stored = serde_json::to_value(&record).unwrap();
            assert_eq!(
                stored["resources"]["fresh_install"]["status"],
                "proven_absent"
            );
            assert_eq!(stored["resources"]["fresh_install"]["run_id"], run_id());
            assert_eq!(stored["resources"]["fresh_install"]["device_id"], UDID);
            assert_eq!(
                stored["resources"]["fresh_install"]["app_id"],
                "com.rndevagent.testapp"
            );
        }
        if let Some(wire) = &self.wire {
            assert_eq!(wire, &lease.wire(), "same lease spans all phases");
        } else {
            self.wire = Some(lease.wire());
        }
        self.observed.push(spec.label.clone());
    }
}

impl Runner for LeaseObservedRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.mock.env_var(name)
    }
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        self.observe(spec);
        self.mock.run(spec)
    }
    fn run_private(&mut self, spec: &CmdSpec, input: &[u8]) -> qaren::exec::PrivateOutput {
        self.observe(spec);
        assert!(!RunRecord::run_dir(&self.repo.join("runs"), &run_id())
            .join("installed-apps.plist")
            .exists());
        self.mock.run_private(spec, input)
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.observe(spec);
        self.mock.spawn_group(spec, log)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.observe(spec);
        self.mock.spawn_piped(spec, log)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.mock.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.mock.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.mock.commands_executed()
    }
}

fn script_admission(mock: &mut MockRunner) {
    mock.expect_run(
        "fresh-install-preflight.js --platform ios --device",
        CmdOutput::success(
            &serde_json::json!({"v":1,"platform":"ios","deviceId":UDID,"status":"clear"})
                .to_string(),
        ),
    );
}

fn script_app_presence(mock: &mut MockRunner, installed: bool) {
    mock.expect_run(
        &format!("simctl listapps {UDID}"),
        CmdOutput::success(include_str!("fixtures/installed-apps.plist")),
    );
    mock.expect_run(
        "plutil -convert json -o -",
        CmdOutput::success(if installed {
            r#"{"com.rndevagent.testapp":{"CFBundleIdentifier":"com.rndevagent.testapp"}}"#
        } else {
            "{}"
        }),
    );
}

#[test]
fn fresh_install_reset_build_readiness_walk_and_teardown_share_one_durable_lease() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight(&mut mock, &repo);
    script_admission(&mut mock);
    script_app_presence(&mut mock, true);
    mock.expect_run(
        &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
        CmdOutput::success(""),
    );
    script_app_presence(&mut mock, false);
    script_provision(&mut mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    script_teardown(&mut mock);
    let mut runner = LeaseObservedRunner {
        mock,
        repo: repo.clone(),
        wire: None,
        observed: Vec::new(),
        expect_fresh_install: true,
    };
    let mut req = request(&repo, &app, 30);
    req.fresh_install = true;
    let receipt = run(&mut runner, &req);
    assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
    assert_eq!(receipt.outcomes["fresh_install"], "proven_absent");
    assert_eq!(receipt.cleanup["device_lease"], "removed");
    assert_eq!(runner.mock.remaining(), 0);
    assert_subsequence(
        &runner.observed,
        &[
            "fresh-install-admission",
            "simctl-listapps",
            "simctl-uninstall",
            "simctl-listapps",
            "pnpm-install",
            "expo-run-ios",
            "metro-status",
            "core-walk",
            "kill-group",
        ],
    );
    let child_request: serde_json::Value =
        serde_json::from_str(runner.mock.piped_stdin_text(0).trim()).unwrap();
    assert_eq!(child_request["payload"]["lease"], runner.wire.unwrap());
    let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
    assert_eq!(record.phase, Phase::Cleaned);
    assert!(record.resources.lease.is_none());
    assert_eq!(
        serde_json::to_value(&receipt.fresh_install).unwrap(),
        serde_json::to_value(&record.resources.fresh_install).unwrap()
    );
    let stored = std::fs::read_to_string(RunRecord::path(&req.runs_root, &run_id())).unwrap();
    for output in [
        stored,
        receipt.to_json(),
        serde_json::to_string(&runner.mock.calls).unwrap(),
    ] {
        assert!(!output.contains("com.private.unrelated"));
        assert!(!output.contains("/private/fixture"));
    }
}

#[test]
fn fresh_install_resets_or_proves_absence_before_cached_install_under_the_same_lease() {
    use qaren::buildplan::{self, ArtifactKind, CachedArtifact, NativeCacheState, CACHE_SCHEMA};
    for installed in [false, true] {
        let (repo, app) = app_repo();
        std::fs::write(
            app.join(".qaren/config.yaml"),
            "appId: com.rndevagent.testapp\nmetroPort: 8791\ndevClientScheme: rndatest\n",
        )
        .unwrap();
        let cached = repo.join("cached/testapp.app");
        std::fs::create_dir_all(&cached).unwrap();
        std::fs::write(cached.join("binary"), "native bits").unwrap();
        let mut fp_mock = MockRunner::new();
        fp_mock.expect_run("ls-files", CmdOutput::success(""));
        let fp = qaren::fingerprint::compute(&mut fp_mock, &repo, &app, "ios").unwrap();
        buildplan::save_json(
            &buildplan::state_path(&repo, "ios", "com.rndevagent.testapp"),
            &NativeCacheState {
                schema: CACHE_SCHEMA.to_string(),
                platform: "ios".into(),
                app_id: "com.rndevagent.testapp".into(),
                worktree_root: repo.canonicalize().unwrap(),
                fingerprint: fp.value,
                built_at: "2026-08-13T00:00:00Z".into(),
                candidate_sha: "a".repeat(40),
                lockfile_sha256: "c".repeat(64),
                generated_native_dirs: vec!["ios".into()],
                artifact: Some(CachedArtifact {
                    sha256: buildplan::hash_artifact(&cached).unwrap(),
                    path: cached,
                    kind: ArtifactKind::AppBundle,
                }),
            },
        )
        .unwrap();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_admission(&mut mock);
        if installed {
            script_app_presence(&mut mock, true);
            mock.expect_run(
                &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
                CmdOutput::success(""),
            );
        }
        script_app_presence(&mut mock, false);
        mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
        mock.expect_run("ls-files", CmdOutput::success(""));
        mock.expect_run(&format!("simctl install {UDID}"), CmdOutput::success(""));
        mock.expect_spawn(
            "expo start",
            Spawned {
                pid: 6000,
                pgid: 6000,
            },
        );
        mock.expect_run("ps", CmdOutput::success(LSTART));
        mock.expect_run("ps", CmdOutput::success("node expo start"));
        for launch in [true, false] {
            mock.expect_run("ps", CmdOutput::success(LSTART));
            mock.expect_run("ps", CmdOutput::success("S"));
            mock.expect_run("lsof", CmdOutput::success("6001"));
            mock.expect_run("ps", CmdOutput::success("6000"));
            mock.expect_run("curl", CmdOutput::success("packager-status:running"));
            if launch {
                mock.expect_run(&format!("simctl openurl {UDID}"), CmdOutput::success(""));
            }
        }
        mock.expect_run(
            "simctl get_app_container",
            CmdOutput::success("/containers/app"),
        );
        mock.expect_run(
            "simctl spawn",
            CmdOutput::success("512\t0\tUIKitApplication:com.rndevagent.testapp[abc]"),
        );
        mock.expect_run("ls-files", CmdOutput::success(""));
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown(&mut mock);
        let mut runner = LeaseObservedRunner {
            mock,
            repo: repo.clone(),
            wire: None,
            observed: Vec::new(),
            expect_fresh_install: true,
        };
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        let receipt = run(&mut runner, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass, "{:?}", receipt.failure);
        assert_eq!(
            receipt.build.unwrap().decision,
            buildplan::BuildDecision::Reuse
        );
        assert_eq!(receipt.outcomes["fresh_install"], "proven_absent");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(runner.mock.remaining(), 0);
        assert_subsequence(
            &runner.observed,
            &[
                "fresh-install-admission",
                "simctl-listapps",
                "simctl-install",
                "metro-status",
                "core-walk",
                "kill-group",
            ],
        );
        assert_eq!(
            runner
                .observed
                .iter()
                .filter(|label| *label == "simctl-uninstall")
                .count(),
            usize::from(installed)
        );
        assert!(!runner.observed.iter().any(|label| label == "expo-run-ios"));
    }
}

#[test]
fn fresh_install_and_boot_device_require_valid_matching_clear_admission_with_success_exit() {
    let response = |status: &str, device: &str| {
        serde_json::json!({
            "v":1, "platform":"ios", "deviceId":device, "status":status,
        })
        .to_string()
    };
    for (fresh, boot) in [(true, false), (false, true), (true, true)] {
        for (output, expected) in [
            (
                CmdOutput::failed(1, "entry point missing"),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput::success("not json"),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput::success(&response("clear", OTHER_UDID)),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput::success(&response("cleared", UDID)),
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: response("clear", UDID),
                    ..Default::default()
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success(&response("clear", UDID))
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: response("unknown", UDID),
                    ..Default::default()
                },
                FailureCode::FreshInstallAdmissionUnknown,
            ),
            (
                CmdOutput {
                    exit_code: Some(4),
                    stdout: response("busy", UDID),
                    ..Default::default()
                },
                FailureCode::DeviceBusy,
            ),
        ] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            if boot {
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory("Shutdown"),
                );
            } else {
                script_preflight(&mut mock, &repo);
            }
            mock.expect_run("fresh-install-preflight.js", output);
            let mut req = request(&repo, &app, 30);
            req.fresh_install = fresh;
            req.boot_device = boot;
            req.device = Some(UDID.to_string()).filter(|_| boot);
            let mut runner = LeaseObservedRunner {
                mock,
                repo,
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let receipt = run(&mut runner, &req);
            assert_eq!(receipt.result, ReceiptResult::Refused);
            assert_eq!(receipt.failure.unwrap().code, expected);
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(runner.observed, ["fresh-install-admission"]);
            assert_eq!(runner.mock.remaining(), 0);
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert_eq!(record.phase, Phase::Failed);
            assert_eq!(record.failure.unwrap().code, expected);
        }
    }
}

#[test]
fn fresh_install_unknown_inventory_never_authorizes_install_or_build() {
    for after_uninstall in [false, true] {
        for (list, converted) in [
            (CmdOutput::failed(1, "simulator unavailable"), None),
            (
                CmdOutput {
                    stderr: "incomplete inventory".into(),
                    ..CmdOutput::success("{}")
                },
                None,
            ),
            (
                CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success("{}")
                },
                None,
            ),
            (
                CmdOutput::success("bad plist"),
                Some(CmdOutput::failed(1, "invalid plist")),
            ),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput::success("not json")),
            ),
            (CmdOutput::success("plist"), Some(CmdOutput::success("[]"))),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput::success(r#"{"error":{}}"#)),
            ),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput {
                    stderr: "incomplete conversion".into(),
                    ..CmdOutput::success("{}")
                }),
            ),
            (
                CmdOutput::success("plist"),
                Some(CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success("{}")
                }),
            ),
        ] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight(&mut mock, &repo);
            script_admission(&mut mock);
            if after_uninstall {
                script_app_presence(&mut mock, true);
                mock.expect_run("simctl uninstall", CmdOutput::success(""));
            }
            mock.expect_run("simctl listapps", list);
            if let Some(output) = converted {
                mock.expect_run("plutil -convert json", output);
            }
            let mut req = request(&repo, &app, 30);
            req.fresh_install = true;
            let receipt = run(&mut mock, &req);
            assert_eq!(receipt.result, ReceiptResult::Refused);
            assert_eq!(
                receipt.failure.unwrap().code,
                FailureCode::AppPresenceUnknown
            );
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(mock.remaining(), 0);
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert_eq!(record.phase, Phase::Failed);
            assert_eq!(
                record.failure.unwrap().code,
                FailureCode::AppPresenceUnknown
            );
        }
    }
}

#[test]
fn fresh_install_requires_uninstall_success_and_proven_absence() {
    for output in [
        CmdOutput::failed(1, "denied"),
        CmdOutput {
            timed_out: true,
            ..Default::default()
        },
        CmdOutput::success(""),
    ] {
        let (repo, app) = app_repo();
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_admission(&mut mock);
        script_app_presence(&mut mock, true);
        let ok = output.ok();
        mock.expect_run("simctl uninstall", output);
        if ok {
            script_app_presence(&mut mock, true);
        }
        let mut req = request(&repo, &app, 30);
        req.fresh_install = true;
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Failed);
        assert_eq!(receipt.failure.unwrap().code, FailureCode::AppResetFailed);
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(mock.remaining(), 0);
        assert_eq!(
            RunRecord::load(&req.runs_root, &run_id()).unwrap().phase,
            Phase::Failed
        );
    }
}

fn available_inventory(state: &str) -> String {
    let mut inventory: serde_json::Value = serde_json::from_str(&booted_json_two()).unwrap();
    let sims = inventory["devices"]["com.apple.CoreSimulator.SimRuntime.iOS-26-5"]
        .as_array_mut()
        .unwrap();
    for sim in sims.iter_mut() {
        sim["isAvailable"] = true.into();
    }
    sims[0]["state"] = state.into();
    inventory.to_string()
}

#[test]
fn boot_device_selection_refuses_unknown_inventory_without_claiming_or_falling_back() {
    let available = available_inventory("Shutdown");
    for output in [
        CmdOutput::failed(1, "unavailable"),
        CmdOutput::success("not json"),
        CmdOutput::success("{}"),
        CmdOutput::success(&available.replace(UDID, &UDID.to_lowercase())),
        CmdOutput::success(&available.replace(UDID, OTHER_UDID)),
        CmdOutput::success(&available.replace(OTHER_UDID, UDID)),
        CmdOutput::success(&available.replace("Shutdown", "Booting")),
        CmdOutput::success(&available.replace("iOS-26-5", "watchOS-26-5")),
        CmdOutput::success(&available.replace("\"isAvailable\":true", "\"isAvailable\":false")),
        CmdOutput {
            stderr: "incomplete".into(),
            ..CmdOutput::success(&available)
        },
        CmdOutput {
            timed_out: true,
            ..CmdOutput::success(&available)
        },
    ] {
        let (repo, app) = app_repo();
        let mut req = request(&repo, &app, 30);
        req.device = Some(UDID.into());
        req.boot_device = true;
        let mut mock = MockRunner::new();
        mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
        script_plan(&mut mock, &repo);
        mock.expect_run("simctl list devices -j", output);
        let receipt = run(&mut mock, &req);
        assert_eq!(
            receipt.failure.unwrap().code,
            FailureCode::DeviceUnavailable
        );
        assert_eq!(mock.remaining(), 0);
        assert!(!req.lock_root.exists());
        assert!(!req.runs_root.exists());
    }
}

#[test]
fn without_boot_device_a_shutdown_selection_still_refuses_even_with_a_booted_ambient_simulator() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    script_preflight_booted(&mut mock, &repo, &available_inventory("Shutdown"));
    let mut req = request(&repo, &app, 30);
    req.device = Some(UDID.into());
    let receipt = run(&mut mock, &req);
    assert_eq!(
        receipt.failure.unwrap().code,
        FailureCode::DeviceUnavailable
    );
    assert_eq!(mock.remaining(), 0);
    assert!(!req.lock_root.exists());
    assert!(!req.runs_root.exists());
}

#[test]
fn boot_device_failure_or_timeout_stops_before_readback_reset_install_or_walk() {
    for fresh in [false, true] {
        for output in [
            CmdOutput::failed(1, "boot failed"),
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("")
            },
        ] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory("Shutdown"),
            );
            script_admission(&mut mock);
            mock.expect_run(&format!("simctl bootstatus {UDID} -b"), output);
            let mut runner = LeaseObservedRunner {
                mock,
                repo: repo.clone(),
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let mut req = request(&repo, &app, 30);
            req.device = Some(UDID.into());
            req.boot_device = true;
            req.fresh_install = fresh;
            let receipt = run(&mut runner, &req);
            assert_eq!(receipt.result, ReceiptResult::Failed);
            assert_eq!(
                receipt.failure.unwrap().code,
                FailureCode::SimulatorBootFailed
            );
            assert_eq!(
                runner.observed,
                ["fresh-install-admission", "simctl-bootstatus"]
            );
            assert_eq!(runner.mock.remaining(), 0);
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(receipt.cleanup["simulator"], "kept");
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert_eq!(record.phase, Phase::Failed);
            assert_eq!(
                record.failure.unwrap().code,
                FailureCode::SimulatorBootFailed
            );
            assert!(record.resources.device_borrowed);
            assert!(record.resources.lease.is_none());
            assert!(record.resources.fresh_install.is_none());
        }
    }
}

#[test]
fn boot_device_readback_must_prove_exact_booted_target_and_unchanged_runtime_and_type() {
    let ready = available_inventory("Booted");
    for fresh in [false, true] {
        for initial in ["Shutdown", "Booted"] {
            for output in [
                CmdOutput::failed(1, "inventory failed"),
                CmdOutput::success("not json"),
                CmdOutput::success(&available_inventory("Shutdown")),
                CmdOutput::success(&ready.replace(UDID, OTHER_UDID)),
                CmdOutput::success(&ready.replace(OTHER_UDID, UDID)),
                CmdOutput::success(&ready.replace(UDID, &UDID.to_lowercase())),
                CmdOutput::success(&ready.replace("iOS-26-5", "iOS-26-4")),
                CmdOutput::success(&ready.replace("iPhone-17", "iPhone-16")),
                CmdOutput::success(&ready.replace("\"isAvailable\":true", "\"isAvailable\":false")),
                CmdOutput {
                    timed_out: true,
                    ..CmdOutput::success(&ready)
                },
                CmdOutput {
                    stderr: "incomplete".into(),
                    ..CmdOutput::success(&ready)
                },
            ] {
                let (repo, app) = app_repo();
                let mut mock = MockRunner::new();
                script_preflight_inventory(
                    &mut mock,
                    &repo,
                    "simctl list devices -j",
                    &available_inventory(initial),
                );
                script_admission(&mut mock);
                if initial == "Shutdown" {
                    mock.expect_run(
                        &format!("simctl bootstatus {UDID} -b"),
                        CmdOutput::success(""),
                    );
                }
                mock.expect_run("simctl list devices -j", output);
                let mut runner = LeaseObservedRunner {
                    mock,
                    repo: repo.clone(),
                    wire: None,
                    observed: Vec::new(),
                    expect_fresh_install: fresh,
                };
                let mut req = request(&repo, &app, 30);
                req.device = Some(UDID.into());
                req.boot_device = true;
                req.fresh_install = fresh;
                let receipt = run(&mut runner, &req);
                assert_eq!(receipt.result, ReceiptResult::Failed);
                assert_eq!(
                    receipt.failure.unwrap().code,
                    FailureCode::SimulatorBootFailed
                );
                let expected = if initial == "Shutdown" {
                    vec![
                        "fresh-install-admission",
                        "simctl-bootstatus",
                        "simctl-list",
                    ]
                } else {
                    vec!["fresh-install-admission", "simctl-list"]
                };
                assert_eq!(runner.observed, expected);
                assert_eq!(runner.mock.remaining(), 0);
                assert_eq!(receipt.cleanup["device_lease"], "removed");
                assert_eq!(receipt.cleanup["simulator"], "kept");
                let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
                assert_eq!(
                    record.failure.unwrap().code,
                    FailureCode::SimulatorBootFailed
                );
                assert!(record.resources.device_borrowed);
                assert!(record.resources.lease.is_none());
                assert!(record.resources.fresh_install.is_none());
            }
        }
    }
}

#[test]
fn boot_device_admission_boot_readback_and_walk_share_a_durable_borrowed_lease() {
    for fresh in [false, true] {
        for initial in ["Shutdown", "Booted"] {
            let (repo, app) = app_repo();
            let mut mock = MockRunner::new();
            script_preflight_inventory(
                &mut mock,
                &repo,
                "simctl list devices -j",
                &available_inventory(initial),
            );
            script_admission(&mut mock);
            if initial == "Shutdown" {
                mock.expect_run(
                    &format!("simctl bootstatus {UDID} -b"),
                    CmdOutput::success(""),
                );
            }
            mock.expect_run(
                "simctl list devices -j",
                CmdOutput::success(&available_inventory("Booted")),
            );
            if fresh {
                script_app_presence(&mut mock, true);
                mock.expect_run(
                    &format!("simctl uninstall {UDID} com.rndevagent.testapp"),
                    CmdOutput::success(""),
                );
                script_app_presence(&mut mock, false);
            }
            script_provision(&mut mock);
            mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
            script_core_identity(&mut mock);
            script_teardown(&mut mock);
            let mut runner = LeaseObservedRunner {
                mock,
                repo: repo.clone(),
                wire: None,
                observed: Vec::new(),
                expect_fresh_install: fresh,
            };
            let mut req = request(&repo, &app, 30);
            req.device = Some(UDID.to_lowercase());
            req.boot_device = true;
            req.fresh_install = fresh;
            let receipt = run(&mut runner, &req);
            assert_eq!(
                receipt.result,
                ReceiptResult::Pass,
                "{initial} fresh={fresh}: {:?}",
                receipt.failure
            );
            assert_eq!(runner.mock.remaining(), 0);
            assert_eq!(receipt.cleanup["device_lease"], "removed");
            assert_eq!(receipt.cleanup["simulator"], "kept");
            let mut phases = vec!["fresh-install-admission"];
            if initial == "Shutdown" {
                phases.push("simctl-bootstatus");
            }
            phases.push("simctl-list");
            if fresh {
                phases.extend(["simctl-listapps", "simctl-uninstall", "simctl-listapps"]);
            }
            phases.extend([
                "pnpm-install",
                "expo-run-ios",
                "metro-status",
                "core-walk",
                "kill-group",
            ]);
            assert_subsequence(&runner.observed, &phases);
            for spec in &runner.mock.calls {
                assert!(!spec.rendered().contains(OTHER_UDID));
                assert!(!matches!(
                    spec.label.as_str(),
                    "simctl-create" | "simctl-shutdown" | "simctl-delete"
                ));
                if spec.label == "simctl-bootstatus" {
                    assert_eq!(spec.args, ["simctl", "bootstatus", UDID, "-b"]);
                    assert_eq!(
                        spec.timeout_seconds,
                        qaren::scenario::Deadlines::default().device_boot_seconds
                    );
                }
                if spec.label == "simctl-list" {
                    assert_eq!(spec.timeout_seconds, 30);
                }
                if spec.label == "expo-run-ios" {
                    assert!(spec.args.windows(2).any(|args| args == ["--device", UDID]));
                }
            }
            if !fresh {
                assert!(!runner
                    .observed
                    .iter()
                    .any(|l| matches!(l.as_str(), "simctl-listapps" | "simctl-uninstall")));
                assert!(receipt.fresh_install.is_none());
            }
            assert_eq!(
                runner
                    .observed
                    .iter()
                    .filter(|l| *l == "simctl-bootstatus")
                    .count(),
                usize::from(initial == "Shutdown")
            );
            let child: serde_json::Value =
                serde_json::from_str(runner.mock.piped_stdin_text(0).trim()).unwrap();
            assert_eq!(child["payload"]["target"]["deviceId"], UDID);
            assert_eq!(child["payload"]["lease"], runner.wire.unwrap());
            let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
            assert!(record.resources.device_borrowed);
            assert!(record.resources.lease.is_none());
            assert_eq!(record.resources.fresh_install.is_some(), fresh);
            assert!(!req
                .lock_root
                .join(qaren::lease::lock_name(Platform::Ios, UDID))
                .exists());
        }
    }
}

#[test]
fn closed_stdout_and_dead_leader_do_not_release_an_unproven_core_group() {
    for (inventory, probe_dead_leader) in [
        (CmdOutput::success("1 1 S\n9001 9000 S\n"), true),
        (CmdOutput::failed(1, "ps denied"), false),
        (CmdOutput::success(""), false),
        (CmdOutput::success("not a process table"), false),
        (CmdOutput::success("1 1 S"), false),
        (CmdOutput::success("1 1 Sgarbage\n"), false),
        (CmdOutput::success("1 1 S\n1 1 S\n"), false),
        (
            CmdOutput {
                timed_out: true,
                ..CmdOutput::success("1 1 S\n")
            },
            false,
        ),
    ] {
        let (repo, app) = app_repo();
        let req = request(&repo, &app, 30);
        let mut mock = MockRunner::new();
        script_preflight(&mut mock, &repo);
        script_provision(&mut mock);
        mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
        script_core_identity(&mut mock);
        script_teardown_core(&mut mock, inventory, probe_dead_leader);
        let receipt = run(&mut mock, &req);
        assert_eq!(receipt.result, ReceiptResult::Pass);
        assert!(receipt.cleanup["core"].starts_with("unresolved"));
        assert!(receipt.cleanup["device_lease"].starts_with("unresolved: retained: core"));
        assert_eq!(mock.remaining(), 0);
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert_eq!(record.resources.core.as_ref().unwrap().pgid, 9000);
        assert_eq!(
            record.resources.core_cleanup.unwrap().outcome,
            qaren::runrecord::GroupCleanupResult::Unresolved
        );
        let lease = record.resources.lease.unwrap();
        assert!(lease.lock_dir.exists());

        let mut cleanup = MockRunner::new();
        cleanup.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
        let receipt = qaren::commands::cleanup::cleanup(&mut cleanup, &req.runs_root, &run_id());
        assert_eq!(
            receipt.result,
            ReceiptResult::Cleaned,
            "{:?}",
            receipt.failure
        );
        assert_eq!(receipt.cleanup["core"], "absent");
        assert_eq!(receipt.cleanup["device_lease"], "removed");
        assert_eq!(cleanup.remaining(), 0);
        assert!(!lease.lock_dir.exists());
        let record = RunRecord::load(&req.runs_root, &run_id()).unwrap();
        assert!(record.resources.core.is_none());
        assert_eq!(
            record.resources.core_cleanup.unwrap().outcome,
            qaren::runrecord::GroupCleanupResult::Absent
        );
    }
}
