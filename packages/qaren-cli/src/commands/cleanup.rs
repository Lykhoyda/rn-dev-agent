use crate::adapters::{android, ios, metro};
use crate::exec::{CmdOutput, CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use crate::receipt::{Receipt, ReceiptResult};
use crate::runrecord::{
    probe_pid_identity, AppRemoval, Phase, PidIdentity, PidLiveness, RunRecord,
};
use crate::scenario::Platform;
use crate::timefmt;
use std::path::Path;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Outcome {
    Removed,
    Absent,
    // A borrowed resource this run never owned; left exactly as found.
    Kept,
    Refused(String),
    Unresolved(String),
}

impl Outcome {
    pub(crate) fn render(&self) -> String {
        match self {
            Outcome::Removed => "removed".to_string(),
            Outcome::Absent => "absent".to_string(),
            Outcome::Kept => "kept".to_string(),
            Outcome::Refused(reason) => format!("refused: {reason}"),
            Outcome::Unresolved(reason) => format!("unresolved: {reason}"),
        }
    }

    pub(crate) fn clean(&self) -> bool {
        matches!(self, Outcome::Removed | Outcome::Absent | Outcome::Kept)
    }
}

pub fn cleanup(runner: &mut dyn Runner, runs_root: &Path, run_id: &str) -> Receipt {
    cleanup_with(runner, runs_root, run_id, None)
}

// `remove_app` confirms "<run-id>/<remote-serial>/<app-id>"; None skips uninstall.
pub fn cleanup_with(
    runner: &mut dyn Runner,
    runs_root: &Path,
    run_id: &str,
    remove_app: Option<&str>,
) -> Receipt {
    let mut record = match RunRecord::load(runs_root, run_id) {
        Ok(record) => record,
        Err(failure) => {
            let mut receipt = Receipt::new(
                "cleanup",
                run_id,
                ReceiptResult::Refused,
                "load",
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.next_action = failure.next_action.clone();
            receipt.failure = Some(failure);
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    };
    if let Some(confirmation) = remove_app {
        if let Err(detail) = removal_confirmed(&record, confirmation) {
            let mut receipt = Receipt::new(
                "cleanup",
                run_id,
                ReceiptResult::Refused,
                record.phase.as_str(),
                timefmt::iso8601_utc(runner.now_epoch_ms()),
            );
            receipt.scenario = Some(super::scenario_identity(&record));
            receipt.candidate = Some(record.candidate.clone());
            receipt.device = Some(super::device_identity(&record));
            let next_action = "re-run with --remove-app --confirm-remove-app <run-id>/<remote-serial>/<app-id> naming exactly this run, its leased emulator serial and its app id, or omit --remove-app for legacy cleanup";
            receipt.failure = Some(Failure::new(
                "cleanup",
                FailureCode::AppRemovalNotConfirmed,
                detail,
                next_action,
            ));
            receipt.next_action = next_action.to_string();
            receipt.commands_executed = runner.commands_executed();
            return receipt;
        }
    }

    let mut outcomes: Vec<(String, Outcome)> = Vec::new();

    if let Some(outcome) = cleanup_build(runner, &mut record, runs_root) {
        outcomes.push(("build_process".to_string(), outcome));
    }

    if let Some(outcome) = cleanup_core(runner, &mut record, runs_root, false) {
        outcomes.push(("core".to_string(), outcome));
    }
    if let Some(m) = record.resources.metro.clone() {
        outcomes.push((
            "metro".to_string(),
            cleanup_process_group(runner, m.identity.as_ref(), m.spawned.pgid, Some(m.port)),
        ));
    }

    match record.scenario.platform {
        Platform::Ios => {
            if let Some(sim) = record.resources.ios_simulator.clone() {
                let outcome = if record.resources.device_borrowed {
                    Outcome::Kept
                } else if record.resources.build_process.is_some() {
                    Outcome::Unresolved(
                        "build process cleanup is unproven; simulator retained".into(),
                    )
                } else {
                    cleanup_simulator(runner, &sim.udid, &sim.name)
                };
                outcomes.push(("simulator".to_string(), outcome));
            }
        }
        Platform::Android => {
            let server = record.resources.adb_server.clone();
            let is_usb =
                record.resources.usb_device.is_some() || record.scenario.android_usb.is_some();
            let mut removal_evidence_persisted = true;
            // Removal needs the lease, tunnel and private server alive to prove ownership.
            if remove_app.is_some() {
                let (mut outcome, removal) = remove_app_install(runner, &record);
                if let (Some(removal), Some(install)) =
                    (removal, record.resources.app_install.as_mut())
                {
                    install.removal = Some(removal);
                    // The removal must be durable before any lease release.
                    if let Err(failure) = record.save(runs_root) {
                        removal_evidence_persisted = false;
                        outcome = Outcome::Unresolved(format!(
                            "{} but the removal record could not be persisted: {}",
                            outcome.render(),
                            failure.detail
                        ));
                    }
                }
                outcomes.push(("app_install".to_string(), outcome));
            }
            // A recorded reverse mapping lives device-side; it can only be
            // removed through the run's own live adb server.
            if let Some(reverse_port) = record.resources.adb_reverse_port {
                match (
                    record.resources.adb_local_serial.clone(),
                    record.resources.adb_path.clone(),
                    &server,
                ) {
                    (Some(serial), Some(adb), Some(srv)) => {
                        push_reverse_outcome(
                            runner,
                            &record,
                            &mut outcomes,
                            reverse_port,
                            serial,
                            adb,
                            srv,
                            is_usb,
                        );
                    }
                    // A mapping was recorded but the path to remove it was
                    // never fully persisted; it cannot be proven gone.
                    _ => outcomes.push((
                        "adb_reverse".to_string(),
                        Outcome::Unresolved(format!(
                            "a reverse mapping tcp:{reverse_port} is recorded but the run's adb serial/path/server record is incomplete; remove it manually if present"
                        )),
                    )),
                }
            }
            if !is_usb {
                match (
                    record.resources.adb_local_serial.clone(),
                    record.resources.adb_path.clone(),
                    &server,
                ) {
                    (Some(serial), Some(adb), Some(srv)) => {
                        // Disconnecting is only meaningful while the run's own adb
                        // server is still alive; killing the server below drops the
                        // connection either way.
                        let server_alive = srv.identity.as_ref().is_some_and(|i| {
                            probe_pid_identity(runner, i) == PidLiveness::AliveMatching
                        });
                        let outcome = if !android::is_tunneled_serial(&serial) {
                            Outcome::Refused(format!(
                                "recorded serial {serial:?} is not a loopback tunnel endpoint"
                            ))
                        } else if server_alive {
                            disconnect_adb(runner, &adb, srv.server_port, &serial)
                        } else {
                            Outcome::Absent
                        };
                        outcomes.push(("adb_connection".to_string(), outcome));
                    }
                    // A recorded adb path without a serial means connect never
                    // succeeded; there is no connection resource to remove.
                    (None, _, _) => {}
                    _ => outcomes.push((
                        "adb_connection".to_string(),
                        Outcome::Refused(
                            "record carries an adb serial without a path/server; not touching adb"
                                .to_string(),
                        ),
                    )),
                }
            }
            if let Some(srv) = server {
                outcomes.push((
                    "adb_server".to_string(),
                    cleanup_process_group(
                        runner,
                        srv.identity.as_ref(),
                        srv.spawned.pgid,
                        Some(srv.server_port),
                    ),
                ));
            }
            // Keyed off its own resource, not the server: prepare can die
            // between writing the key and spawning the server.
            if let Some(vendor_key) = record.resources.adb_vendor_key.clone() {
                let run_dir = RunRecord::run_dir(runs_root, run_id);
                let key_normal = vendor_key
                    .components()
                    .all(|c| !matches!(c, std::path::Component::ParentDir));
                let key_outcome = if !key_normal || !vendor_key.starts_with(&run_dir) {
                    Outcome::Refused(format!(
                        "recorded vendor key {} is outside the run directory; not deleting",
                        vendor_key.display()
                    ))
                } else {
                    match std::fs::remove_file(&vendor_key) {
                        Ok(()) => Outcome::Removed,
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Outcome::Absent,
                        Err(e) => Outcome::Unresolved(format!("cannot remove vendor key: {e}")),
                    }
                };
                outcomes.push(("adb_vendor_key".to_string(), key_outcome));
            }
            let mut tunnel_clean = true;
            let mut tunnel_port = None;
            if let Some(tunnel) = record.resources.tunnel.clone() {
                let outcome = cleanup_process_group(
                    runner,
                    tunnel.identity.as_ref(),
                    tunnel.spawned.pgid,
                    Some(tunnel.local_port),
                );
                tunnel_clean = outcome.clean();
                tunnel_port = Some(tunnel.local_port);
                outcomes.push(("tunnel".to_string(), outcome));
            }
            if let Some(farm) = record.resources.farm.clone() {
                // The lease invariant is about the forwarded port, not the
                // process group: an unresolvable group whose port probes
                // positively free still cannot expose the next lease, while a
                // foreign, shared or indeterminate port keeps the slot held.
                let forward_gone = tunnel_clean
                    || tunnel_port.is_some_and(|p| {
                        let output = runner.run(&metro::port_owner_spec(p));
                        metro::parse_port_owner(&output) == metro::PortOwners::Free
                    });
                // Releasing the lease while our forward may still be live would
                // let the next lease's device be exposed through the old run's
                // local port; the slot stays held until the port is proven free.
                let outcome = if !removal_evidence_persisted {
                    Outcome::Refused(
                        "app removal evidence could not be persisted; retaining the farm lease"
                            .to_string(),
                    )
                } else if forward_gone {
                    cleanup_farm(
                        runner,
                        &farm.ssh_host,
                        &farm.farm_path,
                        farm.slot,
                        &farm.holder,
                    )
                } else {
                    Outcome::Refused(
                        "the tunnel is neither proven removed nor its local port proven \
                         free; retaining the farm lease so the forwarded port cannot \
                         expose the next lease"
                            .to_string(),
                    )
                };
                outcomes.push(("farm_lease".to_string(), outcome));
            }
            // The exclusive device claim is released last, and only once every
            // resource capable of addressing the device (reverse mapping, adb
            // server, and the build/metro process group that drives adb with
            // this run's server socket and serial) is proven removed or absent
            // — releasing earlier could hand the phone to the next run while
            // this run still reaches it.
            // A foreign holder proves this run's claim never succeeded
            // (persist-before-claim; Strict claims are never adopted), so it
            // reads as absent.
            if let Some(usb) = record.resources.usb_device.clone() {
                let device_paths_clean = outcomes
                    .iter()
                    .filter(|(name, _)| {
                        name == "adb_reverse" || name == "adb_server" || name == "metro"
                    })
                    .all(|(_, o)| o.clean());
                let outcome = if !device_paths_clean {
                    Outcome::Refused(
                        "resources that can still address the device are not proven gone; retaining the exclusive claim"
                            .to_string(),
                    )
                } else {
                    match crate::buildplan::release_lock(&usb.lock_dir, &usb.holder, &record.run_id)
                    {
                        crate::buildplan::ReleaseOutcome::Removed => Outcome::Removed,
                        crate::buildplan::ReleaseOutcome::Absent => Outcome::Absent,
                        // Foreign proves this run's Strict claim never
                        // succeeded; nothing of ours remains to release.
                        crate::buildplan::ReleaseOutcome::Foreign(_) => Outcome::Absent,
                        crate::buildplan::ReleaseOutcome::Refused(reason) => {
                            Outcome::Refused(reason)
                        }
                        crate::buildplan::ReleaseOutcome::Unresolved(reason) => {
                            Outcome::Unresolved(reason)
                        }
                    }
                };
                outcomes.push(("usb_device_claim".to_string(), outcome));
            }
        }
    }

    if let Some(lease) = record.resources.lease.clone() {
        let unclean = unclean_legs(&outcomes);
        let outcome = if unclean.is_empty() {
            release_lease_outcome(crate::lease::release(&lease))
        } else {
            retained_lease_outcome(&unclean, &record.run_id)
        };
        if outcome.clean() {
            record.resources.lease = None;
        }
        outcomes.push(("device_lease".to_string(), outcome));
    }

    if let Some(lock) = record.resources.build_lock.clone() {
        let outcome = if record.resources.build_process.is_some() {
            Outcome::Unresolved("build process cleanup is unproven; build lock retained".into())
        } else {
            match crate::buildplan::release_lock(&lock.lock_dir, &lock.holder, &record.run_id) {
                crate::buildplan::ReleaseOutcome::Removed => Outcome::Removed,
                crate::buildplan::ReleaseOutcome::Absent => Outcome::Absent,
                // Foreign is expected here: either this run never won the
                // lock, or a later build legitimately adopted it after this
                // run's prepare died (AdoptDead policy).
                crate::buildplan::ReleaseOutcome::Foreign(_) => Outcome::Absent,
                crate::buildplan::ReleaseOutcome::Refused(reason) => Outcome::Refused(reason),
                crate::buildplan::ReleaseOutcome::Unresolved(reason) => Outcome::Unresolved(reason),
            }
        };
        outcomes.push(("build_lock".to_string(), outcome));
    }

    let all_clean = outcomes.iter().all(|(_, o)| o.clean());
    let any_refused = outcomes
        .iter()
        .any(|(_, o)| matches!(o, Outcome::Refused(_)));
    let result = if all_clean {
        ReceiptResult::Cleaned
    } else if any_refused {
        ReceiptResult::Refused
    } else {
        ReceiptResult::Failed
    };

    let at = timefmt::iso8601_utc(runner.now_epoch_ms());
    let note: Vec<String> = outcomes
        .iter()
        .map(|(n, o)| format!("{n}={}", o.render()))
        .collect();
    record.push_history(at.clone(), &format!("cleanup: {}", note.join(" ")));
    let prev_phase = record.phase;
    if all_clean {
        record.phase = Phase::Cleaned;
    } else if remove_app.is_some() && record.phase == Phase::Cleaned {
        record.phase = Phase::Failed;
    }
    let save_result = record.save(runs_root);
    // A cleaned verdict that could not be made durable is not a cleaned run:
    // the next status would read the stale phase and contradict this receipt.
    // The receipt must also carry the durable phase, not the in-memory one.
    let result = match (&save_result, result) {
        (Err(_), ReceiptResult::Cleaned) => {
            record.phase = prev_phase;
            ReceiptResult::Failed
        }
        (_, r) => r,
    };

    let mut receipt = Receipt::new("cleanup", run_id, result, record.phase.as_str(), at);
    receipt.scenario = Some(super::scenario_identity(&record));
    receipt.candidate = Some(record.candidate.clone());
    receipt.device = Some(super::device_identity(&record));
    receipt.build = record.build.clone();
    receipt.core_cleanup = record.resources.core_cleanup.clone();
    receipt.fresh_install = record.resources.fresh_install.clone();
    for (name, outcome) in &outcomes {
        receipt.cleanup.insert(name.clone(), outcome.render());
    }
    if let (Some(_), Some(removal)) = (
        remove_app,
        record
            .resources
            .app_install
            .as_ref()
            .and_then(|i| i.removal.as_ref()),
    ) {
        receipt
            .outcomes
            .insert("app_removal_at".to_string(), removal.at.clone());
        receipt
            .outcomes
            .insert("app_removal_outcome".to_string(), removal.outcome.clone());
        receipt.outcomes.insert(
            "app_installed_sha256".to_string(),
            removal.installed_sha256.clone(),
        );
        receipt.outcomes.insert(
            "app_removal_uninstall".to_string(),
            removal.uninstall.clone(),
        );
        receipt.outcomes.insert(
            "app_removal_pm_path".to_string(),
            removal.pm_path_after.clone(),
        );
        receipt.outcomes.insert(
            "app_removal_package_list".to_string(),
            removal.package_list_after.clone(),
        );
    }
    receipt.failure = match result {
        ReceiptResult::Refused => Some(Failure::new(
            "cleanup",
            FailureCode::OwnershipUnproven,
            format!(
                "not proven ours or unresolved: {}",
                outcomes
                    .iter()
                    .filter(|(_, o)| !o.clean())
                    .map(|(n, o)| format!("{n} ({})", o.render()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            "resolve the listed resources manually; qaren will not touch them",
        )),
        ReceiptResult::Failed => Some(Failure::new(
            "cleanup",
            FailureCode::CleanupIncomplete,
            format!(
                "some resources could not be resolved: {}",
                outcomes
                    .iter()
                    .filter(|(_, o)| matches!(o, Outcome::Unresolved(_)))
                    .map(|(n, o)| format!("{n} ({})", o.render()))
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            format!("re-run qaren cleanup {run_id} --json"),
        )),
        _ => None,
    };
    if let Err(save_failure) = save_result {
        receipt.outcomes.insert(
            "record_saved".to_string(),
            format!("failed: {}", save_failure.detail),
        );
        receipt.failure = Some(Failure::new(
            "cleanup",
            FailureCode::RunRecordUpdateFailed,
            format!(
                "cleanup outcomes were computed but the run record could not be persisted: {}",
                save_failure.detail
            ),
            format!("fix .qaren permissions, then re-run qaren cleanup {run_id} --json"),
        ));
    }
    receipt.next_action = match result {
        ReceiptResult::Cleaned => "nothing left; the run is fully cleaned".to_string(),
        _ => receipt
            .failure
            .as_ref()
            .map(|f| f.next_action.clone())
            .unwrap_or_default(),
    };
    receipt.commands_executed = runner.commands_executed();
    super::attach_artifacts(&mut receipt, runs_root, &record);
    receipt
}

// The recorded serial must match the adapter that owns it: a loopback endpoint
// for farm runs, the exclusively claimed serial for USB runs. Anything else is
// not ours to address.
#[allow(clippy::too_many_arguments)]
fn push_reverse_outcome(
    runner: &mut dyn Runner,
    record: &RunRecord,
    outcomes: &mut Vec<(String, Outcome)>,
    reverse_port: u16,
    serial: String,
    adb: std::path::PathBuf,
    srv: &crate::runrecord::AdbServerResource,
    is_usb: bool,
) {
    let serial_legal = if is_usb {
        record
            .resources
            .usb_device
            .as_ref()
            .is_some_and(|usb| usb.serial == serial)
    } else {
        android::is_tunneled_serial(&serial)
    };
    let liveness = srv.identity.as_ref().map(|i| probe_pid_identity(runner, i));
    let outcome = if !serial_legal {
        Outcome::Refused(format!(
            "recorded serial {serial:?} does not match the run's device adapter; not addressing it"
        ))
    } else {
        match liveness {
            Some(PidLiveness::AliveMatching) => {
                let removed = runner.run(&android::adb_reverse_remove_spec(
                    &adb,
                    srv.server_port,
                    &serial,
                    reverse_port,
                ));
                if removed.timed_out {
                    Outcome::Unresolved("adb reverse --remove timed out".to_string())
                } else if removed.ok() {
                    Outcome::Removed
                } else if (removed.stdout.contains("listener")
                    || removed.stderr.contains("listener"))
                    && (removed.stdout.contains("not found")
                        || removed.stderr.contains("not found"))
                {
                    // adb's own "listener 'tcp:<port>' not found": the mapping
                    // is positively absent. A missing *device* error is not.
                    Outcome::Absent
                } else {
                    Outcome::Unresolved(format!(
                        "adb reverse --remove tcp:{reverse_port}: {}",
                        removed.summary()
                    ))
                }
            }
            // Reverse forwards live on the device keyed to the transport of
            // the run's own adb server; that server proven gone means the
            // transport closed and adbd dropped the mapping with it.
            Some(PidLiveness::Dead) | Some(PidLiveness::AliveForeign) => Outcome::Absent,
            Some(PidLiveness::Unknown) | None => Outcome::Unresolved(
                "the run's adb server liveness is unprovable; the reverse mapping cannot be resolved"
                    .to_string(),
            ),
        }
    };
    outcomes.push(("adb_reverse".to_string(), outcome));
}

fn removal_confirmed(record: &RunRecord, confirmation: &str) -> Result<(), String> {
    let farm_route = record.scenario.platform == Platform::Android
        && record.resources.usb_device.is_none()
        && record.scenario.android_usb.is_none();
    let Some(farm) = record.resources.farm.as_ref().filter(|_| farm_route) else {
        return Err(
            "app removal is supported only for the leased Android emulator route; this run records no farm lease"
                .to_string(),
        );
    };
    let expected = format!(
        "{}/{}/{}",
        record.run_id, farm.remote_serial, record.candidate.app_id
    );
    if confirmation == expected {
        Ok(())
    } else {
        Err(format!(
            "confirmation {confirmation:?} does not name this run, its leased emulator serial and its app id as <run-id>/<remote-serial>/<app-id>; nothing was touched"
        ))
    }
}

fn probe_evidence(output: &CmdOutput) -> String {
    let code = output
        .exit_code
        .map_or("none".to_string(), |c| c.to_string());
    crate::redact::redact_secrets(&format!(
        "exit={code} timed_out={} stdout={:?} stderr={:?}",
        output.timed_out, output.stdout, output.stderr
    ))
}

// A silent `pm path` exit 1 can mean absence; require an independent package-list read.
fn absence_proven(path: &CmdOutput, list: &CmdOutput, app_id: &str) -> Result<bool, String> {
    if path.timed_out || path.exit_code.is_none() {
        return Err(format!("pm path: {}", path.summary()));
    }
    if !list.ok() || !list.stderr.is_empty() {
        return Err(format!("pm list packages: {}", list.summary()));
    }
    if !path.stderr.is_empty() {
        return Err(format!("pm path: {}", path.summary()));
    }
    if !android::pm_path_packages(&path.stdout).is_empty()
        || android::package_list_has_exact(&list.stdout, app_id)
    {
        return Ok(false);
    }
    Ok(true)
}

fn identity_owned(
    runner: &mut dyn Runner,
    what: &str,
    identity: Option<&PidIdentity>,
) -> Result<(), Outcome> {
    match identity.map(|i| probe_pid_identity(runner, i)) {
        Some(PidLiveness::AliveMatching) => Ok(()),
        Some(PidLiveness::Dead) | Some(PidLiveness::AliveForeign) => Err(Outcome::Refused(
            format!("the run's {what} is no longer this run's process; the device path is not proven ours"),
        )),
        Some(PidLiveness::Unknown) => Err(Outcome::Unresolved(format!(
            "{what} liveness probe was inconclusive"
        ))),
        None => Err(Outcome::Refused(format!(
            "the run's {what} was recorded without a process identity"
        ))),
    }
}

// Re-prove ownership at the destructive boundary; preserve any prior removal evidence.
fn remove_app_install(
    runner: &mut dyn Runner,
    record: &RunRecord,
) -> (Outcome, Option<AppRemoval>) {
    let Some(install) = record.resources.app_install.as_ref() else {
        return (
            Outcome::Refused(
                "no successful installation is recorded for this run; a legacy record cannot prove which package it owns"
                    .to_string(),
            ),
            None,
        );
    };
    if let Some(removal) = &install.removal {
        return (
            if removal.outcome == "removed" || removal.outcome == "absent" {
                Outcome::Absent
            } else {
                Outcome::Refused(format!(
                    "a prior removal attempt remains {}; preserving its evidence without retrying removal",
                    removal.outcome
                ))
            },
            None,
        );
    }
    let (Some(farm), Some(tunnel), Some(server), Some(serial), Some(adb)) = (
        record.resources.farm.as_ref(),
        record.resources.tunnel.as_ref(),
        record.resources.adb_server.as_ref(),
        record.resources.adb_local_serial.as_ref(),
        record.resources.adb_path.as_ref(),
    ) else {
        return (
            Outcome::Refused(
                "the run record lacks the farm lease, tunnel, adb server, serial or adb path needed to prove ownership"
                    .to_string(),
            ),
            None,
        );
    };
    let app_id = record.candidate.app_id.as_str();
    let artifact_sha = install.artifact.sha256.to_ascii_lowercase();
    if install.app_id != app_id
        || install.serial != *serial
        || install.server_port != server.server_port
        || install.artifact.kind != crate::buildplan::ArtifactKind::Apk
        || artifact_sha.len() != 64
    {
        return (
            Outcome::Refused(
                "the recorded installation is bound to a different app id, serial, adb server or artifact than this run's resources"
                    .to_string(),
            ),
            None,
        );
    }
    if !record.farm_serial_consistent() {
        return (
            Outcome::Refused(format!(
                "recorded serial {serial:?} is not the tunnel endpoint of farm port {}",
                farm.adb_port
            )),
            None,
        );
    }

    let status = runner.run(&android::farm_status_spec(&farm.ssh_host, &farm.farm_path));
    if !status.ok() {
        return (
            Outcome::Unresolved(format!("farm status unreachable: {}", status.summary())),
            None,
        );
    }
    let Some(slot) = android::parse_slot_status(&status.stdout, farm.slot) else {
        return (
            Outcome::Unresolved(format!(
                "farm status has no parseable line for slot {}",
                farm.slot
            )),
            None,
        );
    };
    if !farm.matches_live(&slot) {
        return (
            Outcome::Refused(format!(
                "slot {} is live as lease={:?} avd={} serial={} adb_port={} state={}, not this run's {:?} {} {} {} device",
                farm.slot,
                android::lease_holder_token(&slot.lease),
                slot.avd,
                slot.serial,
                slot.adb_port,
                slot.state,
                farm.holder,
                farm.avd,
                farm.remote_serial,
                farm.adb_port
            )),
            None,
        );
    }
    if let Err(outcome) = identity_owned(runner, "tunnel", tunnel.identity.as_ref()) {
        return (outcome, None);
    }
    if let Err(outcome) = identity_owned(runner, "adb server", server.identity.as_ref()) {
        return (outcome, None);
    }
    let port = server.server_port;
    let state = runner.run(&android::adb_get_state_spec(adb, port, serial));
    if !state.ok() || state.stdout.trim() != "device" {
        return (
            Outcome::Unresolved(format!(
                "device state through the run's adb server: {}",
                state.summary()
            )),
            None,
        );
    }

    let path_before = runner.run(&android::pm_path_spec(adb, port, serial, app_id));
    if path_before.timed_out || path_before.exit_code.is_none() {
        return (
            Outcome::Unresolved(format!("pm path: {}", path_before.summary())),
            None,
        );
    }
    let paths = android::pm_path_packages(&path_before.stdout);
    if !paths.is_empty() && (!path_before.ok() || !path_before.stderr.is_empty()) {
        return (
            Outcome::Unresolved(format!("pm path: {}", path_before.summary())),
            None,
        );
    }
    let apk_path = match paths.as_slice() {
        [] => {
            let list = runner.run(&android::pm_list_packages_spec(adb, port, serial, app_id));
            return match absence_proven(&path_before, &list, app_id) {
                Ok(true) => (
                    Outcome::Absent,
                    Some(AppRemoval {
                        at: timefmt::iso8601_utc(runner.now_epoch_ms()),
                        outcome: "absent".to_string(),
                        installed_sha256: String::new(),
                        uninstall: "not issued: package absent before removal".to_string(),
                        pm_path_after: probe_evidence(&path_before),
                        package_list_after: probe_evidence(&list),
                    }),
                ),
                Ok(false) => (
                    Outcome::Refused(
                        "pm path reports no path while the package list still names the package; not guessing"
                            .to_string(),
                    ),
                    None,
                ),
                Err(reason) => (
                    Outcome::Unresolved(format!("installed state could not be read: {reason}")),
                    None,
                ),
            };
        }
        [path] if android::is_user_base_apk_path(path) => path.clone(),
        [path] => {
            return (
                Outcome::Refused(format!(
                    "installed path {path:?} is not a user base.apk under /data/app; not addressing it"
                )),
                None,
            )
        }
        many => {
            return (
                Outcome::Refused(format!(
                    "{} package paths reported; split or multiple APKs are outside the supported single-APK installation path",
                    many.len()
                )),
                None,
            )
        }
    };
    let hash_out = runner.run(&android::sha256sum_spec(adb, port, serial, &apk_path));
    if !hash_out.ok() {
        return (
            Outcome::Unresolved(format!(
                "installed APK hash could not be read: {}",
                hash_out.summary()
            )),
            None,
        );
    }
    let Some(installed_sha) = android::parse_sha256sum(&hash_out.stdout, &apk_path) else {
        return (
            Outcome::Unresolved(format!(
                "sha256sum output was unparseable: {}",
                hash_out.summary()
            )),
            None,
        );
    };
    if installed_sha != artifact_sha {
        return (
            Outcome::Refused(format!(
                "installed base.apk sha256 {installed_sha} does not match this run's installed artifact {artifact_sha}"
            )),
            None,
        );
    }

    let at = timefmt::iso8601_utc(runner.now_epoch_ms());
    let uninstall = runner.run(&android::uninstall_spec(adb, port, serial, app_id));
    let path_after = runner.run(&android::pm_path_spec(adb, port, serial, app_id));
    let list_after = runner.run(&android::pm_list_packages_spec(adb, port, serial, app_id));
    let reported_success = uninstall.ok() && uninstall.stdout.contains("Success");
    let outcome = match (
        reported_success,
        absence_proven(&path_after, &list_after, app_id),
    ) {
        (true, Ok(true)) => Outcome::Removed,
        (_, Ok(false)) => Outcome::Unresolved("package still present after uninstall".to_string()),
        (false, Ok(true)) => Outcome::Unresolved(format!(
            "uninstall did not report Success ({}) although the package now probes absent",
            uninstall.summary()
        )),
        (_, Err(reason)) => Outcome::Unresolved(format!("absence could not be proven: {reason}")),
    };
    let removal = AppRemoval {
        at,
        outcome: outcome.render(),
        installed_sha256: installed_sha,
        uninstall: probe_evidence(&uninstall),
        pm_path_after: probe_evidence(&path_after),
        package_list_after: probe_evidence(&list_after),
    };
    (outcome, Some(removal))
}

// The device lease is released last, and only once every leg that can still address
// the device is proven clean; otherwise it is retained for `qaren cleanup`.
pub(crate) fn unclean_legs(outcomes: &[(String, Outcome)]) -> Vec<String> {
    outcomes
        .iter()
        .filter(|(_, o)| !o.clean())
        .map(|(name, _)| name.clone())
        .collect()
}

pub(crate) fn retained_lease_outcome(unclean: &[String], run_id: &str) -> Outcome {
    Outcome::Unresolved(format!(
        "retained: {} not proven gone; qaren cleanup {run_id} releases it",
        unclean.join(", ")
    ))
}

// A foreign holder proves this run's Strict claim never succeeded, so there is nothing of ours to release.
pub(crate) fn release_lease_outcome(outcome: crate::buildplan::ReleaseOutcome) -> Outcome {
    match outcome {
        crate::buildplan::ReleaseOutcome::Removed => Outcome::Removed,
        crate::buildplan::ReleaseOutcome::Absent => Outcome::Absent,
        crate::buildplan::ReleaseOutcome::Foreign(_) => Outcome::Absent,
        crate::buildplan::ReleaseOutcome::Refused(reason) => Outcome::Refused(reason),
        crate::buildplan::ReleaseOutcome::Unresolved(reason) => Outcome::Unresolved(reason),
    }
}

fn kill_group(runner: &mut dyn Runner, pgid: i32, signal: &str) {
    runner.run(&CmdSpec::new(
        "kill-group",
        "/bin/kill",
        &[signal, "--", &format!("-{pgid}")],
        10,
    ));
}

pub(crate) fn cleanup_build(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
) -> Option<Outcome> {
    use crate::runrecord::BuildProcess;
    let process = record.resources.build_process.clone()?;
    let outcome = match &process {
        BuildProcess::SpawnPending => {
            Outcome::Unresolved("build spawn identity is unproven".into())
        }
        BuildProcess::Running { pgid, identity } => {
            cleanup_process_group(runner, identity.as_ref(), *pgid, None)
        }
    };
    if outcome.clean() {
        record.resources.build_process = None;
        if record.save(runs_root).is_err() {
            record.resources.build_process = Some(process);
            return Some(Outcome::Unresolved(
                "build retirement could not be persisted".into(),
            ));
        }
    }
    Some(outcome)
}

pub(crate) fn cleanup_core(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    wait_unresolved: bool,
) -> Option<Outcome> {
    use crate::runrecord::{CoreCleanupEvidence, GroupCleanupResult};
    let core = record.resources.core.clone()?;
    let mut outcome = cleanup_process_group(runner, core.identity.as_ref(), core.pgid, None);
    if wait_unresolved && outcome.clean() {
        outcome = Outcome::Unresolved("the core exit/pipe grace remained unresolved".into());
    }
    let previous = record.resources.core_cleanup.clone();
    record.resources.core_cleanup = Some(CoreCleanupEvidence {
        run_id: record.run_id.clone(),
        pgid: core.pgid,
        at: timefmt::iso8601_utc(runner.now_epoch_ms()),
        outcome: match &outcome {
            Outcome::Removed => GroupCleanupResult::Removed,
            Outcome::Absent => GroupCleanupResult::Absent,
            Outcome::Refused(_) => GroupCleanupResult::Refused,
            _ => GroupCleanupResult::Unresolved,
        },
    });
    if record.save(runs_root).is_err() {
        record.resources.core_cleanup = previous;
        return Some(Outcome::Unresolved(
            "core cleanup evidence could not be persisted".into(),
        ));
    }
    if outcome.clean() {
        record.resources.core = None;
        if record.save(runs_root).is_err() {
            record.resources.core = Some(core);
            return Some(Outcome::Unresolved(
                "core resource retirement could not be persisted".into(),
            ));
        }
    }
    Some(outcome)
}

// Unported groups require a complete group inventory; signaling remains ownership-gated.
pub(crate) fn cleanup_process_group(
    runner: &mut dyn Runner,
    identity: Option<&PidIdentity>,
    pgid: i32,
    port: Option<u16>,
) -> Outcome {
    // kill -pgid with 0/1/negative has catastrophic special semantics; a record
    // carrying such a value is corrupt and must be refused.
    if pgid < 2 {
        return Outcome::Refused(format!(
            "recorded pgid {pgid} is not a plausible process group"
        ));
    }
    if port.is_none() {
        use metro::GroupPresence;
        match metro::group_presence(runner, pgid) {
            GroupPresence::Absent => return Outcome::Absent,
            GroupPresence::Unknown => {
                return Outcome::Unresolved("process-group inventory is unknown".into())
            }
            GroupPresence::Present => {}
        }
        if !identity.is_some_and(|i| {
            i.pid == pgid && probe_pid_identity(runner, i) == PidLiveness::AliveMatching
        }) {
            // Observation only: 10.3s additional budget (300ms settle + one 10s inventory probe).
            runner.sleep(Duration::from_millis(300));
            return match metro::group_presence(runner, pgid) {
                GroupPresence::Absent => Outcome::Absent,
                GroupPresence::Present => Outcome::Unresolved(
                    "process group remains but its leader ownership is unproven".into(),
                ),
                GroupPresence::Unknown => {
                    Outcome::Unresolved("process-group inventory after settling is unknown".into())
                }
            };
        }
        kill_group(runner, pgid, "-TERM");
        runner.sleep(Duration::from_millis(1500));
        kill_group(runner, pgid, "-KILL");
        runner.sleep(Duration::from_millis(300));
        return match metro::group_presence(runner, pgid) {
            GroupPresence::Absent => Outcome::Removed,
            GroupPresence::Present => {
                Outcome::Unresolved("process group survived TERM and KILL".into())
            }
            GroupPresence::Unknown => {
                Outcome::Unresolved("process-group inventory after KILL is unknown".into())
            }
        };
    }
    let leader = identity.map(|recorded| probe_pid_identity(runner, recorded));
    let group_live_via_port = port.map(|p| {
        let output = runner.run(&metro::port_owner_spec(p));
        match metro::parse_port_owner(&output) {
            metro::PortOwners::Owned(pid) => {
                metro::pgid_of(runner, pid).map(|owner_pgid| owner_pgid == pgid)
            }
            metro::PortOwners::Free => Some(false),
            _ => None,
        }
    });

    let proven_ours =
        leader == Some(PidLiveness::AliveMatching) || group_live_via_port.flatten() == Some(true);
    if proven_ours {
        kill_group(runner, pgid, "-TERM");
        runner.sleep(Duration::from_millis(1500));
        kill_group(runner, pgid, "-KILL");
        runner.sleep(Duration::from_millis(300));
        let leader_after = identity.map(|recorded| probe_pid_identity(runner, recorded));
        if leader_after == Some(PidLiveness::AliveMatching) {
            return Outcome::Unresolved("group leader survived TERM and KILL".to_string());
        }
        // Survival must be positively excluded: only a free port or a port
        // owned by a provably foreign group counts as gone.
        if let Some(p) = port {
            let output = runner.run(&metro::port_owner_spec(p));
            match metro::parse_port_owner(&output) {
                metro::PortOwners::Free => {}
                metro::PortOwners::Owned(pid) => match metro::pgid_of(runner, pid) {
                    Some(owner) if owner == pgid => {
                        return Outcome::Unresolved(format!(
                            "port {p} still owned by the group after KILL"
                        ))
                    }
                    Some(_) => {}
                    None => {
                        return Outcome::Unresolved(format!(
                            "port {p} owner could not be attributed after KILL"
                        ))
                    }
                },
                metro::PortOwners::Multiple => {
                    return Outcome::Unresolved(format!(
                        "port {p} has multiple listeners after KILL"
                    ))
                }
                metro::PortOwners::Unknown => {
                    return Outcome::Unresolved(format!(
                        "port {p} state could not be determined after KILL"
                    ))
                }
            }
        }
        return Outcome::Removed;
    }

    match leader {
        // No recorded identity: a free or foreign port proves nothing about a
        // group that may still be starting up; never guess absent.
        None => Outcome::Unresolved(
            "no recorded identity and the recorded port does not prove the group; \
             resolve the process group manually"
                .to_string(),
        ),
        Some(PidLiveness::Dead) => match group_live_via_port {
            Some(Some(false)) | None => Outcome::Absent,
            Some(Some(true)) => unreachable!("proven_ours handled above"),
            Some(None) => {
                Outcome::Unresolved("port owner pgid could not be determined".to_string())
            }
        },
        Some(PidLiveness::AliveForeign) => Outcome::Absent,
        Some(PidLiveness::Unknown) => {
            Outcome::Unresolved("pid liveness probe was inconclusive".to_string())
        }
        Some(PidLiveness::AliveMatching) => unreachable!("proven_ours handled above"),
    }
}

fn cleanup_simulator(runner: &mut dyn Runner, udid: &str, expected_name: &str) -> Outcome {
    let list = runner.run(&ios::list_devices_spec());
    if !list.ok() {
        return Outcome::Unresolved(format!("simctl list failed: {}", list.summary()));
    }
    // An empty udid is a pending allocation whose create crashed before the
    // udid was learned; the run-scoped name is the recovery key.
    let (resolved_udid, state) = if udid.is_empty() {
        match ios::parse_sim_named(&list.stdout, expected_name) {
            ios::SimNamed::Absent => return Outcome::Absent,
            ios::SimNamed::Unparseable => {
                return Outcome::Unresolved("simctl list output was unparseable".to_string())
            }
            ios::SimNamed::Ambiguous(n) => {
                return Outcome::Refused(format!(
                    "{n} simulators carry the run-scoped name {expected_name:?}; not guessing"
                ))
            }
            ios::SimNamed::Found { udid, state } => (udid, state),
        }
    } else {
        match ios::parse_sim_presence(&list.stdout, udid) {
            ios::SimPresence::Absent => return Outcome::Absent,
            ios::SimPresence::Unparseable => {
                return Outcome::Unresolved("simctl list output was unparseable".to_string())
            }
            ios::SimPresence::Present { name, state } => {
                if name != expected_name {
                    return Outcome::Refused(format!(
                        "simulator {udid} is named {name:?}, expected {expected_name:?}; not ours to delete"
                    ));
                }
                (udid.to_string(), state)
            }
        }
    };
    if state == "Booted" {
        let shutdown = runner.run(&ios::shutdown_spec(&resolved_udid));
        if !shutdown.ok() {
            return Outcome::Unresolved(format!("simctl shutdown failed: {}", shutdown.summary()));
        }
    }
    let delete = runner.run(&ios::delete_spec(&resolved_udid));
    if delete.ok() {
        Outcome::Removed
    } else {
        Outcome::Unresolved(format!("simctl delete failed: {}", delete.summary()))
    }
}

fn disconnect_adb(runner: &mut dyn Runner, adb: &Path, server_port: u16, serial: &str) -> Outcome {
    let output = runner.run(&android::adb_disconnect_spec(adb, server_port, serial));
    if output.timed_out {
        return Outcome::Unresolved("adb disconnect timed out".to_string());
    }
    if output.ok() {
        Outcome::Removed
    } else if output.stdout.contains("no such device") || output.stderr.contains("no such device") {
        Outcome::Absent
    } else {
        Outcome::Unresolved(format!("adb disconnect {serial}: {}", output.summary()))
    }
}

fn cleanup_farm(
    runner: &mut dyn Runner,
    ssh_host: &str,
    farm_path: &str,
    slot: u8,
    holder: &str,
) -> Outcome {
    let status = runner.run(&android::farm_status_spec(ssh_host, farm_path));
    if !status.ok() {
        return Outcome::Unresolved(format!("farm status unreachable: {}", status.summary()));
    }
    let Some(slot_status) = android::parse_slot_status(&status.stdout, slot) else {
        return Outcome::Unresolved(format!("farm status has no parseable line for slot {slot}"));
    };
    let lease_holder = android::lease_holder_token(&slot_status.lease);
    if slot_status.lease == "free" {
        if slot_status.state == "down" {
            return Outcome::Absent;
        }
        return Outcome::Refused(format!(
            "slot {slot} has no lease but state {:?}; a foreign emulator may be running",
            slot_status.state
        ));
    }
    if lease_holder != holder {
        return Outcome::Refused(format!(
            "slot {slot} is leased by {lease_holder:?}, not {holder:?}; not ours to stop"
        ));
    }
    let stop = runner.run(&android::farm_stop_spec(ssh_host, farm_path, slot));
    if stop.ok() && stop.stdout.contains(&format!("stopped slot={slot}")) {
        Outcome::Removed
    } else {
        Outcome::Unresolved(format!("android-farm stop: {}", stop.summary()))
    }
}
