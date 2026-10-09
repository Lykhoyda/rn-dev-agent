use crate::events::Envelope;
use crate::report::{prose, term_safe};
use crate::runrecord::{validate_run_id, PidLiveness, RunRecord};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::{IsTerminal, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const STAGES: [(&str, &str); 11] = [
    ("preflight", "Preflight"),
    ("deps", "Dependencies"),
    ("build_decision", "Build decision"),
    ("prebuild", "Prebuild"),
    ("native_build", "Native compile"),
    ("install_launch_ready", "Install·launch·ready"),
    ("verify", "Verify"),
    ("attach", "Debugger attach"),
    ("steps", "Steps"),
    ("recording", "Recording"),
    ("cleanup", "Cleanup"),
];

pub enum Target {
    RunId(String),
    Latest,
}

pub struct WatchArgs {
    pub target: Target,
    pub plain: bool,
    pub json: bool,
}

struct Tail {
    path: PathBuf,
    offset: u64,
    carry: Vec<u8>,
}

impl Tail {
    fn new(path: PathBuf) -> Self {
        Self {
            path,
            offset: 0,
            carry: Vec::new(),
        }
    }

    fn lines(&mut self) -> Vec<String> {
        if !regular_file(&self.path) {
            return Vec::new();
        }
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut bytes = Vec::new();
        if file.read_to_end(&mut bytes).is_err() {
            return Vec::new();
        }
        self.offset += bytes.len() as u64;
        self.carry.extend(bytes);
        let Some(last) = self.carry.iter().rposition(|b| *b == b'\n') else {
            return Vec::new();
        };
        let rest = self.carry.split_off(last + 1);
        let lines = self.carry[..last]
            .split(|b| *b == b'\n')
            .filter_map(|b| std::str::from_utf8(b).ok().map(str::to_owned))
            .collect();
        self.carry = rest;
        lines
    }
}

enum Input {
    Event(Envelope),
}

fn parse_event(line: &str) -> Option<Input> {
    let envelope: Envelope = serde_json::from_str(line).ok()?;
    (envelope.v == 1
        && envelope.payload.is_object()
        && matches!(
            envelope.event.as_str(),
            "run" | "stage" | "cmd" | "admitted" | "coreT0" | "row" | "end"
        ))
    .then_some(Input::Event(envelope))
}

#[derive(Default, Serialize)]
struct Stage {
    name: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ms: Option<u64>,
    #[serde(skip)]
    began: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    operation_id: u64,
    line: u64,
    attempt: u64,
    kind: String,
    resolved_by: String,
    outcome: String,
    t: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    timing: Option<crate::core::RowTiming>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Default)]
struct State {
    run_id: String,
    verb: String,
    platform: String,
    stages: BTreeMap<String, Stage>,
    rows: BTreeMap<u64, Step>,
    commands: Vec<String>,
    end: Option<Value>,
    first_ms: Option<u64>,
    now_ms: u64,
    core_t0: Option<u64>,
    owner_dead: bool,
    terminal: bool,
    seq: u64,
}

#[derive(Debug, PartialEq, Eq)]
enum Status {
    Live,
    Finished,
    Incomplete,
}

fn string(p: &Value, key: &str) -> String {
    term_safe(p[key].as_str().unwrap_or_default())
        .chars()
        .take(128)
        .collect()
}

impl State {
    fn status(&self) -> Status {
        if self.end.is_some() {
            Status::Finished
        } else if self.owner_dead {
            Status::Incomplete
        } else {
            Status::Live
        }
    }

