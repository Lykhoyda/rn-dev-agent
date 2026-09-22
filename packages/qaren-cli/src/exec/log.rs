use std::io::{self, Read, Write};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub const HELPER_ARG: &str = "--internal-redact-log";
const DRAIN_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_LINE: usize = 64 * 1024;

pub(super) struct LogDrain {
    child: Child,
    control: UnixStream,
}

impl LogDrain {
    pub(super) fn spawn(executable: &Path, path: &Path) -> io::Result<(Self, UnixStream)> {
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        let (input, output) = UnixStream::pair()?;
        let (control, child_control) = UnixStream::pair()?;
        control.set_read_timeout(Some(DRAIN_TIMEOUT))?;
        control.set_write_timeout(Some(DRAIN_TIMEOUT))?;
        // A separate group drains through target SIGKILL and survives a detached prepare.
        let child = Command::new(executable)
            .arg(HELPER_ARG)
            .stdin(Stdio::from(OwnedFd::from(input)))
            .stdout(Stdio::from(OwnedFd::from(child_control)))
            .stderr(log)
            .process_group(0)
            .spawn()?;
        let mut drain = Self { child, control };
        if let Err(error) = drain.flush() {
            drop(output);
            return Err(error);
        }
        Ok((drain, output))
    }

    pub(super) fn flush(&mut self) -> io::Result<()> {
        let deadline = Instant::now() + DRAIN_TIMEOUT;
        if let Some(status) = self.child.try_wait()? {
            return if status.success() {
                Ok(())
            } else {
                Err(io::Error::other("log redactor failed"))
            };
        }
        let sent = self.control.write_all(&[1]);
        let mut ack = [0];
        if sent.is_ok() && self.control.read_exact(&mut ack).is_ok() && ack == [1] {
            return Ok(());
        }
        // EOF can race the checkpoint when the target just closed both streams.
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait()? {
                return if status.success() {
                    Ok(())
                } else {
                    Err(io::Error::other("log redactor failed"))
                };
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "log redactor did not drain",
        ))
    }
}

impl Drop for LogDrain {
    fn drop(&mut self) {
        let _ = self.flush();
    }
}

#[derive(Default)]
struct Lines {
    pending: Vec<u8>,
    dropping: bool,
}

impl Lines {
    fn write(&mut self, bytes: &[u8], log: &mut impl Write) -> io::Result<()> {
        for &byte in bytes {
            if !self.dropping {
                self.pending.push(byte);
                if self.pending.len() == MAX_LINE {
                    self.pending.clear();
                    self.dropping = true;
                    log.write_all(b"[oversized log line withheld]\n")?;
                }
            }
            if byte == b'\n' || byte == b'\r' {
                self.finish(log)?;
                self.dropping = false;
            }
        }
        Ok(())
    }

    fn finish(&mut self, log: &mut impl Write) -> io::Result<()> {
        log.write_all(
            crate::redact::redact_secrets(&String::from_utf8_lossy(&self.pending)).as_bytes(),
        )?;
        self.pending.clear();
        log.flush()
    }
}

pub fn run_helper() -> io::Result<()> {
    if std::env::var("TYPESAFE_API_KEY").is_ok_and(|key| key.contains(['\r', '\n'])) {
        return Err(io::Error::other(
            "cannot stream-redact a multiline configured key",
        ));
    }
    let mut input = UnixStream::from(std::io::stdin().as_fd().try_clone_to_owned()?);
    let mut control = UnixStream::from(std::io::stdout().as_fd().try_clone_to_owned()?);
    input.set_nonblocking(true)?;
    control.set_nonblocking(true)?;
    let mut log = std::io::stderr().lock();
    let mut lines = Lines::default();
    let mut buf = [0; 8192];
    let mut checkpoint = false;
    loop {
        if !checkpoint {
            match control.read(&mut buf[..1]) {
                Ok(1) => checkpoint = true,
                Ok(_) => {}
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == io::ErrorKind::ConnectionReset => {}
                Err(e) => return Err(e),
            }
        }
        let mut eof = false;
        let mut progress = false;
        for _ in 0..128 {
            match input.read(&mut buf) {
                Ok(0) => {
                    eof = true;
                    break;
                }
                Ok(n) => {
                    lines.write(&buf[..n], &mut log)?;
                    progress = true;
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
        if eof {
            lines.finish(&mut log)?;
        }
        // A checkpoint covers this bounded prefix, not eventual producer silence.
        if checkpoint {
            log.flush()?;
            if let Err(e) = control.write_all(&[1]) {
                if !matches!(
                    e.kind(),
                    io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                ) {
                    return Err(e);
                }
            }
            checkpoint = false;
        }
        if eof {
            return Ok(());
        }
        if progress {
            std::thread::yield_now();
        } else {
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
