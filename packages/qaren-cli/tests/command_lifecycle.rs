mod common;

use qaren::events::{self, Envelope};
use qaren::exec::{CmdSpec, RealRunner, Runner};
use std::time::{Duration, Instant};

fn assert_pair(path: &std::path::Path, ok: bool) {
    events::finish();
    let stored = std::fs::read_to_string(path).unwrap();
    let commands: Vec<Envelope> = stored
        .lines()
        .map(|line| serde_json::from_str::<Envelope>(line).unwrap())
        .filter(|event| event.event == "cmd")
        .collect();
    assert_eq!(commands.len(), 2, "{stored}");
    assert_eq!(commands[0].payload["edge"], "start");
    assert_eq!(commands[1].payload["edge"], "end");
    assert_eq!(commands[0].payload["label"], "core-walk");
    assert_eq!(commands[1].payload["label"], "core-walk");
    assert_eq!(commands[1].payload["ok"], ok);
    assert!(commands[1].payload["ms"].is_u64());
    assert!(!stored.contains("private-canary"));
}

#[test]
fn piped_completion_pairs_once_and_preserves_exit_codes() {
    for code in [0, 7] {
        let dir = common::temp_repo();
        let path = dir.join("events.jsonl");
        events::init();
        events::attach(&path);
        let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
        let mut child = runner
            .spawn_piped(
                &CmdSpec::new("core-walk", "/bin/sh", &["-c", &format!("exit {code}")], 5)
                    .env("COMMAND_TEST_VALUE", "private-canary"),
                &dir.join("stderr.log"),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let exit = loop {
            if let Some(exit) = child.handle.try_wait().unwrap() {
                break exit;
            }
            assert!(Instant::now() < deadline);
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(exit, code);
        assert_eq!(child.handle.try_wait().unwrap(), Some(code));
        assert_pair(&path, code == 0);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn failed_piped_spawn_pairs_once_and_preserves_causal_error() {
    for fail_log in [false, true] {
        let dir = common::temp_repo();
        let path = dir.join("events.jsonl");
        events::init();
        events::attach(&path);
        let executable = if fail_log {
            dir.join("missing-log-helper")
        } else {
            env!("CARGO_BIN_EXE_qaren").into()
        };
        let mut runner = RealRunner::with_log_executable(executable);
        let result = runner.spawn_piped(
            &CmdSpec::new("core-walk", "/nonexistent/private-canary", &[], 5),
            &dir.join("stderr.log"),
        );
        let error = result.err().expect("spawn must fail");
        assert_eq!(error.kind(), std::io::ErrorKind::NotFound);
        assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
        assert_pair(&path, false);
        std::fs::remove_dir_all(dir).unwrap();
    }
}

#[test]
fn killed_piped_child_pairs_once_before_subsequent_waits() {
    let dir = common::temp_repo();
    let path = dir.join("events.jsonl");
    events::init();
    events::attach(&path);
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let mut child = runner
        .spawn_piped(
            &CmdSpec::new("core-walk", "/bin/cat", &[], 5),
            &dir.join("stderr.log"),
        )
        .unwrap();
    assert_eq!(child.handle.try_wait().unwrap(), None);
    child.handle.kill_group();
    assert_eq!(child.handle.try_wait().unwrap(), Some(-1));
    assert_eq!(child.handle.try_wait().unwrap(), Some(-1));
    assert_pair(&path, false);
    std::fs::remove_dir_all(dir).unwrap();
}
