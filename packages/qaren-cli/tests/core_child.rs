mod common;

use qaren::core::{self, Budgets, CoreRequest, CoreTarget, Verdict};
use qaren::exec::{CmdOutput, CmdSpec, HoldStdout, MockRunner, PipedChild, Runner, Spawned};
use qaren::failure::FailureCode;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Duration;

const RUN: &str = "check-20260921T100000Z";

#[test]
fn fresh_admission_command_pins_runtime_node_device_cwd_and_deadline_without_adopting_a_lease() {
    let observer = std::env::current_exe()
        .unwrap()
        .into_os_string()
        .into_string()
        .unwrap();
    let mut mock = MockRunner::new();
    mock.expect_run(
        "fresh-install-preflight.js",
        CmdOutput::success(r#"{"v":1,"platform":"ios","deviceId":"AAAA-1111","status":"clear"}"#),
    );
    core::fresh_install_admission(
        &mut mock,
        Path::new("/opt/node bin/node"),
        Path::new("/runtime path"),
        Path::new("/app path"),
        "AAAA-1111",
    )
    .unwrap();
    assert_eq!(
        mock.calls,
        [CmdSpec::new(
            "fresh-install-admission",
            "/opt/node bin/node",
            &[
                "/runtime path/qa/fresh-install-preflight.js",
                "--platform",
                "ios",
                "--device",
                "AAAA-1111",
                "--process-observer",
                &observer,
            ],
            30
        )
        .cwd(Path::new("/app path"))]
    );
}

fn request() -> CoreRequest {
    CoreRequest {
        run_id: RUN.to_string(),
        t0: 1_770_000_000_000,
        plan: "1. Tap \"Tasks\"\n✓ \"Tasks\"\n".to_string(),
        prepared: serde_json::json!({"hash":"test","blocks":[]}),
        preflight_calls: vec![],
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        run_dir: PathBuf::from("/tmp/qaren-runs/check"),
        lease: format!("{RUN}:abcdef0123456789abcdef0123456789"),
        target: CoreTarget {
            device_id: "AAAA-1111".to_string(),
            metro_port: 8791,
            metro_url_for_device: "http://127.0.0.1:8791".to_string(),
            worktree: PathBuf::from("/tmp/app"),
            adb: None,
        },
    }
}

fn budgets() -> Budgets {
    Budgets {
        walk_seconds: 60,
        step_seconds: 10,
    }
}

fn envelope(seq: u64, kind: &str, payload: &str) -> String {
    format!(r#"{{"v":1,"runId":"{RUN}","seq":{seq},"type":"{kind}","payload":{payload}}}"#)
}

fn row(line: u64, attempt: u64, outcome: &str) -> String {
    format!(
        r#"{{"block":"plan","line":{line},"attempt":{attempt},"kind":"step","resolvedBy":"exact","ref":"@e3","screenshot":"screenshots/{line:02}.png","t":{},"outcome":"{outcome}","text":"Tap \"Tasks\""}}"#,
        line * 100
    )
}

fn pass_ledger(rows: &[String]) -> String {
    format!(
        r#"{{"verdict":"PASS","path":"walk","blocks":[{{"key":"plan","outcome":"pass","source":"discovered"}}],"steps":[{}],"jev":{{"calls":0,"medianMs":0}},"llmTurns":0,"escapes":0,"recoveries":0}}"#,
        rows.join(",")
    )
}

fn spec() -> qaren::exec::CmdSpec {
    core::spawn_spec(
        Path::new("/usr/local/bin/node"),
        Path::new("/runtime"),
        Path::new("/tmp/app"),
        &request().lease,
        8791,
    )
}

fn run_child(mock: &mut MockRunner, log: &Path) -> core::CoreOutcome {
    let child = core::spawn(mock, &spec(), log, &request()).unwrap();
    core::wait(mock, child, budgets())
}

#[test]
fn scripted_rows_and_a_pass_result_become_a_typed_ledger() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1]),
        envelope(4, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass);
    assert!(outcome.failure.is_none());
    assert_eq!(outcome.pid, 9000);
    assert_eq!(outcome.ledger.steps.len(), 2);
    assert_eq!(outcome.ledger.steps[1].line, 2);
    assert_eq!(
        outcome.ledger.steps[1].screenshot.as_deref(),
        Some("screenshots/02.png")
    );
    assert_eq!(outcome.ledger.jev.calls, 0);

    let written = mock.piped_stdin_text(0);
    let envelope: serde_json::Value = serde_json::from_str(written.trim()).unwrap();
    assert_eq!(envelope["v"], 1);
    assert_eq!(envelope["type"], "request");
    assert_eq!(envelope["runId"], RUN);
    assert_eq!(envelope["payload"]["target"]["metroPort"], 8791);
    assert_eq!(envelope["payload"]["lease"], request().lease);
    let spawn = &mock.calls[0];
    assert_eq!(spawn.label, "core-walk");
    assert!(spawn.args[0].ends_with("qa/walk.js"));
    assert!(spawn
        .env
        .iter()
        .any(|(k, v)| k == "QAREN_DEVICE_LEASE" && v == &request().lease));
    assert_eq!(spawn.cwd.as_deref(), Some(Path::new("/tmp/app")));
}

