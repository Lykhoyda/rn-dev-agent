use crate::core::Row;
use crate::flow::plan::{Domain, Op, Step};
use crate::flow::privacy::{Privacy, REASON_CHARS, TEXT_CHARS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepOutcome {
    Pass,
    Fail,
    Skipped,
    Retry,
    DispatchedUnknown,
    Cancelled,
}

impl StepOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            StepOutcome::Pass => "pass",
            StepOutcome::Fail => "fail",
            StepOutcome::Skipped => "skipped",
            StepOutcome::Retry => "retry",
            StepOutcome::DispatchedUnknown => "dispatched-unknown",
            StepOutcome::Cancelled => "cancelled",
        }
    }
}

// Replay rows share core::Row so the ledger, report and Observe SPA need no second row type.
pub struct Trace {
    action_id: String,
    t0: u64,
    privacy: Privacy,
    pub rows: Vec<Row>,
}

pub struct Entry<'a> {
    pub step: &'a Step,
    pub attempt: u64,
    pub answered_by: Domain,
    pub now: u64,
    pub outcome: StepOutcome,
    pub reason: Option<String>,
    pub screenshot: Option<String>,
}

impl Trace {
    pub fn new(action_id: &str, t0: u64, privacy: Privacy) -> Trace {
        Trace {
            action_id: privacy.sanitize(action_id),
            t0,
            privacy,
            rows: Vec::new(),
        }
    }

    // Every string that leaves the engine passes here once, on its full text, before any bound.
    pub fn sanitize(&self, text: &str) -> String {
        self.privacy.sanitize(text)
    }

    pub fn record(&mut self, entry: Entry<'_>) {
        let kind = match entry.step.op {
            Op::AssertVisible(_) | Op::AssertNotVisible(_) | Op::RunFlow { .. } => "check",
            _ => "step",
        };
        self.rows.push(Row {
            block: self.action_id.clone(),
            line: entry.step.source.line,
            attempt: entry.attempt,
            kind: kind.to_string(),
            resolved_by: entry.answered_by.as_str().to_string(),
            r#ref: Some(self.sanitize(&entry.step.id)),
            screenshot: entry.screenshot,
            t: entry.now.saturating_sub(self.t0),
            outcome: entry.outcome.as_str().to_string(),
            text: Some(Privacy::bound(
                self.sanitize(&entry.step.op.describe()),
                TEXT_CHARS,
            )),
            reason: entry
                .reason
                .map(|reason| Privacy::bound(self.sanitize(&reason), REASON_CHARS)),
        });
    }
}