    fn fold(&mut self, Input::Event(e): Input) {
        if e.seq <= self.seq || self.end.is_some() {
            return;
        }
        self.seq = e.seq;
        self.first_ms.get_or_insert(e.at);
        self.now_ms = self.now_ms.max(e.at);
        let p = &e.payload;
        match e.event.as_str() {
            "run" => {
                self.run_id = string(p, "runId");
                self.verb = string(p, "verb");
                self.platform = string(p, "platform");
            }
            "stage" => {
                let name = string(p, "name");
                let state = string(p, "state");
                if !STAGES.iter().any(|(n, _)| *n == name)
                    || !matches!(state.as_str(), "running" | "passed" | "failed" | "skipped")
                {
                    return;
                }
                let old = self.stages.get(&name);
                let began = if state == "running" {
                    e.at
                } else {
                    old.map_or(e.at, |s| s.began)
                };
                self.stages.insert(
                    name.clone(),
                    Stage {
                        name,
                        state,
                        code: p["code"].as_str().map(term_safe),
                        ms: p["ms"].as_u64(),
                        began,
                    },
                );
            }
            "row" => {
                let Some(line) = p["line"].as_u64().filter(|l| *l > 0) else {
                    return;
                };
                let Some(attempt) = p["attempt"].as_u64() else {
                    return;
                };
                let Some(operation_id) = p["operationId"].as_u64().filter(|id| *id > 0) else {
                    return;
                };
                if self
                    .rows
                    .get(&operation_id)
                    .is_some_and(|r| r.attempt > attempt)
                {
                    return;
                }
                self.rows.insert(
                    operation_id,
                    Step {
                        operation_id,
                        line,
                        attempt,
                        kind: string(p, "kind"),
                        resolved_by: string(p, "resolvedBy"),
                        outcome: string(p, "outcome"),
                        t: p["t"].as_u64().unwrap_or(0),
                        timing: serde_json::from_value(p["timing"].clone()).ok(),
                        text: None,
                    },
                );
            }
            "cmd" => {
                let label = string(p, "label");
                if p["edge"] == "start" {
                    self.commands.push(label)
                } else if p["edge"] == "end" {
                    if let Some(i) = self.commands.iter().rposition(|l| *l == label) {
                        self.commands.remove(i);
                    }
                }
            }
            "coreT0" => self.core_t0 = p["t0"].as_u64(),
            "end" => {
                let mut end = json!({"result": string(p, "result"), "phase": string(p, "phase"),
                    "expectedExit": p["expectedExit"].as_u64(), "droppedEvents": p["droppedEvents"].as_u64(),
                    "cleanup": {}, "timingsMs": {}});
                for key in ["failureCode", "failurePhase"] {
                    if p[key].is_string() {
                        end[key] = string(p, key).into();
                    }
                }
                for key in [
                    "build_process",
                    "core",
                    "metro",
                    "runner_driver",
                    "runner_host",
                    "recorder",
                    "simulator",
                    "device_lease",
                    "pr_worktree",
                    "adb_reverse",
                    "android_runner",
                ] {
                    if let Some(kind) = p["cleanup"][key].as_str() {
                        end["cleanup"][key] = if matches!(
                            kind,
                            "removed"
                                | "absent"
                                | "kept"
                                | "released"
                                | "retained"
                                | "unresolved"
                                | "refused"
                        ) {
                            kind
                        } else {
                            "other"
                        }
                        .into();
                    }
                }
                if let Some(timings) = p["timingsMs"].as_object() {
                    for (key, value) in timings {
                        if let Some(ms) = value.as_u64() {
                            end["timingsMs"][term_safe(key)] = ms.into();
                        }
                    }
                }
                self.end = Some(end);
            }
            _ => {}
        }
    }

    fn apply_ledger(&mut self, ledger: &crate::core::Ledger) {
        if self.status() == Status::Live && !self.terminal {
            return;
        }
        for row in &ledger.steps {
            if let Some(step) = self
                .rows
                .get_mut(&row.operation_id)
                .filter(|s| s.attempt == row.attempt)
            {
                step.text = row
                    .text
                    .as_deref()
                    .map(|s| term_safe(&prose(&term_safe(s))));
                if let Some(reason) = &row.reason {
                    let text = step.text.get_or_insert_with(String::new);
                    text.push_str(&format!(" — {}", term_safe(&prose(&term_safe(reason)))));
                }
            }
        }
    }

    fn counts(&self) -> (usize, usize) {
        let passed = self.rows.values().filter(|s| s.outcome == "pass").count();
        let failed = self.rows.values().filter(|s| s.outcome == "fail").count();
        (passed, failed)
    }
}

fn duration(ms: u64) -> String {
    if ms < 60_000 {
        format!("{:.1}s", ms as f64 / 1000.)
    } else {
        format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
    }
}

fn mark(state: &str) -> char {
    match state {
        "running" => '▶',
        "passed" | "pass" => '✓',
        "failed" | "fail" => '✗',
        "skipped" => '–',
        "retry" => '↻',
        _ => '·',
    }
}

fn stage_line(s: &State, name: &str, label: &str) -> String {
    let Some(stage) = s.stages.get(name) else {
        return format!("· {label}");
    };
    let label = if name == "build_decision" {
        stage
            .code
            .as_ref()
            .map_or(label.to_string(), |c| format!("{label} → {c}"))
    } else {
        label.to_string()
    };
    let mut details = Vec::new();
    match stage.state.as_str() {
        "skipped" => details.push("not needed".to_string()),
        "running" => details.push(format!(
            "running {}",
            duration(s.now_ms.saturating_sub(stage.began))
        )),
        _ => {
            if name != "build_decision" {
                if let Some(code) = &stage.code {
                    details.push(code.clone());
                }
            }
            if name == "steps" {
                details.push(format!("{}/{} passed", s.counts().0, s.rows.len()));
            }
            if let Some(ms) = stage.ms {
                details.push(duration(ms));
            }
        }
    }
    if stage.ms.is_some()
        && stage.state != "running"
        && name != "steps"
        && (stage.code.is_none() || name == "build_decision")
    {
        format!(
            "{} {label:<32}{:>5}",
            mark(&stage.state),
            details.join("  ")
        )
    } else {
        format!("{} {label:<33}{}", mark(&stage.state), details.join("  "))
    }
}

