use qaren::exec::{CmdOutput, MockRunner, Runner};
use qaren::flow::interpret::{
    self, DriverError, DriverResult, HostDriver, HostOp, Presence, Verdict,
};
use qaren::flow::plan;
use qaren::native::client::RunnerClient;
use qaren::native::ios::IosDriver;
use serde_json::{json, Value};

const CAPABILITY: &str = "cap-0123456789abcdef0123456789abcdef";
const SECRET: &str = "qa-password";

fn reply(data: Value) -> CmdOutput {
    CmdOutput::success(&json!({"ok": true, "data": data, "v": 2}).to_string())
}

fn refusal(code: &str, mutation: &str) -> CmdOutput {
    CmdOutput::success(
        &json!({"ok": false, "error": {"code": code, "message": "no", "mutation": mutation}})
            .to_string(),
    )
}

fn screen(labels: &[(&str, &str)]) -> Value {
    let mut nodes = vec![
        json!({"index": 0, "type": "Application", "label": "", "identifier": "", "rect": {"x": 0, "y": 0, "width": 390, "height": 844}}),
    ];
    for (i, (label, id)) in labels.iter().enumerate() {
        nodes.push(json!({"index": i + 1, "parentIndex": 0, "type": "Button", "label": label, "identifier": id, "rect": {"x": 0, "y": 100 * (i + 1), "width": 390, "height": 44}}));
    }
    json!({"nodes": nodes, "truncated": false})
}

struct Host {
    performed: Vec<HostOp>,
}

impl HostDriver for Host {
    fn observe(
        &mut self,
        _runner: &mut dyn Runner,
        _id: &str,
        _window_ms: u64,
    ) -> DriverResult<Presence> {
        Ok(Presence::Present)
    }

    fn perform(
        &mut self,
        _runner: &mut dyn Runner,
        op: &HostOp,
        _window_ms: u64,
    ) -> DriverResult<()> {
        self.performed.push(op.clone());
        Ok(())
    }
}

const PLAN: &str = r#"{"schema":"rn-flow/1","actionId":"login","appId":"com.x.app","platform":"ios","steps":[
  {"id":"s1","source":{"line":3},"domain":"native","optional":false,"budgetMs":17000,"op":"tapOn","selector":{"id":"password"}},
  {"id":"s2","source":{"line":4},"domain":"native","optional":false,"budgetMs":10000,"op":"inputText","text":"qa-password"},
  {"id":"s3","source":{"line":5},"domain":"native","optional":false,"budgetMs":10000,"op":"hideKeyboard","fallbackDomain":"react-tree"},
  {"id":"s4","source":{"line":6},"domain":"react-tree","optional":false,"budgetMs":17000,"op":"assertVisible","selector":{"id":"login_done"}},
  {"id":"s5","source":{"line":7},"domain":"native","optional":false,"budgetMs":7000,"op":"assertNotVisible","selector":{"text":"Sign in"}}
]}"#;

#[test]
fn a_compiled_plan_replays_through_the_ios_runner_wire_without_leaking_secrets() {
    let plan = plan::parse(PLAN).unwrap();
    let mut runner = MockRunner::new();
    runner.expect_run(
        "curl",
        reply(screen(&[("Password", "password"), ("Sign in", "sign-in")])),
    );
    runner.expect_run("curl", reply(json!({"message": "tap"})));
    runner.expect_run("curl", reply(json!({"message": "typed"})));
    runner.expect_run("curl", refusal("KEYBOARD_DISMISS_FAILED", "none"));
    runner.expect_run("curl", reply(screen(&[("Sign in", "sign-in")])));
    runner.expect_run("curl", reply(screen(&[("Done", "done")])));
    let mut native = IosDriver::new(RunnerClient::new(4711, CAPABILITY, "com.x.app", "run-7"));
    let mut host = Host { performed: vec![] };

    let outcome = interpret::run(&plan, &mut runner, &mut native, &mut host);

    assert_eq!(outcome.verdict, Verdict::Pass, "{:?}", outcome.failure);
    let summary: Vec<(String, u64, String, String)> = outcome
        .rows
        .iter()
        .map(|r| {
            (
                r.r#ref.clone().unwrap(),
                r.attempt,
                r.outcome.clone(),
                r.resolved_by.clone(),
            )
        })
        .collect();
    assert_eq!(
        summary,
        vec![
            ("s1".into(), 1, "pass".into(), "native".into()),
            ("s2".into(), 1, "pass".into(), "native".into()),
            ("s3".into(), 1, "retry".into(), "native".into()),
            ("s3".into(), 2, "pass".into(), "react-tree".into()),
            ("s4".into(), 1, "pass".into(), "react-tree".into()),
            ("s5".into(), 1, "pass".into(), "native".into()),
        ]
    );
    assert_eq!(host.performed, vec![HostOp::KeyboardDismissJs]);
    assert_eq!(runner.remaining(), 0, "every scripted reply was consumed");
    for call in &runner.calls {
        assert_eq!(call.rendered(), "curl -q --config -");
        assert!(call.env.is_empty());
    }
    let rows = serde_json::to_string(&outcome.rows).unwrap();
    assert!(
        !rows.contains(SECRET) && !rows.contains(CAPABILITY),
        "{rows}"
    );
    let requests: Vec<String> = runner
        .private_inputs
        .iter()
        .map(|input| String::from_utf8(input.clone()).unwrap())
        .collect();
    assert!(
        requests.iter().all(|r| r.contains(CAPABILITY)),
        "each request is authorised"
    );
    assert_eq!(
        requests.iter().filter(|r| r.contains(SECRET)).count(),
        1,
        "only the type request carries the text"
    );
    assert!(
        requests[1].contains(r#"\"command\":\"tap\""#)
            && requests[1].contains(r#"\"commandId\":\"run-7-2\""#)
    );
}

#[test]
fn a_timed_out_tap_is_dispatched_unknown_and_nothing_follows() {
    let plan = plan::parse(PLAN).unwrap();
    let mut runner = MockRunner::new();
    runner.expect_run("curl", reply(screen(&[("Password", "password")])));
    runner.expect_run("curl", CmdOutput::failed(28, "Operation timed out"));
    let mut native = IosDriver::new(RunnerClient::new(4711, CAPABILITY, "com.x.app", "run-8"));
    let mut host = Host { performed: vec![] };
    let outcome = interpret::run(&plan, &mut runner, &mut native, &mut host);
    assert_eq!(outcome.verdict, Verdict::Fail);
    assert_eq!(outcome.rows.len(), 1);
    assert_eq!(outcome.rows[0].outcome, "dispatched-unknown");
    assert_eq!(
        runner.calls.len(),
        2,
        "no second mutation and no later step"
    );
    assert!(host.performed.is_empty());
    let _: DriverError = DriverError::Unknown(String::new());
}
