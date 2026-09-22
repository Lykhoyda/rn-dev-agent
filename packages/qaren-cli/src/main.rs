use qaren::commands::{cleanup, complete, prepare, prewarm, status};
use qaren::core::Budgets;
use qaren::exec::{RealRunner, Runner};
use qaren::failure::{Failure, FailureCode};
use qaren::receipt::{Receipt, ReceiptResult};
use qaren::run::{self, RunRequest, DEFAULT_STEP_SECONDS, DEFAULT_WALK_SECONDS};
use qaren::scenario::Platform;
use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: qaren check --plan-file <plan.md> [--platform ios|android] [--device <udid>] [--config .qaren/config.yaml] [--json]\n       qaren prepare <scenario.yaml> [--json] [--dry-run]\n       qaren prewarm <scenario.yaml> [--json]\n       qaren status  <run-id> [--json]\n       qaren complete <run-id> <build-log> [--json]\n       qaren cleanup <run-id> [--json] [--remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id>]\n\ncheck walks the plan on the booted simulator against the working tree; runs land in ~/.qaren/runs/<run-id>/.\n--remove-app also uninstalls the app (and its data) this run installed on its leased Android emulator;\nthe confirmation must name exactly this run, its recorded emulator serial and its app id.";

fn qaren_home() -> Result<PathBuf, String> {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() && PathBuf::from(&home).is_absolute() => {
            Ok(PathBuf::from(home).join(".qaren"))
        }
        _ => Err("HOME is not an absolute path".to_string()),
    }
}

// Cross-project claims (devices, build serialization) live at a host-level
// root so two worktrees sharing a device still contend; only an absolute path works.
fn lock_root() -> Result<PathBuf, String> {
    if let Some(explicit) = std::env::var_os("QAREN_LOCK_ROOT") {
        let path = PathBuf::from(explicit);
        return if path.is_absolute() {
            Ok(path)
        } else {
            Err("QAREN_LOCK_ROOT must be an absolute path".to_string())
        };
    }
    qaren_home().map(|home| home.join("locks"))
}

fn runs_root() -> Result<PathBuf, String> {
    qaren_home().map(|home| home.join("runs"))
}

// The core runtime: QAREN_RUNTIME, else the source checkout beside this binary.
fn runtime_dir() -> PathBuf {
    if let Some(explicit) = std::env::var_os("QAREN_RUNTIME") {
        return PathBuf::from(explicit);
    }
    std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(|p| p.join("../../../qaren-core/dist")))
        .map(|p| p.canonicalize().unwrap_or(p))
        .unwrap_or_else(|| PathBuf::from("packages/qaren-core/dist"))
}

fn env_seconds(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|v| *v > 0)
        .unwrap_or(default)
}

fn check_budgets() -> Budgets {
    Budgets {
        walk_seconds: env_seconds("QAREN_WALK_SECONDS", DEFAULT_WALK_SECONDS),
        step_seconds: env_seconds("QAREN_STEP_SECONDS", DEFAULT_STEP_SECONDS),
    }
}

fn failed_receipt(verb: &str, failure: Failure, runner: &dyn Runner) -> Receipt {
    let mut receipt = Receipt::new(
        verb,
        "none",
        if failure.code.is_refusal() {
            ReceiptResult::Refused
        } else {
            ReceiptResult::Failed
        },
        &failure.phase.clone(),
        qaren::timefmt::iso8601_utc(runner.now_epoch_ms()),
    );
    receipt.next_action = failure.next_action.clone();
    receipt.failure = Some(failure);
    receipt.commands_executed = runner.commands_executed();
    receipt
}

