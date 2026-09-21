mod common;

use qaren::core::Budgets;
use qaren::exec::{CmdOutput, MockRunner, Spawned};
use qaren::failure::FailureCode;
use qaren::receipt::ReceiptResult;
use qaren::run::{run, RunRequest};
use qaren::runrecord::{Phase, RunRecord};
use qaren::scenario::Platform;
use std::path::{Path, PathBuf};

const UDID: &str = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
const LSTART: &str = "Wed Aug 12 16:01:00 2026";
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
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run(
        "walk.js --parse",
        CmdOutput::success("{\"ok\":true,\"blocks\":1,\"items\":2}\n"),
    );
    mock.expect_run(
        "simctl list devices booted",
        CmdOutput::success(&booted_json()),
    );
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
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
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
    assert_subsequence(
        &labels(&mock),
        &[
            "node-version",
            "plan-parse",
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
    script_preflight(&mut mock, &repo);
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n")); // holder alive
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

    assert_eq!(receipt.result, ReceiptResult::Refused);
    assert_eq!(
        receipt.failure.as_ref().unwrap().code,
        FailureCode::DeviceBusy
    );
    assert_eq!(receipt.run_id, "none");
    assert_eq!(mock.remaining(), 0);
    assert!(!labels(&mock).iter().any(|l| l == "pnpm-install"));
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

#[test]
fn an_unparseable_plan_refuses_before_the_device_is_touched() {
    let (repo, app) = app_repo();
    let mut mock = MockRunner::new();
    mock.expect_run("node --version", CmdOutput::success("v26.8.1\n"));
    mock.expect_run(
        "walk.js --parse",
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
    script_provision(&mut mock);
    mock.expect_spawn_piped("walk.js", 9000, &pass_stdout(), Some(0));
    script_core_identity(&mut mock);
    // Drift report, then the Metro group: alive, TERM, KILL, and the leader survives both.
    mock.expect_run("git", CmdOutput::success(&format!("{}\n", "b".repeat(40))));
    mock.expect_run(
        "git",
        CmdOutput::success("?? test-app/.qaren/\0?? test-app/plan.md\0"),
    );
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n")));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    mock.expect_run("lsof", CmdOutput::success("6001\n"));
    mock.expect_run("ps", CmdOutput::success("6000\n"));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("/bin/kill", CmdOutput::success(""));
    mock.expect_run("ps", CmdOutput::success(&format!("{LSTART}\n"))); // leader survived
    mock.expect_run("ps", CmdOutput::success("S\n"));

    let receipt = run(&mut mock, &request(&repo, &app, 30));

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
    mock.expect_run(
        "walk.js --parse",
        CmdOutput::success("{\"ok\":true,\"blocks\":1,\"items\":2}\n"),
    );
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
