use crate::commands::cleanup::{cleanup_process_group, Outcome};
use crate::exec::{CmdSpec, Runner};
use crate::runrecord::{
    capture_pid_identity, probe_pid_identity, PidLiveness, RecorderKind, RecorderResource,
    RunRecord,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Duration;

const START_WAIT_MS: u64 = 10_000;
const STOP_WAIT_MS: u64 = 30_000;
const POLL_MS: u64 = 250;
pub const MAX_VIDEO_BYTES: u64 = 100 * 1024 * 1024;
const FFMPEG_SECONDS: u64 = 900;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VideoStatus {
    Available,
    Unavailable(String),
    TooLarge,
}

impl std::fmt::Display for VideoStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VideoStatus::Available => f.write_str("available"),
            VideoStatus::Unavailable(reason) => write!(f, "unavailable({reason})"),
            VideoStatus::TooLarge => f.write_str("too-large"),
        }
    }
}

impl std::str::FromStr for VideoStatus {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, String> {
        match s {
            "available" => Ok(VideoStatus::Available),
            "too-large" => Ok(VideoStatus::TooLarge),
            other => other
                .strip_prefix("unavailable(")
                .and_then(|r| r.strip_suffix(')'))
                .map(|r| VideoStatus::Unavailable(r.to_string()))
                .ok_or_else(|| format!("unknown video status {other}")),
        }
    }
}

impl Serialize for VideoStatus {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for VideoStatus {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        String::deserialize(d)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VideoPublication {
    Eligible,
    WithheldFill,
    WithheldPrivacy,
    #[default]
    #[serde(other)]
    Unknown,
}

impl VideoPublication {
    pub fn withholding_reason(&self) -> Option<&'static str> {
        match self {
            Self::Eligible => None,
            Self::WithheldFill => Some("the plan contains a fill or type step"),
            Self::WithheldPrivacy => Some("screenshot privacy disallowed capture during the walk"),
            Self::Unknown => Some("video publication eligibility is missing or unknown"),
        }
    }
}

fn media_dir(run_dir: &Path) -> PathBuf {
    run_dir.join("media")
}

pub fn video_path(run_dir: &Path) -> PathBuf {
    media_dir(run_dir).join("video.mp4")
}

fn segment_log(run_dir: &Path) -> PathBuf {
    run_dir.join("logs").join("recorder.log")
}

fn now_ms(runner: &dyn Runner) -> u64 {
    runner.monotonic_ms()
}

fn record_spec(udid: &str, raw: &Path) -> CmdSpec {
    CmdSpec::new(
        "simctl-record-video",
        "xcrun",
        &[
            "simctl",
            "io",
            udid,
            "recordVideo",
            "--codec",
            "h264",
            "--force",
            &raw.to_string_lossy(),
        ],
        0,
    )
}

// ⑧: persisted before the spawn; any failure leaves the run going without video.
pub fn start(
    runner: &mut dyn Runner,
    record: &mut RunRecord,
    runs_root: &Path,
    udid: &str,
) -> Result<(), VideoStatus> {
    let run_dir = RunRecord::run_dir(runs_root, &record.run_id);
    let unavailable = |why: &str| VideoStatus::Unavailable(why.to_string());
    std::fs::create_dir_all(media_dir(&run_dir)).map_err(|_| unavailable("media directory"))?;
    let raw = media_dir(&run_dir).join("raw.mov");
    let spec = record_spec(udid, &raw);
    record.resources.recorder = Some(RecorderResource {
        pid: None,
        birth: None,
        kind: RecorderKind::IosSimulator,
        device: udid.to_string(),
        output: raw,
    });
    if record.save(runs_root).is_err() {
        record.resources.recorder = None;
        return Err(unavailable("run record not persisted"));
    }
    let log = segment_log(&run_dir);
    let spawned = match runner.spawn_group(&spec, &log) {
        Ok(spawned) => spawned,
        Err(_) => {
            record.resources.recorder = None;
            let _ = record.save(runs_root);
            return Err(unavailable("recorder did not spawn"));
        }
    };
    let birth = capture_pid_identity(runner, spawned.pid);
    let proven = birth.is_some();
    if let Some(recorder) = record.resources.recorder.as_mut() {
        recorder.pid = Some(spawned.pid);
        recorder.birth = birth;
    }
    // An identity cleanup cannot read back is no ownership: end our own unreaped child now.
    if !proven || record.save(runs_root).is_err() {
        runner.run(&CmdSpec::new(
            "recorder-abort",
            "/bin/kill",
            &["-KILL", "--", &format!("-{}", spawned.pgid)],
            10,
        ));
        record.resources.recorder = None;
        let _ = record.save(runs_root);
        return Err(unavailable("recorder identity was not persisted"));
    }
    let deadline = now_ms(runner) + START_WAIT_MS;
    loop {
        if std::fs::read_to_string(&log).is_ok_and(|l| l.contains("Recording started")) {
            return Ok(());
        }
        if now_ms(runner) >= deadline {
            break;
        }
        runner.sleep(Duration::from_millis(POLL_MS));
    }
    let outcome = stop(runner, record, runs_root);
    Err(unavailable(&format!(
        "recording did not start within {}s (stop: {})",
        START_WAIT_MS / 1000,
        outcome.render()
    )))
}

fn wait_gone(
    runner: &mut dyn Runner,
    birth: &crate::runrecord::PidIdentity,
    budget_ms: u64,
) -> bool {
    let deadline = now_ms(runner) + budget_ms;
    loop {
        if matches!(
            probe_pid_identity(runner, birth),
            PidLiveness::Dead | PidLiveness::AliveForeign
        ) {
            return true;
        }
        if now_ms(runner) >= deadline {
            return false;
        }
        runner.sleep(Duration::from_millis(POLL_MS));
    }
}

// ⑫: SIGINT so the container is finalized; the group is killed only if it will not exit.
pub fn stop(runner: &mut dyn Runner, record: &mut RunRecord, runs_root: &Path) -> Outcome {
    let Some(recorder) = record.resources.recorder.clone() else {
        return Outcome::Absent;
    };
    let (Some(pid), Some(birth)) = (recorder.pid, recorder.birth.as_ref()) else {
        return Outcome::Unresolved("recorder spawn identity is unproven".into());
    };
    if probe_pid_identity(runner, birth) == PidLiveness::AliveMatching {
        runner.run(&CmdSpec::new(
            "recorder-interrupt",
            "/bin/kill",
            &["-INT", &pid.to_string()],
            10,
        ));
    }
    let outcome = if wait_gone(runner, birth, STOP_WAIT_MS) {
        Outcome::Removed
    } else {
        cleanup_process_group(runner, Some(birth), pid, None)
    };
    if outcome.clean() {
        record.resources.recorder = None;
        let _ = record.save(runs_root);
    }
    outcome
}

fn ffmpeg_encode(
    runner: &mut dyn Runner,
    input: &[&str],
    out: &Path,
    bitrate: Option<u64>,
) -> bool {
    let mut args: Vec<String> = vec!["-y".into(), "-v".into(), "error".into()];
    args.extend(input.iter().map(|a| a.to_string()));
    args.extend(
        [
            "-c:v",
            "libx264",
            "-r",
            "30",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            "-an",
        ]
        .map(String::from),
    );
    if let Some(bps) = bitrate {
        args.extend(["-b:v".to_string(), bps.to_string()]);
    }
    args.push(out.to_string_lossy().into_owned());
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    runner
        .run(&CmdSpec::new(
            "ffmpeg-encode",
            "ffmpeg",
            &args,
            FFMPEG_SECONDS,
        ))
        .ok()
}

fn probe_duration_ms(runner: &mut dyn Runner, video: &Path) -> Option<u64> {
    let output = runner.run(&CmdSpec::new(
        "ffprobe-duration",
        "ffprobe",
        &[
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            &video.to_string_lossy(),
        ],
        60,
    ));
    let seconds: f64 = output.ok().then(|| output.stdout.trim().parse().ok())??;
    (seconds > 0.0).then_some((seconds * 1000.0) as u64)
}

fn size_of(path: &Path) -> u64 {
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0)
}

