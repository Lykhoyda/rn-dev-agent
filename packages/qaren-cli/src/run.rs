use crate::adapters::ios;
use crate::buildplan::BuildDecision;
use crate::candidate::{self, sha256_hex};
use crate::commands::cleanup::{
    cleanup_process_group, release_lease_outcome, retained_lease_outcome, unclean_legs, Outcome,
};
use crate::commands::prepare::{self, finish_receipt, Ctx};
use crate::config::CheckConfig;
use crate::core::{self, Budgets, CoreRequest, CoreTarget, Verdict};
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::lease;
use crate::receipt::{Receipt, ReceiptResult};
use crate::report::{self, ReportInput};
use crate::runrecord::{
    capture_pid_identity, IosSimResource, Phase, Resources, RunRecord, RUN_SCHEMA,
};
use crate::scenario::{
    BuildSpec, CandidateSpec, Deadlines, DepsSpec, IosSpec, MetroSpec, Platform, Scenario,
    SCENARIO_SCHEMA,
};
use crate::timefmt;
use serde_json::Value;
use std::path::{Path, PathBuf};

pub const DEFAULT_WALK_SECONDS: u64 = 1200;
pub const DEFAULT_STEP_SECONDS: u64 = 120;
const MIN_FREE_DISK_KB: u64 = 1024 * 1024;

// `check`: candidate = the working tree at project_root, device = the booted simulator, borrowed.
pub struct RunRequest {
    pub project_root: PathBuf,
    pub config_path: PathBuf,
    pub plan_file: PathBuf,
    pub platform: Platform,
    pub runtime_dir: PathBuf,
    pub node: Option<PathBuf>,
    pub lock_root: PathBuf,
    pub runs_root: PathBuf,
    pub android_home: Option<String>,
    pub budgets: Budgets,
}

struct Device {
    id: String,
    name: String,
    ios: Option<(String, String)>,
}

fn platform_str(platform: Platform) -> &'static str {
    match platform {
        Platform::Ios => "ios",
        Platform::Android => "android",
    }
}

