use crate::exec::{CmdSpec, Runner};
use std::path::Path;

pub fn require_launch_scheme(scheme: Option<&str>) -> Result<(), crate::failure::Failure> {
    if scheme.is_some_and(|s| s.len() <= 128 && crate::scenario::is_uri_scheme(s)) {
        return Ok(());
    }
    Err(crate::failure::Failure::new(
        "config",
        crate::failure::FailureCode::DevClientSchemeRequired,
        "iOS CLI-owned builds require a 1–128-byte dev-client URI scheme matching [A-Za-z][A-Za-z0-9+.-]*",
        "set devClientScheme in .qaren/config.yaml (candidate.dev_client_scheme for prepare) to the app's registered URI scheme",
    ))
}

pub fn require_generic_build(
    runner: &mut dyn Runner,
    project_root: &Path,
) -> Result<(), crate::failure::Failure> {
    use std::os::unix::fs::PermissionsExt;
    let refused = crate::failure::Failure::new(
        "preflight",
        crate::failure::FailureCode::IosBuildCapabilityUnavailable,
        "app-local Expo CLI does not prove generic iOS build-only support with --output and --no-bundler",
        "install app-local dependencies with an Expo CLI supporting generic iOS build-only output, then retry",
    );
    if !std::fs::metadata(project_root.join("node_modules/.bin/expo"))
        .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
    {
        return Err(refused);
    }
    let output = runner.run_private(
        &CmdSpec::new(
            "expo-ios-build-help",
            "pnpm",
            &["exec", "expo", "run:ios", "--help"],
            15,
        )
        .cwd(project_root)
        .env("CI", "1")
        .env("EXPO_NO_TELEMETRY", "1")
        .env("EXPO_OFFLINE", "1")
        .env("COREPACK_ENABLE_NETWORK", "0")
        .env("NO_COLOR", "1"),
        &[],
    );
    let option = |flag: &str| {
        output.stdout().lines().find_map(|line| {
            let line = line.trim_start();
            let line = line
                .strip_prefix("-d, ")
                .or_else(|| line.strip_prefix("-o, "))
                .unwrap_or(line);
            line.strip_prefix(flag)
                .and_then(|tail| tail.strip_prefix(' '))
        })
    };
    if !output.clean()
        || output.stdout().len() > 64 * 1024
        || option("--no-bundler").is_none()
        || !option("--output").is_some_and(|tail| tail.starts_with("<path>"))
        || !option("--device").is_some_and(|tail| tail.contains("\"generic\" for build-only"))
    {
        return Err(refused);
    }
    Ok(())
}

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

pub fn canonical_udid(udid: &str) -> Option<String> {
    (udid.len() == 36
        && udid.bytes().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => b == b'-',
            _ => b.is_ascii_hexdigit(),
        }))
    .then(|| udid.to_ascii_uppercase())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimState {
    Booted,
    Shutdown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Simulator {
    pub udid: String,
    pub name: String,
    pub device_type: String,
    pub runtime: String,
    pub state: SimState,
}

fn parse_sim(runtime: &str, device: &serde_json::Value) -> Option<Simulator> {
    let field = |key: &str| device.get(key).and_then(|v| v.as_str()).unwrap_or("");
    let sim = Simulator {
        udid: field("udid").to_string(),
        name: field("name").to_string(),
        device_type: field("deviceTypeIdentifier").to_string(),
        runtime: runtime.to_string(),
        state: match field("state") {
            "Booted" => SimState::Booted,
            "Shutdown" => SimState::Shutdown,
            _ => return None,
        },
    };
    if sim.udid.is_empty() || sim.device_type.is_empty() {
        return None;
    }
    Some(sim)
}

// Booted iOS simulators only; paired watchOS/tvOS runtimes are not walk targets.
pub fn parse_booted_sims(list_json: &str) -> Option<Vec<Simulator>> {
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
            out.push(parse_sim(runtime, device)?);
        }
    }
    Some(out)
}

