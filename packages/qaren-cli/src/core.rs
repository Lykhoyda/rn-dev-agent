use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::redact::redact_secrets;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::Duration;

pub const WIRE_VERSION: u64 = 1;
const MAX_ROWS: usize = 10_000;
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;
const INBOX_DEPTH: usize = 1_024;
const POST_KILL_GRACE_MS: u64 = 5_000;

// The request payload the core child reads as its first stdin line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRequest {
    pub run_id: String,
    pub t0: u64,
    pub plan: String,
    pub prepared: Value,
    pub preflight_calls: Vec<JevCall>,
    pub platform: String,
    pub app_id: String,
    pub run_dir: PathBuf,
    pub lease: String,
    pub target: CoreTarget,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreTarget {
    pub device_id: String,
    pub metro_port: u16,
    pub metro_url_for_device: String,
    pub worktree: PathBuf,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adb: Option<AdbTarget>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdbTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_socket: Option<String>,
    pub serial: String,
}

// The ledger the child returns as its result line; the wire is a contract, so it is read strictly.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub verdict: String,
    pub path: String,
    pub blocks: Vec<BlockResult>,
    pub steps: Vec<Row>,
    pub jev: JevRollup,
    pub llm_turns: u64,
    pub escapes: u64,
    pub recoveries: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<LedgerFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BlockResult {
    pub key: String,
    pub outcome: String,
    pub source: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevRollup {
    pub calls: u64,
    pub median_ms: u64,
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub call_details: Vec<JevCall>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevCall {
    pub question_ids: Vec<String>,
    pub scope: String,
    pub input_tokens: Option<u64>,
    pub ms: u64,
    pub outcome: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub block: String,
    pub line: u64,
    pub attempt: u64,
    pub kind: String,
    pub resolved_by: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r#ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
    pub t: u64,
    pub outcome: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerFailure {
    pub step: u64,
    pub seen: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screenshot: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub struct Budgets {
    pub walk_seconds: u64,
    pub step_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Refused { code: String, message: String },
}

#[derive(Debug, Clone)]
pub struct CoreOutcome {
    pub pid: i32,
    pub ledger: Ledger,
    pub verdict: Verdict,
    pub exit: Option<i32>,
    // Set when the ledger was synthesized: no result line, a contract violation, or a deadline kill.
    pub failure: Option<Failure>,
    // The leader exited but a member of its group still held stdout after SIGKILL and its grace.
    pub group_survived: bool,
}

pub fn spawn_spec(
    node: &Path,
    runtime_dir: &Path,
    worktree: &Path,
    lease: &str,
    metro_port: u16,
) -> CmdSpec {
    CmdSpec::new(
        "core-walk",
        &node.to_string_lossy(),
        &[&runtime_dir.join("qa").join("walk.js").to_string_lossy()],
        0,
    )
    .cwd(worktree)
    .env("QAREN_DEVICE_LEASE", lease)
    .env("QAREN_METRO_PORT", &metro_port.to_string())
}

pub fn preflight_spec(node: &Path, runtime_dir: &Path, plan_file: &Path) -> CmdSpec {
    CmdSpec::new(
        "plan-preflight",
        &node.to_string_lossy(),
        &[
            &runtime_dir.join("qa").join("walk.js").to_string_lossy(),
            "--preflight",
            &plan_file.to_string_lossy(),
        ],
        320,
    )
}

enum Msg {
    Line(String),
    Oversize,
    Eof,
}

pub struct CoreChild {
    pub pid: i32,
    run_id: String,
    child: crate::exec::PipedChild,
    rx: mpsc::Receiver<Msg>,
}

// The caller could not persist the pid, so nothing else will ever find this child: kill its group now.
pub fn abort(mut core: CoreChild) {
    core.child.handle.kill_group();
}

// Spawns the child and writes the request; the caller persists the pid, then waits.
pub fn spawn(
    runner: &mut dyn Runner,
    spec: &CmdSpec,
    stderr_log: &Path,
    request: &CoreRequest,
) -> Result<CoreChild, Failure> {
    let mut child = runner.spawn_piped(spec, stderr_log).map_err(|e| {
        Failure::new(
            "core",
            FailureCode::CoreSpawnFailed,
            format!("cannot spawn {}: {e}", spec.rendered()),
            "check the node path and the qaren runtime directory, then re-run",
        )
    })?;
    let envelope = json!({
        "v": WIRE_VERSION,
        "runId": request.run_id,
        "seq": 1,
        "type": "request",
        "payload": request,
    });
    let written = child
        .stdin
        .write_all(format!("{envelope}\n").as_bytes())
        .and_then(|()| child.stdin.flush());
    if let Err(e) = written {
        child.handle.kill_group();
        return Err(Failure::new(
            "core",
            FailureCode::CoreSpawnFailed,
            format!("cannot write the request to the core child: {e}"),
            "inspect the core log, then re-run",
        ));
    }
    // Bounded: a flooding child blocks on the pipe instead of growing our memory.
    let (tx, rx) = mpsc::sync_channel::<Msg>(INBOX_DEPTH);
    let mut stdout = std::mem::replace(&mut child.stdout, Box::new(std::io::empty()));
    std::thread::spawn(move || {
        let mut line = Vec::new();
        loop {
            line.clear();
            let mut limited = std::io::Read::take(&mut *stdout, MAX_LINE_BYTES as u64 + 1);
            match limited.read_until(b'\n', &mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let msg = if line.len() > MAX_LINE_BYTES {
                        Msg::Oversize
                    } else {
                        Msg::Line(String::from_utf8_lossy(&line).trim_end().to_string())
                    };
                    let stop = matches!(msg, Msg::Oversize);
                    if tx.send(msg).is_err() || stop {
                        break;
                    }
                }
            }
        }
        let _ = tx.send(Msg::Eof);
    });
    Ok(CoreChild {
        pid: child.pid,
        run_id: request.run_id.clone(),
        child,
        rx,
    })
}

struct Inbox {
    run_id: String,
    last_seq: u64,
    rows: Vec<Row>,
    result: Option<Value>,
    violation: Option<String>,
}

impl Inbox {
    fn accept(&mut self, line: &str) -> bool {
        if self.result.is_some() {
            self.violation = Some(format!("output after the result line: {}", excerpt(line)));
            return false;
        }
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            self.violation = Some(format!("non-JSON line on the wire: {}", excerpt(line)));
            return false;
        };
        let v = value.get("v").and_then(Value::as_u64);
        let run_id = value.get("runId").and_then(Value::as_str);
        let seq = value.get("seq").and_then(Value::as_u64);
        let kind = value.get("type").and_then(Value::as_str);
        if v != Some(WIRE_VERSION) || run_id != Some(self.run_id.as_str()) {
            self.violation = Some(format!(
                "envelope for another run or wire version: {}",
                excerpt(line)
            ));
            return false;
        }
        match seq {
            Some(seq) if seq > self.last_seq => self.last_seq = seq,
            _ => {
                self.violation = Some(format!("envelope seq is not increasing: {}", excerpt(line)));
                return false;
            }
        }
        match (kind, value.get("payload")) {
            (Some("row"), Some(payload)) => {
                if self.rows.len() >= MAX_ROWS {
                    self.violation = Some(format!("more than {MAX_ROWS} rows"));
                    return false;
                }
                match serde_json::from_value::<Row>(payload.clone()) {
                    Ok(row) => {
                        self.rows.push(row);
                        true
                    }
                    Err(e) => {
                        self.violation = Some(format!(
                            "row payload is not a ledger row ({e}): {}",
                            excerpt(line)
                        ));
                        false
                    }
                }
            }
            (Some("result"), Some(payload)) if self.result.is_none() => {
                self.result = Some(payload.clone());
                false
            }
            (Some("result"), _) => {
                self.violation = Some("a second result line arrived".to_string());
                false
            }
            _ => {
                self.violation = Some(format!("unknown envelope: {}", excerpt(line)));
                false
            }
        }
    }
}

fn excerpt(line: &str) -> String {
    redact_secrets(line).chars().take(120).collect()
}

// A missing result or deadline kill becomes a FAIL attributed to the last row.
pub fn wait(runner: &mut dyn Runner, core: CoreChild, budgets: Budgets) -> CoreOutcome {
    let CoreChild {
        pid,
        run_id,
        mut child,
        rx,
    } = core;
    let started = runner.monotonic_ms();
    let mut last_progress = started;
    let mut inbox = Inbox {
        run_id,
        last_seq: 1,
        rows: Vec::new(),
        result: None,
        violation: None,
    };
    let mut exit: Option<i32> = None;
    let mut eof = false;
    let mut deadline_failure: Option<Failure> = None;
    let mut killed_at: Option<u64> = None;
    let mut result_at: Option<u64> = None;
    let mut killed_after_result = false;
    let mut group_survived = false;
    // Kill before reaping to keep the pgid from being recycled under us.
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Line(line)) => {
                if inbox.accept(&crate::redact::redact_api_key(&line)) {
                    last_progress = runner.monotonic_ms();
                }
            }
            Ok(Msg::Oversize) => {
                inbox.violation = Some(format!("a wire line exceeded {MAX_LINE_BYTES} bytes"));
            }
            Ok(Msg::Eof) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                eof = true;
                runner.sleep(Duration::from_millis(50));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => runner.sleep(Duration::from_millis(50)),
        }
        if result_at.is_none() && inbox.result.is_some() {
            result_at = Some(runner.monotonic_ms());
        }
        let now = runner.monotonic_ms();
        if let Some(at) = killed_at {
            if exit.is_none() {
                // An unobservable leader is never guessed dead; the grace below reports it.
                exit = child.handle.try_wait().ok().flatten();
            }
            if exit.is_some() && eof {
                break;
            }
            if now.saturating_sub(at) > POST_KILL_GRACE_MS {
                group_survived = true;
                break;
            }
            continue;
        }
        if eof {
            killed_after_result = inbox.result.is_some();
            child.handle.kill_group();
            killed_at = Some(now);
            continue;
        }
        // Setup uses only the walk budget; a held result uses only the exit grace.
        let walking = inbox.rows.iter().any(|r| r.line > 0);
        let reason = if inbox.violation.is_some() {
            inbox.violation.clone()
        } else if result_at.is_some() {
            None
        } else if now.saturating_sub(started) > budgets.walk_seconds.saturating_mul(1000) {
            Some(format!(
                "the walk exceeded its {}s budget after {} row(s)",
                budgets.walk_seconds,
                inbox.rows.len()
            ))
        } else if walking
            && now.saturating_sub(last_progress) > budgets.step_seconds.saturating_mul(1000)
        {
            Some(format!(
                "no ledger row within {}s after {}",
                budgets.step_seconds,
                describe_last(&inbox.rows)
            ))
        } else {
            None
        };
        if let Some(reason) = reason {
            let code = if inbox.violation.is_some() {
                FailureCode::CoreResultMissing
            } else {
                FailureCode::WalkDeadlineExceeded
            };
            deadline_failure = Some(Failure::new(
                "walk",
                code,
                reason,
                "inspect the core log for the stuck or misbehaving step, then re-run",
            ));
            child.handle.kill_group();
            killed_at = Some(now);
        } else if let Some(at) = result_at {
            // The verdict is in hand; a child that overstays its exit is taken down without losing it.
            if now.saturating_sub(at) > budgets.step_seconds.saturating_mul(1000) {
                killed_after_result = true;
                child.handle.kill_group();
                killed_at = Some(now);
            }
        }
    }
    let (ledger, verdict, failure) = interpret(inbox, exit, deadline_failure, killed_after_result);
    CoreOutcome {
        pid,
        ledger,
        verdict,
        exit,
        failure,
        group_survived,
    }
}

