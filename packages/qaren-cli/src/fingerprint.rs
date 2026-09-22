use crate::candidate::sha256_hex;
use crate::exec::{CmdSpec, Runner};
use crate::failure::{Failure, FailureCode};
use std::collections::BTreeSet;
use std::path::Path;

pub const FINGERPRINT_VERSION: &str = "rnfp1";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeFingerprint {
    pub value: String,
    pub file_count: usize,
    pub native_dir_in_candidate: bool,
    // Reuse of a cached binary is only legal when the input set is provably
    // complete; a dynamic app.config.* can import arbitrary modules that this
    // manifest cannot enumerate.
    pub complete: bool,
    pub incompleteness: Vec<String>,
}

// Native inputs are the files git considers part of the candidate (tracked or
// untracked-but-not-ignored); generated dirs like a CNG ios/ are ignored by
// git and therefore excluded — they are build outputs, not inputs.
fn is_native_input(rel: &str, platform_dir: &str) -> bool {
    match rel {
        "package.json"
        | "pnpm-lock.yaml"
        | "app.json"
        | "eas.json"
        | "app.config.js"
        | "app.config.ts"
        | "app.config.mjs"
        | "app.config.cjs"
        | "react-native.config.js"
        | "react-native.config.ts" => return true,
        _ => {}
    }
    if rel.starts_with("plugins/") || rel.starts_with("assets/") || rel.starts_with("patches/") {
        return true;
    }
    if let Some(inside) = rel.strip_prefix(&format!("{platform_dir}/")) {
        let excluded = match platform_dir {
            "ios" => {
                inside.starts_with("build/")
                    || inside.starts_with("Pods/")
                    || inside.starts_with("DerivedData/")
            }
            "android" => {
                inside.starts_with("build/")
                    || inside.starts_with("app/build/")
                    || inside.starts_with(".gradle/")
                    || inside.starts_with(".cxx/")
                    || inside == "local.properties"
            }
            _ => false,
        };
        return !excluded;
    }
    false
}

fn is_dynamic_config(rel: &str) -> bool {
    matches!(
        rel,
        "app.config.js" | "app.config.ts" | "app.config.mjs" | "app.config.cjs"
    )
}

#[derive(Debug, Default)]
struct ReferencedInputs {
    files: BTreeSet<String>,
    incompleteness: Vec<String>,
}

// Static app.json can reference native inputs by relative path (icons, splash
// images, googleServicesFile, local config plugins, ...); every resolvable
// referenced file joins the manifest so an asset change invalidates reuse.
// An explicit local ref that cannot be resolved leaves the set unprovably
// complete, as does an app.json that does not parse.
fn referenced_paths(app_json: &str, project_root: &Path) -> ReferencedInputs {
    let mut out = ReferencedInputs::default();
    let parsed = match serde_json::from_str::<serde_json::Value>(app_json) {
        Ok(parsed) => parsed,
        Err(e) => {
            out.incompleteness.push(format!(
                "app.json does not parse as JSON ({e}); referenced native assets cannot be enumerated"
            ));
            return out;
        }
    };
    collect_strings(&parsed, &mut |s| {
        let explicit_local = s.starts_with("./") || s.starts_with("../");
        let candidate = s.strip_prefix("./").unwrap_or(s);
        if candidate.is_empty() || candidate.starts_with('/') || candidate.contains("..") {
            if explicit_local {
                out.incompleteness.push(format!(
                    "local reference {s:?} in app.json is not a plain relative path"
                ));
            }
            return;
        }
        // Approximate Node resolution for extensionless local module refs.
        let attempts = [
            candidate.to_string(),
            format!("{candidate}.js"),
            format!("{candidate}.ts"),
            format!("{candidate}.mjs"),
            format!("{candidate}.cjs"),
            format!("{candidate}.json"),
            format!("{candidate}/index.js"),
            format!("{candidate}/index.ts"),
        ];
        for attempt in &attempts {
            let path = project_root.join(attempt);
            if path.is_file() || path.is_symlink() {
                out.files.insert(attempt.clone());
                return;
            }
        }
        if explicit_local {
            out.incompleteness.push(format!(
                "local reference {s:?} in app.json does not resolve to a file; the input set is unprovably complete"
            ));
        }
    });
    out
}

