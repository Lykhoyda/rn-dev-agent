use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Seek, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CmdSpec {
    pub label: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<PathBuf>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub env: Vec<(String, String)>,
    pub timeout_seconds: u64,
}

impl CmdSpec {
    pub fn new(label: &str, program: &str, args: &[&str], timeout_seconds: u64) -> Self {
        CmdSpec {
            label: label.to_string(),
            program: program.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: None,
            env: Vec::new(),
            timeout_seconds,
        }
    }

    pub fn cwd(mut self, dir: &Path) -> Self {
        self.cwd = Some(dir.to_path_buf());
        self
    }

    pub fn env(mut self, key: &str, value: &str) -> Self {
        self.env.push((key.to_string(), value.to_string()));
        self
    }

    pub fn rendered(&self) -> String {
        let mut parts = vec![self.program.clone()];
        parts.extend(self.args.iter().cloned());
        parts.join(" ")
    }
}

#[derive(Debug, Clone, Default)]
pub struct CmdOutput {
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub duration_ms: u64,
}

impl CmdOutput {
    pub fn ok(&self) -> bool {
        !self.timed_out && self.exit_code == Some(0)
    }

    pub fn success(stdout: &str) -> Self {
        CmdOutput {
            exit_code: Some(0),
            stdout: stdout.to_string(),
            ..Default::default()
        }
    }

    pub fn failed(code: i32, stderr: &str) -> Self {
        CmdOutput {
            exit_code: Some(code),
            stderr: stderr.to_string(),
            ..Default::default()
        }
    }

