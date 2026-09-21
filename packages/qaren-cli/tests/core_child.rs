mod common;

use qaren::core::{self, Budgets, CoreRequest, CoreTarget, Verdict};
use qaren::exec::MockRunner;
use qaren::failure::FailureCode;
use std::path::{Path, PathBuf};

const RUN: &str = "check-20260921T100000Z";

fn request() -> CoreRequest {
    CoreRequest {
        run_id: RUN.to_string(),
        t0: 1_770_000_000_000,
        plan: "1. Tap \"Tasks\"\n✓ \"Tasks\"\n".to_string(),
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