fn step_line(s: &Step) -> String {
    let result = if s.attempt > 1 {
        format!("{} (attempt {})", s.resolved_by, s.attempt)
    } else {
        s.resolved_by.clone()
    };
    let timing = |ms: u64| {
        if ms == 0 {
            "—".to_string()
        } else {
            duration(ms)
        }
    };
    let (act, capture, jev) = s
        .timing
        .as_ref()
        .map_or((0, 0, 0), |t| (t.act_ms, t.capture_ms, t.jev_ms));
    let text = s.text.as_ref().map_or(String::new(), |t| format!("  {t}"));
    format!(
        "{} {:>5}  {:<8}  {result:<21}{:>6}  {:>7}  {:>7}{text}",
        mark(&s.outcome),
        s.line,
        s.kind,
        timing(act),
        timing(capture),
        timing(jev)
    )
}

fn verdict(s: &State) -> Option<String> {
    if let Some(end) = &s.end {
        let code = end["failureCode"]
            .as_str()
            .map_or(String::new(), |c| format!("  {c}"));
        let clean = end["cleanup"].as_object().is_some_and(|legs| {
            legs.values()
                .all(|v| matches!(v.as_str(), Some("removed" | "absent" | "kept" | "released")))
        });
        let drops = end["droppedEvents"].as_u64().unwrap_or(0);
        let dropped = if drops > 0 {
            format!("  telemetry incomplete ({drops} dropped events)")
        } else {
            String::new()
        };
        Some(format!(
            "VERDICT {}  (expected exit {}){code}  cleanup {}{dropped}",
            string(end, "result").to_uppercase(),
            end["expectedExit"],
            if clean { "clean" } else { "unclean" }
        ))
    } else if s.status() == Status::Incomplete {
        Some("ENDED WITHOUT FINAL EVENT (telemetry incomplete)".to_string())
    } else {
        None
    }
}

fn header(s: &State) -> String {
    format!("qaren watch  {}  {}  {}", s.run_id, s.verb, s.platform)
}

fn frame(s: &State, width: u16) -> Vec<String> {
    let status = match s.status() {
        Status::Live => "LIVE",
        Status::Finished => "FINISHED",
        Status::Incomplete => "INCOMPLETE",
    };
    let mut lines = vec![
        format!(
            "{}  {status}  {}",
            header(s),
            duration(s.now_ms.saturating_sub(s.first_ms.unwrap_or(s.now_ms)))
        ),
        "STAGES".into(),
    ];
    lines.extend(STAGES.iter().map(|(n, l)| stage_line(s, n, l)));
    let (passed, failed) = s.counts();
    lines.push(format!(
        "STEPS  {} lines  ✓{passed}  ✗{failed}",
        s.rows.len()
    ));
    lines.push("   line  kind      result                  act  capture      jev".into());
    lines.extend(s.rows.values().map(step_line));
    if s.status() == Status::Live {
        lines.push("Step text appears when the run ends.".into());
    }
    if let Some(last) = verdict(s) {
        lines.push(last);
    } else if let Some(cmd) = s.commands.last() {
        lines.push(format!("now: {cmd}"));
    }
    lines
        .into_iter()
        .map(|l| term_safe(&l).chars().take(width as usize).collect())
        .collect()
}

fn plain(s: &State, printed: &mut HashSet<String>) -> Vec<String> {
    let mut out = Vec::new();
    if printed.insert("header".into()) {
        out.push(header(s));
    }
    for step in s.rows.values() {
        let key = format!("row:{}:{}", step.operation_id, step.attempt);
        let text_key = format!("text:{}:{}", step.operation_id, step.attempt);
        if printed.contains(&key) && step.text.is_some() && printed.insert(text_key) {
            out.push(format!(
                "        line {}: {}",
                step.line,
                step.text.as_deref().unwrap_or_default()
            ));
        }
    }
    for (name, label) in STAGES {
        if s.stages.get(name).is_some_and(|st| st.state != "running")
            && printed.insert(format!("stage:{name}"))
        {
            out.push(stage_line(s, name, label));
        }
    }
    for step in s.rows.values() {
        if matches!(step.outcome.as_str(), "pass" | "fail")
            && printed.insert(format!("row:{}:{}", step.operation_id, step.attempt))
        {
            out.push(format!("  {}", step_line(step)));
            if step.text.is_some() {
                printed.insert(format!("text:{}:{}", step.operation_id, step.attempt));
            }
        }
    }
    if let Some(last) = verdict(s) {
        if printed.insert("verdict".into()) {
            out.push(last);
        }
    }
    out
}