fn is_executable_module(rel: &str) -> bool {
    rel.ends_with(".js") || rel.ends_with(".ts") || rel.ends_with(".mjs") || rel.ends_with(".cjs")
}

fn import_specifiers(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for marker in [
        "from \"",
        "from '",
        "require(\"",
        "require('",
        "import(\"",
        "import('",
        "import \"",
        "import '",
    ] {
        let quote = marker.chars().last().expect("marker ends with a quote");
        let mut rest = source;
        while let Some(idx) = rest.find(marker) {
            let after = &rest[idx + marker.len()..];
            match after.find(quote) {
                Some(end) => {
                    out.push(after[..end].to_string());
                    rest = &after[end..];
                }
                None => break,
            }
        }
    }
    out
}

fn normalize_rel(base_dir: &str, specifier: &str) -> Option<String> {
    let joined = if base_dir.is_empty() {
        specifier.to_string()
    } else {
        format!("{base_dir}/{specifier}")
    };
    let mut parts: Vec<&str> = Vec::new();
    for part in joined.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    Some(parts.join("/"))
}

// A local config plugin can import native configuration from other project
// modules; the deterministic closure over relative import specifiers keeps
// those inputs in the manifest. A relative import that cannot be resolved
// leaves the set unprovably complete.
fn trace_local_imports(
    project_root: &Path,
    seeds: Vec<String>,
    inputs: &mut BTreeSet<String>,
    incompleteness: &mut Vec<String>,
) {
    let mut worklist = seeds;
    let mut visited: BTreeSet<String> = BTreeSet::new();
    while let Some(rel) = worklist.pop() {
        if !visited.insert(rel.clone()) {
            continue;
        }
        let Ok(source) = std::fs::read_to_string(project_root.join(&rel)) else {
            incompleteness.push(format!(
                "local module {rel} could not be read; its imports cannot be enumerated"
            ));
            continue;
        };
        let base_dir = rel.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
        for specifier in import_specifiers(&source) {
            if !specifier.starts_with('.') {
                continue;
            }
            let Some(normalized) = normalize_rel(base_dir, &specifier) else {
                incompleteness.push(format!(
                    "import {specifier:?} in {rel} escapes the project root"
                ));
                continue;
            };
            let attempts = [
                normalized.clone(),
                format!("{normalized}.js"),
                format!("{normalized}.ts"),
                format!("{normalized}.mjs"),
                format!("{normalized}.cjs"),
                format!("{normalized}.json"),
                format!("{normalized}/index.js"),
                format!("{normalized}/index.ts"),
            ];
            let resolved = attempts.iter().find(|attempt| {
                let path = project_root.join(attempt);
                path.is_file() || path.is_symlink()
            });
            match resolved {
                Some(found) => {
                    inputs.insert(found.clone());
                    if is_executable_module(found) {
                        worklist.push(found.clone());
                    }
                }
                None => incompleteness.push(format!(
                    "import {specifier:?} in {rel} does not resolve to a project file; the input set is unprovably complete"
                )),
            }
        }
    }
}