#[test]
fn a_child_without_a_result_line_fails_at_its_last_row() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 2, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1])
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(1));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert_eq!(failure.phase, "walk");
    let ledger_failure = outcome.ledger.failure.unwrap();
    assert_eq!(ledger_failure.step, 2, "attributed to the last row");
    assert_eq!(
        ledger_failure.screenshot.as_deref(),
        Some("screenshots/02.png")
    );
    assert!(ledger_failure.seen.contains("code 1"));
    assert_eq!(outcome.ledger.steps.len(), 2);
    assert_eq!(outcome.ledger.verdict, "FAIL");
}

#[test]
fn a_child_that_dies_before_any_row_fails_at_step_zero() {
    let repo = common::temp_repo();
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, "", Some(2));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let ledger_failure = outcome.ledger.failure.unwrap();
    assert_eq!(ledger_failure.step, 0);
    assert!(ledger_failure.seen.contains("without a result line"));
    assert!(outcome.ledger.steps.is_empty());
}

#[test]
fn a_result_that_disagrees_with_the_exit_code_is_not_trusted() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(1));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert!(
        failure.detail.contains("says \"PASS\""),
        "{}",
        failure.detail
    );
    assert_eq!(outcome.ledger.failure.unwrap().step, 1);
}

#[test]
fn the_result_line_and_the_exit_code_must_agree() {
    let rows = [row(1, 1, "pass")];
    let pass = pass_ledger(&rows);
    let fail = pass.replacen("\"verdict\":\"PASS\"", "\"verdict\":\"FAIL\"", 1);
    let refused =
        r#"{"verdict":"REFUSED","code":"METRO_ORIGIN_MISMATCH","message":"port"}"#.to_string();
    let cases: &[(&str, &String, i32, bool)] = &[
        ("PASS", &pass, 0, true),
        ("FAIL", &fail, 1, true),
        ("REFUSED", &refused, 4, true),
        ("PASS", &pass, 1, false),
        ("PASS", &pass, 4, false),
        ("FAIL", &fail, 0, false),
        ("REFUSED", &refused, 0, false),
        ("REFUSED", &refused, 1, false),
    ];
    for (verdict, ledger, exit, agrees) in cases {
        let repo = common::temp_repo();
        let stdout = format!(
            "{}\n{}\n",
            envelope(2, "row", &rows[0]),
            envelope(3, "result", ledger)
        );
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(*exit));
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        if *agrees {
            assert!(
                outcome.failure.is_none(),
                "{verdict}/{exit}: {:?}",
                outcome.failure
            );
            let expected = match *verdict {
                "PASS" => Verdict::Pass,
                "FAIL" => Verdict::Fail,
                _ => Verdict::Refused {
                    code: "METRO_ORIGIN_MISMATCH".to_string(),
                    message: "port".to_string(),
                },
            };
            assert_eq!(outcome.verdict, expected, "{verdict}/{exit}");
            assert_eq!(outcome.ledger.verdict, *verdict, "{verdict}/{exit}");
        } else {
            assert_eq!(outcome.verdict, Verdict::Fail, "{verdict}/{exit}");
            let failure = outcome
                .failure
                .expect("a disagreement is a synthesized failure");
            assert_eq!(
                failure.code,
                FailureCode::CoreResultMissing,
                "{verdict}/{exit}"
            );
            assert!(
                failure.detail.contains("but the core exited with code"),
                "{verdict}/{exit}: {}",
                failure.detail
            );
        }
    }
}

