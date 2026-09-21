use rn_qa::failure::FailureCode;
use rn_qa::scenario::{Platform, Scenario};
use std::path::Path;

fn valid_ios_yaml() -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios/ios-simulator.yaml"),
    )
    .unwrap()
}

fn valid_android_yaml() -> String {
    std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("scenarios/nuc-android.yaml"),
    )
    .unwrap()
}

fn parse(yaml: &str) -> Result<Scenario, rn_qa::failure::Failure> {
    let scenario: Scenario = serde_yaml::from_str(yaml).map_err(|e| {
        rn_qa::failure::Failure::new("validate", FailureCode::ScenarioInvalid, e.to_string(), "")
    })?;
    scenario.validate()?;
    Ok(scenario)
}

#[test]
fn checked_in_ios_example_is_valid() {
    let scenario = parse(&valid_ios_yaml()).unwrap();
    assert_eq!(scenario.platform, Platform::Ios);
    assert_eq!(scenario.name, "ios-simulator");
    assert_eq!(scenario.metro.as_ref().unwrap().port, 8791);
    assert_eq!(scenario.candidate.app_id, "com.rndevagent.testapp");
    assert!(scenario.ios.is_some());
    assert!(scenario.android.is_none());
}

#[test]
fn checked_in_android_example_is_valid() {
    let scenario = parse(&valid_android_yaml()).unwrap();
    assert_eq!(scenario.platform, Platform::Android);
    let android = scenario.android.unwrap();
    assert_eq!(android.ssh_host, "nuc");
    assert_eq!(android.farm_path, "bin/android-farm");
    assert_eq!(android.slot, 1);
}

#[test]
fn examples_use_distinct_metro_ports() {
    let ios = parse(&valid_ios_yaml()).unwrap();
    let android = parse(&valid_android_yaml()).unwrap();
    assert_ne!(ios.metro.unwrap().port, android.metro.unwrap().port);
}

#[test]
fn rejects_unsupported_schema() {
    let yaml = valid_ios_yaml().replace("rn-qa/1", "rn-qa/999");
    let failure = parse(&yaml).unwrap_err();
    assert_eq!(failure.code, FailureCode::ScenarioSchemaUnsupported);
}

#[test]
fn rejects_unknown_fields() {
    let yaml = format!("{}\nextra_field: nope\n", valid_ios_yaml());
    assert!(parse(&yaml).is_err());
}

#[test]
fn rejects_traversal_project_root() {
    for root in ["../outside", "/absolute", "a/../../b"] {
        let yaml =
            valid_ios_yaml().replace("project_root: test-app", &format!("project_root: {root}"));
        let failure = parse(&yaml).unwrap_err();
        assert_eq!(
            failure.code,
            FailureCode::ScenarioInvalid,
            "root {root} must be rejected"
        );
    }
}

#[test]
fn rejects_option_like_ssh_host_and_farm_path() {
    for (from, to) in [
        ("ssh_host: nuc", "ssh_host: -oProxyCommand=evil"),
        ("ssh_host: nuc", "ssh_host: \"nuc evil\""),
        (
            "farm_path: bin/android-farm",
            "farm_path: \"bin/farm; rm -rf /\"",
        ),
        ("farm_path: bin/android-farm", "farm_path: ../escape"),
        ("farm_path: bin/android-farm", "farm_path: /abs/path"),
    ] {
        let yaml = valid_android_yaml().replace(from, to);
        assert!(parse(&yaml).is_err(), "{to} must be rejected");
    }
}

#[test]
fn rejects_bad_app_ids() {
    for app_id in [
        "-leading.dash",
        "double..dot",
        "trailing.",
        "has space",
        "semi;colon",
    ] {
        let yaml = valid_ios_yaml().replace(
            "app_id: com.rndevagent.testapp",
            &format!("app_id: \"{app_id}\""),
        );
        assert!(parse(&yaml).is_err(), "{app_id} must be rejected");
    }
}

#[test]
fn rejects_low_ports_and_bad_deadlines() {
    let yaml = valid_ios_yaml().replace("port: 8791", "port: 80");
    assert!(parse(&yaml).is_err());
    let yaml = valid_ios_yaml().replace("build_seconds: 2400", "build_seconds: 999999");
    assert!(parse(&yaml).is_err());
    let yaml = valid_ios_yaml().replace("install_deps_seconds: 900", "install_deps_seconds: 5");
    assert!(parse(&yaml).is_err());
}