// A local dependency (file:/link:) can autolink native code into the app;
// when it carries a native surface, that surface is hashed into its own
// manifest entries so edits to it invalidate reuse. Unresolvable or
// workspace:-resolved local deps leave the set unprovably complete.
fn local_dependency_manifest(
    project_root: &Path,
    repo_root: &Path,
    package_json: &str,
    manifest: &mut Vec<(String, String)>,
    incompleteness: &mut Vec<String>,
) {
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(package_json) else {
        incompleteness.push(
            "package.json does not parse as JSON; local dependencies cannot be enumerated"
                .to_string(),
        );
        return;
    };
    let mut locals: Vec<(String, String)> = Vec::new();
    for section in ["dependencies", "devDependencies"] {
        let Some(deps) = parsed.get(section).and_then(|d| d.as_object()) else {
            continue;
        };
        for (name, spec) in deps {
            let Some(spec) = spec.as_str() else { continue };
            if let Some(rel) = spec
                .strip_prefix("file:")
                .or_else(|| spec.strip_prefix("link:"))
            {
                locals.push((name.clone(), rel.to_string()));
            } else if spec.starts_with("workspace:") {
                incompleteness.push(format!(
                    "dependency {name} uses a workspace: specifier that qaren does not resolve; the input set is unprovably complete"
                ));
            }
        }
    }
    for (name, rel) in locals {
        let dep_dir = project_root.join(&rel);
        let (Ok(resolved), Ok(root)) = (dep_dir.canonicalize(), repo_root.canonicalize()) else {
            incompleteness.push(format!(
                "local dependency {name} ({rel}) cannot be resolved; the input set is unprovably complete"
            ));
            continue;
        };
        if !resolved.starts_with(&root) {
            incompleteness.push(format!(
                "local dependency {name} ({rel}) resolves outside the worktree; its native surface cannot be bound"
            ));
            continue;
        }
        let has_native_surface = resolved.join("ios").is_dir()
            || resolved.join("android").is_dir()
            || resolved.join("expo-module.config.json").is_file()
            || std::fs::read_dir(&resolved).is_ok_and(|entries| {
                entries
                    .flatten()
                    .any(|e| e.file_name().to_string_lossy().ends_with(".podspec"))
            });
        if !has_native_surface {
            continue;
        }
        let mut files = Vec::new();
        collect_dep_surface(&resolved, &resolved, &mut files);
        files.sort();
        for file_rel in files {
            let path = resolved.join(&file_rel);
            match hash_entry(
                &path,
                &format!("dep:{name}/{file_rel}"),
                repo_root,
                incompleteness,
            ) {
                Ok(hash) => manifest.push((format!("dep:{name}/{file_rel}"), hash)),
                Err(detail) => incompleteness.push(format!(
                    "native surface of local dependency {name} could not be proven: {detail}"
                )),
            }
        }
    }
}

fn collect_dep_surface(base: &Path, dir: &Path, files: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        let rel_ok = path.strip_prefix(base).is_ok();
        if !rel_ok {
            continue;
        }
        let is_dir = path.is_dir() && !path.is_symlink();
        let rel = path
            .strip_prefix(base)
            .expect("checked above")
            .to_string_lossy()
            .into_owned();
        let top = rel.split('/').next().unwrap_or("");
        let excluded = matches!(name.as_str(), "node_modules" | ".git" | "build")
            || (top == "android" && (rel.contains("/.gradle") || rel.contains("/build")))
            || (top == "ios" && (rel.contains("/Pods") || rel.contains("/build")));
        if excluded {
            continue;
        }
        if is_dir {
            let relevant_root = matches!(top, "ios" | "android")
                || name == "expo-module.config.json"
                || top.is_empty();
            let nested = rel.contains('/');
            if relevant_root || nested || matches!(name.as_str(), "ios" | "android") {
                collect_dep_surface(base, &path, files);
            }
            continue;
        }
        let relevant = rel == "package.json"
            || rel == "expo-module.config.json"
            || name.ends_with(".podspec")
            || top == "ios"
            || top == "android";
        if relevant {
            files.push(rel);
        }
    }
}

// A regular file reached through a symlinked ancestor can resolve outside the
// worktree; its content is still hashed, but the escape is flagged so reuse
// is refused rather than bound to foreign state.
fn contained_or_flag(path: &Path, rel: &str, repo_root: &Path, incompleteness: &mut Vec<String>) {
    if path.is_symlink() {
        return;
    }
    let (Ok(resolved), Ok(root)) = (path.canonicalize(), repo_root.canonicalize()) else {
        return;
    };
    if !resolved.starts_with(&root) {
        incompleteness.push(format!(
            "native input {rel} resolves outside the worktree ({}); its content cannot be bound",
            resolved.display()
        ));
    }
}