#[test]
fn a_typed_refusal_needs_exit_four() {
    let repo = common::temp_repo();
    let refusal = r#"{"verdict":"REFUSED","code":"METRO_ORIGIN_MISMATCH","message":"scriptURL port 8081 != 8791","lease":"x"}"#;
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", refusal)),
        Some(4),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(
        outcome.verdict,
        Verdict::Refused {
            code: "METRO_ORIGIN_MISMATCH".to_string(),
            message: "scriptURL port 8081 != 8791".to_string()
        }
    );
    assert!(outcome.failure.is_none());
}

#[test]
fn jev_refusal_accounting_is_optional_but_strict_when_present() {
    for jev in [
        None,
        Some(serde_json::json!({"calls": "invalid"})),
        Some(serde_json::json!({
            "calls": 2, "medianMs": 25, "inputTokens": 12, "callDetails": [
                {"scope":"preflight", "questionIds":["preflight"], "inputTokens":12, "ms":10, "outcome":"ok", "status":200},
                {"scope":"walk", "questionIds":["front"], "inputTokens":null, "ms":40, "outcome":"http", "status":401}
            ]
        })),
    ] {
        let repo = common::temp_repo();
        let mut refusal = serde_json::json!({"verdict":"REFUSED", "code":"JEV_AUTH_FAILED", "message":"key rejected"});
        if let Some(jev) = &jev {
            refusal["jev"] = jev.clone();
        }
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &refusal.to_string())),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        if jev.as_ref().is_some_and(|j| j["calls"].is_string()) {
            assert_eq!(outcome.verdict, Verdict::Fail);
            assert_eq!(
                outcome.failure.unwrap().code,
                FailureCode::CoreResultMissing
            );
        } else {
            assert!(
                matches!(outcome.verdict, Verdict::Refused { ref code, .. } if code == "JEV_AUTH_FAILED")
            );
            assert!(outcome.failure.is_none());
            if let Some(jev) = jev {
                assert_eq!(serde_json::to_value(outcome.ledger.jev).unwrap(), jev);
            } else {
                assert_eq!(outcome.ledger.jev, Default::default());
            }
        }
    }
}

#[test]
fn default_step_budget_covers_reasks_and_the_bounded_scroll_schedule() {
    use qaren::run::{DEFAULT_STEP_SECONDS, DEFAULT_WALK_SECONDS};
    let judgment = 3 * 10 + 2 * 60;
    let check_with_reask = 2 * judgment + 1 + 30;
    let scroll_until = 7 * judgment + 150;
    assert_eq!(DEFAULT_STEP_SECONDS, 1200);
    assert!(DEFAULT_STEP_SECONDS >= check_with_reask);
    assert!(DEFAULT_STEP_SECONDS >= scroll_until);
    assert_eq!(
        DEFAULT_WALK_SECONDS, 1200,
        "the absolute walk cap is not extended or reset by retries"
    );
}

struct ScheduleRunner {
    inner: MockRunner,
    intervals: VecDeque<u64>,
    started_ms: u64,
    after_schedule_ms: u64,
}

