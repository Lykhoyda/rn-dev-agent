use crate::core::Row;
use crate::exec::Runner;
use crate::flow::plan::{
    Condition, Direction, Domain, Key, Op, Plan, Press, Selector, Step, Target,
};
use crate::flow::resolve::{self, Node, Resolution, Snapshot};
use crate::flow::trace::{Entry, StepOutcome, Trace};
use std::time::Duration;

pub const POLL_MS: u64 = 250;
// A dispatch that follows a lookup keeps the compiler's native dispatch budget as its window.
pub const DISPATCH_WINDOW_MS: u64 = 10_000;
// One snapshot or settle probe never waits longer than the runners' slow-verb ceiling.
pub const READ_WINDOW_CAP_MS: u64 = 35_000;
const READ_WINDOW_FLOOR_MS: u64 = 1_000;
pub const SETTLE_CAP_MS: u64 = 5_000;
const SCROLL_DURATION_MS: u64 = 300;
pub const KEYBOARD_DISMISS_FAILED: &str = "KEYBOARD_DISMISS_FAILED";
const KEYBOARD_RETRY_CODES: [&str; 2] = ["KEYBOARD_RELAYOUT_REQUIRED", "KEYBOARD_TARGET_STALE"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DriverError {
    // The request never reached the runner, so a mutation failed cleanly.
    Unsent(String),
    // Sent, but nothing proved the outcome: a timeout, a malformed reply, or a refusal without proof that nothing mutated.
    Unknown(String),
    // The runner answered ok:false and proved it did not mutate; the message is the engine's own text.
    Refused { code: String, message: String },
}

impl std::fmt::Display for DriverError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DriverError::Unsent(why) => write!(f, "not sent: {why}"),
            DriverError::Unknown(why) => write!(f, "outcome unknown: {why}"),
            DriverError::Refused { code, message } if message.is_empty() => f.write_str(code),
            DriverError::Refused { code, message } => write!(f, "{code}: {message}"),
        }
    }
}

pub type DriverResult<T> = Result<T, DriverError>;

// What a runner hands back for a screenshot; the run owner materialises it later.
#[derive(Clone, PartialEq, Eq)]
pub enum Capture {
    PngBase64(String),
    RunnerPath(String),
}

impl std::fmt::Debug for Capture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Capture::PngBase64(png) => write!(f, "PngBase64({} bytes)", png.len()),
            Capture::RunnerPath(_) => f.write_str("RunnerPath([withheld])"),
        }
    }
}