fn collect_strings(value: &serde_json::Value, visit: &mut impl FnMut(&str)) {
    match value {
        serde_json::Value::String(s) => visit(s),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_strings(item, visit);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_strings(item, visit);
            }
        }
        _ => {}
    }
}

// A symlink hashes its link text plus, when the target resolves to a regular
// file inside the authorized worktree, the target content — so an unchanged
// link to changed content still invalidates reuse. A target outside the
// worktree (or an unenumerable directory target) leaves the input set
// unprovably complete instead of coupling the fingerprint to foreign state.
fn hash_entry(
    path: &Path,
    rel: &str,
    repo_root: &Path,
    incompleteness: &mut Vec<String>,
) -> Result<String, String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|e| format!("cannot stat {}: {e}", path.display()))?;
    if meta.file_type().is_symlink() {
        let target = std::fs::read_link(path)
            .map_err(|e| format!("cannot read symlink {}: {e}", path.display()))?;
        let link_hash = format!("symlink:{}", target.display());
        let resolved = path.canonicalize().ok();
        let inside = resolved.as_ref().is_some_and(|r| {
            repo_root
                .canonicalize()
                .map(|root| r.starts_with(root))
                .unwrap_or(false)
        });
        return match resolved {
            None => {
                incompleteness.push(format!(
                    "native input {rel} is a broken or unresolvable symlink; its target cannot be bound"
                ));
                Ok(sha256_hex(link_hash.as_bytes()))
            }
            Some(resolved) if inside && resolved.is_file() => {
                let content = std::fs::read(&resolved)
                    .map_err(|e| format!("cannot read symlink target of {rel}: {e}"))?;
                Ok(sha256_hex(
                    format!("{link_hash}\0{}", sha256_hex(&content)).as_bytes(),
                ))
            }
            Some(_) => {
                incompleteness.push(format!(
                    "native input {rel} is a symlink whose target is outside the worktree or not a plain file; its content cannot be bound"
                ));
                Ok(sha256_hex(link_hash.as_bytes()))
            }
        };
    }
    match std::fs::read(path) {
        Ok(bytes) => Ok(sha256_hex(&bytes)),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

pub fn compute(
    runner: &mut dyn Runner,
    repo_root: &Path,
    project_root: &Path,
    platform_dir: &str,
) -> Result<NativeFingerprint, Failure> {
    let Ok(project_rel_path) = project_root.strip_prefix(repo_root) else {
        return Err(Failure::new(
            "plan",
            FailureCode::CandidatePathInvalid,
            format!(
                "{} is not contained in {}; refusing to fingerprint outside the candidate worktree",
                project_root.display(),
                repo_root.display()
            ),
            "fix candidate.project_root / candidate.worktree in the scenario",
        ));
    };
    let project_rel = project_rel_path.to_string_lossy().into_owned();
    let pathspec = if project_rel.is_empty() {
        ".".to_string()
    } else {
        project_rel.clone()
    };
    let listed = runner.run(&CmdSpec::new(
        "git-ls-files",
        "git",
        &[
            "-C",
            &repo_root.to_string_lossy(),
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
            "--",
            &pathspec,
        ],
        60,
    ));
    if !listed.ok() {
        return Err(Failure::new(
            "plan",
            FailureCode::CandidateGitUnavailable,
            format!(
                "git ls-files for the native fingerprint failed: {}",
                listed.summary()
            ),
            "ensure git can inspect the candidate worktree, then re-run prepare",
        ));
    }
    let prefix = if project_rel.is_empty() {
        String::new()
    } else {
        format!("{project_rel}/")
    };
    let mut inputs: BTreeSet<String> = BTreeSet::new();
    let mut dynamic_config = None;
    for entry in listed.stdout.split('\0') {
        if entry.is_empty() {
            continue;
        }
        let Some(rel) = entry.strip_prefix(&prefix) else {
            continue;
        };
        if is_native_input(rel, platform_dir) {
            if is_dynamic_config(rel) {
                dynamic_config = Some(rel.to_string());
            }
            inputs.insert(rel.to_string());
        }
    }
    let mut incompleteness = Vec::new();
    let mut dep_manifest: Vec<(String, String)> = Vec::new();
    if let Some(config) = dynamic_config {
        incompleteness.push(format!(
            "{config} is a dynamic config whose imports cannot be enumerated; the input set is unprovably complete"
        ));
    }
    if inputs.contains("app.json") {
        match std::fs::read_to_string(project_root.join("app.json")) {
            Ok(app_json) => {
                let referenced = referenced_paths(&app_json, project_root);
                incompleteness.extend(referenced.incompleteness);
                let executable_seeds: Vec<String> = referenced
                    .files
                    .iter()
                    .filter(|rel| is_executable_module(rel))
                    .cloned()
                    .collect();
                inputs.extend(referenced.files);
                trace_local_imports(
                    project_root,
                    executable_seeds,
                    &mut inputs,
                    &mut incompleteness,
                );
            }
            Err(e) => {
                incompleteness.push(format!(
                    "app.json is listed but could not be read ({e}); referenced native assets cannot be enumerated"
                ));
            }
        }
    }
    if inputs.contains("package.json") {
        match std::fs::read_to_string(project_root.join("package.json")) {
            Ok(package_json) => local_dependency_manifest(
                project_root,
                repo_root,
                &package_json,
                &mut dep_manifest,
                &mut incompleteness,
            ),
            Err(e) => incompleteness.push(format!(
                "package.json is listed but could not be read ({e}); local dependencies cannot be enumerated"
            )),
        }
    }
    let native_dir_in_candidate = inputs
        .iter()
        .any(|rel| rel.starts_with(&format!("{platform_dir}/")));
    let mut entries: Vec<(String, String)> = Vec::new();
    for rel in &inputs {
        // A listed-but-deleted file still shapes the fingerprint: its absence
        // must differ from a manifest that never contained it. Any other read
        // error leaves the input unproven and must refuse, not guess.
        let path = project_root.join(rel);
        let entry = if !path.is_symlink() && !path.exists() {
            "absent".to_string()
        } else {
            contained_or_flag(&path, rel, repo_root, &mut incompleteness);
            hash_entry(&path, rel, repo_root, &mut incompleteness).map_err(|detail| {
                Failure::new(
                    "plan",
                    FailureCode::NativeInputUnreadable,
                    format!("native input {rel} could not be proven: {detail}"),
                    "make the file readable (or remove it from the candidate), then re-run prepare",
                )
            })?
        };
        entries.push((rel.clone(), entry));
    }
    entries.extend(dep_manifest);
    entries.sort();
    let mut manifest = String::new();
    for (key, hash) in &entries {
        manifest.push_str(key);
        manifest.push('\0');
        manifest.push_str(hash);
        manifest.push('\n');
    }
    let file_count = entries.len();
    Ok(NativeFingerprint {
        value: format!("{FINGERPRINT_VERSION}:{}", sha256_hex(manifest.as_bytes())),
        file_count,
        native_dir_in_candidate,
        complete: incompleteness.is_empty(),
        incompleteness,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_level_files_are_native_inputs() {
        for rel in [
            "package.json",
            "pnpm-lock.yaml",
            "app.json",
            "app.config.ts",
            "plugins/withThing.ts",
            "assets/icon.png",
        ] {
            assert!(
                is_native_input(rel, "ios"),
                "{rel} should be a native input"
            );
        }
    }

    #[test]
    fn js_sources_are_not_native_inputs() {
        for rel in [
            "App.tsx",
            "src/screens/Home.tsx",
            "babel.config.js",
            "index.js",
        ] {
            assert!(
                !is_native_input(rel, "ios"),
                "{rel} must not be a native input"
            );
        }
    }

    #[test]
    fn platform_dir_included_but_outputs_excluded() {
        assert!(is_native_input("ios/Podfile", "ios"));
        assert!(is_native_input("ios/testapp/Info.plist", "ios"));
        assert!(!is_native_input("ios/build/Build/x.o", "ios"));
        assert!(!is_native_input("ios/Pods/Pods.xcodeproj/x", "ios"));
        assert!(is_native_input(
            "android/app/src/main/AndroidManifest.xml",
            "android"
        ));
        assert!(!is_native_input(
            "android/app/build/outputs/apk/app.apk",
            "android"
        ));
        assert!(!is_native_input("android/.gradle/caches/x", "android"));
        assert!(!is_native_input("android/local.properties", "android"));
    }

    #[test]
    fn other_platform_dir_is_not_an_input() {
        assert!(!is_native_input("android/build.gradle", "ios"));
        assert!(!is_native_input("ios/Podfile", "android"));
    }

    #[test]
    fn referenced_paths_resolve_only_plain_existing_files() {
        let dir = std::env::temp_dir().join(format!("qaren-fp-ref-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets2")).unwrap();
        std::fs::write(dir.join("assets2").join("icon.png"), b"png").unwrap();
        let app_json = r#"{"expo":{"icon":"./assets2/icon.png","name":"x","other":"/etc/passwd","up":"../secret.png","missing":"./assets2/nope.png"}}"#;
        let refs = referenced_paths(app_json, &dir);
        assert_eq!(
            refs.files.into_iter().collect::<Vec<_>>(),
            vec!["assets2/icon.png".to_string()]
        );
        // `../secret.png` and the unresolvable `./assets2/nope.png` both leave
        // the set unprovably complete; the bare-absolute string is ignored.
        assert_eq!(refs.incompleteness.len(), 2);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unparseable_app_json_is_incomplete() {
        let refs = referenced_paths("not json", Path::new("/nonexistent"));
        assert!(refs.files.is_empty());
        assert_eq!(refs.incompleteness.len(), 1);
    }

    #[test]
    fn import_specifiers_finds_static_and_dynamic_forms() {
        let source = r#"
            import { withX } from './helper';
            const y = require("../lib/y");
            const z = await import('./z.json');
            import pkg from 'expo-build-properties';
        "#;
        let specs = import_specifiers(source);
        assert!(specs.contains(&"./helper".to_string()));
        assert!(specs.contains(&"../lib/y".to_string()));
        assert!(specs.contains(&"./z.json".to_string()));
        assert!(specs.contains(&"expo-build-properties".to_string()));
    }

    #[test]
    fn trace_local_imports_walks_relative_closure_and_flags_unresolved() {
        let dir = std::env::temp_dir().join(format!("qaren-fp-trace-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("plugins")).unwrap();
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::write(
            dir.join("plugins").join("withThing.ts"),
            "import { helper } from '../lib/helper';\nimport missing from './gone';\n",
        )
        .unwrap();
        std::fs::write(
            dir.join("lib").join("helper.ts"),
            "export const helper = 1;\n",
        )
        .unwrap();
        let mut inputs = BTreeSet::new();
        let mut incompleteness = Vec::new();
        trace_local_imports(
            &dir,
            vec!["plugins/withThing.ts".to_string()],
            &mut inputs,
            &mut incompleteness,
        );
        assert!(inputs.contains("lib/helper.ts"));
        assert_eq!(incompleteness.len(), 1, "{incompleteness:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn normalize_rel_refuses_escape() {
        assert_eq!(
            normalize_rel("plugins", "./x"),
            Some("plugins/x".to_string())
        );
        assert_eq!(
            normalize_rel("plugins", "../lib/y"),
            Some("lib/y".to_string())
        );
        assert_eq!(normalize_rel("", "../outside"), None);
    }
}
