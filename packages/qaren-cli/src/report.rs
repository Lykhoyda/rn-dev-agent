use crate::core::{Ledger, Row};
use crate::failure::{Failure, FailureCode};
use crate::record::{Gap, VideoStatus};
use crate::redact::{redact_machine, redact_secrets, MachineIdentity};
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

fn walked<'a>(input: &'a ReportInput<'_>) -> impl Iterator<Item = &'a Row> {
    input.ledger.steps.iter().filter(|row| row.line != 0)
}

fn row_line(row: &Row, plan: &str) -> String {
    let text = row
        .text
        .clone()
        .or_else(|| {
            plan.lines()
                .nth(row.line as usize - 1)
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
    format!(
        "- {mark} line {}: {}{retry}{reason}\n",
        row.line,
        prose(&text)
    )
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
    for row in walked(input) {
        out.push_str(&row_line(row, input.plan));
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
    if let Some(speed) = &input.ledger.speed {
        out.push_str(&format!(
            "stepMedianMs {} · stepP95Ms {} · walkMs {} · steps {} ({} passed, {} failed)\n",
            speed
                .step_median_ms
                .map_or_else(|| "n/a".to_string(), |ms| ms.to_string()),
            speed
                .step_p95_ms
                .map_or_else(|| "n/a".to_string(), |ms| ms.to_string()),
            speed.walk_ms,
            speed.steps,
            speed.passed,
            speed.failed
        ));
    }
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

pub const MAX_VERDICT_CHARS: usize = 400;

pub struct PrRun<'a> {
    pub tested_sha: &'a str,
    pub tested_older_commit: bool,
    pub video: &'a VideoStatus,
    pub plan_sha256: &'a str,
    pub gaps: &'a [Gap],
}

// Public text must not carry internal transport vocabulary.
fn public(text: &str) -> String {
    text.replace("cdp_", "")
        .replace("proofReplay", "replay")
        .replace("transport", "connection")
}

// The marker lets a rerun find a comment whose creation outcome was lost.
pub fn comment_marker(run_id: &str) -> String {
    format!("<!-- qaren-run: {} -->", prose(run_id))
}

pub fn failing_screenshot(ledger: &Ledger) -> Option<String> {
    let failure = ledger.failure.as_ref()?;
    failure.screenshot.as_deref().and_then(screenshot_link)
}

fn verdict_sentence(verdict_md: &str) -> String {
    let flat = prose(verdict_md);
    if flat.chars().count() <= MAX_VERDICT_CHARS {
        return flat;
    }
    let mut cut: String = flat.chars().take(MAX_VERDICT_CHARS - 1).collect();
    // A cut must not leave a dangling escape.
    if cut.ends_with('\\') {
        cut.pop();
    }
    cut.push('…');
    cut
}

fn seconds(ms: u64) -> String {
    format!("{}.{}s", ms / 1000, (ms % 1000) / 100)
}

pub fn render_pr_comment(
    input: &ReportInput<'_>,
    verdict_md: &str,
    pr: &PrRun<'_>,
    machine: &MachineIdentity,
) -> String {
    let summary = summarize(input.ledger);
    let short: String = pr.tested_sha.chars().take(7).collect();
    let mut out = String::new();
    out.push_str(&comment_marker(input.run_id));
    out.push('\n');
    out.push_str(&verdict_sentence(verdict_md));
    out.push_str("\n\n");
    out.push_str(&format!(
        "Tested: commit `{}` on {}",
        prose(&short),
        prose(input.platform)
    ));
    if pr.tested_older_commit {
        out.push_str(
            " — this tested an older commit; the pull request moved on while the run was going",
        );
    }
    out.push_str("\n\n");
    match pr.video {
        VideoStatus::Available => out.push_str("Video of the walk is attached below.\n\n"),
        VideoStatus::TooLarge => out.push_str("Video: the recording was too large to attach.\n\n"),
        VideoStatus::Unavailable(reason) => {
            out.push_str(&format!("Video: unavailable ({}).\n\n", prose(reason)))
        }
    }
    out.push_str("**Plan**\n\n");
    for row in walked(input) {
        out.push_str(&row_line(row, input.plan));
    }
    if let Some(failure) = &input.ledger.failure {
        out.push_str(&format!(
            "\n**Failing step** {}: {}\n",
            failure.step,
            prose(&failure.seen)
        ));
        if let Some(shot) = failing_screenshot(input.ledger) {
            out.push_str(&format!("\n![Failing step](./{shot})\n"));
        }
    }
    out.push_str(&format!("\nPlan sha256 `{}`\n\n", prose(pr.plan_sha256)));
    out.push_str("<details><summary>Run details</summary>\n\n");
    out.push_str(&format!(
        "steps {} · jev.calls {} · jev.medianMs {} · llmTurns {} · escapes {} · recoveries {} · path {}\n",
        summary.steps,
        summary.jev_calls,
        summary.jev_median_ms,
        summary.llm_turns,
        summary.escapes,
        summary.recoveries,
        prose(&summary.path)
    ));
    if !pr.gaps.is_empty() {
        let gaps: Vec<String> = pr
            .gaps
            .iter()
            .map(|g| {
                format!(
                    "{} missing after {}",
                    seconds(g.gap_ms),
                    seconds(g.after_ms)
                )
            })
            .collect();
        out.push_str(&format!("\nVideo gaps: {}\n", gaps.join("; ")));
    }
    out.push_str("\n</details>\n");
    redact_machine(&public(&redact_machine(&out, machine)), machine)
}
