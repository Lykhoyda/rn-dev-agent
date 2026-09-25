use crate::exec::{CmdSpec, Runner};
use std::path::Path;

pub fn sim_name(run_id: &str) -> String {
    format!("qaren-{run_id}")
}

pub fn create_spec(name: &str, device_type: &str, runtime: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-create",
        "xcrun",
        &["simctl", "create", name, device_type, runtime],
        120,
    )
}

pub fn bootstatus_spec(udid: &str, deadline_seconds: u64) -> CmdSpec {
    CmdSpec::new(
        "simctl-bootstatus",
        "xcrun",
        &["simctl", "bootstatus", udid, "-b"],
        deadline_seconds,
    )
}

pub fn list_booted_spec() -> CmdSpec {
    CmdSpec::new(
        "simctl-list-booted",
        "xcrun",
        &["simctl", "list", "devices", "booted", "-j"],
        30,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootedSim {
    pub udid: String,
    pub name: String,
    pub device_type: String,
    pub runtime: String,
}

// Booted iOS simulators only; paired watchOS/tvOS runtimes are not walk targets.
pub fn parse_booted_sims(list_json: &str) -> Option<Vec<BootedSim>> {
    let parsed: serde_json::Value = serde_json::from_str(list_json).ok()?;
    let devices = parsed.get("devices")?.as_object()?;
    let mut out = Vec::new();
    for (runtime, list) in devices {
        if !runtime.contains("SimRuntime.iOS") {
            continue;
        }
        for device in list.as_array()? {
            if device.get("state").and_then(|s| s.as_str()) != Some("Booted") {
                continue;
            }
            let field = |key: &str| device.get(key).and_then(|v| v.as_str()).unwrap_or("");
            let sim = BootedSim {
                udid: field("udid").to_string(),
                name: field("name").to_string(),
                device_type: field("deviceTypeIdentifier").to_string(),
                runtime: runtime.clone(),
            };
            if sim.udid.is_empty() || sim.device_type.is_empty() {
                return None;
            }
            out.push(sim);
        }
    }
    Some(out)
}

pub fn list_devices_spec() -> CmdSpec {
    CmdSpec::new(
        "simctl-list",
        "xcrun",
        &["simctl", "list", "devices", "-j"],
        30,
    )
}

pub fn app_container_spec(udid: &str, app_id: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-app-container",
        "xcrun",
        &["simctl", "get_app_container", udid, app_id, "app"],
        20,
    )
}

pub fn launchctl_list_spec(udid: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-launchctl",
        "xcrun",
        &["simctl", "spawn", udid, "launchctl", "list"],
        20,
    )
}

pub fn install_app_spec(udid: &str, app_path: &Path) -> CmdSpec {
    CmdSpec::new(
        "simctl-install",
        "xcrun",
        &["simctl", "install", udid, &app_path.to_string_lossy()],
        120,
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppPresence {
    Installed,
    ProvenAbsent,
    Unknown,
}

pub fn probe_app_presence(runner: &mut dyn Runner, udid: &str, app_id: &str) -> AppPresence {
    let output = runner.run_private(
        &CmdSpec::new(
            "simctl-listapps",
            "xcrun",
            &["simctl", "listapps", udid],
            30,
        ),
        &[],
    );
    if !output.clean() {
        return AppPresence::Unknown;
    }
    let converted = runner.run_private(
        &CmdSpec::new(
            "app-list-json",
            "plutil",
            &["-convert", "json", "-o", "-", "-"],
            10,
        ),
        output.stdout().as_bytes(),
    );
    if !converted.clean() {
        return AppPresence::Unknown;
    }
    let Ok(serde_json::Value::Object(apps)) = serde_json::from_str(converted.stdout()) else {
        return AppPresence::Unknown;
    };
    if apps.iter().any(|(id, info)| {
        info.get("CFBundleIdentifier")
            .and_then(serde_json::Value::as_str)
            != Some(id.as_str())
    }) {
        return AppPresence::Unknown;
    }
    if apps.contains_key(app_id) {
        AppPresence::Installed
    } else {
        AppPresence::ProvenAbsent
    }
}

pub fn uninstall_app_spec(udid: &str, app_id: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-uninstall",
        "xcrun",
        &["simctl", "uninstall", udid, app_id],
        60,
    )
}

pub fn openurl_spec(udid: &str, url: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-openurl",
        "xcrun",
        &["simctl", "openurl", udid, url],
        60,
    )
}

