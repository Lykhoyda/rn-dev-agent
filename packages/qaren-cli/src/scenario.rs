use crate::failure::{Failure, FailureCode};
use serde::{Deserialize, Serialize};
use std::path::Path;

pub const SCENARIO_SCHEMA: &str = "qaren/1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Scenario {
    pub schema: String,
    pub name: String,
    pub platform: Platform,
    pub candidate: CandidateSpec,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metro: Option<MetroSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ios: Option<IosSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub android: Option<AndroidSpec>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub android_usb: Option<AndroidUsbSpec>,
    #[serde(default)]
    pub build: BuildSpec,
    #[serde(default)]
    pub deps: DepsSpec,
    #[serde(default)]
    pub deadlines: Deadlines,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Ios,
    Android,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandidateSpec {
    pub project_root: String,
    pub app_id: String,
    pub revision: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dev_client_scheme: Option<String>,
}

pub(crate) fn is_uri_scheme(scheme: &str) -> bool {
    let mut bytes = scheme.bytes();
    bytes.next().is_some_and(|b| b.is_ascii_alphabetic())
        && bytes.all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'.' | b'-'))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MetroSpec {
    pub port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct IosSpec {
    pub device_type: String,
    pub runtime: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AndroidSpec {
    pub ssh_host: String,
    pub farm_path: String,
    pub slot: u8,
    pub adb_server_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AndroidUsbSpec {
    pub serial: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adb_server_port: Option<u16>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BuildStrategy {
    Auto,
    Clean,
}

// Who performs the one authoritative build/install: the CLI itself (default),
// or a cooperating session that takes a typed handoff after allocation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BuildOwner {
    Cli,
    Qaren,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct BuildSpec {
    #[serde(default = "d_strategy")]
    pub strategy: BuildStrategy,
    #[serde(default = "d_owner")]
    pub owner: BuildOwner,
}

fn d_strategy() -> BuildStrategy {
    BuildStrategy::Auto
}

fn d_owner() -> BuildOwner {
    BuildOwner::Cli
}

impl Default for BuildSpec {
    fn default() -> Self {
        BuildSpec {
            strategy: BuildStrategy::Auto,
            owner: BuildOwner::Cli,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DepsPolicy {
    Install,
    RequirePrewarm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DepsSpec {
    #[serde(default = "d_policy")]
    pub policy: DepsPolicy,
}

fn d_policy() -> DepsPolicy {
    DepsPolicy::Install
}

impl Default for DepsSpec {
    fn default() -> Self {
        DepsSpec {
            policy: DepsPolicy::Install,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Deadlines {
    #[serde(default = "d_deps")]
    pub install_deps_seconds: u64,
    #[serde(default = "d_build")]
    pub build_seconds: u64,
    #[serde(default = "d_boot")]
    pub device_boot_seconds: u64,
}

fn d_deps() -> u64 {
    900
}
fn d_build() -> u64 {
    2400
}
fn d_boot() -> u64 {
    420
}

impl Default for Deadlines {
    fn default() -> Self {
        Deadlines {
            install_deps_seconds: d_deps(),
            build_seconds: d_build(),
            device_boot_seconds: d_boot(),
        }
    }
}

impl Scenario {
    pub fn load(path: &Path) -> Result<(Scenario, String), Failure> {
        let raw = std::fs::read_to_string(path).map_err(|e| {
            Failure::new(
                "validate",
                FailureCode::ScenarioUnreadable,
                format!("cannot read scenario {}: {e}", path.display()),
                "check the scenario path",
            )
        })?;
        let scenario: Scenario = serde_yaml::from_str(&raw).map_err(|e| {
            Failure::new(
                "validate",
                FailureCode::ScenarioInvalid,
                format!("scenario {} does not parse as qaren/1: {e}", path.display()),
                "fix the scenario file against packages/qaren-cli/README.md",
            )
        })?;
        scenario.validate()?;
        Ok((scenario, raw))
    }

    pub fn validate(&self) -> Result<(), Failure> {
        let invalid = |detail: String| {
            Failure::new(
                "validate",
                FailureCode::ScenarioInvalid,
                detail,
                "fix the scenario file against packages/qaren-cli/README.md",
            )
        };
        if self.schema != SCENARIO_SCHEMA {
            return Err(Failure::new(
                "validate",
                FailureCode::ScenarioSchemaUnsupported,
                format!("scenario schema {:?} is not {SCENARIO_SCHEMA}", self.schema),
                "use a scenario with schema qaren/1",
            ));
        }
        if self.name.is_empty()
            || !self
                .name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(invalid(format!(
                "scenario name {:?} must be non-empty [a-z0-9-]",
                self.name
            )));
        }
        match (&self.metro, self.build.owner) {
            (Some(metro), _) if metro.port < 1024 => {
                return Err(invalid(format!(
                    "metro.port {} must be >= 1024",
                    metro.port
                )));
            }
            (None, BuildOwner::Cli) => {
                return Err(invalid(
                    "a `metro:` section is required when qaren owns the build".into(),
                ));
            }
            (Some(_), BuildOwner::Qaren) => {
                return Err(invalid(
                    "build.owner qaren must not carry a `metro:` section: the qaren session allocates and owns its own Metro port".into(),
                ));
            }
            _ => {}
        }
        if self.build.owner == BuildOwner::Qaren && self.build.strategy != BuildStrategy::Auto {
            return Err(invalid(
                "build.strategy names qaren's own build path and must stay `auto` when build.owner is qaren".into(),
            ));
        }
        if self.build.owner == BuildOwner::Qaren && self.candidate.dev_client_scheme.is_some() {
            // The scheme only drives qaren's own cached-reuse deep link; in
            // handoff mode it would promise a launch path qaren does not own.
            return Err(invalid(
                "candidate.dev_client_scheme drives qaren's cached-reuse launch and must be absent when build.owner is qaren".into(),
            ));
        }
        let root = Path::new(&self.candidate.project_root);
        // "." selects a project living at the worktree root itself.
        let root_is_plain = self.candidate.project_root == "."
            || (!self.candidate.project_root.is_empty()
                && !root.is_absolute()
                && root
                    .components()
                    .all(|c| matches!(c, std::path::Component::Normal(_))));
        if !root_is_plain {
            return Err(invalid(
                "candidate.project_root must be `.` or a repo-relative path without `..` or leading `/`"
                    .into(),
            ));
        }
        let app_id = &self.candidate.app_id;
        let app_id_ok = !app_id.starts_with('-')
            && app_id.split('.').all(|segment| {
                !segment.is_empty()
                    && segment
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
            });
        if !app_id_ok {
            return Err(invalid(format!(
                "candidate.app_id {app_id:?} must be dot-separated segments of [A-Za-z0-9_-], not starting with -"
            )));
        }
        let rev = &self.candidate.revision;
        if rev != "HEAD" && !(rev.len() == 40 && rev.chars().all(|c| c.is_ascii_hexdigit())) {
            return Err(invalid(format!(
                "candidate.revision {rev:?} must be \"HEAD\" or a 40-char commit sha"
            )));
        }
        if let Some(worktree) = &self.candidate.worktree {
            let path = Path::new(worktree);
            let plain = path.is_absolute()
                && path.components().all(|c| {
                    matches!(
                        c,
                        std::path::Component::RootDir | std::path::Component::Normal(_)
                    )
                })
                && path
                    .components()
                    .any(|c| matches!(c, std::path::Component::Normal(_)));
            if !plain {
                return Err(invalid(format!(
                    "candidate.worktree {worktree:?} must be an absolute path below the filesystem root without `.` or `..` components"
                )));
            }
        }
        if let Some(scheme) = &self.candidate.dev_client_scheme {
            if !is_uri_scheme(scheme) {
                return Err(invalid(
                    "candidate.dev_client_scheme must be a URI scheme ([A-Za-z][A-Za-z0-9+.-]*)"
                        .into(),
                ));
            }
        }
        for (field, value) in [
            (
                "deadlines.install_deps_seconds",
                self.deadlines.install_deps_seconds,
            ),
            ("deadlines.build_seconds", self.deadlines.build_seconds),
            (
                "deadlines.device_boot_seconds",
                self.deadlines.device_boot_seconds,
            ),
        ] {
            if !(30..=7200).contains(&value) {
                return Err(invalid(format!(
                    "{field} = {value} must be within 30..=7200 seconds"
                )));
            }
        }
        match self.platform {
            Platform::Ios => {
                let ios = self
                    .ios
                    .as_ref()
                    .ok_or_else(|| invalid("platform ios requires an `ios:` section".into()))?;
                if self.android.is_some() || self.android_usb.is_some() {
                    return Err(invalid(
                        "platform ios must not carry an `android:` or `android_usb:` section"
                            .into(),
                    ));
                }
                for (field, value) in [
                    ("ios.device_type", &ios.device_type),
                    ("ios.runtime", &ios.runtime),
                ] {
                    let ok = !value.is_empty()
                        && !value.starts_with('-')
                        && value
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
                    if !ok {
                        return Err(invalid(format!(
                            "{field} {value:?} must be a CoreSimulator identifier ([A-Za-z0-9.-], not starting with -)"
                        )));
                    }
                }
            }
            Platform::Android => {
                if self.ios.is_some() {
                    return Err(invalid(
                        "platform android must not carry an `ios:` section".into(),
                    ));
                }
                let android = match (&self.android, &self.android_usb) {
                    (Some(android), None) => {
                        // The farm emulator is only reachable through qaren's
                        // run-scoped vendor-key adb server, which the
                        // qaren session cannot use.
                        if self.build.owner == BuildOwner::Qaren {
                            return Err(invalid(
                                "build.owner qaren does not support the `android:` farm adapter (the leased emulator is only reachable through qaren's run-scoped vendor-key adb server); use `android_usb:` or platform ios".into(),
                            ));
                        }
                        android
                    }
                    (None, Some(usb)) => {
                        return self.validate_android_usb(usb);
                    }
                    (Some(_), Some(_)) => {
                        return Err(invalid(
                            "platform android must carry exactly one of `android:` (farm) or `android_usb:`; both is ambiguous".into(),
                        ));
                    }
                    (None, None) => {
                        return Err(invalid(
                            "platform android requires an `android:` (farm) or `android_usb:` section".into(),
                        ));
                    }
                };
                let host_ok = !android.ssh_host.is_empty()
                    && !android.ssh_host.starts_with('-')
                    && android
                        .ssh_host
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
                if !host_ok {
                    return Err(invalid(format!(
                        "android.ssh_host {:?} must be a plain host alias ([A-Za-z0-9._-], not starting with -)",
                        android.ssh_host
                    )));
                }
                let farm_ok = !android.farm_path.is_empty()
                    && !android.farm_path.starts_with('/')
                    && !android.farm_path.starts_with('-')
                    && !android.farm_path.contains("..")
                    && android.farm_path.chars().all(|c| {
                        c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' || c == '/'
                    });
                if !farm_ok {
                    return Err(invalid(
                        "android.farm_path must be a $HOME-relative path like bin/android-farm ([A-Za-z0-9._/-])".into(),
                    ));
                }
                if android.slot == 0 {
                    return Err(invalid("android.slot must be >= 1".into()));
                }
                if android.adb_server_port < 1024 {
                    return Err(invalid(format!(
                        "android.adb_server_port {} must be >= 1024",
                        android.adb_server_port
                    )));
                }
                if Some(android.adb_server_port) == self.metro.as_ref().map(|m| m.port) {
                    return Err(invalid(
                        "android.adb_server_port must differ from metro.port".into(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn validate_android_usb(&self, usb: &AndroidUsbSpec) -> Result<(), Failure> {
        let invalid = |detail: String| {
            Failure::new(
                "validate",
                FailureCode::ScenarioInvalid,
                detail,
                "fix the scenario file against packages/qaren-cli/README.md",
            )
        };
        let serial = &usb.serial;
        let serial_ok = !serial.is_empty()
            && !serial.starts_with('-')
            && serial
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
        if !serial_ok {
            return Err(invalid(format!(
                "android_usb.serial {serial:?} must be a plain USB device serial ([A-Za-z0-9._-], not starting with -)"
            )));
        }
        // Emulator and loopback-tunnel serial forms belong to the farm path;
        // accepting them here would blur the two exclusive allocation paths.
        if serial.starts_with("emulator-") || serial.contains(':') {
            return Err(invalid(format!(
                "android_usb.serial {serial:?} must name a physical USB device, not an emulator or loopback endpoint"
            )));
        }
        match (usb.adb_server_port, self.build.owner) {
            (None, BuildOwner::Cli) => {
                return Err(invalid(
                    "android_usb.adb_server_port is required when qaren owns the build".into(),
                ));
            }
            (Some(_), BuildOwner::Qaren) => {
                // In handoff mode qaren never starts an adb server; a pinned
                // port would falsely promise an qaren-owned adb lifecycle.
                return Err(invalid(
                    "build.owner qaren must not carry android_usb.adb_server_port: the qaren session owns the adb lifecycle".into(),
                ));
            }
            (Some(port), BuildOwner::Cli) => {
                if port < 1024 {
                    return Err(invalid(format!(
                        "android_usb.adb_server_port {port} must be >= 1024"
                    )));
                }
                if Some(port) == self.metro.as_ref().map(|m| m.port) {
                    return Err(invalid(
                        "android_usb.adb_server_port must differ from metro.port".into(),
                    ));
                }
            }
            (None, BuildOwner::Qaren) => {}
        }
        Ok(())
    }
}