fn describe_last(rows: &[Row]) -> String {
    match rows.last() {
        Some(row) => format!("line {} (attempt {})", row.line, row.attempt),
        None => "the startup row".to_string(),
    }
}

// A signal from our post-result kill must not replace the child's held verdict.
fn interpret(
    inbox: Inbox,
    exit: Option<i32>,
    deadline_failure: Option<Failure>,
    killed_after_result: bool,
) -> (Ledger, Verdict, Option<Failure>) {
    let missing = |rows: &[Row], seen: String, code: FailureCode| {
        (
            synthesized_ledger(rows, "FAIL", &seen),
            Verdict::Fail,
            Some(Failure::new(
                "walk",
                code,
                seen,
                "inspect the core log, then re-run",
            )),
        )
    };
    if let Some(violation) = inbox.violation {
        return missing(
            &inbox.rows,
            format!("wire contract violated: {violation}"),
            FailureCode::CoreResultMissing,
        );
    }
    if let Some(failure) = deadline_failure {
        let seen = failure.detail.clone();
        return (
            synthesized_ledger(&inbox.rows, "FAIL", &seen),
            Verdict::Fail,
            Some(failure),
        );
    }
    let exit_text = exit.map_or("unknown".to_string(), |c| c.to_string());
    let Some(result) = inbox.result else {
        return missing(
            &inbox.rows,
            format!("core exited with code {exit_text} without a result line"),
            FailureCode::CoreResultMissing,
        );
    };
    let verdict = result
        .get("verdict")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let expected_exit = match verdict.as_str() {
        "PASS" => Some(0),
        "FAIL" => Some(1),
        "REFUSED" => Some(4),
        _ => None,
    };
    let own_kill = killed_after_result && exit.is_some_and(|c| c < 0);
    if expected_exit.is_none() || (expected_exit != exit && !own_kill) {
        return missing(
            &inbox.rows,
            format!("result line says {verdict:?} but the core exited with code {exit_text}"),
            FailureCode::CoreResultMissing,
        );
    }
    if verdict == "REFUSED" {
        let code = redact_secrets(
            result
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("CORE_REFUSED"),
        );
        let message = redact_secrets(
            result
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("the core child refused the run"),
        );
        return match refusal_ledger(&result, &inbox.rows, &format!("{code}: {message}")) {
            Ok(ledger) => (ledger, Verdict::Refused { code, message }, None),
            Err(error) => missing(
                &inbox.rows,
                format!("refusal has invalid ledger evidence: {error}"),
                FailureCode::CoreResultMissing,
            ),
        };
    }
    match serde_json::from_value::<Ledger>(result) {
        Ok(ledger) => {
            let verdict = if verdict == "PASS" {
                Verdict::Pass
            } else {
                Verdict::Fail
            };
            (ledger, verdict, None)
        }
        Err(e) => missing(
            &inbox.rows,
            format!("result line is not a valid ledger: {e}"),
            FailureCode::CoreResultMissing,
        ),
    }
}

