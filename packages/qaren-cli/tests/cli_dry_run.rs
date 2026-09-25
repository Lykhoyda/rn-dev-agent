use std::path::Path;
use std::process::Command;

// Bounded integration coverage: the real binary against the checked-in iOS
// scenario in --dry-run mode. Requires the host toolchain (git/pnpm/xcrun)
// but never allocates a device, port, or run record.
#[test]
fn dry_run_against_checked_in_ios_scenario_emits_parseable_receipt() {
    for tool in ["git", "pnpm", "xcrun"] {
        if !Command::new("/usr/bin/which")
            .arg(tool)
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            eprintln!("skipping: {tool} unavailable on this host");
            return;
        }
    }
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let scenario = manifest_dir.join("scenarios/ios-simulator.yaml");
    let toplevel = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(manifest_dir)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    match toplevel {
        Some(root) if Path::new(&root).join("test-app").is_dir() => {}
        _ => {
            eprintln!("skipping: the checked-in scenario's test-app candidate is absent here");
            return;
        }
    }
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["prepare", scenario.to_str().unwrap(), "--json", "--dry-run"])
        .output()
        .unwrap();
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim())
        .unwrap_or_else(|e| panic!("stdout must be pure JSON ({e}): {stdout}"));
    assert_eq!(value["schema"], "qaren/1");
    assert_eq!(value["verb"], "prepare");
    let result = value["result"].as_str().unwrap();
    match result {
        "planned" => {
            assert!(output.status.success());
            let planned = value["planned_commands"].as_array().unwrap();
            assert!(planned
                .iter()
                .any(|c| c.as_str().unwrap().contains("expo run:ios")));
            assert!(value["candidate"]["git_sha"].as_str().unwrap().len() == 40);
        }
        "failed" => {
            // A busy host may legitimately hold the scenario port; the receipt
            // must still be a bounded structured failure with exit code 1.
            assert_eq!(output.status.code(), Some(1));
            let code = value["failure"]["code"].as_str().unwrap();
            assert!(
                code == "METRO_PORT_OCCUPIED" || code == "PREREQ_MISSING",
                "unexpected dry-run failure code {code}"
            );
        }
        other => panic!("unexpected dry-run result {other}"),
    }
}

#[test]
fn usage_errors_exit_2_with_empty_stdout() {
    let output = Command::new(env!("CARGO_BIN_EXE_qaren")).output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(
        output.stdout.is_empty(),
        "usage errors must not write to stdout"
    );

    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .args(["status", "run", "--dry-run"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn fresh_install_is_check_only_and_opt_in() {
    for verb in ["prepare", "prewarm", "status", "cleanup", "complete"] {
        let mut args = vec![verb, "missing", "--fresh-install"];
        if verb == "complete" {
            args.push("log");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2));
        assert!(String::from_utf8_lossy(&output.stderr).contains("only valid for check"));
        assert!(output.stdout.is_empty());
    }
    for fresh in [false, true] {
        let mut args = vec![
            "check",
            "--plan-file",
            "missing",
            "--config",
            "/nonexistent/qaren-config",
        ];
        if fresh {
            args.push("--fresh-install");
        }
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let receipt: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["commands_executed"], 0);
    }
}

#[test]
fn status_of_unknown_run_exits_3_with_receipt() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ghost = format!("ghost-run-{}", std::process::id());
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .current_dir(manifest_dir)
        .args(["status", &ghost, "--json"])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(3));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(value["result"], "unknown");
    assert_eq!(value["failure"]["code"], "RUN_RECORD_UNAVAILABLE");
}

#[test]
fn remove_app_flags_are_usage_errors_unless_paired_on_cleanup() {
    let cases: &[&[&str]] = &[
        &["cleanup", "run", "--remove-app"],
        &["cleanup", "run", "--remove-app", "--confirm-remove-app"],
        &[
            "cleanup",
            "run",
            "--confirm-remove-app",
            "run/emulator-5554/com.x",
        ],
        &[
            "status",
            "run",
            "--remove-app",
            "--confirm-remove-app",
            "run/emulator-5554/com.x",
        ],
        &[
            "prepare",
            "s.yaml",
            "--remove-app",
            "--confirm-remove-app",
            "run/emulator-5554/com.x",
        ],
    ];
    for args in cases {
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .args(*args)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(2), "{args:?}");
        assert!(
            output.stdout.is_empty(),
            "{args:?} must not write a receipt"
        );
    }
}

#[test]
fn confirmed_removal_of_unknown_run_is_refused_with_receipt() {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let ghost = format!("ghost-run-{}", std::process::id());
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .current_dir(manifest_dir)
        .args([
            "cleanup",
            &ghost,
            "--json",
            "--remove-app",
            "--confirm-remove-app",
            &format!("{ghost}/emulator-5554/com.rndevagent.testapp"),
        ])
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(4));
    let stdout = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(stdout.trim()).unwrap();
    assert_eq!(value["result"], "refused");
    assert_eq!(value["failure"]["code"], "RUN_RECORD_UNAVAILABLE");
}