pub fn run(runner: &mut dyn Runner, req: &RunRequest) -> Receipt {
    let started_ms = runner.now_epoch_ms();
    match run_inner(runner, req, started_ms) {
        Ok(receipt) => receipt,
        Err(failure) => {
            let result = if failure.code.is_refusal() {
                ReceiptResult::Refused
            } else {
                ReceiptResult::Failed
            };
            let mut receipt = Receipt::new(
                "check",
                "none",
                result,
                &failure.phase.clone(),
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.next_action = failure.next_action.clone();
            receipt.failure = Some(failure);
            receipt.commands_executed = runner.commands_executed();
            receipt
        }
    }
}

// Failures before the run record exists come back as Err; everything after is
// folded into the record and torn down so nothing outlives the run.
fn run_inner(
    runner: &mut dyn Runner,
    req: &RunRequest,
    started_ms: u64,
) -> Result<Receipt, Failure> {
    let (config, config_raw) = CheckConfig::load(&req.config_path)?;
    let node = req
        .node
        .clone()
        .or_else(|| config.node_path.as_ref().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("node"));
    preflight_node(runner, &node)?;
    let plan = read_plan(&req.plan_file)?;
    preflight_plan(runner, &node, &req.runtime_dir, &req.plan_file)?;
    // The parser read the file by path; the walk must use the bytes that passed.
    if read_plan(&req.plan_file)? != plan {
        return Err(Failure::new(
            "preflight",
            FailureCode::PlanUnparseable,
            format!(
                "{} changed while it was being validated",
                req.plan_file.display()
            ),
            "leave the plan file alone during the run, then re-run",
        ));
    }
    let device = resolve_device(runner, req.platform)?;
    let (repo_root, project_rel) = locate_worktree(runner, &req.project_root)?;
    let scenario = build_scenario(&config, req.platform, &device, &repo_root, &project_rel);
    scenario.validate()?;
    let cand = candidate::resolve(runner, &scenario, &req.project_root)?;
    prepare::check_prereqs(runner, &scenario, req.android_home.as_deref())?;
    prepare::check_port_free(runner, config.metro_port)?;
    std::fs::create_dir_all(&req.runs_root).map_err(|e| {
        Failure::new(
            "preflight",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot create {}: {e}", req.runs_root.display()),
            "check the run directory permissions",
        )
    })?;
    preflight_disk(runner, &req.runs_root)?;

    let run_id = format!("check-{}", timefmt::compact_utc(started_ms));
    let identity = capture_pid_identity(runner, std::process::id() as i32);
    let lease = lease::acquire(
        runner,
        &req.lock_root,
        req.platform,
        &device.id,
        &run_id,
        identity.clone(),
    )?;

    let run_dir = RunRecord::run_dir(&req.runs_root, &run_id);
    if let Err(f) = claim_run_dir(&run_dir) {
        let _ = lease::release(&lease);
        return Err(f);
    }
    let record = RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.clone(),
        created_at: timefmt::iso8601_utc(started_ms),
        scenario,
        scenario_path: req.config_path.clone(),
        scenario_sha256: sha256_hex(config_raw.as_bytes()),
        candidate: cand,
        phase: Phase::Created,
        prepare: identity,
        build: None,
        handoff: None,
        resources: Resources {
            lease: Some(lease.clone()),
            device_borrowed: true,
            ios_simulator: device
                .ios
                .as_ref()
                .map(|(device_type, runtime)| IosSimResource {
                    udid: device.id.clone(),
                    name: device.name.clone(),
                    device_type: device_type.clone(),
                    runtime: runtime.clone(),
                }),
            ..Default::default()
        },
        failure: None,
        history: Vec::new(),
    };
    if let Err(f) = record.save(&req.runs_root) {
        let _ = lease::release(&lease);
        return Err(f);
    }
    let mut ctx = Ctx {
        runner,
        runs_root: req.runs_root.clone(),
        record,
        started_ms,
        timings: Vec::new(),
        notes: Vec::new(),
        verb: "check",
    };
    let t = ctx.mark("preflight", started_ms);

    if let Err(f) = prepare::install_deps(&mut ctx) {
        return Ok(finish_failed(ctx, f));
    }
    let t = ctx.mark("deps", t);

    let plan_decision = match prepare::plan_build(&mut ctx) {
        Ok(plan) => plan,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    ctx.record.build = Some(plan_decision.clone());
    if plan_decision.decision != BuildDecision::Reuse {
        if let Err(f) = prepare::claim_build_lock(&mut ctx, &req.lock_root) {
            return Ok(finish_failed(ctx, f));
        }
    }
    ctx.record.phase = Phase::ResourcesAllocated;
    if let Err(f) = ctx.save() {
        return Ok(finish_failed(ctx, f));
    }
    let t = ctx.mark("plan", t);

    let t = if plan_decision.decision == BuildDecision::Reuse {
        match prepare::run_reuse_path(&mut ctx, &plan_decision, t) {
            Ok(t) => t,
            Err(f) => return Ok(finish_failed(ctx, f)),
        }
    } else {
        if plan_decision.decision == BuildDecision::Clean {
            if let Err(f) = prepare::run_clean_preparation(&mut ctx, &plan_decision) {
                return Ok(finish_failed(ctx, f));
            }
        }
        if let Err(f) = prepare::spawn_build(&mut ctx) {
            return Ok(finish_failed(ctx, f));
        }
        if let Err(f) = prepare::wait_ready(&mut ctx) {
            return Ok(finish_failed(ctx, f));
        }
        ctx.mark("build_and_ready", t)
    };
    let fp = match prepare::recheck_fingerprint(&mut ctx, &plan_decision) {
        Ok(fp) => fp,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    if plan_decision.decision != BuildDecision::Reuse {
        prepare::record_build_result(&mut ctx, &fp);
        prepare::release_build_lock(&mut ctx);
    }
    let t = ctx.mark("verify", t);

    ctx.record.phase = Phase::Walking;
    let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    ctx.record.push_history(at, "walking");
    if let Err(f) = ctx.save() {
        return Ok(finish_failed(ctx, f));
    }
    let core_request = CoreRequest {
        run_id: run_id.clone(),
        t0: ctx.runner.now_epoch_ms(),
        plan: plan.clone(),
        platform: platform_str(req.platform).to_string(),
        app_id: config.app_id.clone(),
        run_dir: run_dir.clone(),
        lease: lease.wire(),
        target: CoreTarget {
            device_id: device.id.clone(),
            metro_port: config.metro_port,
            metro_url_for_device: format!("http://127.0.0.1:{}", config.metro_port),
            worktree: req.project_root.clone(),
            adb: None,
        },
    };
    let spec = core::spawn_spec(
        &node,
        &req.runtime_dir,
        &req.project_root,
        &lease.wire(),
        config.metro_port,
    );
    let core_log = run_dir.join("logs").join("core.log");
    let core_child = match core::spawn(ctx.runner, &spec, &core_log, &core_request) {
        Ok(child) => child,
        Err(f) => return Ok(finish_failed(ctx, f)),
    };
    ctx.record.resources.core = capture_pid_identity(ctx.runner, core_child.pid);
    if let Err(f) = ctx.save() {
        core::abort(core_child);
        ctx.record.resources.core = None;
        return Ok(finish_failed(ctx, f));
    }
    let outcome = core::wait(ctx.runner, core_child, req.budgets);
    ctx.record.resources.core = None;
    let t = ctx.mark("walk", t);
    if let Some(exit) = outcome.exit {
        ctx.notes.push(("core_exit".to_string(), exit.to_string()));
    }

    let ledger_path = run_dir.join("ledger.json");
    if let Err(e) = std::fs::write(
        &ledger_path,
        serde_json::to_vec_pretty(&outcome.ledger).unwrap_or_default(),
    ) {
        ctx.notes.push((
            "ledger".to_string(),
            format!("could not persist {}: {e}", ledger_path.display()),
        ));
    }
    match candidate::verify_unchanged(ctx.runner, &ctx.record.candidate) {
        Ok(()) => ctx
            .notes
            .push(("candidate_drift".to_string(), "none".to_string())),
        Err(detail) => ctx.notes.push(("candidate_drift".to_string(), detail)),
    }

    let (cleanup, all_clean) = teardown(&mut ctx);
    ctx.mark("teardown", t);

    let report_path = match report::write(
        &run_dir,
        &ReportInput {
            run_id: &run_id,
            platform: platform_str(req.platform),
            app_id: &config.app_id,
            device: &device.name,
            plan: &plan,
            ledger: &outcome.ledger,
        },
    ) {
        Ok(path) => path,
        Err(f) => return Ok(ctx.fail(f)),
    };

    let (result, failure) = match &outcome.verdict {
        Verdict::Pass => (ReceiptResult::Pass, None),
        Verdict::Fail => {
            let failure = outcome.failure.clone().unwrap_or_else(|| {
                let (step, seen) = outcome
                    .ledger
                    .failure
                    .as_ref()
                    .map(|f| (f.step, f.seen.clone()))
                    .unwrap_or((0, "the plan did not pass".to_string()));
                Failure::new(
                    "walk",
                    FailureCode::PlanStepFailed,
                    format!("line {step}: {seen}"),
                    "read the report, fix the app or the plan, then re-run",
                )
            });
            (ReceiptResult::Fail, Some(failure))
        }
        Verdict::Refused { code, message } => (
            ReceiptResult::Refused,
            Some(Failure::new(
                "prove",
                refusal_code(code),
                format!("{code}: {message}"),
                "resolve the refusal, then re-run",
            )),
        ),
    };
    ctx.record.failure = failure.clone();
    ctx.record.phase = if all_clean {
        Phase::Cleaned
    } else {
        Phase::Walking
    };
    let at = timefmt::iso8601_utc(ctx.runner.now_epoch_ms());
    let note: Vec<String> = cleanup.iter().map(|(n, o)| format!("{n}={o}")).collect();
    ctx.record
        .push_history(at, &format!("check finished: {}", note.join(" ")));
    if let Err(f) = ctx.save() {
        return Ok(ctx.fail(f));
    }
    let mut receipt = finish_receipt(ctx, result, failure);
    receipt.ledger = Some(report::summarize(&outcome.ledger));
    receipt.artifacts.insert("report".to_string(), report_path);
    receipt.artifacts.insert("ledger".to_string(), ledger_path);
    for (name, rendered) in cleanup {
        receipt.cleanup.insert(name, rendered);
    }
    if !all_clean {
        receipt.next_action = format!("qaren cleanup {run_id} --json");
    }
    Ok(receipt)
}

fn refusal_code(code: &str) -> FailureCode {
    match code {
        "METRO_ORIGIN_MISMATCH" => FailureCode::MetroOriginMismatch,
        "PLAN_UNPARSEABLE" => FailureCode::PlanUnparseable,
        _ => FailureCode::CoreRefused,
    }
}

fn finish_failed(mut ctx: Ctx, failure: Failure) -> Receipt {
    let (cleanup, _) = teardown(&mut ctx);
    let mut receipt = ctx.fail(failure);
    for (name, rendered) in cleanup {
        receipt.cleanup.insert(name, rendered);
    }
    receipt
}

// core dead → runners dead (they share the core's process group) → Metro pgid →
// borrowed device kept → lease released. Every leg is ownership-gated.
fn teardown(ctx: &mut Ctx) -> (Vec<(String, String)>, bool) {
    let mut outcomes: Vec<(String, Outcome)> = Vec::new();
    if let Some(core) = ctx.record.resources.core.clone() {
        let outcome = cleanup_process_group(ctx.runner, Some(&core), core.pid, None);
        if outcome.clean() {
            ctx.record.resources.core = None;
        }
        outcomes.push(("core".to_string(), outcome));
    }
    if let Some(m) = ctx.record.resources.metro.clone() {
        let outcome = cleanup_process_group(
            ctx.runner,
            m.identity.as_ref(),
            m.spawned.pgid,
            Some(m.port),
        );
        if outcome.clean() {
            ctx.record.resources.metro = None;
        }
        outcomes.push(("metro".to_string(), outcome));
    }
    prepare::release_build_lock(ctx);
    if ctx.record.resources.ios_simulator.is_some() {
        outcomes.push(("simulator".to_string(), Outcome::Kept));
    }
    if let Some(lease) = ctx.record.resources.lease.clone() {
        let unclean = unclean_legs(&outcomes);
        let outcome = if unclean.is_empty() {
            let outcome = release_lease_outcome(lease::release(&lease));
            if outcome.clean() {
                ctx.record.resources.lease = None;
            }
            outcome
        } else {
            retained_lease_outcome(&unclean, &ctx.record.run_id)
        };
        outcomes.push(("device_lease".to_string(), outcome));
    }
    let all_clean = outcomes.iter().all(|(_, o)| o.clean());
    let _ = ctx.save();
    (
        outcomes.into_iter().map(|(n, o)| (n, o.render())).collect(),
        all_clean,
    )
}

fn read_plan(plan_file: &Path) -> Result<String, Failure> {
    std::fs::read_to_string(plan_file).map_err(|e| {
        Failure::new(
            "preflight",
            FailureCode::PlanUnparseable,
            format!("cannot read {}: {e}", plan_file.display()),
            "pass a readable plan file",
        )
    })
}

fn preflight_node(runner: &mut dyn Runner, node: &Path) -> Result<(), Failure> {
    let output = runner.run(&CmdSpec::new(
        "node-version",
        &node.to_string_lossy(),
        &["--version"],
        10,
    ));
    if !output.ok() {
        return Err(Failure::new(
            "preflight",
            FailureCode::PrereqMissing,
            format!(
                "node at {} did not run: {}",
                node.display(),
                output.summary()
            ),
            "install node >= 24 or set nodePath in .qaren/config.yaml",
        ));
    }
    let major = output
        .stdout
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|m| m.parse::<u64>().ok());
    match major {
        Some(major) if major >= 24 => Ok(()),
        _ => Err(Failure::new(
            "preflight",
            FailureCode::NodeUnsupported,
            format!(
                "node at {} reports {:?}; qaren needs node >= 24",
                node.display(),
                output.stdout.trim()
            ),
            "point nodePath in .qaren/config.yaml at a node >= 24",
        )),
    }
}

fn preflight_plan(
    runner: &mut dyn Runner,
    node: &Path,
    runtime_dir: &Path,
    plan_file: &Path,
) -> Result<(), Failure> {
    let output = runner.run(&core::parse_spec(node, runtime_dir, plan_file));
    if output.ok() {
        return Ok(());
    }
    if output.exit_code == Some(4) {
        let refused = serde_json::from_str::<Value>(output.stdout.trim())
            .ok()
            .and_then(|v| v.get("refused").cloned())
            .and_then(|r| r.as_array().cloned())
            .map(|entries| {
                entries
                    .iter()
                    .map(|e| {
                        format!(
                            "line {}: {}",
                            e.get("line").and_then(Value::as_u64).unwrap_or(0),
                            e.get("reason")
                                .and_then(Value::as_str)
                                .unwrap_or("unreadable")
                        )
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            })
            .unwrap_or_else(|| output.stdout.trim().to_string());
        return Err(Failure::new(
            "preflight",
            FailureCode::PlanUnparseable,
            format!("the plan does not parse: {refused}"),
            "rewrite the named lines with the verb grammar (Tap \"X\", Type \"t\" into \"X\", Scroll down, Wait for \"X\", Go back, Accept the dialog, ✓ \"text\")",
        ));
    }
    Err(Failure::new(
        "preflight",
        FailureCode::PrereqMissing,
        format!(
            "the qaren runtime could not parse the plan: {}",
            output.summary()
        ),
        "check QAREN_RUNTIME points at a built qaren-core dist, then re-run",
    ))
}

fn preflight_disk(runner: &mut dyn Runner, runs_root: &Path) -> Result<(), Failure> {
    let output = runner.run(&CmdSpec::new(
        "df",
        "df",
        &["-Pk", &runs_root.to_string_lossy()],
        10,
    ));
    if !output.ok() {
        return Err(Failure::new(
            "preflight",
            FailureCode::PrereqMissing,
            format!(
                "df could not report free space under {}: {}",
                runs_root.display(),
                output.summary()
            ),
            "make df available on PATH and the run directory readable, then re-run",
        ));
    }
    let available_kb = output
        .stdout
        .lines()
        .last()
        .and_then(|line| line.split_whitespace().nth(3))
        .and_then(|kb| kb.parse::<u64>().ok());
    match available_kb {
        Some(kb) if kb < MIN_FREE_DISK_KB => Err(Failure::new(
            "preflight",
            FailureCode::DiskBudgetExceeded,
            format!(
                "only {} MiB free under {}; a run needs at least {} MiB",
                kb / 1024,
                runs_root.display(),
                MIN_FREE_DISK_KB / 1024
            ),
            "free disk space, then re-run",
        )),
        Some(_) => Ok(()),
        None => Err(Failure::new(
            "preflight",
            FailureCode::PrereqMissing,
            format!(
                "df -Pk output for {} had no readable available-space column",
                runs_root.display()
            ),
            "check that df prints the POSIX table for the run directory, then re-run",
        )),
    }
}

fn resolve_device(runner: &mut dyn Runner, platform: Platform) -> Result<Device, Failure> {
    match platform {
        Platform::Android => Err(Failure::new(
            "device",
            FailureCode::PlatformUnsupported,
            "qaren check walks a booted iOS simulator in this release; the borrowed Android emulator path is not wired yet",
            "re-run with --platform ios",
        )),
        Platform::Ios => {
            let output = runner.run(&ios::list_booted_spec());
            if !output.ok() {
                return Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    format!("simctl list failed: {}", output.summary()),
                    "check Xcode and CoreSimulator, then re-run",
                ));
            }
            let Some(sims) = ios::parse_booted_sims(&output.stdout) else {
                return Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    "simctl list output was unparseable".to_string(),
                    "check Xcode and CoreSimulator, then re-run",
                ));
            };
            match sims.as_slice() {
                [sim] => Ok(Device {
                    id: sim.udid.clone(),
                    name: sim.name.clone(),
                    ios: Some((sim.device_type.clone(), sim.runtime.clone())),
                }),
                [] => Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    "no booted iOS simulator".to_string(),
                    "boot the simulator to walk on, then re-run",
                )),
                many => Err(Failure::new(
                    "device",
                    FailureCode::DeviceUnavailable,
                    format!(
                        "{} booted iOS simulators; qaren check borrows exactly one",
                        many.len()
                    ),
                    "shut down the simulators you are not testing on, then re-run",
                )),
            }
        }
    }
}

