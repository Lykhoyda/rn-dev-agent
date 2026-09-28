use crate::core::Row;
use crate::flow::plan::{Domain, Op, Step};
use crate::flow::resolve::{safe_snapshot_text, LABEL_CHARS};

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

const MASK: &str = "\"<private>\"";

// Replay rows share core::Row so the ledger, report and Observe SPA need no second row type.
pub struct Trace {
    action_id: String,
    t0: u64,
    // Every quoted form a run-private value takes in a row, longest first so that one value's
    // form can never split another's.
    private: Vec<String>,
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
    // Selectors and labels render text with {:?}, so a run-private value recurs only in its
    // quoted form: whole, cut to the label length, or as the sanitised label itself.
    pub fn new(action_id: &str, t0: u64, private: Vec<String>) -> Trace {
        let mut forms: Vec<String> = private
            .iter()
            .filter(|value| !value.is_empty())
            .flat_map(|value| {
                let head: String = value.chars().take(LABEL_CHARS).collect();
                let label = safe_snapshot_text(value);
                [
                    format!("{value:?}"),
                    format!("{head:?}"),
                    format!("{label:?}"),
                ]
            })
            .filter(|form| form != MASK)
            .collect();
        forms.sort_by_key(|form| std::cmp::Reverse(form.len()));
        Trace {
            action_id: action_id.to_string(),
            t0,
            private: forms,
            rows: Vec::new(),
        }
    }

    pub fn mask(&self, text: &str) -> String {
        let mut masked = text.to_string();
        for form in &self.private {
            // Re-find after each hit: `replace` skips an occurrence that shares a quote with the
            // previous one. Every hit removes original text, so the loop ends.
            while let Some(at) = masked.find(form.as_str()) {
                masked.replace_range(at..at + form.len(), MASK);
            }
        }
        masked
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
            r#ref: Some(entry.step.id.clone()),
            screenshot: entry.screenshot,
            t: entry.now.saturating_sub(self.t0),
            outcome: entry.outcome.as_str().to_string(),
            text: Some(self.mask(&entry.step.op.describe())),
            reason: entry.reason.map(|reason| self.mask(&reason)),
        });
    }
}