pub fn finalize(runner: &mut dyn Runner, run_dir: &Path) -> VideoStatus {
    let unavailable = |why: &str| VideoStatus::Unavailable(why.to_string());
    if !runner
        .run(&CmdSpec::new("which", "which", &["ffmpeg"], 10))
        .ok()
    {
        return unavailable("ffmpeg");
    }
    let media = media_dir(run_dir);
    let video = video_path(run_dir);
    let raw = media.join("raw.mov");
    if size_of(&raw) == 0 {
        return unavailable("no capture was written");
    }
    let input = ["-i".to_string(), raw.to_string_lossy().into_owned()];
    let input: Vec<&str> = input.iter().map(String::as_str).collect();
    if !ffmpeg_encode(runner, &input, &video, None) {
        return unavailable("encode failed");
    }
    let Some(duration_ms) = probe_duration_ms(runner, &video) else {
        return unavailable("ffprobe found no playable duration");
    };
    if size_of(&video) <= MAX_VIDEO_BYTES {
        return VideoStatus::Available;
    }
    // One re-encode sized to fit, with headroom for the container.
    let bitrate = MAX_VIDEO_BYTES * 8 * 9 / 10 * 1000 / duration_ms.max(1);
    let smaller = media.join("video-small.mp4");
    let source = video.to_string_lossy().into_owned();
    if ffmpeg_encode(runner, &["-i", &source], &smaller, Some(bitrate))
        && probe_duration_ms(runner, &smaller).is_some()
        && size_of(&smaller) <= MAX_VIDEO_BYTES
        && std::fs::rename(&smaller, &video).is_ok()
    {
        return VideoStatus::Available;
    }
    let _ = std::fs::remove_file(&smaller);
    VideoStatus::TooLarge
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::exec::{CmdOutput, MockRunner, Spawned};
    use std::sync::atomic::{AtomicU32, Ordering};

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_run_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qaren-record-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(media_dir(&dir)).unwrap();
        dir
    }

    fn write_raw(run_dir: &Path, bytes: usize) {
        std::fs::write(media_dir(run_dir).join("raw.mov"), vec![0u8; bytes]).unwrap();
    }

    #[test]
    fn an_ffprobe_failure_refuses_the_attachment() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut mock = MockRunner::new();
        mock.expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        mock.expect_run("ffmpeg", CmdOutput::success(""));
        mock.expect_run("ffprobe", CmdOutput::failed(1, "moov atom not found"));
        assert!(matches!(
            finalize(&mut mock, &run_dir),
            VideoStatus::Unavailable(r) if r.contains("ffprobe")
        ));
    }

    #[test]
    fn missing_ffmpeg_is_unavailable() {
        let run_dir = temp_run_dir();
        let mut mock = MockRunner::new();
        mock.expect_run("which ffmpeg", CmdOutput::failed(1, ""));
        assert_eq!(
            finalize(&mut mock, &run_dir),
            VideoStatus::Unavailable("ffmpeg".into())
        );
    }

    // A runner whose encodes write files of scripted sizes.
    struct SizedEncodes {
        mock: MockRunner,
        sizes: Vec<u64>,
    }

    impl Runner for SizedEncodes {
        fn run(&mut self, spec: &CmdSpec) -> CmdOutput {
            if spec.label == "ffmpeg-encode" {
                let out = PathBuf::from(spec.args.last().unwrap());
                let file = std::fs::File::create(&out).unwrap();
                file.set_len(self.sizes.remove(0)).unwrap();
            }
            self.mock.run(spec)
        }
        fn spawn_group(&mut self, spec: &CmdSpec, log: &Path) -> std::io::Result<Spawned> {
            self.mock.spawn_group(spec, log)
        }
        fn spawn_piped(
            &mut self,
            spec: &CmdSpec,
            log: &Path,
        ) -> std::io::Result<crate::exec::PipedChild> {
            self.mock.spawn_piped(spec, log)
        }
        fn sleep(&mut self, d: Duration) {
            self.mock.sleep(d)
        }
        fn now_epoch_ms(&self) -> u64 {
            self.mock.now_epoch_ms()
        }
        fn commands_executed(&self) -> u64 {
            self.mock.commands_executed()
        }
    }

    #[test]
    fn over_the_limit_after_one_reencode_is_too_large() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![MAX_VIDEO_BYTES + 1, MAX_VIDEO_BYTES + 1],
        };
        runner
            .mock
            .expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("60.0\n"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("60.0\n"));
        assert_eq!(finalize(&mut runner, &run_dir), VideoStatus::TooLarge);
        let reencode = &runner.mock.calls[3];
        assert!(reencode.args.contains(&"-b:v".to_string()));
        assert_eq!(runner.mock.remaining(), 0);
    }

    #[test]
    fn a_fitting_capture_is_available_with_the_reviewer_encoding() {
        let run_dir = temp_run_dir();
        write_raw(&run_dir, 10);
        let mut runner = SizedEncodes {
            mock: MockRunner::new(),
            sizes: vec![1024],
        };
        runner
            .mock
            .expect_run("which ffmpeg", CmdOutput::success("/opt/ffmpeg\n"));
        runner.mock.expect_run("ffmpeg", CmdOutput::success(""));
        runner
            .mock
            .expect_run("ffprobe", CmdOutput::success("12.5\n"));
        assert_eq!(finalize(&mut runner, &run_dir), VideoStatus::Available);
        let encode = &runner.mock.calls[1].args;
        for arg in ["libx264", "30", "yuv420p", "+faststart"] {
            assert!(encode.contains(&arg.to_string()), "{arg}: {encode:?}");
        }
    }

    #[test]
    fn video_status_round_trips_as_a_string() {
        for status in [
            VideoStatus::Available,
            VideoStatus::TooLarge,
            VideoStatus::Unavailable("ffmpeg".into()),
        ] {
            let json = serde_json::to_string(&status).unwrap();
            assert_eq!(serde_json::from_str::<VideoStatus>(&json).unwrap(), status);
        }
        assert_eq!(
            VideoStatus::Unavailable("ffmpeg".into()).to_string(),
            "unavailable(ffmpeg)"
        );
    }
}
