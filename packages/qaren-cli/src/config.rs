use crate::failure::{Failure, FailureCode};
use crate::scenario::{require_launch_scheme, Platform};
use serde::Deserialize;
use std::path::Path;

pub const DEFAULT_CONFIG_PATH: &str = ".qaren/config.yaml";
pub const DEFAULT_METRO_PORT: u16 = 8791;

// `.qaren/config.yaml` in the app root. Flags override what they name.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct CheckConfig {
    pub app_id: String,
    #[serde(default = "d_package_manager")]
    pub package_manager: String,
    #[serde(default = "d_metro_port")]
    pub metro_port: u16,
    #[serde(default)]
    pub ios: Option<IosConfig>,
    #[serde(default)]
    pub android: Option<AndroidConfig>,
    #[serde(default)]
    pub node_path: Option<String>,
    #[serde(default)]
    pub dev_client_scheme: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct IosConfig {
    #[serde(default)]
    pub device_type: Option<String>,
    #[serde(default)]
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AndroidConfig {
    #[serde(default)]
    pub avd: Option<String>,
}

fn d_package_manager() -> String {
    "pnpm".to_string()
}

fn d_metro_port() -> u16 {
    DEFAULT_METRO_PORT
}

impl CheckConfig {
    pub fn validate_for_platform(&self, platform: Platform) -> Result<(), Failure> {
        if platform == Platform::Ios {
            require_launch_scheme(self.dev_client_scheme.as_deref())?;
        }
        Ok(())
    }

    // Returns the bytes it parsed so the run record hashes exactly that configuration.
    pub fn load(path: &Path) -> Result<(CheckConfig, String), Failure> {
        let raw = std::fs::read_to_string(path).map_err(|e| {
            Failure::new(
                "config",
                FailureCode::ScenarioUnreadable,
                format!("cannot read {}: {e}", path.display()),
                "create .qaren/config.yaml with at least `appId: <bundle id>`",
            )
        })?;
        let config: CheckConfig = serde_yaml::from_str(&raw).map_err(|e| {
            Failure::new(
                "config",
                FailureCode::ScenarioInvalid,
                format!("{} does not parse: {e}", path.display()),
                "fix .qaren/config.yaml (keys: appId, packageManager, metroPort, ios, android, nodePath, devClientScheme)",
            )
        })?;
        config.validate(path)?;
        Ok((config, raw))
    }

    fn validate(&self, path: &Path) -> Result<(), Failure> {
        let invalid = |detail: String| {
            Failure::new(
                "config",
                FailureCode::ScenarioInvalid,
                format!("{}: {detail}", path.display()),
                "fix .qaren/config.yaml",
            )
        };
        if self.package_manager != "pnpm" {
            return Err(invalid(format!(
                "packageManager {:?} is not supported in this release; only pnpm is",
                self.package_manager
            )));
        }
        if self.metro_port < 1024 {
            return Err(invalid(format!(
                "metroPort {} must be >= 1024",
                self.metro_port
            )));
        }
        if self.app_id.trim().is_empty() {
            return Err(invalid("appId is required".to_string()));
        }
        if let Some(node) = &self.node_path {
            if !Path::new(node).is_absolute() {
                return Err(invalid(format!(
                    "nodePath {node:?} must be an absolute path"
                )));
            }
        }
        Ok(())
    }
}
