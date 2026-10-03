#![cfg(unix)]
mod common;

use qaren::commands::cleanup::cleanup;
use qaren::exec::{CmdSpec, RealRunner, Runner};
use qaren::runrecord::{capture_pid_identity, MetroResource, Phase, PrWorktreeResource, RunRecord};
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

struct OwnedMember(Child);
impl Drop for OwnedMember {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn git(repo: &Path, args: &[&str]) {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn real_unbound_group_survives_launcher_exit_and_cleanup_retries() {
    let root = common::temp_repo();
    git(&root, &["init"]);
    git(&root, &["config", "user.name", "QA"]);
    git(&root, &["config", "user.email", "qa@example.com"]);
    git(&root, &["add", "test-app/package.json"]);
    git(&root, &["commit", "-m", "fixture"]);
    let mut record = common::base_record(
        &root,
        &common::ios_scenario_yaml(8791),
        "metro-run",
        Phase::Walking,
    );
    let runs = root.join("runs");
    let dir = RunRecord::run_dir(&runs, &record.run_id);
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    let wt = qaren::worktree::pr_worktree_path(&dir);
    git(
        &root,
        &["worktree", "add", "--detach", wt.to_str().unwrap(), "HEAD"],
    );
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let spawned = runner
        .spawn_group(
            &CmdSpec::new("fixture-launcher", "/bin/sleep", &["30"], 0),
            &dir.join("logs/metro.log"),
        )
        .unwrap();
    let identity = capture_pid_identity(&mut runner, spawned.pid).unwrap();
    let mut member = OwnedMember(
        Command::new("/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(spawned.pgid)
            .spawn()
            .unwrap(),
    );
    record.prepare = Some(identity.clone());
    record.resources.metro = Some(MetroResource {
        port,
        endpoint: format!("http://localhost:{port}"),
        spawned: spawned.clone(),
        identity: Some(identity),
        log: dir.join("logs/metro.log"),
    });
    record.resources.pr_worktree = Some(PrWorktreeResource {
        repo_root: root.clone(),
        path: wt.clone(),
    });
    record.save(&runs).unwrap();
    assert_eq!(unsafe { libc::kill(spawned.pid, libc::SIGTERM) }, 0);
    for _ in 0..100 {
        if runner.try_reap(spawned.pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    for _ in 0..2 {
        assert!(member.0.try_wait().unwrap().is_none());
        assert_eq!(
            qaren::adapters::metro::group_presence(&mut runner, spawned.pgid),
            qaren::adapters::metro::GroupPresence::Present
        );
        let receipt = cleanup(&mut runner, &runs, &record.run_id);
        assert!(receipt.cleanup["metro"].starts_with("unresolved"));
        assert!(receipt.cleanup["pr_worktree"].contains("retained"));
        assert!(wt.exists());
        let saved = RunRecord::load(&runs, &record.run_id).unwrap();
        assert!(saved.resources.metro.is_some());
        assert!(saved.resources.pr_worktree.is_some());
    }
    drop(member.0.stdin.take());
    assert!(member.0.wait().unwrap().success());
    let receipt = cleanup(&mut runner, &runs, &record.run_id);
    assert_eq!(receipt.cleanup["metro"], "absent");
    assert_eq!(receipt.cleanup["pr_worktree"], "removed");
    assert!(!wt.exists());
}

#[test]
fn real_owned_metro_shutdown_reaps_before_proving_group_absence() {
    let root = common::temp_repo();
    let mut record = common::base_record(
        &root,
        &common::ios_scenario_yaml(8791),
        "metro-stop",
        Phase::Walking,
    );
    let runs = root.join("runs");
    let dir = RunRecord::run_dir(&runs, &record.run_id);
    std::fs::create_dir_all(dir.join("logs")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let mut runner = RealRunner::with_log_executable(env!("CARGO_BIN_EXE_qaren").into());
    let spawned = runner
        .spawn_group(
            &CmdSpec::new("fixture-metro", "/bin/sleep", &["30"], 0),
            &dir.join("logs/metro.log"),
        )
        .unwrap();
    let identity = capture_pid_identity(&mut runner, spawned.pid).unwrap();
    record.resources.metro = Some(MetroResource {
        port,
        endpoint: format!("http://localhost:{port}"),
        spawned,
        identity: Some(identity),
        log: dir.join("logs/metro.log"),
    });
    record.save(&runs).unwrap();
    let receipt = cleanup(&mut runner, &runs, &record.run_id);
    assert_eq!(receipt.cleanup["metro"], "removed");
    let receipt = cleanup(&mut runner, &runs, &record.run_id);
    assert_eq!(receipt.cleanup["metro"], "absent");
}
