#![allow(dead_code)]

use qaren::candidate::Candidate;
use qaren::exec::{CmdOutput, MockRunner};
use qaren::runrecord::{Phase, PidIdentity, RunRecord, RUN_SCHEMA};
use qaren::scenario::Scenario;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

pub fn temp_repo() -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let dir = std::env::temp_dir().join(format!(
        "qaren-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(dir.join("test-app")).unwrap();
    std::fs::write(dir.join("test-app").join("package.json"), "{}").unwrap();
    std::fs::create_dir_all(dir.join("test-app/node_modules/.bin")).unwrap();
    std::fs::write(
        dir.join("test-app/node_modules/.bin/expo"),
        "mock local expo",
    )
    .unwrap();
    std::fs::set_permissions(
        dir.join("test-app/node_modules/.bin/expo"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    std::fs::write(
        dir.join("test-app").join("pnpm-lock.yaml"),
        "lockfileVersion: 9\n",
    )
    .unwrap();
    dir
}

pub fn script_tracked_file_identity(mock: &mut MockRunner, path: &str, mode: &str) {
    let oid = "a".repeat(40);
    mock.expect_run(
        "ls-tree",
        CmdOutput::success(&format!("{mode} blob {oid}\t{path}\0")),
    );
    mock.expect_run(
        "ls-files",
        CmdOutput::success(&format!("{mode} {oid} 0\t{path}\0")),
    );
}

pub fn ios_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: ios-simulator\nplatform: ios\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: {port}\nios:\n  device_type: com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro\n  runtime: com.apple.CoreSimulator.SimRuntime.iOS-26-4\n"
    )
}

pub fn android_scenario_yaml(port: u16) -> String {
    format!(
        "schema: qaren/1\nname: nuc-android\nplatform: android\ncandidate:\n  project_root: test-app\n  app_id: com.rndevagent.testapp\n  revision: HEAD\nmetro:\n  port: {port}\nandroid:\n  ssh_host: nuc\n  farm_path: bin/android-farm\n  slot: 1\n  adb_server_port: 15037\n"
    )
}

pub fn scenario_from(yaml: &str) -> Scenario {
    let scenario: Scenario = serde_yaml::from_str(yaml).unwrap();
    scenario.validate().unwrap();
    scenario
}

pub fn identity(pid: i32, started_at: &str) -> PidIdentity {
    PidIdentity {
        pid,
        started_at: started_at.to_string(),
        command: "node metro".to_string(),
    }
}

pub fn base_record(
    repo_root: &std::path::Path,
    yaml: &str,
    run_id: &str,
    phase: Phase,
) -> RunRecord {
    let scenario = scenario_from(yaml);
    RunRecord {
        schema: RUN_SCHEMA.to_string(),
        run_id: run_id.to_string(),
        created_at: "2026-08-12T16:00:00Z".to_string(),
        scenario,
        scenario_path: repo_root.join("scenario.yaml"),
        scenario_sha256: "0".repeat(64),
        candidate: Candidate {
            repo_root: repo_root.to_path_buf(),
            project_root: repo_root.join("test-app"),
            app_id: "com.rndevagent.testapp".to_string(),
            git_sha: "b".repeat(40),
            git_dirty: false,
            lockfile_sha256: Some("c".repeat(64)),
            worktree_fingerprint: Some(qaren::candidate::worktree_fingerprint("")),
        },
        phase,
        prepare: Some(identity(999, "Wed Aug 12 15:00:00 2026")),
        // Only phases reached after build planning carry a recorded plan,
        // matching what production records can actually contain.
        build: matches!(phase, Phase::Building | Phase::Ready | Phase::Cleaned).then(|| {
            qaren::buildplan::BuildPlan {
                decision: qaren::buildplan::BuildDecision::Clean,
                fingerprint: format!("rnfp1:{}", "e".repeat(64)),
                reason:
                    "no native cache state recorded for this worktree/app; compatibility is unprovable"
                        .to_string(),
                evidence: Vec::new(),
                artifact: None,
                regenerate_native_dir: false,
            }
        }),
        handoff: None,
        resources: Default::default(),
        failure: None,
        history: Vec::new(),
    }
}

pub fn ios_app_info() -> String {
    serde_json::json!({
        "CFBundleIdentifier": "com.rndevagent.testapp",
        "CFBundlePackageType": "APPL",
        "CFBundleSupportedPlatforms": ["iPhoneSimulator"],
        "CFBundleExecutable": "binary",
        "CFBundleURLTypes": [{"CFBundleURLSchemes": ["rndatest"]}]
    })
    .to_string()
}

pub fn write_ios_app(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(path).unwrap();
    std::fs::write(path.join("Info.plist"), ios_app_info()).unwrap();
    std::fs::write(path.join("binary"), b"mock simulator executable").unwrap();
    std::fs::set_permissions(path.join("binary"), std::fs::Permissions::from_mode(0o755)).unwrap();
}

pub fn script_ios_app_verification(mock: &mut MockRunner) {
    mock.expect_run("plutil", CmdOutput::success(&ios_app_info()));
    mock.expect_run(
        "vtool -show-build",
        CmdOutput::success("Load command 9\n cmd LC_BUILD_VERSION\n platform IOSSIMULATOR\n"),
    );
    mock.expect_run("otool -L", CmdOutput::success("test.app/binary:\n"));
    mock.expect_run("nm -j -U", CmdOutput::success(IOS_LAUNCHER_SYMBOLS));
    mock.expect_run(
        "otool -v -s __TEXT __cstring",
        CmdOutput::success("0000000100012345  --initialUrl\n"),
    );
}

pub const IOS_LAUNCHER_SYMBOLS: &str = "+[EXDevLauncherController initialUrlFromProcessInfo]\n-[EXDevLauncherController start:launchOptions:]\n-[EXDevLauncherController loadApp:withProjectUrl:onSuccess:onError:]\n";

pub const IOS_BUILD_HELP: &str = "Usage\n  npx expo run:ios\nOptions\n  --no-bundler                     Skip starting the Metro bundler\n  -d, --device [device]            Device name, UDID, or \"generic\" for build-only\n  -o, --output <path>              Directory to output the built app binary\n";

pub fn script_ios_deps(mock: &mut MockRunner) {
    mock.expect_run("pnpm install --frozen-lockfile", CmdOutput::success(""));
    mock.expect_run("expo run:ios --help", CmdOutput::success(IOS_BUILD_HELP));
}

pub fn script_finite_ios_build(mock: &mut MockRunner) {
    mock.expect_spawn_piped("expo run:ios", 5000, "", Some(0));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:00:00 2026"));
    mock.expect_run("ps", CmdOutput::success("qaren-build"));
    mock.expect_run("ps -A", CmdOutput::success("1 1 S\n"));
    script_ios_app_verification(mock);
    script_ios_app_verification(mock);
    mock.expect_run("simctl install", CmdOutput::success(""));
    mock.expect_spawn(
        "expo start",
        qaren::exec::Spawned {
            pid: 6000,
            pgid: 6000,
        },
    );
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("node expo start"));
    mock.expect_run("ps", CmdOutput::success("Wed Aug 12 16:01:00 2026"));
    mock.expect_run("ps", CmdOutput::success("S"));
    mock.expect_run("lsof", CmdOutput::success("6001"));
    mock.expect_run("ps", CmdOutput::success("6000"));
    mock.expect_run("curl", CmdOutput::success("packager-status:running"));
    mock.expect_run(
        "simctl launch --terminate-running-process",
        CmdOutput::success(""),
    );
}

