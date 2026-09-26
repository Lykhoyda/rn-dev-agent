use serde::Serialize;
use std::ffi::OsString;
use std::io::Write;

pub const HELPER_ARG: &str = "--internal-process-observation";

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Birth {
    pub seconds: u64,
    pub micros: u64,
}

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Observation {
    v: u8,
    pub pid: i32,
    pub birth: Birth,
    pub executable: String,
}

#[cfg(any(test, target_os = "macos"))]
fn valid_path(path: &str) -> bool {
    path.starts_with('/') && path.len() < 4096 && !path.chars().any(char::is_control)
}

#[cfg(any(test, target_os = "macos"))]
fn valid_birth(seconds: u64, micros: u64) -> bool {
    seconds > 0 && micros < 1_000_000
}

pub fn run_helper(args: &[OsString]) -> u8 {
    let observation = if args.len() == 2 && args[0] == HELPER_ARG {
        args[1]
            .to_str()
            .and_then(|pid| pid.parse::<i32>().ok())
            .filter(|pid| *pid > 0)
            .and_then(observe)
    } else {
        None
    };
    let (line, exit) = match observation {
        Some(observation) => (serde_json::to_string(&observation).unwrap(), 0),
        None => (r#"{"v":1,"status":"unknown"}"#.to_string(), 4),
    };
    if writeln!(std::io::stdout().lock(), "{line}").is_err() {
        return 4;
    }
    exit
}

#[cfg(not(target_os = "macos"))]
pub fn observe(_pid: i32) -> Option<Observation> {
    None
}

#[cfg(target_os = "macos")]
pub fn observe(pid: i32) -> Option<Observation> {
    if pid <= 0 {
        return None;
    }
    let first = identity(pid)?;
    let first_path = executable_path(pid)?;
    let second = identity(pid)?;
    let second_path = executable_path(pid)?;
    let third = identity(pid)?;
    if first != second || second != third || first_path != second_path {
        return None;
    }
    Some(Observation {
        v: 1,
        pid,
        birth: first,
        executable: first_path,
    })
}

#[cfg(target_os = "macos")]
fn identity(pid: i32) -> Option<Birth> {
    use std::mem::{size_of, MaybeUninit};
    let mut info = MaybeUninit::<libc::proc_bsdinfo>::zeroed();
    let size = size_of::<libc::proc_bsdinfo>();
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as libc::c_int,
        )
    };
    if read != size as libc::c_int {
        return None;
    }
    let info = unsafe { info.assume_init() };
    if !valid_info(pid, &info) {
        return None;
    }
    Some(Birth {
        seconds: info.pbi_start_tvsec,
        micros: info.pbi_start_tvusec,
    })
}

#[cfg(target_os = "macos")]
fn valid_info(pid: i32, info: &libc::proc_bsdinfo) -> bool {
    info.pbi_pid == pid as u32
        && info.pbi_status != libc::SZOMB
        && info.pbi_status != 0
        && valid_birth(info.pbi_start_tvsec, info.pbi_start_tvusec)
}

#[cfg(target_os = "macos")]
fn executable_path(pid: i32) -> Option<String> {
    let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    let len = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), buffer.len() as u32) };
    if len <= 0 || len as usize >= buffer.len() {
        return None;
    }
    let len = len as usize;
    let end = buffer[..=len].iter().position(|byte| *byte == 0)?;
    if end != len && end + 1 != len {
        return None;
    }
    let path = std::str::from_utf8(&buffer[..end]).ok()?;
    valid_path(path).then(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_birth_and_paths() {
        assert!(!valid_birth(0, 12));
        assert!(!valid_birth(1, 1_000_000));
        assert!(valid_birth(1, 999_999));
        for path in [
            "",
            "relative",
            "/line\nbreak",
            "/nul\0byte",
            "/tab\t",
            &"/a".repeat(4096),
        ] {
            assert!(!valid_path(path));
        }
        assert!(valid_path(
            "/Applications/Test App.app/Contents/MacOS/テスト"
        ));
    }

    #[test]
    fn invalid_pids_never_produce_evidence() {
        assert!(observe(0).is_none());
        assert!(observe(-1).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn identity_rejects_reused_pid_zombie_and_invalid_birth() {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        info.pbi_pid = 42;
        info.pbi_status = libc::SRUN;
        info.pbi_start_tvsec = 123;
        info.pbi_start_tvusec = 999_999;
        assert!(valid_info(42, &info));
        assert!(!valid_info(43, &info));
        info.pbi_status = libc::SZOMB;
        assert!(!valid_info(42, &info));
        info.pbi_status = libc::SRUN;
        info.pbi_start_tvusec = 1_000_000;
        assert!(!valid_info(42, &info));
    }
}