fn locate_worktree(
    runner: &mut dyn Runner,
    project_root: &Path,
) -> Result<(PathBuf, String), Failure> {
    let output = runner.run(&CmdSpec::new(
        "git-toplevel",
        "git",
        &[
            "-C",
            &project_root.to_string_lossy(),
            "rev-parse",
            "--show-toplevel",
        ],
        20,
    ));
    if !output.ok() {
        return Err(Failure::new(
            "validate",
            FailureCode::CandidateGitUnavailable,
            format!("git rev-parse --show-toplevel failed: {}", output.summary()),
            "run qaren check from inside a git checkout of the app",
        ));
    }
    let repo_root = PathBuf::from(output.stdout.trim());
    let invalid = |detail: String| {
        Failure::new(
            "validate",
            FailureCode::CandidatePathInvalid,
            detail,
            "run qaren check from the app root inside its git checkout",
        )
    };
    let canonical_repo = repo_root
        .canonicalize()
        .map_err(|e| invalid(format!("cannot resolve {}: {e}", repo_root.display())))?;
    let canonical_project = project_root
        .canonicalize()
        .map_err(|e| invalid(format!("cannot resolve {}: {e}", project_root.display())))?;
    let rel = canonical_project
        .strip_prefix(&canonical_repo)
        .map(|p| p.to_string_lossy().into_owned())
        .map_err(|_| {
            invalid(format!(
                "{} is not inside its git toplevel {}",
                canonical_project.display(),
                canonical_repo.display()
            ))
        })?;
    Ok((
        canonical_repo,
        if rel.is_empty() { ".".to_string() } else { rel },
    ))
}

