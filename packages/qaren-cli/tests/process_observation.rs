use std::process::Command;

fn probe(args: &[&str]) -> (i32, serde_json::Value) {
    let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
        .arg("--internal-process-observation")
        .args(args)
        .output()
        .unwrap();
    assert!(output.stderr.is_empty());
    let stdout = std::str::from_utf8(&output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "exactly one JSON line");
    assert!(stdout.ends_with('\n'));
    (
        output.status.code().unwrap(),
        serde_json::from_str(stdout).unwrap(),
    )
}

#[test]
fn invalid_requests_refuse_without_reflecting_input() {
    for args in [
        vec![],
        vec!["0"],
        vec!["-2"],
        vec!["123secret-invalid"],
        vec!["999999999999999999999999999"],
        vec!["123secret-invalid", "extra"],
    ] {
        let (exit, value) = probe(&args);
        assert_eq!(exit, 4);
        assert_eq!(value, serde_json::json!({"v":1,"status":"unknown"}));
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        let output = Command::new(env!("CARGO_BIN_EXE_qaren"))
            .arg("--internal-process-observation")
            .arg(std::ffi::OsString::from_vec(b"secret\xff".to_vec()))
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(4));
        assert_eq!(output.stdout, b"{\"v\":1,\"status\":\"unknown\"}\n");
        assert!(output.stderr.is_empty());
    }
}

#[test]
fn live_self_process_yields_only_path_and_birth_or_unknown_on_unsupported_hosts() {
    let pid = std::process::id().to_string();
    let (exit, value) = probe(&[&pid]);
    if cfg!(target_os = "macos") {
        assert_eq!(exit, 0, "macOS should observe the current test process");
        assert_eq!(value["v"], 1);
        assert_eq!(value["pid"], std::process::id());
        assert!(value["birth"]["seconds"].as_u64().unwrap() > 0);
        assert!(value["birth"]["micros"].as_u64().unwrap() < 1_000_000);
        assert!(value["executable"].as_str().unwrap().starts_with('/'));
        assert_eq!(value.as_object().unwrap().len(), 4);
    } else {
        assert_eq!(exit, 4);
        assert_eq!(value, serde_json::json!({"v":1,"status":"unknown"}));
    }
}