fn refusal_ledger(result: &Value, rows: &[Row], seen: &str) -> Result<Ledger, String> {
    for field in ["code", "message", "lease"] {
        if result.get(field).is_some_and(|value| !value.is_string()) {
            return Err(format!("{field} must be a string when supplied"));
        }
    }
    let mut normalized = serde_json::to_value(synthesized_ledger(rows, "REFUSED", seen))
        .map_err(|error| error.to_string())?;
    for field in [
        "path",
        "blocks",
        "steps",
        "jev",
        "llmTurns",
        "escapes",
        "recoveries",
        "failure",
    ] {
        if let Some(value) = result.get(field) {
            if value.is_null() {
                return Err(format!("{field} must not be null when supplied"));
            }
            normalized[field] = value.clone();
        }
    }
    let mut ledger: Ledger =
        serde_json::from_value(normalized).map_err(|error| error.to_string())?;
    if ledger.path != "walk" {
        return Err("path must be walk".into());
    }
    if ledger.blocks.iter().any(|block| {
        !matches!(block.outcome.as_str(), "pass" | "fail") || block.source != "discovered"
    }) {
        return Err("invalid block outcome or source".into());
    }
    if ledger.steps.len() > MAX_ROWS
        || ledger.steps.iter().any(|row| {
            !matches!(row.kind.as_str(), "step" | "check")
                || !matches!(row.resolved_by.as_str(), "exact" | "jev")
                || !matches!(row.outcome.as_str(), "pass" | "fail" | "retry")
        })
    {
        return Err("invalid ledger steps".into());
    }
    if ledger.jev.call_details.iter().any(|call| {
        !matches!(call.scope.as_str(), "preflight" | "parse" | "walk")
            || !matches!(
                call.outcome.as_str(),
                "ok" | "timeout" | "network" | "http" | "invalid"
            )
            || call
                .status
                .is_some_and(|status| !(100..=599).contains(&status))
    }) {
        return Err("invalid Jev call details".into());
    }
    if result.get("failure").is_none() {
        ledger.failure = Some(synthesized_failure(&ledger.steps, seen));
    }
    Ok(ledger)
}

fn synthesized_failure(rows: &[Row], seen: &str) -> LedgerFailure {
    let last = rows.last();
    LedgerFailure {
        step: last.map_or(0, |row| row.line),
        seen: seen.to_string(),
        screenshot: last.and_then(|row| row.screenshot.clone()),
    }
}

pub fn synthesized_ledger(rows: &[Row], verdict: &str, seen: &str) -> Ledger {
    let steps: Vec<Row> = rows.to_vec();
    Ledger {
        verdict: verdict.to_string(),
        path: "walk".to_string(),
        blocks: Vec::new(),
        failure: Some(synthesized_failure(&steps, seen)),
        steps,
        jev: JevRollup::default(),
        llm_turns: 0,
        escapes: 0,
        recoveries: 0,
    }
}