fn build_scenario(
    config: &CheckConfig,
    platform: Platform,
    device: &Device,
    repo_root: &Path,
    project_rel: &str,
) -> Scenario {
    Scenario {
        schema: SCENARIO_SCHEMA.to_string(),
        name: "check".to_string(),
        platform,
        candidate: CandidateSpec {
            project_root: project_rel.to_string(),
            app_id: config.app_id.clone(),
            revision: "HEAD".to_string(),
            worktree: Some(repo_root.to_string_lossy().into_owned()),
            dev_client_scheme: None,
        },
        metro: Some(MetroSpec {
            port: config.metro_port,
        }),
        ios: device.ios.as_ref().map(|(device_type, runtime)| IosSpec {
            device_type: device_type.clone(),
            runtime: runtime.clone(),
        }),
        android: None,
        android_usb: None,
        build: BuildSpec::default(),
        deps: DepsSpec::default(),
        deadlines: Deadlines::default(),
    }
}

fn claim_run_dir(run_dir: &Path) -> Result<(), Failure> {
    let cannot = |what: &Path, e: std::io::Error| {
        Failure::new(
            "record",
            FailureCode::RunRecordUpdateFailed,
            format!("cannot create {}: {e}", what.display()),
            "check the run directory permissions",
        )
    };
    if let Some(parent) = run_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|e| cannot(parent, e))?;
    }
    // mkdir is the atomic claim on the run id.
    std::fs::create_dir(run_dir).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            Failure::new(
                "record",
                FailureCode::RunAlreadyExists,
                format!("{} already exists", run_dir.display()),
                "re-run; run ids are timestamped per second",
            )
        } else {
            cannot(run_dir, e)
        }
    })?;
    std::fs::create_dir_all(run_dir.join("logs")).map_err(|e| cannot(run_dir, e))?;
    std::fs::create_dir_all(run_dir.join("screenshots")).map_err(|e| cannot(run_dir, e))
}