fn snapshot(s: &State) -> Value {
    json!({"runId": s.run_id, "verb": s.verb, "platform": s.platform,
        "state": match s.status() { Status::Live => "live", Status::Finished => "finished", Status::Incomplete => "incomplete" },
        "stages": STAGES.iter().map(|(n, _)| s.stages.get(*n).map_or_else(|| json!({"name": n, "state": "unobserved"}), |stage| serde_json::to_value(stage).unwrap_or(Value::Null))).collect::<Vec<_>>(),
        "steps": s.rows.values().collect::<Vec<_>>(), "end": s.end})
}

fn regular_file(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| m.is_file())
        && path
            .parent()
            .is_some_and(|p| std::fs::symlink_metadata(p).is_ok_and(|m| m.is_dir()))
}

fn latest(root: &Path) -> Option<String> {
    std::fs::read_dir(root)
        .ok()?
        .flatten()
        .filter_map(|e| {
            let id = e.file_name().to_str()?.to_owned();
            let record = e.path().join("run.json");
            if validate_run_id(&id).is_err() || !regular_file(&record) {
                return None;
            }
            Some((std::fs::metadata(record).ok()?.modified().ok()?, id))
        })
        .max()
        .map(|(_, id)| id)
}

fn owner_alive(record: &RunRecord) -> bool {
    let Some(owner) = &record.prepare else {
        return true;
    };
    !matches!(
        crate::runrecord::probe_pid_identity(&mut crate::exec::RealRunner::new(), owner),
        PidLiveness::Dead | PidLiveness::AliveForeign
    )
}

fn follow(
    root: &Path,
    args: &WatchArgs,
    out: &mut dyn Write,
    alive: &mut dyn FnMut(Option<&RunRecord>) -> bool,
    poll: Duration,
) -> u8 {
    let id = match &args.target {
        Target::RunId(id) if validate_run_id(id).is_ok() => id.clone(),
        Target::RunId(_) => return 2,
        Target::Latest => match latest(root) {
            Some(id) => id,
            None => return 1,
        },
    };
    let dir = root.join(&id);
    if !std::fs::symlink_metadata(&dir).is_ok_and(|m| m.is_dir()) {
        return 1;
    }
    let events = dir.join("logs/events.jsonl");
    if !regular_file(&events) {
        return 3;
    }
    let mut tail = Tail::new(events);
    let mut state = State {
        run_id: id,
        ..State::default()
    };
    let mut printed = HashSet::new();
    let record_path = dir.join("run.json");
    let mut record_mtime = None;
    let mut record: Option<RunRecord> = None;
    let mut ledger_read = false;
    loop {
        let mtime = regular_file(&record_path)
            .then(|| {
                std::fs::metadata(&record_path)
                    .ok()
                    .and_then(|m| m.modified().ok())
            })
            .flatten();
        if record_mtime != mtime && regular_file(&record_path) {
            record = std::fs::read(&record_path)
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            record_mtime = mtime;
        }
        for line in tail.lines() {
            if let Some(input) = parse_event(&line) {
                state.fold(input);
            }
        }
        state.owner_dead = !alive(record.as_ref());
        if state.owner_dead {
            for line in tail.lines() {
                if let Some(input) = parse_event(&line) {
                    state.fold(input);
                }
            }
        }
        state.terminal = record.as_ref().is_some_and(|r| r.terminal.is_some());
        if state.status() == Status::Live {
            state.now_ms = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_millis() as u64);
        }
        if !ledger_read && (state.end.is_some() || state.terminal) {
            let path = dir.join("ledger.json");
            if regular_file(&path) {
                if let Some(ledger) = std::fs::read(path)
                    .ok()
                    .and_then(|b| serde_json::from_slice(&b).ok())
                {
                    state.apply_ledger(&ledger);
                    ledger_read = true;
                }
            }
        }
        let lines = if args.json {
            vec![snapshot(&state).to_string()]
        } else if args.plain {
            plain(&state, &mut printed)
        } else {
            if write!(out, "\x1b[H\x1b[2J").is_err() {
                return 0;
            }
            let width = std::env::var("COLUMNS")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(100);
            frame(&state, width)
        };
        for line in lines {
            if writeln!(out, "{line}").is_err() {
                return 0;
            }
        }
        if out.flush().is_err() {
            return 0;
        }
        if args.json || state.status() != Status::Live {
            return 0;
        }
        // ponytail: 250 ms polling; add file notification only if users report lag.
        std::thread::sleep(poll);
    }
}