impl Runner for ScheduleRunner {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        self.inner.run(spec)
    }
    fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
        self.inner.spawn_group(spec, log)
    }
    fn spawn_piped(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<PipedChild> {
        self.inner.spawn_piped(spec, log)
    }
    fn sleep(&mut self, duration: Duration) {
        if *self.inner.piped_killed[0].lock().unwrap() {
            self.inner.sleep(duration);
            return;
        }
        let ms = self.intervals.pop_front().unwrap_or_else(|| {
            self.after_schedule_ms
                .saturating_sub(self.inner.now_epoch_ms() - self.started_ms)
                .max(1)
        });
        self.inner.sleep(Duration::from_millis(ms));
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
}

fn drive_schedule(intervals: Vec<u64>, budgets: Budgets) -> (core::CoreOutcome, ScheduleRunner) {
    let repo = common::temp_repo();
    let mut inner = MockRunner::new();
    inner.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "row", &row(1, 1, "pass"))),
        None,
    );
    let mut runner = ScheduleRunner {
        started_ms: inner.now_epoch_ms(),
        inner,
        intervals: intervals.into(),
        after_schedule_ms: budgets.walk_seconds * 1000 + 1,
    };
    let child = core::spawn(&mut runner, &spec(), &repo.join("core.log"), &request()).unwrap();
    let outcome = core::wait(&mut runner, child, budgets);
    (outcome, runner)
}

fn judgment_schedule() -> Vec<u64> {
    vec![10_000, 60_000, 10_000, 60_000, 10_000]
}

fn scroll_schedule() -> Vec<u64> {
    let mut schedule = vec![15_000];
    schedule.extend(judgment_schedule());
    for _ in 0..6 {
        schedule.extend([5_000, 15_000]);
        schedule.extend(judgment_schedule());
    }
    schedule.push(15_000);
    schedule
}

#[test]
fn wait_allows_the_full_retry_reask_and_scroll_schedules_before_the_absolute_cap() {
    use qaren::run::{DEFAULT_STEP_SECONDS, DEFAULT_WALK_SECONDS};
    let mut reask = vec![15_000];
    reask.extend(judgment_schedule());
    reask.extend([500, 15_000]);
    reask.extend(judgment_schedule());
    reask.push(15_000);
    assert_eq!(judgment_schedule().iter().sum::<u64>(), 150_000);
    assert_eq!(reask.iter().sum::<u64>(), 345_500);
    assert_eq!(scroll_schedule().iter().sum::<u64>(), 1_200_000);
    for schedule in [judgment_schedule(), reask, scroll_schedule()] {
        let (outcome, runner) = drive_schedule(
            schedule,
            Budgets {
                walk_seconds: DEFAULT_WALK_SECONDS,
                step_seconds: DEFAULT_STEP_SECONDS,
            },
        );
        assert!(
            runner.intervals.is_empty(),
            "the permitted schedule was interrupted: {:?}",
            outcome.failure
        );
        assert_eq!(outcome.ledger.steps.len(), 1);
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
        assert!(
            failure.detail.contains("walk exceeded its 1200s budget"),
            "{}",
            failure.detail
        );
    }
}

#[test]
fn wait_honors_small_step_and_absolute_walk_caps_during_retries() {
    for (budgets, message) in [
        (
            Budgets {
                walk_seconds: 1200,
                step_seconds: 5,
            },
            "no ledger row within 5s",
        ),
        (
            Budgets {
                walk_seconds: 5,
                step_seconds: 1200,
            },
            "walk exceeded its 5s budget",
        ),
    ] {
        let (outcome, runner) = drive_schedule(scroll_schedule(), budgets);
        assert!(
            !runner.intervals.is_empty(),
            "a small override must interrupt the schedule"
        );
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
        assert!(failure.detail.contains(message), "{}", failure.detail);
        assert!(*runner.inner.piped_killed[0].lock().unwrap());
    }
}

