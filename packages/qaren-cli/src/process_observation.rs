use serde::Serialize;
use std::ffi::OsString;
use std::io::Write;

pub const HELPER_ARG: &str = "--internal-process-observation";
const ARGV_ARG: &str = "--argv";
// Keeps the helper's JSON inside the caller's 32 KiB output buffer even when escaped.
const ARGV_LIMIT: usize = 8 * 1024;

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
}

// KERN_PROCARGS2 is argc, the exec path, NUL padding, argv, then the environment,
// which is never read.
#[cfg(any(test, target_os = "macos"))]
fn parse_procargs(buffer: &[u8]) -> Option<Vec<String>> {
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    if !(1..=4096).contains(&argc) {
        return None;
    }
    let mut rest = &buffer[4..];
    rest = &rest[rest.iter().position(|byte| *byte == 0)?..];
    rest = &rest[rest.iter().position(|byte| *byte != 0)?..];
    let mut argv = Vec::with_capacity(argc as usize);
    let mut total = 0;
    for _ in 0..argc {
        let end = rest.iter().position(|byte| *byte == 0)?;
        total += end;
        if total > ARGV_LIMIT {
            return None;
        }
        argv.push(std::str::from_utf8(&rest[..end]).ok()?.to_string());
        rest = &rest[end + 1..];
    }
    Some(argv)
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
    let with_argv = args.len() == 3 && args[2] == ARGV_ARG;
    let observation = if (args.len() == 2 || with_argv) && args[0] == HELPER_ARG {
        args[1]
            .to_str()
            .and_then(|pid| pid.parse::<i32>().ok())
            .filter(|pid| *pid > 0)
            .and_then(|pid| observe(pid, with_argv))
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
pub fn observe(_pid: i32, _with_argv: bool) -> Option<Observation> {
    None
}

#[cfg(target_os = "macos")]
pub fn observe(pid: i32, with_argv: bool) -> Option<Observation> {
    if pid <= 0 {
        return None;
    }
    let first = identity(pid)?;
    let first_path = executable_path(pid)?;
    let argv = if with_argv {
        Some(arguments(pid)?)
    } else {
        None
    };
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
        argv,
    })
}

#[cfg(target_os = "macos")]
fn arguments(pid: i32) -> Option<Vec<String>> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            (&mut argmax as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 || argmax <= 0 {
        return None;
    }
    let mut buffer = vec![0u8; argmax as usize];
    let mut size = buffer.len();
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let read = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            buffer.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if read != 0 || size > buffer.len() {
        return None;
    }
    parse_procargs(&buffer[..size])
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
        for with_argv in [false, true] {
            assert!(observe(0, with_argv).is_none());
            assert!(observe(-1, with_argv).is_none());
        }
    }

    fn procargs(argc: i32, path: &str, padding: usize, args: &[&str], env: &[&str]) -> Vec<u8> {
        let mut buffer = argc.to_ne_bytes().to_vec();
        buffer.extend_from_slice(path.as_bytes());
        buffer.extend(std::iter::repeat_n(0u8, padding));
        for part in args.iter().chain(env) {
            buffer.extend_from_slice(part.as_bytes());
            buffer.push(0);
        }
        buffer
    }

    #[test]
    fn procargs_reads_exactly_argc_strings_and_never_the_environment() {
        let args = [
            "xcodebuild",
            "-destination",
            "platform=iOS Simulator,id=AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB",
        ];
        let buffer = procargs(
            3,
            "/usr/bin/xcodebuild",
            3,
            &args,
            &["TYPESAFE_API_KEY=secret", "HOME=/Users/x"],
        );
        let parsed = parse_procargs(&buffer).unwrap();
        assert_eq!(parsed, args);
        assert!(!format!("{parsed:?}").contains("secret"));
    }

    #[test]
    fn procargs_fail_closed_on_malformed_or_oversized_buffers() {
        assert_eq!(parse_procargs(&[1, 0]), None);
        assert_eq!(parse_procargs(&procargs(0, "/bin/x", 1, &[], &[])), None);
        assert_eq!(
            parse_procargs(&procargs(3, "/bin/x", 1, &["a", "b"], &[])),
            None
        );
        let big = "x".repeat(ARGV_LIMIT + 1);
        assert_eq!(
            parse_procargs(&procargs(1, "/bin/x", 1, &[&big], &[])),
            None
        );
        let mut invalid = procargs(1, "/bin/x", 1, &["ok"], &[]);
        let at = invalid.len() - 2;
        invalid[at] = 0xff;
        assert_eq!(parse_procargs(&invalid), None);
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
