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
    pub fn new(action_id: &str, t0: u64, private: Vec<String>) -> Trace {
        let rendered = |value: &str| {
            let quoted = format!("{value:?}");
            quoted[1..quoted.len() - 1].to_string()
        };
        let mut forms: Vec<String> = private
            .iter()
            .filter(|value| !value.is_empty())
            .flat_map(|value| {
                let head: String = value.chars().take(LABEL_CHARS).collect();
                let label = safe_snapshot_text(value);
                [rendered(value), rendered(&head), rendered(&label)]
            })
            .filter(|form| !form.is_empty() && form != "<private>")
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
            let quoted = format!("\"{form}\"");
            while let Some(at) = masked.find(&quoted) {
                masked.replace_range(at..at + quoted.len(), MASK);
            }
        }
        let mut result = String::with_capacity(masked.len());
        let mut cursor = 0;
        while let Some(open) = masked[cursor..].find('"').map(|at| cursor + at) {
            result.push_str(&masked[cursor..=open]);
            let mut end = open + 1;
            while end < masked.len() {
                let ch = masked[end..].chars().next().unwrap();
                if ch == '\\' {
                    end += 1;
                    if end < masked.len() {
                        end += masked[end..].chars().next().unwrap().len_utf8();
                    }
                } else if ch == '"' {
                    break;
                } else {
                    end += ch.len_utf8();
                }
            }
            if end == masked.len() {
                cursor = open + 1;
                break;
            }
            let inner = &masked[open + 1..end];
            let mut at = 0;
            while at < inner.len() {
                if inner[at..].starts_with("<private>") {
                    result.push_str("<private>");
                    at += "<private>".len();
                } else if let Some(form) = self
                    .private
                    .iter()
                    .find(|form| inner[at..].starts_with(form.as_str()))
                {
                    result.push_str("<private>");
                    at += form.len();
                } else {
                    let ch = inner[at..].chars().next().unwrap();
                    result.push(ch);
                    at += ch.len_utf8();
                }
            }
            result.push('"');
            cursor = end + 1;
        }
        result.push_str(&masked[cursor..]);
        result
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
