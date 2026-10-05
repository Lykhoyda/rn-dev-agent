use qaren::exec::{CmdOutput, MockRunner};
use qaren::fingerprint::{compute, NativeFingerprint, FINGERPRINT_VERSION};
use qaren::scenario::IosWorkspaceBuild;
use std::path::Path;

fn prior_fingerprint() -> NativeFingerprint {
    NativeFingerprint {
        value: "rnfp1:prior-native-inputs".into(),
        file_count: 7,
        native_dir_in_candidate: true,
        complete: true,
        incompleteness: vec![],
    }
}

#[test]
fn no_workspace_preserves_the_entire_existing_fingerprint() {
    let prior = prior_fingerprint();
    assert_eq!(prior.clone().with_ios_workspace(None), prior);
}

#[test]
fn workspace_hash_uses_domain_separated_typed_json_bytes() {
    let prior = prior_fingerprint();
    let spec = IosWorkspaceBuild {
        workspace: "ios/My \"App\".xcworkspace".into(),
        scheme: "App\\Debug".into(),
    };
    let bytes = serde_json::to_vec(&(
        "qaren-ios-workspace-build/1",
        &prior.value,
        &spec.workspace,
        &spec.scheme,
    ))
    .unwrap();
    assert_eq!(
        bytes,
        br#"["qaren-ios-workspace-build/1","rnfp1:prior-native-inputs","ios/My \"App\".xcworkspace","App\\Debug"]"#
    );
    let expected = "rnfp1:58811e70a526e0c38597b23ff566399d78ff387c0ba664bd22185ff98fb3ffc8";
    let actual = prior.clone().with_ios_workspace(Some(&spec));
    assert_eq!(actual.value, expected);
    assert_eq!(actual, prior.with_ios_workspace(Some(&spec)));
}

#[test]
fn workspace_scheme_backend_and_prior_inputs_each_change_the_hash() {
    let prior = prior_fingerprint();
    let spec = IosWorkspaceBuild {
        workspace: "ios/App.xcworkspace".into(),
        scheme: "App".into(),
    };
    let actual = prior.clone().with_ios_workspace(Some(&spec));
    for changed in [
        None,
        Some(IosWorkspaceBuild {
            workspace: "ios/Other.xcworkspace".into(),
            ..spec.clone()
        }),
        Some(IosWorkspaceBuild {
            scheme: "Other".into(),
            ..spec.clone()
        }),
    ] {
        assert_ne!(
            actual.value,
            prior.clone().with_ios_workspace(changed.as_ref()).value
        );
    }
    let changed_prior = NativeFingerprint {
        value: "rnfp1:changed-native-inputs".into(),
        ..prior
    };
    assert_ne!(
        actual.value,
        changed_prior.with_ios_workspace(Some(&spec)).value
    );
    assert_eq!(FINGERPRINT_VERSION, "rnfp1");
    assert!(actual.value.starts_with("rnfp1:"));
}

#[test]
fn workspace_binding_preserves_all_facts_and_cannot_make_incomplete_inputs_complete() {
    let spec = IosWorkspaceBuild {
        workspace: "ios/App.xcworkspace".into(),
        scheme: "App".into(),
    };
    for complete in [false, true] {
        for native_dir_in_candidate in [false, true] {
            let prior = NativeFingerprint {
                complete,
                native_dir_in_candidate,
                incompleteness: if complete {
                    vec![]
                } else {
                    vec![
                        "dynamic config imports".into(),
                        "unresolved local dependency".into(),
                    ]
                },
                ..prior_fingerprint()
            };
            assert_eq!(prior.clone().with_ios_workspace(None), prior);
            let actual = prior.clone().with_ios_workspace(Some(&spec));
            assert_ne!(actual.value, prior.value);
            assert_eq!(
                actual,
                NativeFingerprint {
                    value: actual.value.clone(),
                    ..prior
                }
            );
        }
    }
}