#[test]
fn malformed_supplied_refusal_evidence_is_not_silently_synthesized() {
    use serde_json::json;
    let mut invalid_kind: serde_json::Value = serde_json::from_str(&row(9, 1, "fail")).unwrap();
    invalid_kind["kind"] = json!("unknown");
    let mut cases = vec![
        ("blocks", json!({})),
        ("blocks", json!([{"key":"account","outcome":"fail"}])),
        (
            "blocks",
            json!([{"key":false,"outcome":"fail","source":"discovered"}]),
        ),
        (
            "blocks",
            json!([{"key":"account","outcome":"unknown","source":"discovered"}]),
        ),
        ("failure", json!({"step":"nine","seen":"evidence"})),
        (
            "failure",
            json!({"step":9,"seen":"evidence","screenshot":42}),
        ),
        ("steps", json!({})),
        ("steps", json!([{}])),
        ("steps", json!([invalid_kind])),
        ("path", json!(42)),
        ("path", json!("unknown")),
        ("jev", json!({"calls":-1,"medianMs":0})),
        (
            "jev",
            json!({"calls":1,"medianMs":0,"callDetails":[{"scope":"unknown","questionIds":[],"ms":0,"inputTokens":null,"outcome":"ok"}]}),
        ),
        ("code", json!(42)),
        ("message", json!([])),
        ("lease", json!(false)),
        ("llmTurns", json!("one")),
        ("escapes", json!(-1)),
        ("recoveries", json!(0.5)),
    ];
    for field in [
        "blocks",
        "steps",
        "failure",
        "path",
        "jev",
        "llmTurns",
        "escapes",
        "recoveries",
    ] {
        cases.push((field, serde_json::Value::Null));
    }
    for (field, value) in cases {
        let repo = common::temp_repo();
        let mut refusal =
            json!({"verdict":"REFUSED","code":"JEV_REQUEST_INVALID","message":"refused"});
        refusal[field] = value;
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!("{}\n", envelope(2, "result", &refusal.to_string())),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert_eq!(outcome.verdict, Verdict::Fail, "{field}");
        let failure = outcome.failure.unwrap();
        assert_eq!(failure.code, FailureCode::CoreResultMissing, "{field}");
        assert!(
            failure.detail.contains("invalid ledger evidence"),
            "{field}: {}",
            failure.detail
        );
    }
}

#[test]
fn partial_and_startup_refusals_use_the_available_rows_for_missing_evidence() {
    for supplied_steps in [false, true] {
        let repo = common::temp_repo();
        let streamed = row(1, 1, "pass");
        let later = row(9, 1, "fail");
        let mut refusal =
            serde_json::json!({"verdict":"REFUSED","code":"JEV_AUTH_FAILED","message":"refused"});
        if supplied_steps {
            refusal["steps"] =
                serde_json::json!([serde_json::from_str::<serde_json::Value>(&later).unwrap()]);
        }
        let mut mock = MockRunner::new();
        mock.expect_spawn_piped(
            "walk.js",
            9000,
            &format!(
                "{}\n{}\n",
                envelope(2, "row", &streamed),
                envelope(3, "result", &refusal.to_string())
            ),
            Some(4),
        );
        let outcome = run_child(&mut mock, &repo.join("core.log"));
        assert!(matches!(outcome.verdict, Verdict::Refused { .. }));
        assert_eq!(outcome.exit, Some(4));
        let expected = if supplied_steps { 9 } else { 1 };
        assert_eq!(outcome.ledger.steps[0].line, expected);
        let failure = outcome.ledger.failure.unwrap();
        assert_eq!(failure.step, expected);
        assert_eq!(
            failure.screenshot,
            Some(format!("screenshots/{expected:02}.png"))
        );
        assert_eq!(failure.seen, "JEV_AUTH_FAILED: refused");
    }
}

#[test]
fn a_stuck_child_is_killed_at_the_step_budget_naming_the_last_row() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1])
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, None);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::WalkDeadlineExceeded);
    assert_eq!(failure.phase, "walk");
    assert!(
        failure
            .detail
            .contains("no ledger row within 10s after line 2"),
        "{}",
        failure.detail
    );
    assert!(
        *mock.piped_killed[0].lock().unwrap(),
        "the child group was killed"
    );
    assert_eq!(outcome.exit, Some(-9));
    assert_eq!(outcome.ledger.failure.unwrap().step, 2);
}