#[test]
fn rejects_platform_section_mismatch() {
    let yaml = valid_ios_yaml().replace("platform: ios", "platform: android");
    assert!(
        parse(&yaml).is_err(),
        "android platform with ios section must be rejected"
    );
}

#[test]
fn rejects_revision_that_is_not_head_or_sha() {
    for bad in [
        "main",
        &"a".repeat(39),
        &"a".repeat(41),
        &format!("g{}", "a".repeat(39)),
    ] {
        let yaml = valid_ios_yaml().replace("revision: HEAD", &format!("revision: {bad}"));
        assert!(parse(&yaml).is_err(), "revision {bad:?} must be rejected");
    }
    let sha_yaml =
        valid_ios_yaml().replace("revision: HEAD", &format!("revision: {}", "a".repeat(40)));
    assert!(parse(&sha_yaml).is_ok());
}

#[test]
fn rejects_bad_slot() {
    let yaml = valid_android_yaml().replace("slot: 1", "slot: 0");
    assert!(parse(&yaml).is_err());
}

fn valid_handoff_yaml() -> String {
    "schema: rn-qa/1\nname: coop-ios\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n".to_string()
}

#[test]
fn handoff_owner_scenario_is_valid_without_metro() {
    let scenario = parse(&valid_handoff_yaml()).unwrap();
    assert!(scenario.metro.is_none());
    assert_eq!(
        scenario.build.owner,
        rn_qa::scenario::BuildOwner::Qaren
    );
}

#[test]
fn rn_qa_owner_still_requires_metro() {
    let yaml = valid_ios_yaml()
        .lines()
        .filter(|l| !l.starts_with("metro") && !l.contains("port:"))
        .collect::<Vec<_>>()
        .join("\n");
    let failure = parse(&yaml).unwrap_err();
    assert!(failure.detail.contains("metro"), "{}", failure.detail);
}

#[test]
fn handoff_owner_rejects_a_metro_section() {
    let yaml = valid_handoff_yaml() + "metro:\n  port: 8791\n";
    let failure = parse(&yaml).unwrap_err();
    assert!(
        failure.detail.contains("qaren session allocates"),
        "{}",
        failure.detail
    );
}

#[test]
fn handoff_owner_rejects_the_farm_adapter() {
    let yaml = valid_android_yaml() + "build:\n  owner: qaren\n";
    // Drop the metro section too, otherwise that refusal fires first.
    let yaml = yaml
        .lines()
        .filter(|l| !l.starts_with("metro") && !l.trim_start().starts_with("port: 879"))
        .collect::<Vec<_>>()
        .join("\n");
    let failure = parse(&yaml).unwrap_err();
    assert!(failure.detail.contains("farm"), "{}", failure.detail);
}

#[test]
fn handoff_owner_rejects_clean_strategy_and_scheme_and_usb_port() {
    let clean = valid_handoff_yaml().replace(
        "owner: qaren",
        "owner: qaren\n  strategy: clean",
    );
    assert!(parse(&clean).unwrap_err().detail.contains("build.strategy"));

    let scheme = valid_handoff_yaml() + "  # comment\n";
    let scheme = scheme.replace(
        "revision: HEAD",
        "revision: HEAD\n  dev_client_scheme: rndatest",
    );
    assert!(parse(&scheme)
        .unwrap_err()
        .detail
        .contains("dev_client_scheme"));

    let usb = "schema: rn-qa/1\nname: coop-usb\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nbuild:\n  owner: qaren\nandroid_usb:\n  serial: R5CR20XXYZ\n  adb_server_port: 15039\n";
    assert!(parse(usb).unwrap_err().detail.contains("adb_server_port"));
}

#[test]
fn rn_qa_owner_usb_still_requires_adb_server_port() {
    let usb = "schema: rn-qa/1\nname: usb\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: 8794\nandroid_usb:\n  serial: R5CR20XXYZ\n";
    let failure = parse(usb).unwrap_err();
    assert!(
        failure.detail.contains("adb_server_port is required"),
        "{}",
        failure.detail
    );
}