#[test]
fn default_expo_backend_keeps_the_legacy_cache_key() {
    let mut runner = MockRunner::new();
    runner.expect_run("ls-files", CmdOutput::success(""));
    let root = Path::new("/candidate");
    let prior = compute(&mut runner, root, root, "ios").unwrap();
    assert_eq!(
        prior.value,
        "rnfp1:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(prior.clone().with_ios_workspace(None), prior);
}

fn plugin_project(plugin: &str) -> std::path::PathBuf {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let root = std::env::temp_dir().join(format!(
        "qaren-fp-scan-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("plugins")).unwrap();
    std::fs::create_dir_all(root.join("config")).unwrap();
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["./plugins/withX.js"]}}"#,
    )
    .unwrap();
    std::fs::write(root.join("plugins/withX.js"), plugin).unwrap();
    std::fs::write(root.join("config/x.json"), r#"{"a":1}"#).unwrap();
    root
}

fn fingerprint(root: &Path) -> NativeFingerprint {
    let mut runner = MockRunner::new();
    runner.expect_run(
        "ls-files",
        CmdOutput::success("app.json\0plugins/withX.js\0config/x.json\0"),
    );
    compute(&mut runner, root, root, "ios").unwrap()
}

#[test]
fn a_spaced_static_require_is_traced_into_the_fingerprint() {
    let root =
        plugin_project("const x = require( '../config/x.json' );\nmodule.exports = (c) => c;\n");
    let before = fingerprint(&root);
    assert!(before.complete, "{:?}", before.incompleteness);
    std::fs::write(root.join("config/x.json"), r#"{"a":2}"#).unwrap();
    let after = fingerprint(&root);
    assert_ne!(
        before.value, after.value,
        "a traced input change must invalidate reuse"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn an_unparseable_require_or_import_makes_the_fingerprint_incomplete() {
    for plugin in [
        "const name = '../config/x.json';\nconst x = require(name);\n",
        "const x = require(`../config/${'x'}.json`);\n",
        "const x = await import( name );\n",
        "const x = require /* explanation */ ('../config/x.json');",
        "const x = module.require('../config/x.json');",
        r"const x = require('\x2e./config/x.json');",
        r"const x = require('../config/\x78.json');",
        r"import x from '../config/\x78.json';",
        "const x = import /* explanation */ ('../config/x.json');",
    ] {
        let root = plugin_project(plugin);
        let fp = fingerprint(&root);
        assert!(!fp.complete, "{plugin:?} must not claim completeness");
        assert!(
            fp.incompleteness
                .iter()
                .any(|reason| reason.contains("plugins/withX.js")),
            "{:?}",
            fp.incompleteness
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}

#[test]
fn react_native_config_imports_are_traced() {
    for name in ["react-native.config.js", "react-native.config.ts"] {
        let root = plugin_project("module.exports = (c) => c;");
        std::fs::write(
            root.join(name),
            "import x from './config/x.json'; export default x;",
        )
        .unwrap();
        let compute_config = || {
            let mut runner = MockRunner::new();
            runner.expect_run(
                "ls-files",
                CmdOutput::success(&format!("app.json\0{name}\0config/x.json\0")),
            );
            compute(&mut runner, &root, &root, "ios").unwrap()
        };
        let before = compute_config();
        assert!(before.complete, "{:?}", before.incompleteness);
        std::fs::write(root.join("config/x.json"), r#"{"a":2}"#).unwrap();
        assert_ne!(before.value, compute_config().value);
        std::fs::write(root.join(name), "module.require(name)").unwrap();
        assert!(!compute_config().complete);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn only_direct_file_dependencies_can_claim_completeness() {
    for specifier in ["../config/native", "../config/native/value", "some-package"] {
        let root = plugin_project(&format!("const native = require({specifier:?});"));
        std::fs::create_dir_all(root.join("config/native")).unwrap();
        std::fs::write(
            root.join("config/native/package.json"),
            r#"{"main":"values.json"}"#,
        )
        .unwrap();
        std::fs::write(root.join("config/native/index.js"), "module.exports = 1;").unwrap();
        std::fs::write(root.join("config/native/values.json"), "1").unwrap();
        std::fs::write(root.join("config/native/value.ts"), "export default 1;").unwrap();
        std::fs::write(root.join("config/native/value.json"), "1").unwrap();
        assert!(!fingerprint(&root).complete, "{specifier}");
        std::fs::remove_dir_all(root).unwrap();
    }
    let root = plugin_project("module.exports = 1;");
    std::fs::create_dir_all(root.join("config/native")).unwrap();
    std::fs::write(
        root.join("config/native/package.json"),
        r#"{"main":"values.json"}"#,
    )
    .unwrap();
    std::fs::write(root.join("config/native/index.js"), "module.exports = 1;").unwrap();
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["./config/native"]}}"#,
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["./plugins/withX"]}}"#,
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::write(
        root.join("app.json"),
        r#"{"expo":{"plugins":["some-package"]}}"#,
    )
    .unwrap();
    assert!(!fingerprint(&root).complete);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn extensionless_plugin_seeds_and_dependencies_forbid_reuse() {
    for seed in [true, false] {
        let root = plugin_project("require('../config/native')");
        std::fs::write(root.join("config/native"), "require('./x.json')").unwrap();
        if seed {
            std::fs::write(root.join("app.json"), r#"{"expo":{"plugins":["./config/native"]}}"#).unwrap();
        }
        let fp = fingerprint(&root);
        assert!(!fp.complete);
        assert!(fp.incompleteness.iter().any(|reason| reason.contains("recognized extension")));
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(unix)]
#[test]
fn symlinked_plugin_seeds_dependencies_and_parent_directories_forbid_reuse() {
    use std::os::unix::fs::symlink;
    for site in ["seed", "dependency", "parent"] {
        let root = plugin_project("require('../config/value.js')");
        std::fs::write(root.join("config/value.js"), "require('./x.json')").unwrap();
        match site {
            "seed" => {
                std::fs::remove_file(root.join("plugins/withX.js")).unwrap();
                symlink("../config/value.js", root.join("plugins/withX.js")).unwrap();
            }
            "dependency" => {
                symlink("value.js", root.join("config/linked.js")).unwrap();
                std::fs::write(root.join("plugins/withX.js"), "require('../config/linked.js')").unwrap();
            }
            _ => {
                symlink("config", root.join("linked")).unwrap();
                std::fs::write(root.join("plugins/withX.js"), "require('../linked/value.js')").unwrap();
            }
        }
        let fp = fingerprint(&root);
        assert!(!fp.complete, "{site}");
        assert!(fp.incompleteness.iter().any(|reason| reason.contains("non-symlink")));
        std::fs::remove_dir_all(root).unwrap();
    }
}

fn local_dependency_project(spec: &str) -> std::path::PathBuf {
    let root = plugin_project("module.exports = (c) => c;");
    std::fs::write(
        root.join("package.json"),
        serde_json::json!({"dependencies": {"foo": format!("{spec}./foo")}}).to_string(),
    )
    .unwrap();
    std::fs::create_dir_all(root.join("foo/cpp")).unwrap();
    std::fs::write(root.join("foo/package.json"), r#"{"name":"foo"}"#).unwrap();
    std::fs::write(
        root.join("foo/Foo.podspec"),
        "Pod::Spec.new { |s| s.source_files = 'ios/**', 'cpp/**/*.{cpp,h}' }",
    )
    .unwrap();
    std::fs::write(root.join("foo/cpp/Foo.cpp"), "int foo = 1;").unwrap();
    root
}

fn local_fingerprint(root: &Path, platform: &str) -> NativeFingerprint {
    let mut runner = MockRunner::new();
    runner.expect_run("ls-files", CmdOutput::success("package.json\0"));
    compute(&mut runner, root, root, platform).unwrap()
}

#[test]
fn local_dependency_cpp_inputs_invalidate_both_platform_fingerprints() {
    for spec in ["file:", "link:"] {
        let root = local_dependency_project(spec);
        let before: Vec<_> = ["ios", "android"]
            .map(|platform| local_fingerprint(&root, platform))
            .into();
        for fp in &before {
            assert!(fp.complete, "{:?}", fp.incompleteness);
        }
        std::fs::write(root.join("foo/cpp/Foo.cpp"), "int foo = 2;").unwrap();
        for (platform, before) in ["ios", "android"].into_iter().zip(before) {
            let after = local_fingerprint(&root, platform);
            assert!(after.complete, "{:?}", after.incompleteness);
            assert_ne!(before.value, after.value, "{spec} {platform}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn local_dependency_build_outputs_do_not_invalidate_fingerprints() {
    let root = local_dependency_project("file:");
    let before = local_fingerprint(&root, "ios");
    for excluded in [
        "node_modules",
        "build",
        ".gradle",
        "Pods",
        "DerivedData",
        "android/app/build",
        "ios/Pods",
        "ios/DerivedData",
        "cpp/build",
        ".cxx",
    ] {
        let dir = root.join("foo").join(excluded);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("generated"), "output").unwrap();
    }
    let after = local_fingerprint(&root, "ios");
    assert!(after.complete, "{:?}", after.incompleteness);
    assert_eq!(before.value, after.value);
    std::fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn local_dependency_unreadable_files_and_directories_forbid_reuse() {
    use std::os::unix::fs::PermissionsExt;
    for spec in ["file:", "link:"] {
        for site in ["cpp/Foo.cpp", "cpp"] {
            let root = local_dependency_project(spec);
            let path = root.join("foo").join(site);
            let permissions = std::fs::metadata(&path).unwrap().permissions();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0)).unwrap();
            let fp = local_fingerprint(&root, "ios");
            std::fs::set_permissions(&path, permissions).unwrap();
            std::fs::remove_dir_all(root).unwrap();
            assert!(!fp.complete, "{spec} {site} must forbid reuse");
            assert!(
                fp.incompleteness
                    .iter()
                    .any(|reason| reason.contains("local dependency foo")),
                "{:?}",
                fp.incompleteness
            );
        }
    }
}


#[test]
fn optional_local_dependencies_bind_native_inputs_and_unresolved_workspaces() {
    for spec in ["file:", "link:", "workspace:"] {
        let root = local_dependency_project(spec);
        std::fs::write(
            root.join("package.json"),
            serde_json::json!({"optionalDependencies": {"foo": format!("{spec}./foo")}})
                .to_string(),
        )
        .unwrap();
        for platform in ["ios", "android"] {
            let before = local_fingerprint(&root, platform);
            if spec == "workspace:" {
                assert!(!before.complete);
                assert!(before
                    .incompleteness
                    .iter()
                    .any(|reason| reason.contains("workspace:")));
                continue;
            }
            assert!(before.complete, "{:?}", before.incompleteness);
            std::fs::write(
                root.join("foo/cpp/Foo.cpp"),
                format!("int foo = {};", platform.len()),
            )
            .unwrap();
            let after = local_fingerprint(&root, platform);
            assert!(after.complete, "{:?}", after.incompleteness);
            assert_ne!(before.value, after.value, "{spec} {platform}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