// Every call takes the runner it reaches the device through and the transport window it may use.
pub trait NativeDriver {
    fn snapshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Snapshot>;
    fn press(
        &mut self,
        runner: &mut dyn Runner,
        press: Press,
        x: f64,
        y: f64,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn type_text(
        &mut self,
        runner: &mut dyn Runner,
        text: &str,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn erase(
        &mut self,
        runner: &mut dyn Runner,
        characters: u64,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn press_key(&mut self, runner: &mut dyn Runner, key: Key, window_ms: u64) -> DriverResult<()>;
    fn drag(
        &mut self,
        runner: &mut dyn Runner,
        from: (f64, f64),
        to: (f64, f64),
        duration_ms: u64,
        window_ms: u64,
    ) -> DriverResult<()>;
    fn back(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()>;
    fn keyboard_dismiss(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<()>;
    fn is_settled(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<bool>;
    fn screenshot(&mut self, runner: &mut dyn Runner, window_ms: u64) -> DriverResult<Capture>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Presence {
    Present,
    Absent,
}

#[derive(Clone, PartialEq, Eq)]
pub enum HostOp {
    KeyboardDismissJs,
    Launch { stop_app: bool, clear_state: bool },
    StopApp,
    KillApp,
    ClearState,
    OpenLink(String),
}

impl HostOp {
    // The only form of the operation that rows and errors carry; a link stays in the request.
    pub fn name(&self) -> &'static str {
        match self {
            HostOp::KeyboardDismissJs => "keyboard.dismissJs",
            HostOp::Launch { .. } => "launchApp",
            HostOp::StopApp => "stopApp",
            HostOp::KillApp => "killApp",
            HostOp::ClearState => "clearState",
            HostOp::OpenLink(_) => "openLink",
        }
    }
}

impl std::fmt::Debug for HostOp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HostOp::Launch {
                stop_app,
                clear_state,
            } => write!(f, "launchApp(stopApp={stop_app}, clearState={clear_state})"),
            other => f.write_str(other.name()),
        }
    }
}

// The core child: one React-tree observation at a time, and the lifecycle and keyboard JS tiers.
pub trait HostDriver {
    fn observe(
        &mut self,
        runner: &mut dyn Runner,
        id: &str,
        window_ms: u64,
    ) -> DriverResult<Presence>;
    fn perform(&mut self, runner: &mut dyn Runner, op: &HostOp, window_ms: u64)
        -> DriverResult<()>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Pass,
    Fail,
    Cancelled(String),
}

#[derive(Debug)]
pub struct Outcome {
    pub verdict: Verdict,
    pub rows: Vec<Row>,
    pub failure: Option<String>,
    pub captures: Vec<(String, Capture)>,
}

// Runs a plan whose foreground surface the caller has already proven to be the app.
pub fn run(
    plan: &Plan,
    runner: &mut dyn Runner,
    native: &mut dyn NativeDriver,
    host: &mut dyn HostDriver,
) -> Outcome {
    let t0 = runner.monotonic_ms();
    let mut engine = Engine {
        runner,
        native,
        host,
        trace: Trace::new(&plan.action_id, t0),
        captures: Vec::new(),
        attempt: 1,
        answered_by: Domain::Native,
        screenshot: None,
    };
    let (verdict, failure) = match engine.run_steps(&plan.steps) {
        Ok(()) => (Verdict::Pass, None),
        Err(stop) => (stop.verdict, Some(stop.reason)),
    };
    Outcome {
        verdict,
        rows: engine.trace.rows,
        failure,
        captures: engine.captures,
    }
}

enum Fail {
    // The target was not there or the runner cleanly refused; `optional` may skip it.
    Miss(String),
    // The selector itself is wrong (ambiguous); `optional` never hides an authoring error.
    Selector(String),
    Unknown(String),
    Cancelled(String),
}

struct Stop {
    verdict: Verdict,
    reason: String,
}

struct Engine<'a> {
    runner: &'a mut dyn Runner,
    native: &'a mut dyn NativeDriver,
    host: &'a mut dyn HostDriver,
    trace: Trace,
    captures: Vec<(String, Capture)>,
    attempt: u64,
    answered_by: Domain,
    screenshot: Option<String>,
}

fn outcome(result: DriverResult<()>, what: &str) -> Result<(), Fail> {
    match result {
        Ok(()) => Ok(()),
        Err(DriverError::Unsent(why)) => Err(Fail::Miss(format!("{what} was not sent: {why}"))),
        Err(DriverError::Unknown(why)) => Err(Fail::Unknown(format!(
            "{what} was dispatched but its outcome is unknown: {why}"
        ))),
        Err(refused @ DriverError::Refused { .. }) => {
            Err(Fail::Miss(format!("{what} refused {refused}")))
        }
    }
}

fn ambiguous(selector: &Selector, candidates: &[String]) -> Fail {
    Fail::Selector(format!(
        "{} is ambiguous between {}",
        selector.describe(),
        candidates.join("; ")
    ))
}

// Half a screen in the direction, clamped to the screen.
pub fn swipe_path(
    screen: &Node,
    origin: (f64, f64),
    direction: Direction,
) -> ((f64, f64), (f64, f64)) {
    let (dx, dy) = match direction {
        Direction::Up => (0.0, -screen.height / 2.0),
        Direction::Down => (0.0, screen.height / 2.0),
        Direction::Left => (-screen.width / 2.0, 0.0),
        Direction::Right => (screen.width / 2.0, 0.0),
    };
    let clamp = |x: f64, y: f64| {
        (
            x.clamp(screen.x, screen.x + screen.width),
            y.clamp(screen.y, screen.y + screen.height),
        )
    };
    (
        clamp(origin.0, origin.1),
        clamp(origin.0 + dx, origin.1 + dy),
    )
}

// Scrolling DOWN reveals content below: the finger moves from 70% to 35% of the screen.
pub fn scroll_path(screen: &Node, direction: Direction) -> ((f64, f64), (f64, f64)) {
    let (cx, cy) = screen.center();
    let far = 0.7;
    let near = 0.35;
    let along_y = |f: f64| (cx, screen.y + screen.height * f);
    let along_x = |f: f64| (screen.x + screen.width * f, cy);
    match direction {
        Direction::Down => (along_y(far), along_y(near)),
        Direction::Up => (along_y(near), along_y(far)),
        Direction::Right => (along_x(far), along_x(near)),
        Direction::Left => (along_x(near), along_x(far)),
    }
}

impl Engine<'_> {
    fn now(&self) -> u64 {
        self.runner.monotonic_ms()
    }

    fn remaining(&self, deadline: u64) -> u64 {
        deadline.saturating_sub(self.now())
    }

    fn read_window(&self, deadline: u64) -> u64 {
        self.remaining(deadline)
            .clamp(READ_WINDOW_FLOOR_MS, READ_WINDOW_CAP_MS)
    }

    fn cancelled(&self) -> Result<(), Fail> {
        match self.runner.cancellation() {
            Some(reason) => Err(Fail::Cancelled(reason)),
            None => Ok(()),
        }
    }

    fn record(&mut self, step: &Step, outcome: StepOutcome, reason: Option<String>) {
        let now = self.now();
        self.trace.record(Entry {
            step,
            attempt: self.attempt,
            answered_by: self.answered_by,
            now,
            outcome,
            reason: reason.filter(|r| !r.is_empty()),
            screenshot: self.screenshot.take(),
        });
    }

    // The attempt that ends in a permitted second try leaves its own row.
    fn retry(&mut self, step: &Step, reason: String) {
        self.record(step, StepOutcome::Retry, Some(reason));
        self.attempt += 1;
    }

    fn run_steps(&mut self, steps: &[Step]) -> Result<(), Stop> {
        steps.iter().try_for_each(|step| self.step(step))
    }

    fn step(&mut self, step: &Step) -> Result<(), Stop> {
        self.attempt = 1;
        self.answered_by = step.domain;
        self.screenshot = None;
        if let Some(reason) = self.runner.cancellation() {
            return self.finish(step, Err(Fail::Cancelled(reason)));
        }
        let deadline = self.now().saturating_add(step.budget_ms);
        if let Op::RunFlow { when, steps } = &step.op {
            return match self.condition(when, step.domain) {
                Ok(true) => {
                    self.record(step, StepOutcome::Pass, Some("condition held".into()));
                    self.check_after(step)?;
                    self.run_steps(steps)
                }
                Ok(false) => {
                    self.record(
                        step,
                        StepOutcome::Skipped,
                        Some("condition not held".into()),
                    );
                    self.check_after(step)
                }
                Err(fail) => self.finish(step, Err(fail)),
            };
        }
        let result = self.execute(step, deadline);
        self.finish(step, result)
    }

    fn finish(&mut self, step: &Step, result: Result<String, Fail>) -> Result<(), Stop> {
        match result {
            Ok(detail) => {
                self.record(step, StepOutcome::Pass, Some(detail));
                self.check_after(step)
            }
            Err(Fail::Miss(reason)) if step.optional => {
                self.record(step, StepOutcome::Skipped, Some(reason));
                self.check_after(step)
            }
            Err(Fail::Miss(reason)) | Err(Fail::Selector(reason)) => {
                self.record(step, StepOutcome::Fail, Some(reason.clone()));
                Err(Stop {
                    verdict: Verdict::Fail,
                    reason: format!("step {}: {reason}", step.id),
                })
            }
            // Device state is unknown after an unanswered mutation, so even an optional step ends the run.
            Err(Fail::Unknown(reason)) => {
                self.record(step, StepOutcome::DispatchedUnknown, Some(reason.clone()));
                let verdict = self
                    .runner
                    .cancellation()
                    .map_or(Verdict::Fail, Verdict::Cancelled);
                Err(Stop {
                    verdict,
                    reason: format!("step {}: {reason}", step.id),
                })
            }
            Err(Fail::Cancelled(reason)) => {
                self.record(step, StepOutcome::Cancelled, Some(reason.clone()));
                Err(Stop {
                    verdict: Verdict::Cancelled(reason.clone()),
                    reason: format!("step {}: cancelled: {reason}", step.id),
                })
            }
        }
    }

    // A cancellation that arrived while the step ran ends the run after the step's truthful row.
    fn check_after(&mut self, step: &Step) -> Result<(), Stop> {
        match self.runner.cancellation() {
            Some(reason) => Err(Stop {
                verdict: Verdict::Cancelled(reason.clone()),
                reason: format!("cancelled after step {}: {reason}", step.id),
            }),
            None => Ok(()),
        }
    }

    fn execute(&mut self, step: &Step, deadline: u64) -> Result<String, Fail> {
        let budget = step.budget_ms;
        match &step.op {
            Op::LaunchApp {
                stop_app: false,
                clear_state: false,
            } => {
                let snapshot = self.snapshot_within(deadline)?;
                Ok(format!("app answered with {} nodes", snapshot.nodes.len()))
            }
            Op::LaunchApp {
                stop_app,
                clear_state,
            } => self.perform(
                &HostOp::Launch {
                    stop_app: *stop_app,
                    clear_state: *clear_state,
                },
                budget,
            ),
            Op::StopApp => self.perform(&HostOp::StopApp, budget),
            Op::KillApp => self.perform(&HostOp::KillApp, budget),
            Op::ClearState => self.perform(&HostOp::ClearState, budget),
            Op::OpenLink(link) => {
                self.perform(&HostOp::OpenLink(link.as_str().to_string()), budget)
            }
            Op::Press(press, selector) => self.press(step, *press, selector, deadline),
            Op::AssertVisible(selector) if step.domain == Domain::ReactTree => {
                self.tree_visible(selector, deadline)
            }
            Op::AssertVisible(selector) => self
                .lookup(selector, deadline)
                .map(|(node, _)| format!("found {}", node.describe())),
            Op::AssertNotVisible(selector) => self.absent(selector, deadline),
            Op::ScrollUntilVisible {
                selector,
                direction,
            } => self.scroll_until_visible(selector, *direction, deadline),
            Op::InputText(text) => self
                .dispatch("inputText", |e| {
                    e.native.type_text(e.runner, text.as_str(), budget)
                })
                .map(|_| "typed".into()),
            Op::EraseText(0) => Ok("nothing to erase".into()),
            Op::EraseText(characters) => self
                .dispatch("eraseText", |e| {
                    e.native.erase(e.runner, *characters, budget)
                })
                .map(|_| format!("erased {characters}")),
            Op::HideKeyboard => self.hide_keyboard(step, deadline),
            Op::PressKey(key) => self
                .dispatch("pressKey", |e| e.native.press_key(e.runner, *key, budget))
                .map(|_| format!("pressed {key:?}")),
            Op::Swipe {
                direction,
                from,
                duration_ms,
            } => self.swipe(from.as_ref(), *direction, *duration_ms, deadline),
            Op::Back => self
                .dispatch("back", |e| e.native.back(e.runner, budget))
                .map(|_| "back".into()),
            Op::Scroll => {
                let screen = self.snapshot_within(deadline)?.nodes[0].clone();
                let (start, end) = scroll_path(&screen, Direction::Down);
                self.dispatch("scroll", |e| {
                    e.native.drag(
                        e.runner,
                        start,
                        end,
                        SCROLL_DURATION_MS,
                        DISPATCH_WINDOW_MS.saturating_add(SCROLL_DURATION_MS),
                    )
                })
                .map(|_| "scrolled".into())
            }
            Op::WaitForAnimationToEnd => self.settle(deadline),
            Op::TakeScreenshot(name) => {
                self.cancelled()?;
                let capture = self
                    .native
                    .screenshot(self.runner, budget)
                    .map_err(|e| Fail::Miss(format!("screenshot failed: {e}")))?;
                self.captures.push((name.clone(), capture));
                self.screenshot = Some(name.clone());
                Ok("captured".into())
            }
            Op::RunFlow { .. } => unreachable!("runFlow is handled by step()"),
        }
    }

    fn dispatch(
        &mut self,
        what: &str,
        call: impl FnOnce(&mut Self) -> DriverResult<()>,
    ) -> Result<(), Fail> {
        self.cancelled()?;
        outcome(call(self), what)
    }

    fn perform(&mut self, op: &HostOp, window_ms: u64) -> Result<String, Fail> {
        let what = op.name();
        self.dispatch(what, |e| e.host.perform(e.runner, op, window_ms))
            .map(|_| format!("{what} done"))
    }

    // Observes until the closure yields or the deadline passes, always at least once; the closure
    // decides what is fatal.
    fn poll<T>(
        &mut self,
        deadline: u64,
        mut observe: impl FnMut(&mut Self, u64) -> Result<Option<T>, Fail>,
    ) -> Result<Option<T>, Fail> {
        loop {
            self.cancelled()?;
            let window = self.read_window(deadline);
            if let Some(found) = observe(self, window)? {
                return Ok(Some(found));
            }
            let now = self.now();
            if now >= deadline {
                return Ok(None);
            }
            self.runner
                .sleep(Duration::from_millis(POLL_MS.min(deadline - now)));
        }
    }

    fn snapshot_within(&mut self, deadline: u64) -> Result<Snapshot, Fail> {
        let mut last = String::from("no snapshot observed");
        let snapshot = self.poll(deadline, |engine, window| {
            match engine.native.snapshot(engine.runner, window) {
                Ok(snapshot) => Ok(Some(snapshot)),
                Err(error) => {
                    last = format!("snapshot failed: {error}");
                    Ok(None)
                }
            }
        })?;
        snapshot.ok_or(Fail::Miss(last))
    }

    // The target and the screen node it was found on. An index past today's list keeps polling:
    // more matches may still render, and the deadline failure names the list.
    fn lookup(&mut self, selector: &Selector, deadline: u64) -> Result<(Node, Node), Fail> {
        let mut last = String::from("no snapshot observed");
        let found = self.poll(deadline, |engine, window| {
            match engine.native.snapshot(engine.runner, window) {
                Ok(snapshot) => match resolve::resolve(selector, &snapshot.nodes) {
                    Resolution::Found(node) => Ok(Some((node, snapshot.nodes[0].clone()))),
                    Resolution::Ambiguous { candidates } => Err(ambiguous(selector, &candidates)),
                    Resolution::OutOfRange { index, matches } => {
                        last = format!(
                            "index {index} is out of range of {} match(es): {}",
                            matches.len(),
                            matches.join("; ")
                        );
                        Ok(None)
                    }
                    Resolution::NotFound { near_misses } => {
                        last = if snapshot.truncated {
                            "the snapshot was truncated".into()
                        } else if near_misses.is_empty() {
                            "no near misses".into()
                        } else {
                            format!("near misses: {}", near_misses.join("; "))
                        };
                        Ok(None)
                    }
                },
                Err(error) => {
                    last = format!("snapshot failed: {error}");
                    Ok(None)
                }
            }
        })?;
        found.ok_or_else(|| {
            Fail::Miss(format!(
                "{} not found before the deadline; {last}",
                selector.describe()
            ))
        })
    }

    // Absence is one complete snapshot without the nth match on screen; ambiguity means it is
    // still visible more than once.
    fn absent(&mut self, selector: &Selector, deadline: u64) -> Result<String, Fail> {
        let mut last = String::from("no snapshot observed");
        let gone = self.poll(deadline, |engine, window| {
            match engine.native.snapshot(engine.runner, window) {
                Ok(snapshot) => match resolve::resolve(selector, &snapshot.nodes) {
                    Resolution::NotFound { .. } | Resolution::OutOfRange { .. }
                        if !snapshot.truncated =>
                    {
                        Ok(Some(()))
                    }
                    Resolution::NotFound { .. } | Resolution::OutOfRange { .. } => {
                        last = "the snapshot was truncated, so absence is unproven".into();
                        Ok(None)
                    }
                    Resolution::Found(node) => {
                        last = format!("still visible: {}", node.describe());
                        Ok(None)
                    }
                    Resolution::Ambiguous { candidates } => {
                        last = format!("still visible: {}", candidates.join("; "));
                        Ok(None)
                    }
                },
                Err(error) => {
                    last = format!("snapshot failed: {error}");
                    Ok(None)
                }
            }
        })?;
        gone.map(|_| format!("{} absent", selector.describe()))
            .ok_or_else(|| {
                Fail::Miss(format!(
                    "{} still visible at the deadline; {last}",
                    selector.describe()
                ))
            })
    }

    fn tree_visible(&mut self, selector: &Selector, deadline: u64) -> Result<String, Fail> {
        let Target::Id(id) = &selector.target else {
            return Err(Fail::Selector("a React-tree read takes an id".into()));
        };
        let mut last = String::from("no observation");
        let present = self.poll(deadline, |engine, window| {
            match engine.host.observe(engine.runner, id, window) {
                Ok(Presence::Present) => Ok(Some(())),
                Ok(Presence::Absent) => {
                    last = "not mounted".into();
                    Ok(None)
                }
                Err(error) => {
                    last = format!("React tree unavailable: {error}");
                    Ok(None)
                }
            }
        })?;
        present
            .map(|_| format!("id {id:?} mounted"))
            .ok_or_else(|| Fail::Miss(format!("id {id:?} not visible before the deadline; {last}")))
    }

    // One observation decides a condition; anything short of a valid observation fails the step.
    fn condition(&mut self, when: &Condition, domain: Domain) -> Result<bool, Fail> {
        let selector = when.selector();
        let present = if domain == Domain::ReactTree {
            let Target::Id(id) = &selector.target else {
                return Err(Fail::Selector("a React-tree condition takes an id".into()));
            };
            match self.host.observe(self.runner, id, DISPATCH_WINDOW_MS) {
                Ok(Presence::Present) => true,
                Ok(Presence::Absent) => false,
                Err(error) => {
                    return Err(Fail::Miss(format!(
                        "condition unobservable: React tree unavailable: {error}"
                    )))
                }
            }
        } else {
            let snapshot = self
                .native
                .snapshot(self.runner, DISPATCH_WINDOW_MS)
                .map_err(|e| Fail::Miss(format!("condition unobservable: snapshot failed: {e}")))?;
            match resolve::resolve(selector, &snapshot.nodes) {
                Resolution::Found(_) => true,
                Resolution::NotFound { .. } | Resolution::OutOfRange { .. }
                    if !snapshot.truncated =>
                {
                    false
                }
                Resolution::NotFound { .. } | Resolution::OutOfRange { .. } => {
                    return Err(Fail::Miss(
                        "condition unobservable: the snapshot was truncated".into(),
                    ))
                }
                Resolution::Ambiguous { candidates } => {
                    return Err(ambiguous(selector, &candidates))
                }
            }
        };
        Ok(match when {
            Condition::Visible(_) => present,
            Condition::NotVisible(_) => !present,
        })
    }

    fn press(
        &mut self,
        step: &Step,
        press: Press,
        selector: &Selector,
        deadline: u64,
    ) -> Result<String, Fail> {
        let (node, _) = self.lookup(selector, deadline)?;
        let (x, y) = node.center();
        self.cancelled()?;
        let first = self
            .native
            .press(self.runner, press, x, y, DISPATCH_WINDOW_MS);
        match first {
            // The runner's keyboard guard dismissed the keyboard without pressing; one re-resolved press follows.
            Err(DriverError::Refused { code, message })
                if KEYBOARD_RETRY_CODES.contains(&code.as_str()) =>
            {
                self.retry(step, format!("{code} {message}").trim().to_string());
                let (node, _) = self.lookup(selector, deadline)?;
                let (x, y) = node.center();
                self.cancelled()?;
                let second = self
                    .native
                    .press(self.runner, press, x, y, DISPATCH_WINDOW_MS);
                outcome(second, "press").map(|_| {
                    format!(
                        "{} at ({x:.0},{y:.0}) after the keyboard guard",
                        node.describe()
                    )
                })
            }
            result => {
                outcome(result, "press").map(|_| format!("{} at ({x:.0},{y:.0})", node.describe()))
            }
        }
    }

    fn hide_keyboard(&mut self, step: &Step, deadline: u64) -> Result<String, Fail> {
        self.cancelled()?;
        match self.native.keyboard_dismiss(self.runner, step.budget_ms) {
            Ok(()) => Ok("native dismissal".into()),
            Err(DriverError::Refused { code, .. }) if code == KEYBOARD_DISMISS_FAILED => {
                self.retry(step, code);
                self.answered_by = Domain::ReactTree;
                let window = self.remaining(deadline).max(READ_WINDOW_FLOOR_MS);
                self.dispatch("keyboard.dismissJs", |e| {
                    e.host.perform(e.runner, &HostOp::KeyboardDismissJs, window)
                })
                .map(|_| "JavaScript tier dismissed the keyboard".into())
            }
            result => outcome(result, "keyboardDismiss").map(|_| String::new()),
        }
    }

    fn swipe(
        &mut self,
        from: Option<&Selector>,
        direction: Direction,
        duration_ms: u64,
        deadline: u64,
    ) -> Result<String, Fail> {
        let (origin, screen) = match from {
            Some(selector) => {
                let (node, screen) = self.lookup(selector, deadline)?;
                (node.center(), screen)
            }
            None => {
                let screen = self.snapshot_within(deadline)?.nodes[0].clone();
                (screen.center(), screen)
            }
        };
        let (start, end) = swipe_path(&screen, origin, direction);
        let window = DISPATCH_WINDOW_MS.saturating_add(duration_ms);
        self.dispatch("swipe", |e| {
            e.native.drag(e.runner, start, end, duration_ms, window)
        })
        .map(|_| {
            format!(
                "swiped {direction:?} from ({:.0},{:.0}) to ({:.0},{:.0})",
                start.0, start.1, end.0, end.1
            )
        })
    }

    fn scroll_until_visible(
        &mut self,
        selector: &Selector,
        direction: Direction,
        deadline: u64,
    ) -> Result<String, Fail> {
        let mut scrolls = 0u32;
        let mut last: String;
        loop {
            self.cancelled()?;
            let window = self.read_window(deadline);
            let screen = match self.native.snapshot(self.runner, window) {
                Ok(snapshot) => match resolve::resolve(selector, &snapshot.nodes) {
                    Resolution::Found(node) => {
                        return Ok(format!(
                            "{} visible after {scrolls} scroll(s)",
                            node.describe()
                        ))
                    }
                    Resolution::Ambiguous { candidates } => {
                        return Err(ambiguous(selector, &candidates))
                    }
                    Resolution::OutOfRange { index, matches } => {
                        last = format!(
                            "index {index} is out of range of {} match(es)",
                            matches.len()
                        );
                        Some(snapshot.nodes[0].clone())
                    }
                    Resolution::NotFound { near_misses } => {
                        last = if near_misses.is_empty() {
                            "no near misses".into()
                        } else {
                            format!("near misses: {}", near_misses.join("; "))
                        };
                        Some(snapshot.nodes[0].clone())
                    }
                },
                Err(error) => {
                    last = format!("snapshot failed: {error}");
                    None
                }
            };
            if self.now() >= deadline {
                return Err(Fail::Miss(format!(
                    "{} not visible after {scrolls} scroll(s); {last}",
                    selector.describe()
                )));
            }
            match screen {
                Some(screen) => {
                    let (start, end) = scroll_path(&screen, direction);
                    self.dispatch("scroll", |e| {
                        e.native.drag(
                            e.runner,
                            start,
                            end,
                            SCROLL_DURATION_MS,
                            DISPATCH_WINDOW_MS.saturating_add(SCROLL_DURATION_MS),
                        )
                    })?;
                    scrolls += 1;
                    let settle_by = deadline.min(self.now().saturating_add(SETTLE_CAP_MS));
                    if let Err(Fail::Cancelled(reason)) = self.settle(settle_by) {
                        return Err(Fail::Cancelled(reason));
                    }
                }
                None => self.runner.sleep(Duration::from_millis(POLL_MS)),
            }
        }
    }

    // Passes when the screen is static, or at the deadline when at least one probe answered.
    fn settle(&mut self, deadline: u64) -> Result<String, Fail> {
        let mut polls = 0u32;
        let mut observed = false;
        let mut last = String::new();
        let settled = self.poll(deadline, |engine, window| {
            polls += 1;
            match engine.native.is_settled(engine.runner, window) {
                Ok(true) => {
                    observed = true;
                    Ok(Some(()))
                }
                Ok(false) => {
                    observed = true;
                    Ok(None)
                }
                Err(error) => {
                    last = format!("settle probe failed: {error}");
                    Ok(None)
                }
            }
        })?;
        match (settled, observed) {
            (Some(()), _) => Ok(format!("settled after {polls} poll(s)")),
            (None, true) => Ok(format!("still changing after {polls} poll(s)")),
            (None, false) => Err(Fail::Miss(format!("no settle observation: {last}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::MockRunner;
    use crate::flow::plan::{Private, Source};
    use crate::scenario::Platform;
    use std::collections::VecDeque;

    const LATENCY_MS: u64 = 100;

    fn node(index: usize, kind: &str, label: &str, id: &str, y: f64) -> Node {
        Node {
            index,
            parent: Some(0),
            kind: kind.into(),
            label: label.into(),
            identifier: id.into(),
            value: String::new(),
            secure: false,
            x: 0.0,
            y,
            width: 400.0,
            height: 40.0,
        }
    }

    fn screen(labels: &[&str]) -> Snapshot {
        let mut nodes = vec![Node {
            parent: None,
            width: 400.0,
            height: 800.0,
            ..node(0, "Application", "", "", 0.0)
        }];
        for (i, label) in labels.iter().enumerate() {
            nodes.push(node(i + 1, "Button", label, label, 100.0 * (i + 1) as f64));
        }
        Snapshot {
            nodes,
            truncated: false,
        }
    }

    fn text(label: &str) -> Selector {
        Selector {
            target: Target::Text(label.into()),
            index: None,
        }
    }

    fn id(id: &str) -> Selector {
        Selector {
            target: Target::Id(id.into()),
            index: None,
        }
    }

    fn indexed(selector: Selector, index: usize) -> Selector {
        Selector {
            index: Some(index),
            ..selector
        }
    }

    fn step(id: &str, domain: Domain, budget_ms: u64, op: Op) -> Step {
        Step {
            id: id.into(),
            source: Source {
                line: 10,
                file: None,
            },
            domain,
            optional: false,
            budget_ms,
            op,
        }
    }

    fn optional(step: Step) -> Step {
        Step {
            optional: true,
            ..step
        }
    }

    fn plan(steps: Vec<Step>) -> Plan {
        Plan {
            action_id: "action".into(),
            app_id: "com.x".into(),
            platform: Platform::Ios,
            steps,
        }
    }

    struct ScriptedNative {
        snapshots: VecDeque<DriverResult<Snapshot>>,
        steady: DriverResult<Snapshot>,
        after_scroll: Option<Snapshot>,
        presses: VecDeque<DriverResult<()>>,
        keyboard: VecDeque<DriverResult<()>>,
        settled: VecDeque<DriverResult<bool>>,
        mutations: Vec<String>,
        snapshots_taken: u32,
    }

    impl ScriptedNative {
        fn steady(snapshot: Snapshot) -> Self {
            ScriptedNative {
                snapshots: VecDeque::new(),
                steady: Ok(snapshot),
                after_scroll: None,
                presses: VecDeque::new(),
                keyboard: VecDeque::new(),
                settled: VecDeque::new(),
                mutations: Vec::new(),
                snapshots_taken: 0,
            }
        }

        fn then(mut self, snapshots: Vec<DriverResult<Snapshot>>) -> Self {
            self.snapshots = snapshots.into();
            self
        }

        fn mutate(&mut self, runner: &mut dyn Runner, what: String) {
            runner.sleep(Duration::from_millis(LATENCY_MS));
            self.mutations.push(what);
        }
    }

    impl NativeDriver for ScriptedNative {
        fn snapshot(&mut self, runner: &mut dyn Runner, _window_ms: u64) -> DriverResult<Snapshot> {
            runner.sleep(Duration::from_millis(LATENCY_MS));
            self.snapshots_taken += 1;
            self.snapshots
                .pop_front()
                .unwrap_or_else(|| self.steady.clone())
        }

        fn press(
            &mut self,
            runner: &mut dyn Runner,
            press: Press,
            x: f64,
            y: f64,
            window_ms: u64,
        ) -> DriverResult<()> {
            self.mutate(runner, format!("{press:?}@{x:.0},{y:.0}/{window_ms}"));
            self.presses.pop_front().unwrap_or(Ok(()))
        }

        fn type_text(
            &mut self,
            runner: &mut dyn Runner,
            text: &str,
            window_ms: u64,
        ) -> DriverResult<()> {
            self.mutate(runner, format!("type:{text}/{window_ms}"));
            self.presses.pop_front().unwrap_or(Ok(()))
        }

        fn erase(
            &mut self,
            runner: &mut dyn Runner,
            characters: u64,
            _window_ms: u64,
        ) -> DriverResult<()> {
            self.mutate(runner, format!("erase:{characters}"));
            Ok(())
        }

        fn press_key(&mut self, runner: &mut dyn Runner, key: Key, _w: u64) -> DriverResult<()> {
            self.mutate(runner, format!("key:{key:?}"));
            Ok(())
        }

        fn drag(
            &mut self,
            runner: &mut dyn Runner,
            from: (f64, f64),
            to: (f64, f64),
            duration_ms: u64,
            _window_ms: u64,
        ) -> DriverResult<()> {
            self.mutate(
                runner,
                format!(
                    "drag:{:.0},{:.0}->{:.0},{:.0}/{duration_ms}",
                    from.0, from.1, to.0, to.1
                ),
            );
            if let Some(after) = self.after_scroll.take() {
                self.snapshots.push_front(Ok(after));
            }
            self.presses.pop_front().unwrap_or(Ok(()))
        }

        fn back(&mut self, runner: &mut dyn Runner, _window_ms: u64) -> DriverResult<()> {
            self.mutate(runner, "back".into());
            Ok(())
        }

        fn keyboard_dismiss(&mut self, runner: &mut dyn Runner, _w: u64) -> DriverResult<()> {
            self.mutate(runner, "keyboardDismiss".into());
            self.keyboard.pop_front().unwrap_or(Ok(()))
        }

        fn is_settled(&mut self, runner: &mut dyn Runner, _window_ms: u64) -> DriverResult<bool> {
            runner.sleep(Duration::from_millis(LATENCY_MS));
            self.settled.pop_front().unwrap_or(Ok(true))
        }

        fn screenshot(&mut self, runner: &mut dyn Runner, _w: u64) -> DriverResult<Capture> {
            runner.sleep(Duration::from_millis(LATENCY_MS));
            Ok(Capture::RunnerPath("tmp/shot.png".into()))
        }
    }

    #[derive(Default)]
    struct ScriptedHost {
        observations: VecDeque<DriverResult<Presence>>,
        observed: Vec<(String, u64)>,
        performed: Vec<HostOp>,
        results: VecDeque<DriverResult<()>>,
    }

    impl HostDriver for ScriptedHost {
        fn observe(
            &mut self,
            runner: &mut dyn Runner,
            id: &str,
            window_ms: u64,
        ) -> DriverResult<Presence> {
            runner.sleep(Duration::from_millis(LATENCY_MS));
            self.observed.push((id.into(), window_ms));
            self.observations
                .pop_front()
                .unwrap_or(Ok(Presence::Absent))
        }

        fn perform(&mut self, runner: &mut dyn Runner, op: &HostOp, _w: u64) -> DriverResult<()> {
            runner.sleep(Duration::from_millis(LATENCY_MS));
            self.performed.push(op.clone());
            self.results.pop_front().unwrap_or(Ok(()))
        }
    }

    fn drive(plan: &Plan, native: &mut ScriptedNative, host: &mut ScriptedHost) -> (Outcome, u64) {
        let mut runner = MockRunner::new();
        let t0 = runner.now_epoch_ms();
        let outcome = run(plan, &mut runner, native, host);
        (outcome, runner.now_epoch_ms() - t0)
    }

    fn drive_cancelling(
        plan: &Plan,
        native: &mut ScriptedNative,
        host: &mut ScriptedHost,
        after_ms: u64,
        reason: &str,
    ) -> Outcome {
        let mut runner = MockRunner::new();
        runner.cancel_at_ms = Some((runner.now_epoch_ms() + after_ms, reason.into()));
        run(plan, &mut runner, native, host)
    }

    fn outcomes(rows: &[Row]) -> Vec<&str> {
        rows.iter().map(|row| row.outcome.as_str()).collect()
    }

    fn tap(label: &str) -> Op {
        Op::Press(Press::Tap, text(label))
    }

    fn refused(code: &str) -> DriverError {
        DriverError::Refused {
            code: code.into(),
            message: String::new(),
        }
    }

    #[test]
    fn a_lookup_polls_until_the_target_appears_then_presses_once() {
        let plan = plan(vec![step("s1", Domain::Native, 17_000, tap("Go"))]);
        let mut native =
            ScriptedNative::steady(screen(&["Go"])).then(vec![Ok(screen(&[])), Ok(screen(&[]))]);
        let (outcome, elapsed) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(native.snapshots_taken, 3);
        assert_eq!(native.mutations, vec!["Tap@200,120/10000"]);
        assert!(elapsed >= 2 * POLL_MS, "{elapsed}");
        let row = &outcome.rows[0];
        assert_eq!(
            (row.outcome.as_str(), row.attempt, row.line),
            ("pass", 1, 10)
        );
        assert_eq!(row.r#ref.as_deref(), Some("s1"));
        assert_eq!(row.resolved_by, "native");
        assert_eq!(row.text.as_deref(), Some("tapOn text \"Go\""));
    }

    #[test]
    fn a_lookup_that_never_resolves_fails_with_near_misses_and_stops_the_run() {
        let plan = plan(vec![
            step("s1", Domain::Native, 1_000, tap("Go")),
            step("s2", Domain::Native, 1_000, tap("Later")),
        ]);
        let mut native = ScriptedNative::steady(screen(&["Go home", "Later"]));
        let (outcome, elapsed) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Fail);
        assert_eq!(outcomes(&outcome.rows), vec!["fail"]);
        let reason = outcome.rows[0].reason.clone().unwrap();
        assert!(
            reason.contains("near misses") && reason.contains("Go home"),
            "{reason}"
        );
        assert!(native.mutations.is_empty());
        assert!((1_000..1_400).contains(&elapsed), "{elapsed}");
        assert!(outcome.failure.unwrap().starts_with("step s1"));
    }

    #[test]
    fn an_optional_miss_is_skipped_and_the_run_continues() {
        let plan = plan(vec![
            optional(step("s1", Domain::Native, 500, tap("Skip"))),
            step("s2", Domain::Native, 1_000, tap("Go")),
        ]);
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        let (outcome, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(outcomes(&outcome.rows), vec!["skipped", "pass"]);
        assert_eq!(native.mutations.len(), 1);
    }

    #[test]
    fn an_ambiguous_selector_fails_even_when_optional() {
        let plan = plan(vec![
            optional(step("s1", Domain::Native, 1_000, tap("Save"))),
            step("s2", Domain::Native, 1_000, tap("Go")),
        ]);
        let mut snapshot = screen(&["Save", "Save", "Go"]);
        snapshot.nodes[2].kind = "StaticText".into();
        let mut native = ScriptedNative::steady(snapshot);
        let (outcome, elapsed) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(
            outcome.verdict,
            Verdict::Fail,
            "an authoring error is never skipped"
        );
        assert_eq!(outcomes(&outcome.rows), vec!["fail"]);
        assert!(outcome.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("ambiguous"));
        assert!(native.mutations.is_empty(), "nothing is pressed");
        assert!(
            elapsed < POLL_MS,
            "fails on the first observation: {elapsed}"
        );
    }

    #[test]
    fn an_extended_wait_honours_its_own_budget() {
        let late = |budget| {
            plan(vec![step(
                "s1",
                Domain::Native,
                budget,
                Op::AssertVisible(text("Done")),
            )])
        };
        let appears_late = || {
            ScriptedNative::steady(screen(&["Done"])).then(vec![
                Ok(screen(&[])),
                Ok(screen(&[])),
                Ok(screen(&[])),
                Ok(screen(&[])),
            ])
        };
        let (patient, _) = drive(
            &late(3_000),
            &mut appears_late(),
            &mut ScriptedHost::default(),
        );
        assert_eq!(patient.verdict, Verdict::Pass);
        let (hasty, elapsed) = drive(
            &late(500),
            &mut appears_late(),
            &mut ScriptedHost::default(),
        );
        assert_eq!(hasty.verdict, Verdict::Fail);
        assert!(elapsed < 1_000, "the deadline bounds the wait: {elapsed}");
    }

    #[test]
    fn absence_is_a_bounded_poll_over_complete_snapshots() {
        let absent = |budget| {
            plan(vec![step(
                "s1",
                Domain::Native,
                budget,
                Op::AssertNotVisible(id("sheet")),
            )])
        };
        let mut leaves = ScriptedNative::steady(screen(&[]))
            .then(vec![Ok(screen(&["sheet"])), Ok(screen(&["sheet"]))]);
        let (gone, _) = drive(&absent(7_000), &mut leaves, &mut ScriptedHost::default());
        assert_eq!(gone.verdict, Verdict::Pass);
        assert_eq!(leaves.snapshots_taken, 3);

        let mut stays = ScriptedNative::steady(screen(&["sheet"]));
        let (still, _) = drive(&absent(1_000), &mut stays, &mut ScriptedHost::default());
        assert_eq!(still.verdict, Verdict::Fail);
        assert!(still.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("still visible"));

        let mut twice = ScriptedNative::steady(screen(&["sheet", "sheet"]));
        let (doubled, _) = drive(&absent(1_000), &mut twice, &mut ScriptedHost::default());
        assert_eq!(
            doubled.verdict,
            Verdict::Fail,
            "two matches are still visible"
        );

        let mut truncated = screen(&[]);
        truncated.truncated = true;
        let mut partial = ScriptedNative::steady(truncated);
        let (unproven, _) = drive(&absent(1_000), &mut partial, &mut ScriptedHost::default());
        assert_eq!(unproven.verdict, Verdict::Fail);
        assert!(unproven.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("truncated"));
    }

    #[test]
    fn an_index_past_the_visible_matches_counts_as_absent() {
        let plan = plan(vec![step(
            "s1",
            Domain::Native,
            7_000,
            Op::AssertNotVisible(indexed(id("sheet"), 3)),
        )]);
        let mut native = ScriptedNative::steady(screen(&["sheet"]));
        let (outcome, elapsed) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert!(elapsed < POLL_MS, "one observation: {elapsed}");
    }

    #[test]
    fn scroll_until_visible_scrolls_settles_and_finds_the_target() {
        let plan = plan(vec![step(
            "s1",
            Domain::Native,
            20_000,
            Op::ScrollUntilVisible {
                selector: text("Footer"),
                direction: Direction::Down,
            },
        )]);
        let mut native = ScriptedNative::steady(screen(&["Header"]));
        native.after_scroll = Some(screen(&["Footer"]));
        native.settled = vec![Ok(false), Ok(true)].into();
        let (outcome, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(native.mutations, vec!["drag:200,560->200,280/300"]);
        assert!(outcome.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("after 1 scroll"));
        assert!(
            native.settled.is_empty(),
            "both settle probes were consumed"
        );
    }

    #[test]
    fn scroll_until_visible_gives_up_at_its_deadline() {
        let plan = plan(vec![step(
            "s1",
            Domain::Native,
            1_000,
            Op::ScrollUntilVisible {
                selector: text("Footer"),
                direction: Direction::Up,
            },
        )]);
        let mut native = ScriptedNative::steady(screen(&["Header"]));
        let (outcome, elapsed) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Fail);
        assert!(!native.mutations.is_empty());
        assert!(native
            .mutations
            .iter()
            .all(|m| m.starts_with("drag:200,280->200,560")));
        assert!(outcome.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("scroll(s)"));
        assert!(elapsed < 2_000, "{elapsed}");
    }

    #[test]
    fn wait_for_animation_passes_when_static_or_at_the_cap_but_needs_one_observation() {
        let wait = || {
            plan(vec![step(
                "s1",
                Domain::Native,
                1_000,
                Op::WaitForAnimationToEnd,
            )])
        };
        let mut settles = ScriptedNative::steady(screen(&[]));
        settles.settled = vec![Ok(false), Ok(false), Ok(true)].into();
        let (settled, _) = drive(&wait(), &mut settles, &mut ScriptedHost::default());
        assert_eq!(settled.verdict, Verdict::Pass);
        assert!(settled.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("settled after 3"));

        let mut busy = ScriptedNative::steady(screen(&[]));
        busy.settled = std::iter::repeat_n(Ok(false), 20).collect();
        let (changing, _) = drive(&wait(), &mut busy, &mut ScriptedHost::default());
        assert_eq!(changing.verdict, Verdict::Pass);
        assert!(changing.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("still changing"));

        let mut blind = ScriptedNative::steady(screen(&[]));
        blind.settled = std::iter::repeat_n(Err(DriverError::Unsent("down".into())), 20).collect();
        let (unobserved, _) = drive(&wait(), &mut blind, &mut ScriptedHost::default());
        assert_eq!(unobserved.verdict, Verdict::Fail);
        assert!(unobserved.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("no settle observation"));
    }

    fn conditional(when: Condition, domain: Domain) -> Plan {
        plan(vec![
            step(
                "s1",
                domain,
                0,
                Op::RunFlow {
                    when,
                    steps: vec![step("s2", Domain::Native, 1_000, tap("Skip"))],
                },
            ),
            step("s3", Domain::Native, 1_000, tap("Go")),
        ])
    }

    #[test]
    fn a_run_flow_condition_is_one_observation_and_gates_its_sub_steps() {
        let mut shown = ScriptedNative::steady(screen(&["Skip", "Go"]));
        let (held, _) = drive(
            &conditional(Condition::Visible(text("Skip")), Domain::Native),
            &mut shown,
            &mut ScriptedHost::default(),
        );
        assert_eq!(held.verdict, Verdict::Pass);
        assert_eq!(outcomes(&held.rows), vec!["pass", "pass", "pass"]);
        assert_eq!(held.rows[0].kind, "check");
        assert_eq!(shown.mutations.len(), 2);

        let mut hidden = ScriptedNative::steady(screen(&["Go"]));
        let (skipped, elapsed) = drive(
            &conditional(Condition::Visible(text("Skip")), Domain::Native),
            &mut hidden,
            &mut ScriptedHost::default(),
        );
        assert_eq!(skipped.verdict, Verdict::Pass);
        assert_eq!(outcomes(&skipped.rows), vec!["skipped", "pass"]);
        assert_eq!(hidden.mutations.len(), 1);
        assert!(
            elapsed < 3 * LATENCY_MS + POLL_MS,
            "one observation: {elapsed}"
        );

        let mut hidden = ScriptedNative::steady(screen(&["Go"]));
        let (inverse, _) = drive(
            &conditional(Condition::NotVisible(text("Skip")), Domain::Native),
            &mut hidden,
            &mut ScriptedHost::default(),
        );
        assert_eq!(
            outcomes(&inverse.rows),
            vec!["pass", "fail"],
            "the sub-step needs Skip"
        );
        assert_eq!(inverse.verdict, Verdict::Fail);

        let mut single = ScriptedNative::steady(screen(&["Skip", "Go"]));
        let (second_missing, _) = drive(
            &conditional(Condition::Visible(indexed(text("Skip"), 1)), Domain::Native),
            &mut single,
            &mut ScriptedHost::default(),
        );
        assert_eq!(
            outcomes(&second_missing.rows),
            vec!["skipped", "pass"],
            "no second Skip"
        );

        let mut doubled = ScriptedNative::steady(screen(&["Skip", "Skip", "Go"]));
        let (ambiguous, _) = drive(
            &conditional(Condition::Visible(text("Skip")), Domain::Native),
            &mut doubled,
            &mut ScriptedHost::default(),
        );
        assert_eq!(outcomes(&ambiguous.rows), vec!["fail"]);
    }

    #[test]
    fn a_react_tree_condition_asks_the_host_once_and_fails_when_unobservable() {
        let mut native = ScriptedNative::steady(screen(&["Skip", "Go"]));
        let mut host = ScriptedHost {
            observations: vec![Ok(Presence::Present)].into(),
            ..Default::default()
        };
        let (held, _) = drive(
            &conditional(Condition::Visible(id("onboarding")), Domain::ReactTree),
            &mut native,
            &mut host,
        );
        assert_eq!(held.verdict, Verdict::Pass);
        assert_eq!(
            host.observed,
            vec![("onboarding".to_string(), DISPATCH_WINDOW_MS)]
        );
        assert_eq!(held.rows[0].resolved_by, "react-tree");

        let mut host = ScriptedHost {
            observations: vec![Err(refused("REACT_TREE_UNAVAILABLE"))].into(),
            ..Default::default()
        };
        let (blind, _) = drive(
            &conditional(Condition::Visible(id("onboarding")), Domain::ReactTree),
            &mut native,
            &mut host,
        );
        assert_eq!(blind.verdict, Verdict::Fail);
        assert_eq!(outcomes(&blind.rows), vec!["fail"]);
    }

    #[test]
    fn a_react_tree_assertion_polls_the_host_within_its_budget() {
        let plan = plan(vec![step(
            "s1",
            Domain::ReactTree,
            2_000,
            Op::AssertVisible(id("screen")),
        )]);
        let mut host = ScriptedHost {
            observations: vec![Ok(Presence::Absent), Ok(Presence::Present)].into(),
            ..Default::default()
        };
        let (outcome, _) = drive(&plan, &mut ScriptedNative::steady(screen(&[])), &mut host);
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(host.observed.len(), 2);
        let mut never = ScriptedHost::default();
        let (missing, _) = drive(&plan, &mut ScriptedNative::steady(screen(&[])), &mut never);
        assert_eq!(missing.verdict, Verdict::Fail);
        assert!(missing.rows[0]
            .reason
            .clone()
            .unwrap()
            .contains("not mounted"));
    }

    #[test]
    fn the_keyboard_tier_runs_only_after_a_native_dismiss_failure() {
        let hide = || plan(vec![step("s1", Domain::Native, 10_000, Op::HideKeyboard)]);
        let mut native = ScriptedNative::steady(screen(&[]));
        native.keyboard = vec![Err(refused(KEYBOARD_DISMISS_FAILED))].into();
        let mut host = ScriptedHost::default();
        let (outcome, _) = drive(&hide(), &mut native, &mut host);
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(host.performed, vec![HostOp::KeyboardDismissJs]);
        let attempts: Vec<(u64, &str, &str)> = outcome
            .rows
            .iter()
            .map(|r| (r.attempt, r.outcome.as_str(), r.resolved_by.as_str()))
            .collect();
        assert_eq!(
            attempts,
            vec![(1, "retry", "native"), (2, "pass", "react-tree")]
        );

        let mut native = ScriptedNative::steady(screen(&[]));
        native.keyboard = vec![Err(refused(KEYBOARD_DISMISS_FAILED))].into();
        let mut host = ScriptedHost {
            results: vec![Err(refused("KEYBOARD_STILL_VISIBLE"))].into(),
            ..Default::default()
        };
        let (failed, _) = drive(&hide(), &mut native, &mut host);
        assert_eq!(failed.verdict, Verdict::Fail);
        assert_eq!(outcomes(&failed.rows), vec!["retry", "fail"]);

        let mut native = ScriptedNative::steady(screen(&[]));
        native.keyboard = vec![Err(refused("UNSUPPORTED_COMMAND"))].into();
        let mut host = ScriptedHost::default();
        let (other, _) = drive(&hide(), &mut native, &mut host);
        assert_eq!(outcomes(&other.rows), vec!["fail"]);
        assert!(host.performed.is_empty(), "no tier for other refusals");
    }

    #[test]
    fn the_keyboard_guard_earns_exactly_one_re_resolved_press() {
        let plan = plan(vec![step("s1", Domain::Native, 17_000, tap("Go"))]);
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        native.presses = vec![Err(refused("KEYBOARD_RELAYOUT_REQUIRED")), Ok(())].into();
        let (outcome, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(outcomes(&outcome.rows), vec!["retry", "pass"]);
        assert_eq!(native.mutations.len(), 2);
        assert_eq!(native.snapshots_taken, 2, "the target is re-resolved");

        let mut native = ScriptedNative::steady(screen(&["Go"]));
        native.presses = vec![
            Err(refused("KEYBOARD_RELAYOUT_REQUIRED")),
            Err(refused("KEYBOARD_TARGET_STALE")),
        ]
        .into();
        let (twice, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(twice.verdict, Verdict::Fail);
        assert_eq!(outcomes(&twice.rows), vec!["retry", "fail"]);
    }

    #[test]
    fn an_unanswered_mutation_is_dispatched_unknown_and_never_re_sent() {
        let plan = plan(vec![
            optional(step("s1", Domain::Native, 17_000, tap("Go"))),
            step("s2", Domain::Native, 17_000, tap("Go")),
        ]);
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        native.presses = vec![Err(DriverError::Unknown("curl timed out".into()))].into();
        let (outcome, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Fail);
        assert_eq!(outcomes(&outcome.rows), vec!["dispatched-unknown"]);
        assert_eq!(
            native.mutations.len(),
            1,
            "one outstanding mutation, never a second"
        );
        assert!(outcome.failure.unwrap().contains("outcome is unknown"));
    }

    #[test]
    fn an_unsent_mutation_fails_cleanly_and_may_be_optional() {
        let plan = plan(vec![
            optional(step("s1", Domain::Native, 17_000, tap("Go"))),
            step("s2", Domain::Native, 17_000, tap("Go")),
        ]);
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        native.presses = vec![Err(DriverError::Unsent("connection refused".into()))].into();
        let (outcome, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(outcomes(&outcome.rows), vec!["skipped", "pass"]);
    }

    #[test]
    fn cancellation_mid_lookup_ends_the_run_without_a_dispatch() {
        let plan = plan(vec![
            step("s1", Domain::Native, 17_000, tap("Go")),
            step("s2", Domain::Native, 17_000, tap("Go")),
        ]);
        let mut native = ScriptedNative::steady(screen(&[]));
        let outcome = drive_cancelling(
            &plan,
            &mut native,
            &mut ScriptedHost::default(),
            600,
            "received SIGTERM",
        );
        assert_eq!(
            outcome.verdict,
            Verdict::Cancelled("received SIGTERM".into())
        );
        assert_eq!(outcomes(&outcome.rows), vec!["cancelled"]);
        assert!(native.mutations.is_empty());
        assert!(
            (2..=3).contains(&native.snapshots_taken),
            "{}",
            native.snapshots_taken
        );
    }

    #[test]
    fn cancellation_during_a_completed_mutation_keeps_its_row_truthful() {
        let plan = plan(vec![
            step("s1", Domain::Native, 17_000, tap("Go")),
            step("s2", Domain::Native, 17_000, tap("Go")),
        ]);
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        let outcome = drive_cancelling(
            &plan,
            &mut native,
            &mut ScriptedHost::default(),
            150,
            "received SIGINT",
        );
        assert_eq!(outcomes(&outcome.rows), vec!["pass"]);
        assert_eq!(
            outcome.verdict,
            Verdict::Cancelled("received SIGINT".into())
        );
        assert_eq!(native.mutations.len(), 1);
        assert!(outcome.failure.unwrap().contains("cancelled after step s1"));
    }

    #[test]
    fn cancellation_on_a_final_skip_never_passes_the_run() {
        let optional_last = plan(vec![optional(step(
            "s1",
            Domain::Native,
            17_000,
            tap("Go"),
        ))]);
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        native.presses = vec![Err(DriverError::Unsent("connection refused".into()))].into();
        let outcome = drive_cancelling(
            &optional_last,
            &mut native,
            &mut ScriptedHost::default(),
            150,
            "received SIGTERM",
        );
        assert_eq!(outcomes(&outcome.rows), vec!["skipped"]);
        assert_eq!(
            outcome.verdict,
            Verdict::Cancelled("received SIGTERM".into())
        );

        let condition_last = plan(vec![step(
            "s1",
            Domain::Native,
            0,
            Op::RunFlow {
                when: Condition::Visible(text("Skip")),
                steps: vec![step("s2", Domain::Native, 1_000, tap("Skip"))],
            },
        )]);
        let mut hidden = ScriptedNative::steady(screen(&["Go"]));
        let outcome = drive_cancelling(
            &condition_last,
            &mut hidden,
            &mut ScriptedHost::default(),
            50,
            "received SIGHUP",
        );
        assert_eq!(outcomes(&outcome.rows), vec!["skipped"]);
        assert_eq!(
            outcome.verdict,
            Verdict::Cancelled("received SIGHUP".into())
        );
    }

    #[test]
    fn lifecycle_steps_go_to_the_host_and_a_foreground_launch_only_proves_the_app_answers() {
        let plan = plan(vec![
            step(
                "s1",
                Domain::Lifecycle,
                15_000,
                Op::LaunchApp {
                    stop_app: true,
                    clear_state: false,
                },
            ),
            step(
                "s2",
                Domain::Native,
                15_000,
                Op::LaunchApp {
                    stop_app: false,
                    clear_state: false,
                },
            ),
            step(
                "s3",
                Domain::Lifecycle,
                15_000,
                Op::OpenLink(Private("app://x?token=TOKEN-42".into())),
            ),
        ]);
        let mut native = ScriptedNative::steady(screen(&["Home"]));
        let mut host = ScriptedHost {
            results: vec![Ok(()), Err(refused("LINK_REFUSED"))].into(),
            ..Default::default()
        };
        let (outcome, _) = drive(&plan, &mut native, &mut host);
        assert_eq!(
            outcome.verdict,
            Verdict::Fail,
            "the refused link fails the step"
        );
        assert_eq!(
            host.performed,
            vec![
                HostOp::Launch {
                    stop_app: true,
                    clear_state: false
                },
                HostOp::OpenLink("app://x?token=TOKEN-42".into())
            ]
        );
        assert_eq!(outcome.rows[0].resolved_by, "lifecycle");
        assert!(outcome.rows[1].reason.clone().unwrap().contains("2 nodes"));
        assert!(native.mutations.is_empty());
        let shown = format!(
            "{} {:?} {}",
            serde_json::to_string(&outcome.rows).unwrap(),
            host.performed,
            outcome.failure.unwrap()
        );
        assert!(!shown.contains("TOKEN-42"), "{shown}");
        assert!(shown.contains("openLink refused LINK_REFUSED"));
    }

    #[test]
    fn a_swipe_looks_up_its_origin_and_never_drags_after_the_deadline() {
        let swipe = |from, duration_ms| {
            plan(vec![step(
                "s1",
                Domain::Native,
                1_000,
                Op::Swipe {
                    direction: Direction::Down,
                    from,
                    duration_ms,
                },
            )])
        };
        let mut native = ScriptedNative::steady(screen(&["handle"]));
        let (outcome, _) = drive(
            &swipe(Some(id("handle")), 400),
            &mut native,
            &mut ScriptedHost::default(),
        );
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(native.mutations, vec!["drag:200,120->200,520/400"]);

        let mut missing = ScriptedNative::steady(screen(&[]));
        let (failed, _) = drive(
            &swipe(Some(id("handle")), 400),
            &mut missing,
            &mut ScriptedHost::default(),
        );
        assert_eq!(failed.verdict, Verdict::Fail);
        assert!(missing.mutations.is_empty(), "no drag without an origin");

        let mut centre = ScriptedNative::steady(screen(&[]));
        let (free, _) = drive(
            &swipe(None, u64::MAX),
            &mut centre,
            &mut ScriptedHost::default(),
        );
        assert_eq!(
            free.verdict,
            Verdict::Pass,
            "an absurd duration saturates instead of panicking"
        );
        assert!(centre.mutations[0].starts_with("drag:200,400->200,800/"));
    }

    #[test]
    fn typing_erasing_and_screenshots_leave_no_typed_text_in_rows() {
        let plan = plan(vec![
            step(
                "s1",
                Domain::Native,
                10_000,
                Op::InputText(Private("hunter2".into())),
            ),
            step("s2", Domain::Native, 10_000, Op::EraseText(0)),
            step("s3", Domain::Native, 10_000, Op::EraseText(7)),
            step("s4", Domain::Native, 10_000, Op::PressKey(Key::Enter)),
            step(
                "s5",
                Domain::Native,
                10_000,
                Op::TakeScreenshot("after".into()),
            ),
        ]);
        let mut native = ScriptedNative::steady(screen(&[]));
        let (outcome, _) = drive(&plan, &mut native, &mut ScriptedHost::default());
        assert_eq!(outcome.verdict, Verdict::Pass);
        assert_eq!(
            native.mutations,
            vec!["type:hunter2/10000", "erase:7", "key:Enter"],
            "zero characters dispatch nothing"
        );
        let json = serde_json::to_string(&outcome.rows).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
        assert!(!format!("{plan:?} {outcome:?}").contains("hunter2"));
        assert!(json.contains("\"resolvedBy\":\"native\"") && json.contains("\"ref\":\"s1\""));
        assert_eq!(outcome.rows[4].screenshot.as_deref(), Some("after"));
        assert_eq!(
            outcome.captures,
            vec![(
                "after".to_string(),
                Capture::RunnerPath("tmp/shot.png".into())
            )]
        );
        assert!(!format!("{:?}", outcome.captures).contains("shot.png"));
    }

    #[test]
    fn every_outcome_appears_in_rows_and_serialises_as_a_core_row() {
        let mut seen: Vec<String> = Vec::new();
        let mut collect = |outcome: Outcome| {
            seen.extend(outcome.rows.iter().map(|r| r.outcome.clone()));
            for row in &outcome.rows {
                let value = serde_json::to_value(row).unwrap();
                let back: Row = serde_json::from_value(value).unwrap();
                assert_eq!(&back, row);
            }
        };
        let mut native = ScriptedNative::steady(screen(&["Go"]));
        native.keyboard = vec![Err(refused(KEYBOARD_DISMISS_FAILED))].into();
        native.presses = vec![Ok(()), Err(DriverError::Unknown("lost".into()))].into();
        collect(
            drive(
                &plan(vec![
                    step("s1", Domain::Native, 10_000, Op::HideKeyboard),
                    optional(step("s2", Domain::Native, 500, tap("Missing"))),
                    step("s3", Domain::Native, 17_000, tap("Go")),
                    step("s4", Domain::Native, 17_000, tap("Go")),
                ]),
                &mut native,
                &mut ScriptedHost::default(),
            )
            .0,
        );
        collect(
            drive(
                &plan(vec![step("s1", Domain::Native, 500, tap("Missing"))]),
                &mut ScriptedNative::steady(screen(&[])),
                &mut ScriptedHost::default(),
            )
            .0,
        );
        collect(drive_cancelling(
            &plan(vec![step("s1", Domain::Native, 5_000, tap("Go"))]),
            &mut ScriptedNative::steady(screen(&[])),
            &mut ScriptedHost::default(),
            1,
            "received SIGHUP",
        ));
        for outcome in [
            "pass",
            "fail",
            "skipped",
            "retry",
            "dispatched-unknown",
            "cancelled",
        ] {
            assert!(
                seen.iter().any(|s| s == outcome),
                "{outcome} missing from {seen:?}"
            );
        }
    }

    #[test]
    fn swipe_and_scroll_paths_stay_on_screen() {
        let screen = screen(&[]).nodes[0].clone();
        assert_eq!(
            swipe_path(&screen, (200.0, 700.0), Direction::Down),
            ((200.0, 700.0), (200.0, 800.0))
        );
        assert_eq!(
            swipe_path(&screen, (50.0, 400.0), Direction::Left),
            ((50.0, 400.0), (0.0, 400.0))
        );
        assert_eq!(
            swipe_path(&screen, (200.0, 400.0), Direction::Right),
            ((200.0, 400.0), (400.0, 400.0))
        );
        assert_eq!(
            scroll_path(&screen, Direction::Left),
            ((140.0, 400.0), (280.0, 400.0))
        );
        assert_eq!(
            scroll_path(&screen, Direction::Right),
            ((280.0, 400.0), (140.0, 400.0))
        );
    }
}
