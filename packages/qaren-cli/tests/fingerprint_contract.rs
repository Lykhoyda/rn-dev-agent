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