#[test]
fn an_envelope_for_another_run_is_a_contract_violation() {
    let repo = common::temp_repo();
    let foreign = format!(
        r#"{{"v":1,"runId":"someone-else","seq":2,"type":"row","payload":{}}}"#,
        row(1, 1, "pass")
    );
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{foreign}\n{}\n",
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Fail);
    let failure = outcome.failure.unwrap();
    assert_eq!(failure.code, FailureCode::CoreResultMissing);
    assert!(
        failure.detail.contains("wire contract violated"),
        "{}",
        failure.detail
    );
    assert_eq!(outcome.ledger.verdict, "FAIL");
}

#[test]
fn a_refusal_ledger_says_refused_and_redacts_the_message() {
    let repo = common::temp_repo();
    let refusal = r#"{"verdict":"REFUSED","code":"JEV_UNAVAILABLE","message":"401 from api with Bearer sk-live-secret-token-value"}"#;
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", refusal)),
        Some(4),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.ledger.verdict, "REFUSED");
    let Verdict::Refused { message, .. } = outcome.verdict else {
        panic!("expected a refusal");
    };
    assert!(!message.contains("sk-live-secret-token-value"), "{message}");
}

#[test]
fn rows_after_the_result_line_are_a_contract_violation() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows)),
        envelope(4, "row", &row(2, 1, "pass"))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped("walk.js", 9000, &stdout, Some(0));
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Fail);
    assert!(outcome
        .failure
        .unwrap()
        .detail
        .contains("output after the result line"));
}

#[test]
fn a_pass_result_that_is_not_a_ledger_is_a_fail() {
    let repo = common::temp_repo();
    let bogus = r#"{"verdict":"PASS"}"#;
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped(
        "walk.js",
        9000,
        &format!("{}\n", envelope(2, "result", bogus)),
        Some(0),
    );
    let outcome = run_child(&mut mock, &repo.join("core.log"));
    assert_eq!(outcome.verdict, Verdict::Fail);
    assert!(outcome
        .failure
        .unwrap()
        .detail
        .contains("not a valid ledger"));
}

#[test]
fn a_held_verdict_survives_a_child_that_overstays_its_exit() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass"), row(2, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "row", &rows[1]),
        envelope(4, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    // The child wrote its result, then never exits (stuck in runner teardown).
    mock.expect_spawn_piped("walk.js", 9000, &stdout, None);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert!(outcome.failure.is_none());
    assert_eq!(outcome.ledger.steps.len(), 2);
    assert!(
        *mock.piped_killed[0].lock().unwrap(),
        "the overstaying child is taken down"
    );
    assert!(!outcome.group_survived);
}

#[test]
fn a_group_member_that_dies_with_the_kill_is_not_a_survivor() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    // The leader exits 0 but stdout stays open until the group is killed.
    mock.expect_spawn_piped_holding("walk.js", 9000, &stdout, Some(0), HoldStdout::UntilKill);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert!(*mock.piped_killed[0].lock().unwrap());
    assert!(!outcome.group_survived);
}

#[test]
fn a_group_member_that_outlives_the_kill_is_reported_as_a_survivor() {
    let repo = common::temp_repo();
    let rows = [row(1, 1, "pass")];
    let stdout = format!(
        "{}\n{}\n",
        envelope(2, "row", &rows[0]),
        envelope(3, "result", &pass_ledger(&rows))
    );
    let mut mock = MockRunner::new();
    mock.expect_spawn_piped_holding("walk.js", 9000, &stdout, Some(0), HoldStdout::Forever);
    let outcome = run_child(&mut mock, &repo.join("core.log"));

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    assert!(*mock.piped_killed[0].lock().unwrap());
    assert!(outcome.group_survived);
}
