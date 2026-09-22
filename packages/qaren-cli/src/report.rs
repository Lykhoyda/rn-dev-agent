use crate::core::Ledger;
use crate::failure::{Failure, FailureCode};
use crate::redact::redact_secrets;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

// The rollups every receipt carries, read from the ledger the core child returned.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LedgerSummary {
    pub verdict: String,
    pub path: String,
    pub steps: u64,
    pub jev_calls: u64,
    pub jev_median_ms: u64,
    #[serde(default)]
    pub jev_input_tokens: u64,
    pub llm_turns: u64,
    pub escapes: u64,
    pub recoveries: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failed_step: Option<u64>,
}

pub fn summarize(ledger: &Ledger) -> LedgerSummary {
    LedgerSummary {
        verdict: ledger.verdict.clone(),
        path: ledger.path.clone(),
        steps: ledger.steps.len() as u64,
        jev_calls: ledger.jev.calls,
        jev_median_ms: ledger.jev.median_ms,
        jev_input_tokens: ledger.jev.input_tokens,
        llm_turns: ledger.llm_turns,
        escapes: ledger.escapes,
        recoveries: ledger.recoveries,
        failed_step: ledger.failure.as_ref().map(|f| f.step),
    }
}

pub struct ReportInput<'a> {
    pub run_id: &'a str,
    pub platform: &'a str,
    pub app_id: &'a str,
    pub device: &'a str,
    pub plan: &'a str,
    pub ledger: &'a Ledger,
}

// Dynamic prose comes from the child and the app under test: redacted, one line, no Markdown syntax.
fn prose(raw: &str) -> String {
    let flat: String = redact_secrets(raw)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = String::with_capacity(flat.len());
    for c in flat.chars() {
        if matches!(
            c,
            '[' | ']' | '!' | '#' | '<' | '>' | '*' | '_' | '`' | '~' | '|'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

// Screenshots are run-local relative paths; anything else is not linked.
fn screenshot_link(path: &str) -> Option<String> {
    let p = Path::new(path);
    let plain = !p.is_absolute()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.extension()
            .is_some_and(|e| e == "png" || e == "jpg" || e == "jpeg")
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'));
    (plain && redact_secrets(path) == path).then(|| path.to_string())
}

pub fn render(input: &ReportInput<'_>) -> String {
    let summary = summarize(input.ledger);
    let mut out = String::new();
    out.push_str(&format!("# QaReN check: {}\n\n", prose(&summary.verdict)));
    out.push_str(&format!(
        "Run `{}` · {} · `{}` · device {}\n\n",
        prose(input.run_id),
        prose(input.platform),
        prose(input.app_id),
        prose(input.device)
    ));
    out.push_str("## What was walked\n\n");
    let plan_lines: Vec<&str> = input.plan.lines().collect();
    for row in &input.ledger.steps {
        if row.line == 0 {
            continue;
        }
        let text = row
            .text
            .clone()
            .or_else(|| {
                plan_lines
                    .get(row.line as usize - 1)
                    .map(|l| l.trim().to_string())
            })
            .unwrap_or_default();
        let mark = if row.outcome == "pass" { "✓" } else { "✗" };
        let retry = if row.attempt > 1 {
            format!(" (attempt {})", row.attempt)
        } else {
            String::new()
        };
        let reason = row
            .reason
            .as_deref()
            .map(|r| format!(" — {}", prose(r)))
            .unwrap_or_default();
        out.push_str(&format!(
            "- {mark} line {}: {}{retry}{reason}\n",
            row.line,
            prose(&text)
        ));
        if let Some(shot) = row.screenshot.as_deref().and_then(screenshot_link) {
            out.push_str(&format!("  ![line {}]({shot})\n", row.line));
        }
    }
    if !input.ledger.blocks.is_empty() {
        out.push_str("\n## Blocks\n\n");
        for block in &input.ledger.blocks {
            out.push_str(&format!(
                "- {}: {} ({})\n",
                prose(&block.key),
                prose(&block.outcome),
                prose(&block.source)
            ));
        }
    }
    if let Some(failure) = &input.ledger.failure {
        out.push_str("\n## Failure\n\n");
        out.push_str(&format!(
            "Step {}: {}\n",
            failure.step,
            prose(&failure.seen)
        ));
        if let Some(shot) = failure.screenshot.as_deref().and_then(screenshot_link) {
            out.push_str(&format!("\n![failure]({shot})\n"));
        }
    }
    out.push_str("\n## Run details\n\n");
    out.push_str(&format!(
        "steps {} · jev.calls {} · jev.medianMs {} · jev.inputTokens {} · llmTurns {} · escapes {} · recoveries {} · path {}\n",
        summary.steps,
        summary.jev_calls,
        summary.jev_median_ms,
        summary.jev_input_tokens,
        summary.llm_turns,
        summary.escapes,
        summary.recoveries,
        prose(&summary.path)
    ));
    out
}

pub fn write(run_dir: &Path, input: &ReportInput<'_>) -> Result<PathBuf, Failure> {
    let path = run_dir.join("report.md");
    std::fs::write(&path, render(input)).map_err(|e| {
        Failure::new(
            "report",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot write {}: {e}", path.display()),
            "check the run directory permissions",
        )
    })?;
    Ok(path)
}