    pub fn summary(&self) -> String {
        if self.timed_out {
            return format!("timed out after {}ms", self.duration_ms);
        }
        let code = self
            .exit_code
            .map_or("signal".to_string(), |c| c.to_string());
        let tail: String = self
            .stderr
            .lines()
            .chain(self.stdout.lines())
            .rev()
            .take(6)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join(" | ");
        format!("exit={code} {tail}")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Spawned {
    pub pid: i32,
    pub pgid: i32,
}

// A child the caller talks to over stdio: its stdin and stdout are pipes, its
// stderr lands in the given log, and it leads its own process group.
pub struct PipedChild {
    pub pid: i32,
    pub stdin: Box<dyn Write + Send>,
    pub stdout: Box<dyn BufRead + Send>,
    pub handle: Box<dyn ChildHandle + Send>,
}

pub trait ChildHandle {
    // Some(code) once exited; a signal death reports -1.
    fn try_wait(&mut self) -> std::io::Result<Option<i32>>;
    fn kill_group(&mut self);
}

struct RealChildHandle(std::process::Child);

impl ChildHandle for RealChildHandle {
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        Ok(self.0.try_wait()?.map(|s| s.code().unwrap_or(-1)))
    }

    fn kill_group(&mut self) {
        kill_group_and_reap(&mut self.0);
    }
}

pub trait Runner {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput;
    fn spawn_group(&mut self, spec: &CmdSpec, log_path: &Path) -> std::io::Result<Spawned>;
    fn spawn_piped(&mut self, spec: &CmdSpec, stderr_log: &Path) -> std::io::Result<PipedChild>;
    fn sleep(&mut self, duration: Duration);
    fn now_epoch_ms(&self) -> u64;
    // Deadline arithmetic must survive wall-clock adjustments; implementations
    // with access to a monotonic source override this.
    fn monotonic_ms(&self) -> u64 {
        self.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64;
}

pub struct RealRunner {
    executed: u64,
    started: Instant,
}

impl RealRunner {
    pub fn new() -> Self {
        RealRunner {
            executed: 0,
            started: Instant::now(),
        }
    }
}

impl Default for RealRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for RealRunner {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        self.executed += 1;
        let started = Instant::now();
        let mut stdout_file = match tempfile() {
            Ok(f) => f,
            Err(e) => return io_failure(&started, format!("tempfile: {e}")),
        };
        let mut stderr_file = match tempfile() {
            Ok(f) => f,
            Err(e) => return io_failure(&started, format!("tempfile: {e}")),
        };
        use std::os::unix::process::CommandExt;
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::null())
            .stdout(match stdout_file.try_clone() {
                Ok(f) => Stdio::from(f),
                Err(e) => return io_failure(&started, format!("clone stdout: {e}")),
            })
            .stderr(match stderr_file.try_clone() {
                Ok(f) => Stdio::from(f),
                Err(e) => return io_failure(&started, format!("clone stderr: {e}")),
            })
            .process_group(0);
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => return io_failure(&started, format!("spawn {}: {e}", spec.program)),
        };
        let deadline = started + Duration::from_secs(spec.timeout_seconds);
        let mut timed_out = false;
        let exit_code = loop {
            match child.try_wait() {
                Ok(Some(status)) => break status.code(),
                Ok(None) => {
                    if Instant::now() >= deadline {
                        timed_out = true;
                        kill_group_and_reap(&mut child);
                        break None;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => {
                    kill_group_and_reap(&mut child);
                    return io_failure(&started, format!("wait {}: {e}", spec.program));
                }
            }
        };
        CmdOutput {
            exit_code,
            stdout: read_back(&mut stdout_file),
            stderr: read_back(&mut stderr_file),
            timed_out,
            duration_ms: started.elapsed().as_millis() as u64,
        }
    }

    fn spawn_group(&mut self, spec: &CmdSpec, log_path: &Path) -> std::io::Result<Spawned> {
        use std::os::unix::process::CommandExt;
        self.executed += 1;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_path)?;
        let log_err = log.try_clone()?;
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err))
            .process_group(0);
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let child = cmd.spawn()?;
        let pid = child.id() as i32;
        Ok(Spawned { pid, pgid: pid })
    }

    fn spawn_piped(&mut self, spec: &CmdSpec, stderr_log: &Path) -> std::io::Result<PipedChild> {
        use std::os::unix::process::CommandExt;
        self.executed += 1;
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(stderr_log)?;
        let mut cmd = Command::new(&spec.program);
        cmd.args(&spec.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::from(log))
            .process_group(0);
        if let Some(dir) = &spec.cwd {
            cmd.current_dir(dir);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }
        let mut child = cmd.spawn()?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        Ok(PipedChild {
            pid: child.id() as i32,
            stdin: Box::new(stdin),
            stdout: Box::new(BufReader::new(stdout)),
            handle: Box::new(RealChildHandle(child)),
        })
    }

    fn sleep(&mut self, duration: Duration) {
        std::thread::sleep(duration);
    }

    fn now_epoch_ms(&self) -> u64 {
        crate::timefmt::epoch_ms()
    }

    fn monotonic_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }

    fn commands_executed(&self) -> u64 {
        self.executed
    }
}

fn tempfile() -> std::io::Result<std::fs::File> {
    let dir = std::env::temp_dir();
    let name = format!(
        "qaren-cmd-{}-{}",
        std::process::id(),
        crate::timefmt::epoch_ms()
    );
    let path = dir.join(name);
    let file = std::fs::OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(&path)?;
    let _ = std::fs::remove_file(&path);
    Ok(file)
}

fn read_back(file: &mut std::fs::File) -> String {
    let mut buf = Vec::new();
    if file.rewind().is_err() {
        return String::new();
    }
    let _ = file.read_to_end(&mut buf);
    String::from_utf8_lossy(&buf).into_owned()
}

