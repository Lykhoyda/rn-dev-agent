mod common;

use qaren::config::CheckConfig;
use qaren::failure::FailureCode;
use qaren::scenario::Platform;

#[test]
fn launch_scheme_requirement_uses_the_selected_check_platform_not_config_sections() {
    let repo = common::temp_repo();
    let path = repo.join("config.yaml");
    std::fs::write(&path, "appId: com.test.app\nios: {}\nandroid: {}\n").unwrap();
    let (config, _) = CheckConfig::load(&path).unwrap();
    assert!(config.validate_for_platform(Platform::Android).is_ok());
    let failure = config.validate_for_platform(Platform::Ios).unwrap_err();
    assert_eq!(failure.code, FailureCode::DevClientSchemeRequired);
    assert!(failure.code.is_refusal());
}

#[test]
fn ios_check_config_owns_bounded_launch_scheme_validation_without_echoing_input() {
    let mut config: CheckConfig = serde_yaml::from_str("appId: com.test.app\n").unwrap();
    for scheme in ["A", "Expo+test-1.2", &"a".repeat(128)] {
        config.dev_client_scheme = Some(scheme.into());
        assert!(config.validate_for_platform(Platform::Ios).is_ok());
    }
    let mut refusal = None;
    for scheme in [
        None,
        Some(""),
        Some(" "),
        Some("1private"),
        Some("private://payload"),
        Some("private\npayload"),
        Some("privaté"),
        Some(&"a".repeat(129)),
    ] {
        config.dev_client_scheme = scheme.map(String::from);
        let failure = config.validate_for_platform(Platform::Ios).unwrap_err();
        assert_eq!(failure.code, FailureCode::DevClientSchemeRequired);
        assert!(failure.code.is_refusal());
        let json = serde_json::to_value(failure).unwrap();
        assert_eq!(refusal.get_or_insert(json.clone()), &json);
        assert!(config.validate_for_platform(Platform::Android).is_ok());
    }
}
