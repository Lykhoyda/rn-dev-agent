use rn_qa::commands::{cleanup, complete, prepare, prewarm, status};
use rn_qa::exec::{RealRunner, Runner};
use rn_qa::receipt::{Receipt, ReceiptResult};
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: rn-qa prepare <scenario.yaml> [--json] [--dry-run]\n       rn-qa prewarm <scenario.yaml> [--json]\n       rn-qa status  <run-id> [--json]\n       rn-qa complete <run-id> <build-log> [--json]\n       rn-qa cleanup <run-id> [--json] [--remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id>]\n\n--remove-app also uninstalls the app (and its data) this run installed on its leased Android emulator;\nthe confirmation must name exactly this run, its recorded emulator serial and its app id.";

// Cross-project claims (physical devices, build serialization) live at a
// host-level root so two worktrees preparing the same phone still contend.
// A relative root would fragment contention by working directory, so only an
// absolute path is acceptable.
fn lock_root() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("RN_QA_LOCK_ROOT") {
        let path = PathBuf::from(explicit);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Err("RN_QA_LOCK_ROOT must be an absolute path".to_string())
        };
    }
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() && PathBuf::from(&home).is_absolute() => {
            Ok(PathBuf::from(home).join(".rn-qa").join("locks"))
        }
        _ => Err("HOME is not an absolute path; set RN_QA_LOCK_ROOT explicitly".to_string()),
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut positional = Vec::new();
    let mut dry_run = false;
    let mut remove_app = false;
    let mut confirm_remove_app: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--json" => {}
            "--dry-run" => dry_run = true,
            "--remove-app" => remove_app = true,
            "--confirm-remove-app" => match iter.next() {
                Some(value) if !value.starts_with('-') => confirm_remove_app = Some(value.clone()),
                _ => {
                    eprintln!(
                        "--confirm-remove-app requires <run-id>/<remote-serial>/<app-id>\n{USAGE}"
                    );
                    return ExitCode::from(2);
                }
            },
            "-h" | "--help" => {
                eprintln!("{USAGE}");
                return ExitCode::from(0);
            }
            other if other.starts_with('-') => {
                eprintln!("unknown flag {other}\n{USAGE}");
                return ExitCode::from(2);
            }
            other => positional.push(other.to_string()),
        }
    }
    let (Some(verb), Some(target)) = (positional.first(), positional.get(1)) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let expected_positionals = if verb == "complete" { 3 } else { 2 };
    if positional.len() != expected_positionals {
        eprintln!("wrong number of arguments for {verb}\n{USAGE}");
        return ExitCode::from(2);
    }
    if remove_app != confirm_remove_app.is_some() {
        eprintln!("--remove-app and --confirm-remove-app must be given together\n{USAGE}");
        return ExitCode::from(2);
    }
    if remove_app && verb != "cleanup" {
        eprintln!("--remove-app is only valid for cleanup\n{USAGE}");
        return ExitCode::from(2);
    }

    let mut runner = RealRunner::new();
    let receipt = match verb.as_str() {
        "prepare" => match lock_root() {
            Ok(lock_root) => {
                let prepare_args = prepare::PrepareArgs {
                    scenario_path: PathBuf::from(target),
                    dry_run,
                    android_home: std::env::var("ANDROID_HOME").ok(),
                    lock_root,
                };
                prepare::prepare(&mut runner, &prepare_args)
            }
            Err(detail) => {
                let mut receipt = Receipt::new(
                    "prepare",
                    "none",
                    ReceiptResult::Failed,
                    "validate",
                    rn_qa::timefmt::iso8601_utc(runner.now_epoch_ms()),
                );
                receipt.next_action = "set RN_QA_LOCK_ROOT to an absolute path".to_string();
                receipt.failure = Some(rn_qa::failure::Failure::new(
                    "validate",
                    rn_qa::failure::FailureCode::PrereqMissing,
                    format!("no host-level lock root is available: {detail}"),
                    "set RN_QA_LOCK_ROOT to an absolute path",
                ));
                receipt
            }
        },
        "prewarm" => {
            if dry_run {
                eprintln!("--dry-run is only valid for prepare\n{USAGE}");
                return ExitCode::from(2);
            }
            let prewarm_args = prewarm::PrewarmArgs {
                scenario_path: PathBuf::from(target),
            };
            prewarm::prewarm(&mut runner, &prewarm_args)
        }
        "status" | "cleanup" | "complete" => {
            if dry_run {
                eprintln!("--dry-run is only valid for prepare\n{USAGE}");
                return ExitCode::from(2);
            }
            match rn_qa::commands::repo_root_of_cwd(&mut runner) {
                Ok(repo_root) => match verb.as_str() {
                    "status" => status::status(&mut runner, &repo_root, target),
                    "cleanup" => cleanup::cleanup_with(
                        &mut runner,
                        &repo_root,
                        target,
                        confirm_remove_app.as_deref(),
                    ),
                    _ => complete::complete(
                        &mut runner,
                        &repo_root,
                        target,
                        std::path::Path::new(
                            positional.get(2).expect("arity checked for complete"),
                        ),
                    ),
                },
                Err(failure) => {
                    let mut receipt = Receipt::new(
                        verb,
                        target,
                        ReceiptResult::Unknown,
                        "load",
                        rn_qa::timefmt::iso8601_utc(runner.now_epoch_ms()),
                    );
                    receipt.next_action = failure.next_action.clone();
                    receipt.failure = Some(failure);
                    receipt.commands_executed = runner.commands_executed();
                    receipt
                }
            }
        }
        other => {
            eprintln!("unknown verb {other}\n{USAGE}");
            return ExitCode::from(2);
        }
    };

    let receipt_delivered = {
        use std::io::Write;
        writeln!(std::io::stdout(), "{}", receipt.to_json()).is_ok()
    };
    if !receipt_delivered {
        eprintln!("rn-qa: could not write the receipt to stdout");
        return ExitCode::from(1);
    }
    eprintln!(
        "rn-qa {}: {} (run {}, phase {}, {} commands)",
        receipt.verb,
        result_str(receipt.result),
        receipt.run_id,
        receipt.phase,
        receipt.commands_executed
    );
    if let Some(failure) = &receipt.failure {
        eprintln!(
            "failure: {} — next: {}",
            failure.detail, failure.next_action
        );
    }

    match receipt.result {
        ReceiptResult::Ready
        | ReceiptResult::Cleaned
        | ReceiptResult::Planned
        | ReceiptResult::Prewarmed
        | ReceiptResult::Working => ExitCode::from(0),
        ReceiptResult::Failed => ExitCode::from(1),
        ReceiptResult::Unknown => ExitCode::from(3),
        ReceiptResult::Refused => ExitCode::from(4),
    }
}

fn result_str(result: ReceiptResult) -> &'static str {
    match result {
        ReceiptResult::Ready => "ready",
        ReceiptResult::Working => "working",
        ReceiptResult::Failed => "failed",
        ReceiptResult::Cleaned => "cleaned",
        ReceiptResult::Refused => "refused",
        ReceiptResult::Unknown => "unknown",
        ReceiptResult::Planned => "planned",
        ReceiptResult::Prewarmed => "prewarmed",
    }
}