#[derive(Default)]
pub struct IosBuildRunner {
    pub inner: MockRunner,
    pub omit_app: bool,
    pub build_log: Option<String>,
    pub build_spawn_fault: Option<BuildSpawnFault>,
}

#[derive(Clone, Copy)]
pub enum BuildSpawnFault {
    Error,
    ErrorWithSaveFailure,
    Interrupted,
}

impl IosBuildRunner {
    pub fn new() -> Self {
        Self::default()
    }
}

impl std::ops::Deref for IosBuildRunner {
    type Target = MockRunner;
    fn deref(&self) -> &MockRunner {
        &self.inner
    }
}

impl std::ops::DerefMut for IosBuildRunner {
    fn deref_mut(&mut self) -> &mut MockRunner {
        &mut self.inner
    }
}

struct BuildStart {
    stdin: Box<dyn std::io::Write + Send>,
    run_dir: PathBuf,
    output: Option<PathBuf>,
}

impl std::io::Write for BuildStart {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        assert_eq!(bytes, b"start\n");
        let record: RunRecord =
            serde_json::from_slice(&std::fs::read(self.run_dir.join("run.json")).unwrap()).unwrap();
        assert!(matches!(
            record.resources.build_process,
            Some(qaren::runrecord::BuildProcess::Running {
                identity: Some(_),
                ..
            })
        ));
        assert!(record.resources.metro.is_none());
        let lock = record.resources.build_lock.unwrap();
        assert_eq!(
            qaren::buildplan::read_holder(&lock.lock_dir)
                .unwrap()
                .run_id,
            record.run_id
        );
        if let Some(output) = &self.output {
            write_ios_app(&output.join("testapp.app"));
        }
        self.stdin.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stdin.flush()
    }
}

