mod common;

use qaren::buildplan::{read_holder, ReleaseOutcome};
use qaren::exec::{CmdOutput, MockRunner};
use qaren::failure::FailureCode;
use qaren::lease::{acquire, lock_name, release};
use qaren::scenario::Platform;

const UDID: &str = "AAAABBBB-1111-2222-3333-444455556666";

#[test]
fn lock_name_is_one_filesystem_safe_component_per_device() {
    let wireless = lock_name(Platform::Android, "192.168.1.5:5555");
    assert!(!wireless.contains(':') && !wireless.contains('/'));
    assert!(wireless.starts_with("device-android-192.168.1.5_5555-"));
    assert_ne!(
        lock_name(Platform::Android, "a/b"),
        lock_name(Platform::Android, "a_b"),
        "the hash suffix keeps distinct ids distinct after sanitizing"
    );
    assert_ne!(
        lock_name(Platform::Ios, UDID),
        lock_name(Platform::Android, UDID)
    );
}

#[test]
fn acquire_writes_a_holder_and_release_removes_it() {
    let root = common::temp_repo().join("locks");
    let mut mock = MockRunner::new();
    let lease = acquire(
        &mut mock,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();
    assert_eq!(lease.run_id, "check-1");
    assert_eq!(lease.token.len(), 32);
    assert!(lease.token.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(lease.wire(), format!("check-1:{}", lease.token));
    let holder = read_holder(&lease.lock_dir).expect("holder.json is written");
    assert_eq!(holder.run_id, "check-1");
    assert_eq!(holder.identity.as_ref().unwrap().pid, 4242);
    assert_eq!(mock.remaining(), 0);

    assert_eq!(release(&lease), ReleaseOutcome::Removed);
    assert!(!lease.lock_dir.exists());
    assert_eq!(release(&lease), ReleaseOutcome::Absent);
}

#[test]
fn contention_is_device_busy_and_a_live_holder_is_never_stolen() {
    let root = common::temp_repo().join("locks");
    let mut first = MockRunner::new();
    let lease = acquire(
        &mut first,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();

    let mut second = MockRunner::new();
    // The holder's birth time still matches and it is not a zombie: alive.
    second.expect_run("ps", CmdOutput::success("Wed Aug 12 15:00:00 2026\n"));
    second.expect_run("ps", CmdOutput::success("S\n"));
    let failure = acquire(&mut second, &root, Platform::Ios, UDID, "check-2", None).unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.code.is_refusal());
    assert!(
        failure.detail.contains("held for run check-1"),
        "{}",
        failure.detail
    );
    assert_eq!(second.remaining(), 0);
    let holder = read_holder(&lease.lock_dir).unwrap();
    assert_eq!(holder.run_id, "check-1", "the live holder keeps the lease");
}

#[test]
fn a_dead_holder_is_still_not_adopted() {
    let root = common::temp_repo().join("locks");
    let mut first = MockRunner::new();
    let lease = acquire(
        &mut first,
        &root,
        Platform::Ios,
        UDID,
        "check-1",
        Some(common::identity(4242, "Wed Aug 12 15:00:00 2026")),
    )
    .unwrap();

    let mut second = MockRunner::new();
    second.expect_run("ps", CmdOutput::failed(1, ""));
    let failure = acquire(&mut second, &root, Platform::Ios, UDID, "check-2", None).unwrap_err();
    assert_eq!(failure.code, FailureCode::DeviceBusy);
    assert!(failure.next_action.contains("qaren cleanup"));
    assert_eq!(read_holder(&lease.lock_dir).unwrap().run_id, "check-1");
}

#[test]
fn release_refuses_a_foreign_holder() {
    let root = common::temp_repo().join("locks");
    let mut mock = MockRunner::new();
    let ours = acquire(&mut mock, &root, Platform::Ios, UDID, "check-1", None).unwrap();
    let foreign = qaren::lease::Lease {
        run_id: "check-9".to_string(),
        token: ours.token.clone(),
        lock_dir: ours.lock_dir.clone(),
        holder: "qaren-check-9".to_string(),
    };
    assert!(matches!(release(&foreign), ReleaseOutcome::Foreign(_)));
    assert!(ours.lock_dir.exists());
}
