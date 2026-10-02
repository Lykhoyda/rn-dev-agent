use serde::Serialize;
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionEntry {
    pub slug: String,
    pub platform: Option<String>,
    pub plan_hash: Option<String>,
    pub status: Option<String>,
}

// The `# key: value` comment block above an action's commands, read like the core's M7 header.
pub fn header(text: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    let mut in_comment = false;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix('#') {
            in_comment = true;
            let rest = rest.strip_prefix(' ').unwrap_or(rest).trim();
            if let Some((key, value)) = rest.split_once(':') {
                let key = key.trim();
                let valid = key.starts_with(|c: char| c.is_ascii_alphabetic())
                    && key
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
                if valid && !value.trim().is_empty() {
                    fields.insert(key.to_string(), value.trim().to_string());
                }
            }
        } else if in_comment && (!line.trim().is_empty() || !fields.is_empty()) {
            break;
        }
    }
    fields
}

fn actions_dir(app_root: &Path) -> Result<PathBuf, String> {
    let qaren = app_root.join(".qaren");
    let dir = qaren.join("actions");
    for path in [&qaren, &dir] {
        if std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink()) {
            return Err(format!(
                "refusing the symlinked action corpus at {}",
                path.display()
            ));
        }
    }
    Ok(dir)
}

// Opens without following a symlink at the file and checks the opened descriptor is a regular file.
fn read_action(path: &Path) -> Result<String, String> {
    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    if !file.metadata().is_ok_and(|meta| meta.is_file()) {
        return Err(format!("{} is not a regular file", path.display()));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    Ok(text)
}

fn action_path(dir: &Path, slug: &str) -> Result<PathBuf, String> {
    let mut found = None;
    for extension in ["yaml", "yml"] {
        let path = dir.join(format!("{slug}.{extension}"));
        match std::fs::symlink_metadata(&path) {
            Ok(_) => {
                if found.is_some() {
                    return Err(format!(
                        "action {slug} is ambiguous because both {slug}.yaml and {slug}.yml exist; keep exactly one file before replay"
                    ));
                }
                found = Some(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("cannot inspect {}: {e}", path.display())),
        }
    }
    found.ok_or_else(|| format!("no saved action named {slug}"))
}

pub fn list(app_root: &Path) -> Result<Vec<ActionEntry>, String> {
    let dir = actions_dir(app_root)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("cannot read {}: {e}", dir.display())),
    };
    let mut actions = Vec::new();
    for entry in entries {
        let path = entry
            .map_err(|e| format!("cannot read {}: {e}", dir.display()))?
            .path();
        let slug = match (path.file_stem(), path.extension()) {
            (Some(stem), Some(ext)) if ext == "yaml" || ext == "yml" => {
                stem.to_string_lossy().into_owned()
            }
            _ => continue,
        };
        let mut fields = header(&read_action(&action_path(&dir, &slug)?)?);
        if !fields.contains_key("id") {
            continue;
        }
        actions.push(ActionEntry {
            slug,
            platform: fields.remove("platform"),
            plan_hash: fields.remove("planHash"),
            status: fields.remove("status"),
        });
    }
    actions.sort_by(|a, b| a.slug.cmp(&b.slug));
    Ok(actions)
}

pub fn show(app_root: &Path, slug: &str) -> Result<String, String> {
    let valid = !slug.is_empty()
        && slug.len() <= 128
        && !slug.starts_with('.')
        && slug
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
        && !slug.contains("..");
    if !valid {
        return Err(format!("{slug:?} is not an action slug"));
    }
    let path = action_path(&actions_dir(app_root)?, slug)?;
    read_action(&path)
}

pub fn render(actions: &[ActionEntry]) -> String {
    let cell = |value: &Option<String>| value.clone().unwrap_or_else(|| "-".to_string());
    actions
        .iter()
        .map(|a| {
            format!(
                "{}\t{}\t{}\t{}\n",
                a.slug,
                cell(&a.platform),
                cell(&a.plan_hash),
                cell(&a.status)
            )
        })
        .collect()
}