impl qaren::exec::Runner for IosBuildRunner {
    fn env_var(&self, name: &str) -> Option<String> {
        self.inner.env_var(name)
    }
    fn run(&mut self, spec: &qaren::exec::CmdSpec) -> CmdOutput {
        self.inner.run(spec)
    }
    fn run_private(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        input: &[u8],
    ) -> qaren::exec::PrivateOutput {
        self.inner.run_private(spec, input)
    }
    fn spawn_group(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::Spawned> {
        self.inner.spawn_group(spec, log)
    }
    fn spawn_piped(
        &mut self,
        spec: &qaren::exec::CmdSpec,
        log: &std::path::Path,
    ) -> std::io::Result<qaren::exec::PipedChild> {
        if let Some(fault) = self
            .build_spawn_fault
            .filter(|_| spec.label == "expo-run-ios")
        {
            self.inner.calls.push(spec.clone());
            let run_dir = log.parent().unwrap().parent().unwrap();
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            assert!(matches!(
                record.resources.build_process,
                Some(qaren::runrecord::BuildProcess::SpawnPending)
            ));
            match fault {
                BuildSpawnFault::Error => {}
                BuildSpawnFault::ErrorWithSaveFailure => {
                    std::fs::create_dir(
                        run_dir.join(format!(".run.json.tmp.{}", std::process::id())),
                    )
                    .unwrap();
                }
                BuildSpawnFault::Interrupted => panic!("interrupted during build spawn"),
            }
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "build executable unavailable",
            ));
        }
        let mut child = self.inner.spawn_piped(spec, log)?;
        if spec.label == "expo-run-ios" || spec.label == "expo-prebuild" {
            let run_dir = log.parent().unwrap().parent().unwrap().to_path_buf();
            let record: RunRecord =
                serde_json::from_slice(&std::fs::read(run_dir.join("run.json")).unwrap()).unwrap();
            assert!(matches!(
                record.resources.build_process,
                Some(qaren::runrecord::BuildProcess::SpawnPending)
            ));
            if let Some(text) = &self.build_log {
                std::fs::write(log, qaren::redact::redact_secrets(text)).unwrap();
            }
            let output = spec
                .args
                .iter()
                .position(|a| a == "--output")
                .filter(|_| !self.omit_app)
                .map(|i| PathBuf::from(&spec.args[i + 1]));
            if let Some(output) = &output {
                assert_eq!(output, &run_dir.join("ios-build"));
            }
            child.stdin = Box::new(BuildStart {
                stdin: child.stdin,
                run_dir,
                output,
            });
        }
        Ok(child)
    }
    fn sleep(&mut self, duration: std::time::Duration) {
        self.inner.sleep(duration);
    }
    fn now_epoch_ms(&self) -> u64 {
        self.inner.now_epoch_ms()
    }
    fn commands_executed(&self) -> u64 {
        self.inner.commands_executed()
    }
}