pub fn shutdown_spec(udid: &str) -> CmdSpec {
    CmdSpec::new(
        "simctl-shutdown",
        "xcrun",
        &["simctl", "shutdown", udid],
        120,
    )
}

pub fn delete_spec(udid: &str) -> CmdSpec {
    CmdSpec::new("simctl-delete", "xcrun", &["simctl", "delete", udid], 120)
}

pub fn build_spec(project_root: &Path, udid: &str, port: u16, deadline_seconds: u64) -> CmdSpec {
    CmdSpec::new(
        "expo-run-ios",
        "pnpm",
        &[
            "exec",
            "expo",
            "run:ios",
            "--device",
            udid,
            "--port",
            &port.to_string(),
        ],
        deadline_seconds,
    )
    .cwd(project_root)
    .env("CI", "1")
    .env("EXPO_NO_TELEMETRY", "1")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimPresence {
    Present { name: String, state: String },
    Absent,
    Unparseable,
}

pub fn parse_sim_presence(list_json: &str, udid: &str) -> SimPresence {
    let parsed: serde_json::Value = match serde_json::from_str(list_json) {
        Ok(v) => v,
        Err(_) => return SimPresence::Unparseable,
    };
    let Some(devices) = parsed.get("devices").and_then(|d| d.as_object()) else {
        return SimPresence::Unparseable;
    };
    for runtime_devices in devices.values() {
        let Some(list) = runtime_devices.as_array() else {
            return SimPresence::Unparseable;
        };
        for device in list {
            if device.get("udid").and_then(|u| u.as_str()) == Some(udid) {
                let name = device.get("name").and_then(|n| n.as_str()).unwrap_or("");
                let state = device.get("state").and_then(|s| s.as_str()).unwrap_or("");
                if name.is_empty() || state.is_empty() {
                    return SimPresence::Unparseable;
                }
                return SimPresence::Present {
                    name: name.to_string(),
                    state: state.to_string(),
                };
            }
        }
    }
    SimPresence::Absent
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimNamed {
    Found { udid: String, state: String },
    Ambiguous(usize),
    Absent,
    Unparseable,
}

// Recovery path for a pending allocation whose create crashed before the udid
// was learned: the run-scoped name is the only ownership key.
pub fn parse_sim_named(list_json: &str, name: &str) -> SimNamed {
    let parsed: serde_json::Value = match serde_json::from_str(list_json) {
        Ok(v) => v,
        Err(_) => return SimNamed::Unparseable,
    };
    let Some(devices) = parsed.get("devices").and_then(|d| d.as_object()) else {
        return SimNamed::Unparseable;
    };
    let mut matches = Vec::new();
    for runtime_devices in devices.values() {
        let Some(list) = runtime_devices.as_array() else {
            return SimNamed::Unparseable;
        };
        for device in list {
            if device.get("name").and_then(|n| n.as_str()) == Some(name) {
                let udid = device.get("udid").and_then(|u| u.as_str()).unwrap_or("");
                let state = device.get("state").and_then(|s| s.as_str()).unwrap_or("");
                if udid.is_empty() || state.is_empty() {
                    return SimNamed::Unparseable;
                }
                matches.push((udid.to_string(), state.to_string()));
            }
        }
    }
    match matches.len() {
        0 => SimNamed::Absent,
        1 => {
            let (udid, state) = matches.remove(0);
            SimNamed::Found { udid, state }
        }
        n => SimNamed::Ambiguous(n),
    }
}

// launchctl list rows are "PID Status Label"; a loaded-but-dead job shows "-" as PID.
pub fn app_running_in_launchctl(launchctl_output: &str, app_id: &str) -> bool {
    let label_prefix = format!("UIKitApplication:{app_id}[");
    launchctl_output.lines().any(|line| {
        let mut cols = line.split_whitespace();
        let pid_ok = cols.next().is_some_and(|pid| pid.parse::<u32>().is_ok());
        let label_ok = cols
            .nth(1)
            .is_some_and(|label| label.starts_with(&label_prefix));
        pid_ok && label_ok
    })
}