// The child is its own group leader, so -pid addresses the whole group.
fn kill_group_and_reap(child: &mut std::process::Child) {
    let pid = child.id() as i32;
    let _ = Command::new("/bin/kill")
        .args(["-9", "--", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let reap_deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < reap_deadline {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => return,
        }
    }
}

fn io_failure(started: &Instant, detail: String) -> CmdOutput {
    CmdOutput {
        exit_code: None,
        stdout: String::new(),
        stderr: detail,
        timed_out: false,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

// What the scripted stdout does once its bytes are consumed: close, stay open until the
// group is killed (a member dying with the group), or stay open forever (a survivor).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HoldStdout {
    Close,
    UntilKill,
    Forever,
}

pub enum MockResult {
    Run(CmdOutput),
    Spawn(std::io::Result<Spawned>, Option<String>),
    // Scripted stdout for a piped child; `exit` None means it never exits on its own.
    SpawnPiped {
        pid: i32,
        stdout: String,
        exit: Option<i32>,
        hold: HoldStdout,
    },
}

struct HeldStdout {
    script: std::io::Cursor<Vec<u8>>,
    hold: HoldStdout,
    killed: Arc<Mutex<bool>>,
}

impl HeldStdout {
    fn exhausted(&self) -> bool {
        self.script.position() as usize >= self.script.get_ref().len()
    }

    // Blocks by the hold rule once the script is consumed; true means EOF.
    fn wait_for_eof(&self) -> bool {
        loop {
            match self.hold {
                HoldStdout::Close => return true,
                HoldStdout::UntilKill if *self.killed.lock().unwrap() => return true,
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
    }
}

impl std::io::Read for HeldStdout {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.exhausted() && self.wait_for_eof() {
            return Ok(0);
        }
        self.script.read(buf)
    }
}

impl BufRead for HeldStdout {
    fn fill_buf(&mut self) -> std::io::Result<&[u8]> {
        if self.exhausted() && self.wait_for_eof() {
            return Ok(&[]);
        }
        self.script.fill_buf()
    }

    fn consume(&mut self, amt: usize) {
        self.script.consume(amt)
    }
}

struct MockChildHandle {
    exit: Option<i32>,
    killed: Arc<Mutex<bool>>,
}

impl ChildHandle for MockChildHandle {
    // A child that already exited keeps its status; a kill only ends one still running.
    fn try_wait(&mut self) -> std::io::Result<Option<i32>> {
        if self.exit.is_some() {
            return Ok(self.exit);
        }
        if *self.killed.lock().unwrap() {
            return Ok(Some(-9));
        }
        Ok(None)
    }

    fn kill_group(&mut self) {
        *self.killed.lock().unwrap() = true;
    }
}

struct SharedWriter(Arc<Mutex<Vec<u8>>>);

impl Write for SharedWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub struct MockExpectation {
    pub program_hint: String,
    pub result: MockResult,
}

pub struct MockRunner {
    pub calls: Vec<CmdSpec>,
    pub spawned_logs: Vec<PathBuf>,
    // Everything written to each piped child's stdin, in spawn order.
    pub piped_stdin: Vec<Arc<Mutex<Vec<u8>>>>,
    pub piped_killed: Vec<Arc<Mutex<bool>>>,
    script: VecDeque<MockExpectation>,
    now_ms: u64,
}

impl MockRunner {
    pub fn new() -> Self {
        MockRunner {
            calls: Vec::new(),
            spawned_logs: Vec::new(),
            piped_stdin: Vec::new(),
            piped_killed: Vec::new(),
            script: VecDeque::new(),
            now_ms: 1_770_000_000_000,
        }
    }

    pub fn expect_spawn_piped(
        &mut self,
        program_hint: &str,
        pid: i32,
        stdout: &str,
        exit: Option<i32>,
    ) {
        // A child that never exits on its own keeps its pipe open until it is killed.
        let hold = if exit.is_some() {
            HoldStdout::Close
        } else {
            HoldStdout::UntilKill
        };
        self.expect_spawn_piped_holding(program_hint, pid, stdout, exit, hold);
    }

    pub fn expect_spawn_piped_holding(
        &mut self,
        program_hint: &str,
        pid: i32,
        stdout: &str,
        exit: Option<i32>,
        hold: HoldStdout,
    ) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::SpawnPiped {
                pid,
                stdout: stdout.to_string(),
                exit,
                hold,
            },
        });
    }

    pub fn piped_stdin_text(&self, index: usize) -> String {
        String::from_utf8_lossy(&self.piped_stdin[index].lock().unwrap()).into_owned()
    }

    pub fn expect_run(&mut self, program_hint: &str, output: CmdOutput) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Run(output),
        });
    }

    pub fn expect_spawn(&mut self, program_hint: &str, spawned: Spawned) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Spawn(Ok(spawned), None),
        });
    }

    pub fn expect_spawn_failure(&mut self, program_hint: &str, message: &str) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Spawn(Err(std::io::Error::other(message)), None),
        });
    }

    pub fn expect_spawn_with_log(
        &mut self,
        program_hint: &str,
        spawned: Spawned,
        log_content: &str,
    ) {
        self.script.push_back(MockExpectation {
            program_hint: program_hint.to_string(),
            result: MockResult::Spawn(Ok(spawned), Some(log_content.to_string())),
        });
    }

    pub fn remaining(&self) -> usize {
        self.script.len()
    }

    fn next_for(&mut self, spec: &CmdSpec) -> MockExpectation {
        let expectation = self
            .script
            .pop_front()
            .unwrap_or_else(|| panic!("unexpected command: {}", spec.rendered()));
        let hint = &expectation.program_hint;
        assert!(
            spec.rendered().contains(hint.as_str()),
            "expected command containing {hint:?}, got {:?}",
            spec.rendered()
        );
        expectation
    }
}

