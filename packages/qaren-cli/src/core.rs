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
const POST_EXIT_DRAIN_MS: u64 = 2_000;

// The request payload the core child reads as its first stdin line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreRequest {
    pub run_id: String,
    pub t0: u64,
    pub plan: String,
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
    pub blocks: Vec<Value>,
    pub steps: Vec<Row>,
    pub jev: JevRollup,
    pub llm_turns: u64,
    pub escapes: u64,
    pub recoveries: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure: Option<LedgerFailure>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JevRollup {
    pub calls: u64,
    pub median_ms: u64,
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

pub fn parse_spec(node: &Path, runtime_dir: &Path, plan_file: &Path) -> CmdSpec {
    CmdSpec::new(
        "plan-parse",
        &node.to_string_lossy(),
        &[
            &runtime_dir.join("qa").join("walk.js").to_string_lossy(),
            "--parse",
            &plan_file.to_string_lossy(),
        ],
        60,
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
    redact_secrets(&line.chars().take(120).collect::<String>())
}

// Reads rows and the result under the two budgets and always returns a ledger:
// a child that exits without a result line is a FAIL attributed to its last row.
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
    let mut exited_at: Option<u64> = None;
    loop {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Line(line)) => {
                if inbox.accept(&line) {
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
        if exit.is_none() {
            exit = match child.handle.try_wait() {
                Ok(code) => code,
                Err(_) => {
                    // The child cannot be observed; take its group down rather than leave it running.
                    child.handle.kill_group();
                    Some(-1)
                }
            };
            if exit.is_some() {
                exited_at = Some(runner.monotonic_ms());
            }
        }
        let now = runner.monotonic_ms();
        if let Some(at) = exited_at {
            // The pipe closes with the process; a grandchild holding stdout is bounded here.
            if eof || now.saturating_sub(at) > POST_EXIT_DRAIN_MS {
                break;
            }
            continue;
        }
        if let Some(at) = killed_at {
            if now.saturating_sub(at) > POST_KILL_GRACE_MS {
                break;
            }
            continue;
        }
        // The step budget starts at the first walk row; before it, session setup
        // (runner build, attach, prove) is bounded by the whole-walk budget only.
        let walking = inbox.rows.iter().any(|r| r.line > 0);
        let reason = if inbox.violation.is_some() {
            inbox.violation.clone()
        } else if now.saturating_sub(started) > budgets.walk_seconds * 1000 {
            Some(format!(
                "the walk exceeded its {}s budget after {} row(s)",
                budgets.walk_seconds,
                inbox.rows.len()
            ))
        } else if walking && now.saturating_sub(last_progress) > budgets.step_seconds * 1000 {
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
        }
    }
    let (ledger, verdict, failure) = interpret(inbox, exit, deadline_failure);
    CoreOutcome {
        pid,
        ledger,
        verdict,
        exit,
        failure,
    }
}

fn describe_last(rows: &[Row]) -> String {
    match rows.last() {
        Some(row) => format!("line {} (attempt {})", row.line, row.attempt),
        None => "the startup row".to_string(),
    }
}

fn interpret(
    inbox: Inbox,
    exit: Option<i32>,
    deadline_failure: Option<Failure>,
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
    if let Some(failure) = deadline_failure {
        let seen = failure.detail.clone();
        return (
            synthesized_ledger(&inbox.rows, "FAIL", &seen),
            Verdict::Fail,
            Some(failure),
        );
    }
    if let Some(violation) = inbox.violation {
        return missing(
            &inbox.rows,
            format!("wire contract violated: {violation}"),
            FailureCode::CoreResultMissing,
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
    if expected_exit.is_none() || expected_exit != exit {
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
        let ledger = synthesized_ledger(&inbox.rows, "REFUSED", &format!("{code}: {message}"));
        return (ledger, Verdict::Refused { code, message }, None);
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

pub fn synthesized_ledger(rows: &[Row], verdict: &str, seen: &str) -> Ledger {
    let steps: Vec<Row> = rows.to_vec();
    let last = steps.last();
    Ledger {
        verdict: verdict.to_string(),
        path: "walk".to_string(),
        blocks: Vec::new(),
        failure: Some(LedgerFailure {
            step: last.map_or(0, |r| r.line),
            seen: seen.to_string(),
            screenshot: last.and_then(|r| r.screenshot.clone()),
        }),
        steps,
        jev: JevRollup {
            calls: 0,
            median_ms: 0,
        },
        llm_turns: 0,
        escapes: 0,
        recoveries: 0,
    }
}
