use qaren::cancel;
use qaren::exec::{RealRunner, Runner};
use std::time::Duration;

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
    let sent = std::process::Command::new("/bin/kill")
        .args(["-TERM", &std::process::id().to_string()])
        .status()
        .unwrap();
    assert!(sent.success());
    for _ in 0..200 {
        if cancel::caught() != 0 {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(cancel::caught(), libc::SIGTERM);
    assert_eq!(runner.cancellation().as_deref(), Some("received SIGTERM"));
}