impl Default for MockRunner {
    fn default() -> Self {
        Self::new()
    }
}

impl Runner for MockRunner {
    fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
        self.calls.push(spec.clone());
        match self.next_for(spec).result {
            MockResult::Run(output) => output,
            MockResult::Spawn(..) | MockResult::SpawnPiped { .. } => {
                panic!("expected run, script had spawn for {}", spec.rendered())
            }
        }
    }

    fn spawn_piped(&mut self, spec: &CmdSpec, stderr_log: &Path) -> std::io::Result<PipedChild> {
        self.calls.push(spec.clone());
        self.spawned_logs.push(stderr_log.to_path_buf());
        match self.next_for(spec).result {
            MockResult::SpawnPiped {
                pid,
                stdout,
                exit,
                hold,
            } => {
                let stdin = Arc::new(Mutex::new(Vec::new()));
                let killed = Arc::new(Mutex::new(false));
                self.piped_stdin.push(stdin.clone());
                self.piped_killed.push(killed.clone());
                Ok(PipedChild {
                    pid,
                    stdin: Box::new(SharedWriter(stdin)),
                    stdout: Box::new(HeldStdout {
                        script: std::io::Cursor::new(stdout.into_bytes()),
                        hold,
                        killed: killed.clone(),
                    }),
                    handle: Box::new(MockChildHandle { exit, killed }),
                })
            }
            _ => panic!(
                "expected spawn_piped, script had another shape for {}",
                spec.rendered()
            ),
        }
    }

    fn spawn_group(&mut self, spec: &CmdSpec, log_path: &Path) -> std::io::Result<Spawned> {
        self.calls.push(spec.clone());
        self.spawned_logs.push(log_path.to_path_buf());
        match self.next_for(spec).result {
            MockResult::Spawn(result, log_content) => {
                if let Some(content) = log_content {
                    let _ = std::fs::write(log_path, content);
                }
                result
            }
            _ => panic!(
                "expected spawn, script had another shape for {}",
                spec.rendered()
            ),
        }
    }

    fn sleep(&mut self, duration: Duration) {
        self.now_ms += duration.as_millis() as u64;
    }

    fn now_epoch_ms(&self) -> u64 {
        self.now_ms
    }

    fn commands_executed(&self) -> u64 {
        self.calls.len() as u64
    }
}