pub fn parse_selected_sim(list_json: &str, udid: &str) -> Option<Simulator> {
    let udid = canonical_udid(udid)?;
    let parsed: serde_json::Value = serde_json::from_str(list_json).ok()?;
    let devices = parsed.get("devices")?.as_object()?;
    let mut selected = None;
    for (runtime, list) in devices {
        for device in list.as_array()? {
            let observed = device.get("udid")?.as_str()?;
            if !observed.eq_ignore_ascii_case(&udid) {
                continue;
            }
            if selected.is_some()
                || observed != udid
                || !device.get("isAvailable")?.as_bool()?
                || runtime
                    .strip_prefix("com.apple.CoreSimulator.SimRuntime.iOS-")?
                    .is_empty()
            {
                return None;
            }
            let sim = parse_sim(runtime, device)?;
            if sim.name.trim().is_empty() || sim.device_type.trim().is_empty() {
                return None;
            }
            selected = Some(sim);
        }
    }
    selected
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

pub fn launch_spec(udid: &str, app_id: &str, metro_port: u16) -> CmdSpec {
    CmdSpec::new(
        "simctl-launch",
        "xcrun",
        &[
            "simctl",
            "launch",
            "--terminate-running-process",
            udid,
            app_id,
            "--initialUrl",
            &format!("http://127.0.0.1:{metro_port}"),
        ],
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

pub fn build_spec(project_root: &Path, output: &Path, deadline_seconds: u64) -> CmdSpec {
    CmdSpec::new(
        "expo-run-ios",
        "pnpm",
        &[
            "exec",
            "expo",
            "run:ios",
            "--device",
            "generic",
            "--no-bundler",
            "--output",
            &output.to_string_lossy(),
        ],
        deadline_seconds,
    )
    .cwd(project_root)
    .env("CI", "1")
    .env("EXPO_NO_TELEMETRY", "1")
}

pub fn built_app(output: &Path) -> Result<std::path::PathBuf, String> {
    if !std::fs::symlink_metadata(output)
        .map_err(|e| e.to_string())?
        .is_dir()
    {
        return Err("build output is not a real directory".into());
    }
    let mut apps = Vec::new();
    for entry in std::fs::read_dir(output).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.extension().is_some_and(|ext| ext == "app") {
            apps.push(path);
        }
    }
    match apps.as_slice() {
        [app] => Ok(app.clone()),
        _ => Err(format!(
            "expected exactly one simulator .app, found {}",
            apps.len()
        )),
    }
}

pub fn verify_app(
    runner: &mut dyn Runner,
    path: &Path,
    app_id: &str,
    scheme: &str,
) -> Result<crate::buildplan::CachedArtifact, String> {
    use std::os::unix::fs::PermissionsExt;
    fn regular_tree(path: &Path) -> Result<(), String> {
        let meta = std::fs::symlink_metadata(path).map_err(|e| e.to_string())?;
        if meta.is_dir() {
            for entry in std::fs::read_dir(path).map_err(|e| e.to_string())? {
                regular_tree(&entry.map_err(|e| e.to_string())?.path())?;
            }
        } else if !meta.is_file() {
            return Err("app bundle contains a symlink or special file".into());
        }
        Ok(())
    }
    if !path.is_dir() || path.extension().is_none_or(|ext| ext != "app") {
        return Err("artifact is not an app bundle directory".into());
    }
    regular_tree(path)?;
    let info = runner.run_private(
        &CmdSpec::new(
            "ios-app-info",
            "plutil",
            &[
                "-convert",
                "json",
                "-o",
                "-",
                &path.join("Info.plist").to_string_lossy(),
            ],
            10,
        ),
        &[],
    );
    if !info.clean() {
        return Err("app Info.plist could not be read".into());
    }
    let info: serde_json::Value =
        serde_json::from_str(info.stdout()).map_err(|_| "app Info.plist is not an object")?;
    if info["CFBundleIdentifier"].as_str() != Some(app_id)
        || info["CFBundlePackageType"].as_str() != Some("APPL")
        || info["CFBundleSupportedPlatforms"] != serde_json::json!(["iPhoneSimulator"])
        || !info["CFBundleURLTypes"].as_array().is_some_and(|types| {
            types.iter().any(|t| {
                t["CFBundleURLSchemes"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s.as_str() == Some(scheme)))
            })
        })
    {
        return Err(
            "app bundle identity, simulator platform or launch scheme does not match".into(),
        );
    }
    let executable = info["CFBundleExecutable"]
        .as_str()
        .ok_or("app executable is missing")?;
    if executable.is_empty() || executable == "." || executable == ".." || executable.contains('/')
    {
        return Err("app executable is not a bundle-local filename".into());
    }
    let executable = path.join(executable);
    let meta = std::fs::metadata(&executable).map_err(|_| "app executable is missing")?;
    if !meta.is_file() || meta.len() < 4 || meta.permissions().mode() & 0o111 == 0 {
        return Err("app executable is not usable".into());
    }
    let binary = runner.run_private(
        &CmdSpec::new(
            "ios-app-platform",
            "xcrun",
            &["vtool", "-show-build", &executable.to_string_lossy()],
            10,
        ),
        &[],
    );
    let platforms: Vec<_> = binary
        .stdout()
        .lines()
        .filter_map(|line| line.trim().strip_prefix("platform "))
        .collect();
    if !binary.clean()
        || platforms.is_empty()
        || platforms.iter().any(|p| p.trim() != "IOSSIMULATOR")
    {
        return Err("app executable does not prove an iOS simulator build".into());
    }
    verify_initial_url_launcher(runner, path, &executable)?;
    Ok(crate::buildplan::CachedArtifact {
        path: path.to_path_buf(),
        sha256: crate::buildplan::hash_artifact(path)?,
        kind: crate::buildplan::ArtifactKind::AppBundle,
    })
}

fn verify_initial_url_launcher(
    runner: &mut dyn Runner,
    app: &Path,
    executable: &Path,
) -> Result<(), String> {
    let refused = "app does not prove support for direct Metro launch via --initialUrl";
    if app.join("main.jsbundle").exists() {
        return Err(refused.into());
    }
    let linked = runner.run_private(
        &CmdSpec::new(
            "ios-app-linked-images",
            "xcrun",
            &["otool", "-L", &executable.to_string_lossy()],
            10,
        ),
        &[],
    );
    if !linked.clean() {
        return Err(refused.into());
    }
    // Xcode's debug executable may delegate to a bundle-local dylib.
    let debug_name = format!(
        "{}.debug.dylib",
        executable.file_name().unwrap().to_string_lossy()
    );
    let debug_link = format!("@rpath/{debug_name}");
    let image = if linked.stdout().lines().skip(1).any(|line| {
        line.rsplit_once(" (compatibility version ")
            .is_some_and(|(name, _)| name.trim() == debug_link)
    }) {
        app.join(debug_name)
    } else {
        executable.to_path_buf()
    };
    if !image.is_file() {
        return Err(refused.into());
    }
    let symbols = runner.run_private(
        &CmdSpec::new(
            "ios-app-launcher-symbols",
            "xcrun",
            &["nm", "-j", "-U", &image.to_string_lossy()],
            10,
        ),
        &[],
    );
    if !symbols.clean()
        || ![
            "+[EXDevLauncherController initialUrlFromProcessInfo]",
            "-[EXDevLauncherController start:launchOptions:]",
            "-[EXDevLauncherController loadApp:withProjectUrl:onSuccess:onError:]",
        ]
        .iter()
        .all(|required| symbols.stdout().lines().any(|line| line == *required))
    {
        return Err(refused.into());
    }
    let strings = runner.run_private(
        &CmdSpec::new(
            "ios-app-launcher-arguments",
            "xcrun",
            &[
                "otool",
                "-v",
                "-s",
                "__TEXT",
                "__cstring",
                &image.to_string_lossy(),
            ],
            10,
        ),
        &[],
    );
    if !strings.clean()
        || !strings.stdout().lines().any(|line| {
            let mut fields = line.split_whitespace();
            fields
                .next()
                .is_some_and(|address| address.bytes().all(|b| b.is_ascii_hexdigit()))
                && fields.next() == Some("--initialUrl")
                && fields.next().is_none()
        })
    {
        return Err(refused.into());
    }
    Ok(())
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
