use qaren::cancel;
use qaren::exec::{CmdSpec, RealRunner, Runner};
use std::time::{Duration, Instant};

#[test]
fn a_changed_parent_or_a_caught_signal_cancels_the_run() {
    assert_eq!(cancel::reason(0, 4242, 4242), None);
    assert_eq!(
        cancel::reason(0, 4242, 1).as_deref(),
        Some("the calling process exited")
    );
    assert_eq!(
        cancel::reason(libc::SIGINT, 4242, 4242).as_deref(),
        Some("received SIGINT")
    );
    assert_eq!(
        cancel::reason(libc::SIGHUP, 4242, 1).as_deref(),
        Some("received SIGHUP"),
        "a signal names itself even when the caller is also gone"
    );
}

#[test]
fn the_first_signal_is_recorded_instead_of_ending_the_process() {
    cancel::install();
    let runner = RealRunner::new();
    assert_eq!(runner.cancellation(), None);
    let mut runner = runner;
    let start = Instant::now();
    let output = runner.run(&CmdSpec::new(
        "cancel-wait",
        "/bin/sh",
        &["-c", "kill -TERM \"$PPID\"; exec sleep 30"],
        60,
    ));
    assert!(!output.ok());
    assert!(start.elapsed() < Duration::from_secs(5));
    assert_eq!(cancel::caught(), libc::SIGTERM);
    assert_eq!(runner.cancellation().as_deref(), Some("received SIGTERM"));
    let executed = runner.commands_executed();
    let blocked = runner.run(&CmdSpec::new(
        "forward",
        "/bin/sh",
        &["-c", "printf forbidden"],
        5,
    ));
    assert!(!blocked.ok());
    assert!(blocked.stdout.is_empty());
    let spec = CmdSpec::new("forward-spawn", "/bin/sh", &["-c", "printf forbidden"], 5);
    assert!(runner
        .spawn_group(&spec, std::path::Path::new("unused.log"))
        .is_err());
    assert!(runner
        .spawn_piped(&spec, std::path::Path::new("unused.log"))
        .is_err());
    assert!(!runner.run_private(&spec, b"input").clean());
    assert_eq!(runner.commands_executed(), executed);
    let cleanup = runner.execute(
        &CmdSpec::new("cleanup", "/bin/sh", &["-c", "printf cleaned"], 5),
        false,
    );
    assert!(cleanup.ok());
    assert_eq!(cleanup.stdout, "cleaned");
}