fn roots_failure(detail: String) -> Failure {
    Failure::new(
        "validate",
        FailureCode::PrereqMissing,
        format!("no host-level state root is available: {detail}"),
        "set HOME to an absolute path",
    )
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args == [qaren::exec::log::HELPER_ARG] {
        return ExitCode::from(u8::from(qaren::exec::log::run_helper().is_err()));
    }
    let mut positional = Vec::new();
    let mut dry_run = false;
    let mut remove_app = false;
    let mut confirm_remove_app: Option<String> = None;
    let mut plan_file: Option<String> = None;
    let mut platform: Option<String> = None;
    let mut config: Option<String> = None;
    let mut device: Option<String> = None;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        let value_for = |flag: &str, iter: &mut std::slice::Iter<String>| -> Option<String> {
            match iter.next() {
                Some(value) if !value.starts_with('-') => Some(value.clone()),
                _ => {
                    eprintln!("{flag} requires a value\n{USAGE}");
                    None
                }
            }
        };
        match arg.as_str() {
            "--json" => {}
            "--dry-run" => dry_run = true,
            "--remove-app" => remove_app = true,
            "--confirm-remove-app" => match value_for("--confirm-remove-app", &mut iter) {
                Some(v) => confirm_remove_app = Some(v),
                None => return ExitCode::from(2),
            },
            "--plan-file" => match value_for("--plan-file", &mut iter) {
                Some(v) => plan_file = Some(v),
                None => return ExitCode::from(2),
            },
            "--platform" => match value_for("--platform", &mut iter) {
                Some(v) => platform = Some(v),
                None => return ExitCode::from(2),
            },
            "--config" => match value_for("--config", &mut iter) {
                Some(v) => config = Some(v),
                None => return ExitCode::from(2),
            },
            "--device" => match value_for("--device", &mut iter) {
                Some(v) => device = Some(v),
                None => return ExitCode::from(2),
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
    let Some(verb) = positional.first().cloned() else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let expected_positionals = match verb.as_str() {
        "check" => 1,
        "complete" => 3,
        _ => 2,
    };
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
    if dry_run && verb != "prepare" {
        eprintln!("--dry-run is only valid for prepare\n{USAGE}");
        return ExitCode::from(2);
    }
    if (plan_file.is_some() || platform.is_some() || config.is_some() || device.is_some())
        && verb != "check"
    {
        eprintln!(
            "--plan-file, --platform, --config and --device are only valid for check\n{USAGE}"
        );
        return ExitCode::from(2);
    }

    let mut runner = RealRunner::new();
    let receipt = match verb.as_str() {
        "check" => {
            let Some(plan_file) = plan_file else {
                eprintln!("check requires --plan-file <plan.md>\n{USAGE}");
                return ExitCode::from(2);
            };
            let platform = match platform.as_deref() {
                None | Some("ios") => Platform::Ios,
                Some("android") => Platform::Android,
                Some(other) => {
                    eprintln!("--platform must be ios or android, not {other}\n{USAGE}");
                    return ExitCode::from(2);
                }
            };
            match lock_root().and_then(|lock| runs_root().map(|runs| (lock, runs))) {
                Ok((lock_root, runs_root)) => {
                    let project_root =
                        std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                    let request = RunRequest {
                        config_path: project_root.join(
                            config
                                .as_deref()
                                .unwrap_or(qaren::config::DEFAULT_CONFIG_PATH),
                        ),
                        plan_file: project_root.join(plan_file),
                        project_root,
                        platform,
                        device,
                        runtime_dir: runtime_dir(),
                        node: std::env::var_os("QAREN_NODE").map(PathBuf::from),
                        lock_root,
                        runs_root,
                        android_home: std::env::var("ANDROID_HOME").ok(),
                        budgets: check_budgets(),
                    };
                    run::run(&mut runner, &request)
                }
                Err(detail) => failed_receipt("check", roots_failure(detail), &runner),
            }
        }
        "prepare" => match lock_root().and_then(|lock| runs_root().map(|runs| (lock, runs))) {
            Ok((lock_root, runs_root)) => {
                let prepare_args = prepare::PrepareArgs {
                    scenario_path: PathBuf::from(&positional[1]),
                    dry_run,
                    android_home: std::env::var("ANDROID_HOME").ok(),
                    lock_root,
                    runs_root,
                };
                prepare::prepare(&mut runner, &prepare_args)
            }
            Err(detail) => failed_receipt("prepare", roots_failure(detail), &runner),
        },
        "prewarm" => {
            let prewarm_args = prewarm::PrewarmArgs {
                scenario_path: PathBuf::from(&positional[1]),
            };
            prewarm::prewarm(&mut runner, &prewarm_args)
        }
        "status" | "cleanup" | "complete" => {
            let target = positional[1].as_str();
            match runs_root() {
                Ok(runs_root) => match verb.as_str() {
                    "status" => status::status(&mut runner, &runs_root, target),
                    "cleanup" => cleanup::cleanup_with(
                        &mut runner,
                        &runs_root,
                        target,
                        confirm_remove_app.as_deref(),
                    ),
                    _ => complete::complete(
                        &mut runner,
                        &runs_root,
                        target,
                        std::path::Path::new(&positional[2]),
                    ),
                },
                Err(detail) => {
                    let failure = roots_failure(detail);
                    let mut receipt = Receipt::new(
                        &verb,
                        target,
                        ReceiptResult::Unknown,
                        "load",
                        qaren::timefmt::iso8601_utc(runner.now_epoch_ms()),
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
        eprintln!("qaren: could not write the receipt to stdout");
        return ExitCode::from(1);
    }
    eprintln!(
        "qaren {}: {} (run {}, phase {}, {} commands)",
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
    if let Some(report) = receipt.artifacts.get("report") {
        eprintln!("report: {}", report.display());
    }

    ExitCode::from(receipt_exit_code(receipt.result))
}

fn receipt_exit_code(result: ReceiptResult) -> u8 {
    match result {
        ReceiptResult::Ready
        | ReceiptResult::Cleaned
        | ReceiptResult::Planned
        | ReceiptResult::Prewarmed
        | ReceiptResult::Working
        | ReceiptResult::Pass => 0,
        ReceiptResult::Failed | ReceiptResult::Fail => 1,
        ReceiptResult::Unknown => 3,
        ReceiptResult::Refused => 4,
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
        ReceiptResult::Pass => "pass",
        ReceiptResult::Fail => "fail",
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn check_uses_the_run_defaults_and_honors_a_small_step_override() {
        let names = ["QAREN_STEP_SECONDS", "QAREN_WALK_SECONDS"];
        let prior = names.map(std::env::var_os);
        for name in names {
            std::env::remove_var(name);
        }
        assert_eq!(
            super::check_budgets().step_seconds,
            super::DEFAULT_STEP_SECONDS
        );
        assert_eq!(
            super::check_budgets().walk_seconds,
            super::DEFAULT_WALK_SECONDS
        );
        std::env::set_var("QAREN_STEP_SECONDS", "5");
        assert_eq!(super::check_budgets().step_seconds, 5);
        assert_eq!(
            super::check_budgets().walk_seconds,
            super::DEFAULT_WALK_SECONDS
        );
        for (name, value) in names.into_iter().zip(prior) {
            match value {
                Some(value) => std::env::set_var(name, value),
                None => std::env::remove_var(name),
            }
        }
    }

    #[test]
    fn a_refused_receipt_exits_four_not_one() {
        assert_eq!(super::receipt_exit_code(super::ReceiptResult::Refused), 4);
        assert_eq!(super::receipt_exit_code(super::ReceiptResult::Fail), 1);
    }
}