pub fn watch(root: &Path, mut args: WatchArgs) -> u8 {
    args.plain |= !std::io::stdout().is_terminal()
        || std::env::var_os("CI").is_some()
        || std::env::var_os("NO_COLOR").is_some();
    follow(
        root,
        &args,
        &mut std::io::stdout().lock(),
        &mut |r| r.is_none_or(owner_alive),
        Duration::from_millis(250),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const T: u64 = 1_791_540_900_000;

    fn line(seq: u64, at: u64, event: &str, payload: Value) -> String {
        json!({"v": 1, "seq": seq, "event": event, "at": T + at, "payload": payload}).to_string()
    }

    fn stage(seq: u64, at: u64, name: &str, state: &str, extra: Value) -> String {
        let mut p = json!({"name": name, "state": state});
        for (k, v) in extra.as_object().unwrap() {
            p[k] = v.clone();
        }
        line(seq, at, "stage", p)
    }

    fn row(
        seq: u64,
        line_no: u64,
        attempt: u64,
        outcome: &str,
        by: &str,
        timing: [u64; 3],
    ) -> String {
        let [act, cap, jev] = timing;
        line(
            seq,
            60_000 + line_no,
            "row",
            json!({
                "operationId": line_no, "line": line_no, "attempt": attempt, "kind": "action", "resolvedBy": by, "t": 0, "outcome": outcome,
                "timing": {"captureMs": cap, "nativeMs": 0, "reactMs": 0, "resolveMs": 0, "jevMs": jev,
                           "actMs": act, "postCaptureMs": 0, "otherMs": 0, "total": act + cap + jev}
            }),
        )
    }

    // A Reuse check, mid-walk: the 100-column live frame of the mock.
    fn reuse_check_live() -> Vec<String> {
        vec![
            stage(1, 0, "preflight", "running", json!({})),
            line(
                2,
                10,
                "run",
                json!({"runId": "check-20261009T081500Z", "verb": "check", "platform": "ios", "ownerPid": 4242}),
            ),
            stage(3, 900, "preflight", "passed", json!({"ms": 900})),
            stage(4, 900, "deps", "running", json!({})),
            line(
                5,
                1000,
                "cmd",
                json!({"label": "pnpm-install", "edge": "start"}),
            ),
            line(
                6,
                22000,
                "cmd",
                json!({"label": "pnpm-install", "edge": "end", "ok": true, "ms": 21000}),
            ),
            stage(7, 22300, "deps", "passed", json!({"ms": 21400})),
            stage(8, 22300, "build_decision", "running", json!({})),
            stage(
                9,
                22700,
                "build_decision",
                "passed",
                json!({"code": "reuse", "ms": 400}),
            ),
            stage(10, 22700, "prebuild", "skipped", json!({})),
            stage(11, 22700, "native_build", "skipped", json!({})),
            stage(12, 22700, "install_launch_ready", "running", json!({})),
            stage(
                13,
                33900,
                "install_launch_ready",
                "passed",
                json!({"ms": 11200}),
            ),
            stage(14, 33900, "verify", "running", json!({})),
            stage(15, 34200, "verify", "passed", json!({"ms": 300})),
            stage(16, 34200, "recording", "skipped", json!({})),
            line(17, 34300, "coreT0", json!({"t0": T + 34300})),
            stage(18, 34300, "attach", "running", json!({})),
            line(19, 37400, "admitted", json!({})),
            stage(20, 37400, "attach", "passed", json!({"ms": 3100})),
            stage(21, 37400, "steps", "running", json!({})),
            row(22, 0, 1, "pass", "startup", [0, 0, 0]),
            row(23, 3, 1, "pass", "exact", [1100, 600, 0]),
            row(24, 4, 1, "pass", "jev", [2000, 800, 400]),
            row(25, 5, 1, "retry", "exact", [0, 1400, 0]),
            row(26, 5, 2, "pass", "exact", [900, 700, 0]),
            row(27, 7, 1, "fail", "exact\u{1b}[2J", [0, 900, 0]),
            line(
                28,
                98000,
                "cmd",
                json!({"label": "simctl-io", "edge": "start"}),
            ),
        ]
    }

    fn folded(lines: &[String]) -> State {
        let mut state = State::default();
        for l in lines {
            if let Some(input) = parse_event(l) {
                state.fold(input);
            }
        }
        state.now_ms = T + 102_000;
        state
    }

    fn finish(lines: &mut Vec<String>, result: &str, code: Option<&str>) {
        let n = lines.len() as u64;
        lines.push(stage(
            n + 1,
            100_000,
            "steps",
            "failed",
            json!({"code": "PLAN_STEP_FAILED", "ms": 62600}),
        ));
        lines.push(stage(n + 2, 100_000, "cleanup", "running", json!({})));
        lines.push(stage(
            n + 3,
            102_000,
            "cleanup",
            "passed",
            json!({"ms": 2000}),
        ));
        let mut end = json!({"result": result, "phase": "cleaned", "timingsMs": {"total": 102000},
            "cleanup": {"core": "absent", "metro": "removed", "simulator": "kept", "device_lease": "removed"},
            "expectedExit": 1, "droppedEvents": 0});
        if let Some(code) = code {
            end["failureCode"] = code.into();
            end["failurePhase"] = "walk".into();
        }
        lines.push(line(n + 4, 102_000, "end", end));
    }

    fn ledger() -> crate::core::Ledger {
        let step = |line: u64, attempt: u64, outcome: &str, text: &str, reason: Option<&str>| {
            json!({"block": "plan", "operationId": line, "line": line, "attempt": attempt, "kind": "action", "resolvedBy": "exact",
                   "t": 0, "outcome": outcome, "text": text, "reason": reason})
        };
        serde_json::from_value(json!({
            "verdict": "FAIL", "path": "walk", "blocks": [],
            "steps": [
                step(0, 1, "pass", "startup", None),
                step(3, 1, "pass", "Tap \"Tasks\"", None),
                step(4, 1, "pass", "Type ••• into \"Email\"", None),
                step(5, 2, "pass", "Wait for \"Welcome\"", None),
                step(7, 1, "fail", "✓ \"Balance\"\u{1b}]0;pwned\u{7}", Some("TARGET_AMBIGUOUS")),
                step(8, 1, "pass", "never streamed", None),
            ],
            "jev": {"calls": 1, "medianMs": 400}, "llmTurns": 0, "escapes": 0, "recoveries": 0
        }))
        .unwrap()
    }

    #[test]
    fn login_plan_and_retry_identities_survive_every_view() {
        let root = temp_runs("operations");
        let path = root.join("check-1/logs/events.jsonl");
        let mut events = crate::events::Events::start(None).unwrap();
        events.attach(&path);
        let specs = [
            (1, 3, 1, "pass", "plan-three"),
            (2, 1, 1, "pass", "login-one"),
            (3, 2, 1, "pass", "login-two"),
            (4, 3, 1, "pass", "login-three"),
            (5, 4, 1, "retry", "plan-four-retry"),
            (5, 4, 2, "pass", "plan-four"),
            (5, 4, 1, "retry", "stale-retry"),
        ];
        let mut ledger = ledger();
        ledger.steps.clear();
        for (id, line, attempt, outcome, text) in specs {
            let row: crate::core::Row = serde_json::from_value(json!({
                "operationId": id, "block": "private-block", "line": line,
                "attempt": attempt, "kind": "step", "resolvedBy": "exact",
                "t": 0, "outcome": outcome, "text": text
            }))
            .unwrap();
            events.row(&row);
            ledger.steps.push(row);
        }
        let receipt = crate::receipt::Receipt::new(
            "check",
            "check-1",
            crate::receipt::ReceiptResult::Pass,
            "cleaned",
            "now".into(),
        );
        events.end(&receipt, 0);
        events.finish();
        let raw = std::fs::read_to_string(path).unwrap();
        assert!(!raw.contains("private-block") && !raw.contains("login-three"));
        let mut state = folded(&raw.lines().map(str::to_owned).collect::<Vec<_>>());
        assert_eq!(state.rows.len(), 5);
        assert_eq!(state.counts(), (5, 0));
        assert_eq!(state.rows[&5].attempt, 2);
        let mut printed = HashSet::new();
        let live_plain = plain(&state, &mut printed);
        assert_eq!(
            live_plain.iter().filter(|l| l.starts_with("  ✓")).count(),
            5
        );
        state.apply_ledger(&ledger);
        let texts = plain(&state, &mut printed);
        assert_eq!(texts.len(), 5);
        assert!(plain(&state, &mut printed).is_empty());
        let json = snapshot(&state);
        assert_eq!(json["steps"].as_array().unwrap().len(), 5);
        for (index, text) in [
            "plan-three",
            "login-one",
            "login-two",
            "login-three",
            "plan-four",
        ]
        .iter()
        .enumerate()
        {
            assert_eq!(json["steps"][index]["operationId"], index + 1);
            assert_eq!(json["steps"][index]["text"], *text);
            assert!(frame(&state, 200).iter().any(|line| line.ends_with(text)));
            assert!(texts.iter().any(|line| line.ends_with(text)));
        }
    }

    #[test]
    fn term_safe_strips_c0_and_c1_controls() {
        assert_eq!(
            term_safe("a\u{1b}[2Jb\u{7}c\u{9b}d\u{7f}e\tf\ng·✓"),
            "a[2Jbcdefg·✓"
        );
    }

    #[test]
    fn folds_a_reuse_check_into_the_golden_frame() {
        let state = folded(&reuse_check_live());
        assert_eq!(state.status(), Status::Live);
        let got = frame(&state, 100);
        let golden = [
            "qaren watch  check-20261009T081500Z  check  ios  LIVE  1:42",
            "STAGES",
            "✓ Preflight                        0.9s",
            "✓ Dependencies                    21.4s",
            "✓ Build decision → reuse           0.4s",
            "– Prebuild                         not needed",
            "– Native compile                   not needed",
            "✓ Install·launch·ready            11.2s",
            "✓ Verify                           0.3s",
            "✓ Debugger attach                  3.1s",
            "▶ Steps                            running 1:04",
            "– Recording                        not needed",
            "· Cleanup",
            "STEPS  4 lines  ✓3  ✗1",
            "   line  kind      result                  act  capture      jev",
            "✓     3  action    exact                  1.1s     0.6s        —",
            "✓     4  action    jev                    2.0s     0.8s     0.4s",
            "✓     5  action    exact (attempt 2)      0.9s     0.7s        —",
            "✗     7  action    exact[2J                  —     0.9s        —",
            "Step text appears when the run ends.",
            "now: simctl-io",
        ];
        assert_eq!(got, golden);
        assert!(frame(&state, 20).iter().all(|l| l.chars().count() <= 20));
    }

    #[test]
    fn finished_view_takes_text_only_from_the_ledger() {
        let mut lines = reuse_check_live();
        let live = folded(&lines);
        let rendered = frame(&live, 200).join("\n") + &plain(&live, &mut HashSet::new()).join("\n");
        assert!(
            !rendered.contains("Tasks") && !rendered.contains("Email"),
            "{rendered}"
        );
        assert!(!serde_json::to_string(&snapshot(&live))
            .unwrap()
            .contains("Tasks"));

        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        assert_eq!(done.status(), Status::Finished);
        done.apply_ledger(&ledger());
        let got = frame(&done, 200);
        assert_eq!(
            got[0],
            "qaren watch  check-20261009T081500Z  check  ios  FINISHED  1:42"
        );
        assert!(got.contains(&"✓     4  action    jev                    2.0s     0.8s     0.4s  Type ••• into \"Email\"".to_string()), "{got:#?}");
        assert!(got.contains(&"✗     7  action    exact[2J                  —     0.9s        —  ✓ \"Balance\"\\]0;pwned — TARGET\\_AMBIGUOUS".to_string()), "{got:#?}");
        assert!(
            got.contains(
                &"✗ Steps                            PLAN_STEP_FAILED  3/4 passed  1:02"
                    .to_string()
            ),
            "{got:#?}"
        );
        assert_eq!(
            got.last().unwrap(),
            "VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean"
        );
        assert!(!got.join("\n").contains("never streamed"));
        assert!(!got.join("\n").contains('\u{1b}') && !got.join("\n").contains('\u{7}'));
    }

    #[test]
    fn plain_prints_each_final_item_once_without_escapes() {
        let mut lines = reuse_check_live();
        let mut printed = HashSet::new();
        let first = plain(&folded(&lines[..8]), &mut printed);
        assert_eq!(
            first,
            [
                "qaren watch  check-20261009T081500Z  check  ios",
                "✓ Preflight                        0.9s",
                "✓ Dependencies                    21.4s",
            ]
        );
        assert!(plain(&folded(&lines[..8]), &mut printed).is_empty());
        let middle = plain(&folded(&lines), &mut printed);
        assert_eq!(middle[0], "✓ Build decision → reuse           0.4s");
        assert!(
            middle.contains(
                &"  ✗     7  action    exact[2J                  —     0.9s        —".to_string()
            ),
            "{middle:#?}"
        );
        assert!(!middle
            .iter()
            .any(|l| l.contains("Steps") || l.contains("Cleanup")));
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        done.apply_ledger(&ledger());
        let last = plain(&done, &mut printed);
        assert_eq!(
            last,
            [
                "        line 3: Tap \"Tasks\"",
                "        line 4: Type ••• into \"Email\"",
                "        line 5: Wait for \"Welcome\"",
                "        line 7: ✓ \"Balance\"\\]0;pwned — TARGET\\_AMBIGUOUS",
                "✗ Steps                            PLAN_STEP_FAILED  3/4 passed  1:02",
                "✓ Cleanup                          2.0s",
                "VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean",
            ]
        );
        assert!(plain(&done, &mut printed).is_empty());
        for l in first.iter().chain(&middle).chain(&last) {
            assert!(!l.chars().any(|c| c.is_control()), "{l:?}");
        }
    }

    #[test]
    fn a_finished_run_watched_later_prints_the_text_with_each_row() {
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        let mut done = folded(&lines);
        done.apply_ledger(&ledger());
        let out = plain(&done, &mut HashSet::new());
        assert!(out.contains(&"  ✓     3  action    exact                  1.1s     0.6s        —  Tap \"Tasks\"".to_string()), "{out:#?}");
        assert!(!out.iter().any(|l| l.starts_with("        line")));
    }

    fn temp_runs(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("qaren-watch-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("check-1").join("logs")).unwrap();
        root
    }

    fn args(plain: bool, json: bool) -> WatchArgs {
        WatchArgs {
            target: Target::RunId("check-1".into()),
            plain,
            json,
        }
    }

    fn follow_out(root: &Path, args: WatchArgs, alive: bool) -> (u8, String) {
        let mut out = Vec::new();
        let code = follow(root, &args, &mut out, &mut |_| alive, Duration::ZERO);
        (code, String::from_utf8(out).unwrap())
    }

    #[test]
    fn owner_dead_without_end_reports_incomplete() {
        let root = temp_runs("dead");
        let lines = reuse_check_live();
        std::fs::write(
            root.join("check-1/logs/events.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        let (code, out) = follow_out(&root, args(true, false), false);
        assert_eq!(code, 0);
        assert!(
            out.ends_with("ENDED WITHOUT FINAL EVENT (telemetry incomplete)\n"),
            "{out}"
        );
        assert!(out.contains("✓ Verify"));
        assert!(!out.contains('\u{1b}'));
        let (code, out) = follow_out(&root, args(false, true), false);
        assert_eq!(code, 0);
        let v: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["state"], "incomplete");
        assert_eq!(
            v["stages"][2],
            json!({"name": "build_decision", "state": "passed", "code": "reuse", "ms": 400})
        );
        assert_eq!(v["steps"][3]["line"], 7);
        assert!(v["steps"][3].get("text").is_none());
    }

    #[test]
    fn a_finished_run_is_printed_once_with_ledger_text() {
        let root = temp_runs("finished");
        let mut lines = reuse_check_live();
        finish(&mut lines, "fail", Some("PLAN_STEP_FAILED"));
        std::fs::write(
            root.join("check-1/logs/events.jsonl"),
            lines.join("\n") + "\n",
        )
        .unwrap();
        std::fs::write(
            root.join("check-1/ledger.json"),
            serde_json::to_string(&ledger()).unwrap(),
        )
        .unwrap();
        let (code, out) = follow_out(&root, args(true, false), true);
        assert_eq!(code, 0);
        assert!(out.contains("Type ••• into \"Email\""), "{out}");
        assert!(out.ends_with("VERDICT FAIL  (expected exit 1)  PLAN_STEP_FAILED  cleanup clean\n"));
        let (_, json_out) = follow_out(&root, args(false, true), true);
        let v: Value = serde_json::from_str(&json_out).unwrap();
        assert_eq!(v["state"], "finished");
        assert_eq!(v["end"]["result"], "fail");
        assert_eq!(v["steps"][1]["text"], "Type ••• into \"Email\"");
    }

    #[test]
    fn missing_events_is_unavailable_exit_3() {
        let root = temp_runs("missing");
        assert_eq!(follow_out(&root, args(true, false), true).0, 3);
        let none = WatchArgs {
            target: Target::RunId("check-2".into()),
            plain: true,
            json: false,
        };
        assert_eq!(follow_out(&root, none, true).0, 1);
        let bad = WatchArgs {
            target: Target::RunId("../etc".into()),
            plain: true,
            json: false,
        };
        assert_eq!(follow_out(&root, bad, true).0, 2);
        assert_eq!(
            follow_out(
                &root.join("absent"),
                WatchArgs {
                    target: Target::Latest,
                    plain: true,
                    json: false
                },
                true
            )
            .0,
            1
        );
    }

    #[test]
    fn latest_is_the_newest_run_record() {
        let root = temp_runs("latest");
        std::fs::create_dir_all(root.join("check-2")).unwrap();
        std::fs::write(root.join("check-1/run.json"), "{}").unwrap();
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(root.join("check-2/run.json"), "{}").unwrap();
        std::fs::create_dir_all(root.join("check-3")).unwrap();
        for id in ["check.latest", "check_latest", "-check"] {
            std::fs::create_dir_all(root.join(id)).unwrap();
            std::fs::write(root.join(id).join("run.json"), "{}").unwrap();
        }
        assert_eq!(latest(&root).as_deref(), Some("check-2"));
    }

    #[test]
    fn the_tail_keeps_a_partial_line_until_it_completes() {
        let root = temp_runs("tail");
        let path = root.join("check-1/logs/events.jsonl");
        std::fs::write(&path, "one\ntw").unwrap();
        let mut tail = Tail::new(path.clone());
        assert_eq!(tail.lines(), ["one"]);
        assert!(tail.lines().is_empty());
        use std::io::Write as _;
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"o\nthree\n")
            .unwrap();
        assert_eq!(tail.lines(), ["two", "three"]);
    }
}
