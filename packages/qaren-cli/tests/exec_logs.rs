mod common;

use qaren::exec::{CmdSpec, RealRunner, Runner};
use qaren::failure::{Failure, FailureCode};
use std::io::{Read, Write};
use std::os::fd::OwnedFd;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

const KEY: &str = "synthetic-phase3-typesafe-key";

fn shell(script: &str, dir: &Path) -> CmdSpec {
    CmdSpec::new("fixture", "/bin/sh", &["-c", script], 5).cwd(dir)
}

fn until(mut ready: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !ready() {
        assert!(Instant::now() < deadline, "fixture did not finish");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn persist_failure(dir: &Path, run_id: &str, failure: Failure) {
    let mut record = common::base_record(
        dir,
        &common::ios_scenario_yaml(8791),
        run_id,
        qaren::runrecord::Phase::Failed,
    );
    record.failure = Some(failure);
    record.save(dir).unwrap();
}

struct HelperGuard(Child);

impl Drop for HelperGuard {
    fn drop(&mut self) {
        if !matches!(self.0.try_wait(), Ok(Some(_))) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

#[test]
fn a_checkpoint_completes_while_four_writers_keep_the_helper_busy() {
    let deadline = Instant::now() + Duration::from_secs(12);
    let (input, output) = UnixStream::pair().unwrap();
    let (mut control, helper_control) = UnixStream::pair().unwrap();
    control
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    control
        .set_write_timeout(Some(Duration::from_secs(1)))
        .unwrap();
    let mut helper = HelperGuard(
        Command::new(env!("CARGO_BIN_EXE_qaren"))
            .arg(qaren::exec::log::HELPER_ARG)
            .env_clear()
            .env("TYPESAFE_API_KEY", KEY)
            .stdin(Stdio::from(OwnedFd::from(input)))
            .stdout(Stdio::from(OwnedFd::from(helper_control)))
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let stop = Arc::new(AtomicBool::new(false));
    let written: Vec<_> = (0..4).map(|_| Arc::new(AtomicU64::new(0))).collect();
    let writers: Vec<_> = written
        .iter()
        .map(|written| {
            let written = Arc::clone(written);
            let stop = Arc::clone(&stop);
            let mut output = output.try_clone().unwrap();
            std::thread::spawn(move || {
                let mut bytes = [b'x'; 64 * 1024];
                for byte in bytes.iter_mut().skip(1).step_by(2) {
                    *byte = b' ';
                }
                for line in bytes.chunks_mut(128) {
                    line[127] = b'\n';
                }
                while !stop.load(Ordering::Relaxed) && Instant::now() < deadline {
                    match output.write(&bytes) {
                        Ok(n) => {
                            written.fetch_add(n as u64, Ordering::Relaxed);
                        }
                        Err(_) if stop.load(Ordering::Relaxed) => break,
                        Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                        Err(error) => return Err(error),
                    }
                }
                Ok(())
            })
        })
        .collect();
    let warmup = Instant::now() + Duration::from_secs(3);
    while written
        .iter()
        .any(|bytes| bytes.load(Ordering::Relaxed) < 256 * 1024)
        && Instant::now() < warmup
    {
        std::thread::sleep(Duration::from_millis(1));
    }
    let active = written
        .iter()
        .all(|bytes| bytes.load(Ordering::Relaxed) >= 256 * 1024);
    let mut ack = [0];
    let checkpoint = control
        .write_all(&[1])
        .and_then(|()| control.read_exact(&mut ack));
    let still_running = matches!(helper.0.try_wait(), Ok(None));
    let writers_running = writers.iter().all(|writer| !writer.is_finished());

    stop.store(true, Ordering::Relaxed);
    output.shutdown(std::net::Shutdown::Write).unwrap();
    drop(output);
    let writer_results: Vec<_> = writers.into_iter().map(|writer| writer.join()).collect();
    let exit = loop {
        if let Some(status) = helper.0.try_wait().unwrap() {
            break Some(status);
        }
        if Instant::now() >= deadline {
            break None;
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        active,
        "all four writers must be producing before the checkpoint"
    );
    assert!(
        still_running && writers_running,
        "the checkpoint must not rely on writer or helper exit"
    );
    assert!(writer_results
        .into_iter()
        .all(|result| matches!(result, Ok(Ok(())))));
    assert!(
        exit.is_some_and(|status| status.success()),
        "the helper must drain EOF and be reaped after the writers stop: {exit:?}"
    );
    assert!(
        checkpoint.is_ok(),
        "a healthy busy helper starved its checkpoint: {checkpoint:?}"
    );
    assert_eq!(ack, [1]);
}

#[test]
fn subprocess_logs_are_redacted_before_persistence() {
    let dir = common::temp_repo();
    std::fs::write(dir.join(".env"), format!("TYPESAFE_API_KEY={KEY}\n")).unwrap();
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "subprocess_fixture_worker", "--nocapture"])
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("TYPESAFE_API_KEY", KEY)
        .env("QAREN_TEST_LOG_DIR", &dir)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(!String::from_utf8_lossy(&result.stdout).contains(KEY));
    assert!(!String::from_utf8_lossy(&result.stderr).contains(KEY));

    // The legacy prepare owner can exit while its managed Metro is still logging.
    std::fs::write(dir.join("detached-release"), "").unwrap();
    until(|| {
        std::fs::read_to_string(dir.join("detached.log"))
            .unwrap_or_default()
            .contains("detached done")
    });
    for name in [
        "build.log",
        "core.log",
        "killed.log",
        "detached.log",
        "build-failure/run.json",
        "capture-failure/run.json",
    ] {
        let stored = std::fs::read_to_string(dir.join(name)).unwrap();
        assert!(!stored.contains(KEY), "{name} leaked the synthetic key");
    }
    std::fs::remove_dir_all(dir).unwrap();
}

#[test]
fn subprocess_fixture_worker() {
    let Some(dir) = std::env::var_os("QAREN_TEST_LOG_DIR") else {
        return;
    };
    let dir = Path::new(&dir);
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let log = dir.join("build.log");
    runner
        .spawn_group(
            &shell(
                r#"
        test "${TYPESAFE_API_KEY+x}" != x || exit 10
        . ./.env
        printf 'build ready\n'
        printf 'compiling 42%%\r'
        printf 'split synthetic-phase3-'
        printf 'stderr progress\n' >&2
        : > partial
        n=0; while [ ! -f release ] && [ "$n" -lt 500 ]; do n=$((n+1)); sleep 0.01; done
        printf 'typesafe-key\n'
        printf 'stderr %s\n' "$TYPESAFE_API_KEY" >&2
        printf 'TYPESAFE_API_KEY=%s\n' "$TYPESAFE_API_KEY"
        n=0; while [ "$n" -lt 8192 ]; do printf 'abcdefgh'; n=$((n+1)); done
        printf '%s\n' "$TYPESAFE_API_KEY"
        printf 'stdout done'
        printf 'final diagnostic %s' "$TYPESAFE_API_KEY" >&2
    "#,
                dir,
            ),
            &log,
        )
        .unwrap();
    until(|| dir.join("partial").exists());
    runner.flush_logs().unwrap();
    let partial = std::fs::read_to_string(&log).unwrap();
    assert!(partial.contains("build ready"));
    assert!(partial.contains("compiling 42%\r"));
    assert!(partial.contains("stderr progress"));
    assert!(
        !partial.contains("synthetic"),
        "unfinished lines must not reach disk"
    );
    std::fs::write(dir.join("release"), "").unwrap();
    until(|| {
        runner.flush_logs().unwrap();
        let stored = std::fs::read_to_string(&log).unwrap();
        stored.contains("final diagnostic") && stored.contains("stdout done")
    });
    let stored = std::fs::read_to_string(&log).unwrap();
    assert!(!stored.contains(KEY));
    assert!(stored.contains("split [REDACTED_SECRET]"));
    assert!(stored.contains("stderr [REDACTED_SECRET]"));
    assert!(stored.contains("[oversized log line withheld]"));
    let failure = Failure::new(
        "build",
        FailureCode::BuildFailed,
        "fixture failed",
        "inspect log",
    )
    .with_evidence(vec![
        qaren::commands::log_tail(&log, 25),
        format!(".env echo {KEY}"),
    ]);
    persist_failure(dir, "build-failure", failure);

    let output = runner.run(&shell(
        r#"
        test "${TYPESAFE_API_KEY+x}" != x || exit 10
        . ./.env
        printf 'captured stdout %s\n' "$TYPESAFE_API_KEY"
        printf 'captured stderr %s\n' "$TYPESAFE_API_KEY" >&2
        exit 2
    "#,
        dir,
    ));
    assert_eq!(output.exit_code, Some(2));
    assert!(!output.stderr.contains(KEY));
    assert!(!output.summary().contains(KEY));
    let failure = Failure::new(
        "deps",
        FailureCode::DepsInstallFailed,
        output.stdout.clone(),
        "retry",
    )
    .with_evidence(vec![output.stdout]);
    assert!(!serde_json::to_string(&failure).unwrap().contains(KEY));
    persist_failure(dir, "capture-failure", failure);

    let mut preflight = shell(
        r#"printf '{"prepared":{"text":"Bearer ordinary text","token":"%s"}}' "$TYPESAFE_API_KEY""#,
        dir,
    );
    preflight.label = "plan-preflight".into();
    let output = runner.run(&preflight);
    assert!(output.ok());
    let prepared: serde_json::Value = serde_json::from_str(&output.stdout).unwrap();
    assert_eq!(
        prepared["prepared"]["token"], KEY,
        "protocol stdout stays memory-only and intact"
    );
    assert_eq!(prepared["prepared"]["text"], "Bearer ordinary text");

    let mut timeout = shell(
        ". ./.env; printf '%s' \"$TYPESAFE_API_KEY\" >&2; sleep 5",
        dir,
    );
    timeout.timeout_seconds = 1;
    let output = runner.run(&timeout);
    assert!(output.timed_out);
    assert_eq!(output.stderr, "[REDACTED_SECRET]");
    let mut overflowing = shell("head -c 17825792 /dev/zero", dir);
    overflowing.timeout_seconds = 30;
    let output = runner.run(&overflowing);
    assert!(!output.ok());
    assert!(output.stderr.contains("command output exceeded 16 MiB"));

    let core = shell(
        r#"printf '{"token":"%s"}\n' "$TYPESAFE_API_KEY"; printf 'core diagnostic %s' "$TYPESAFE_API_KEY" >&2"#,
        dir,
    );
    let mut child = runner.spawn_piped(&core, &dir.join("core.log")).unwrap();
    let mut wire = String::new();
    child.stdout.read_line(&mut wire).unwrap();
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(&wire).unwrap()["token"],
        KEY
    );
    until(|| child.handle.try_wait().unwrap().is_some());
    assert_eq!(
        std::fs::read_to_string(dir.join("core.log")).unwrap(),
        "core diagnostic [REDACTED_SECRET]"
    );

    let mut killed = runner
        .spawn_piped(
            &shell(
                r#"printf 'kill tail %s' "$TYPESAFE_API_KEY" >&2; : > kill-ready; sleep 5"#,
                dir,
            ),
            &dir.join("killed.log"),
        )
        .unwrap();
    until(|| dir.join("kill-ready").exists());
    killed.handle.kill_group();
    assert_eq!(
        std::fs::read_to_string(dir.join("killed.log")).unwrap(),
        "kill tail [REDACTED_SECRET]"
    );

    runner
        .spawn_group(
            &shell(
                r#"
        . ./.env
        n=0; while [ ! -f detached-release ] && [ "$n" -lt 500 ]; do n=$((n+1)); sleep 0.01; done
        printf 'detached done %s\n' "$TYPESAFE_API_KEY"
    "#,
                dir,
            ),
            &dir.join("detached.log"),
        )
        .unwrap();
}
