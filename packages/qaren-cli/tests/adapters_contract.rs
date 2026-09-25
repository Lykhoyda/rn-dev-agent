use qaren::adapters::{android, ios, metro};
use qaren::exec::CmdOutput;
use std::path::Path;

#[test]
fn app_inventory_conversion_is_private_stdin_only_and_uses_exact_bundle_lookup() {
    let plist = include_str!("fixtures/installed-apps.plist");
    let converted = r#"{"com.rndevagent.testapp":{"CFBundleIdentifier":"com.rndevagent.testapp","Path":"/private/fixture/Applications/Test.app"},"com.private.unrelated":{"CFBundleIdentifier":"com.private.unrelated","DataContainer":"file:///private/fixture/Data/OTHER"}}"#;
    for (app, expected) in [
        ("com.rndevagent.testapp", ios::AppPresence::Installed),
        ("com.rndevagent", ios::AppPresence::ProvenAbsent),
    ] {
        let mut mock = qaren::exec::MockRunner::new();
        mock.expect_run(
            "xcrun simctl listapps selected-udid",
            CmdOutput::success(plist),
        );
        mock.expect_run("plutil -convert json -o - -", CmdOutput::success(converted));
        assert_eq!(
            ios::probe_app_presence(&mut mock, "selected-udid", app),
            expected
        );
        assert_eq!(
            mock.private_inputs,
            [Vec::<u8>::new(), plist.as_bytes().to_vec()]
        );
        assert_eq!(mock.calls[0].args, ["simctl", "listapps", "selected-udid"]);
        assert_eq!(mock.calls[1].args, ["-convert", "json", "-o", "-", "-"]);
        assert_eq!(mock.calls[1].timeout_seconds, 10);
        assert!(mock.spawned_logs.is_empty());
        assert!(!serde_json::to_string(&mock.calls)
            .unwrap()
            .contains("com.private.unrelated"));
    }
}

// Captured verbatim from `ssh nuc '~/bin/android-farm status'` on 2026-08-12.
const FARM_STATUS: &str = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=free state=down\nslot=2 avd=Pixel_10_Pro serial=emulator-5556 adb_port=5557 lease=free state=down\n";

#[test]
fn farm_status_parses_recorded_output() {
    let slot = android::parse_slot_status(FARM_STATUS, 1).unwrap();
    assert_eq!(slot.avd, "Pixel_10a");
    assert_eq!(slot.serial, "emulator-5554");
    assert_eq!(slot.adb_port, 5555);
    assert_eq!(slot.lease, "free");
    assert_eq!(slot.state, "down");
    let slot2 = android::parse_slot_status(FARM_STATUS, 2).unwrap();
    assert_eq!(slot2.adb_port, 5557);
    assert!(android::parse_slot_status(FARM_STATUS, 3).is_none());
}

#[test]
fn farm_status_parses_leased_slot_with_flattened_leasefile() {
    let leased = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=qaren-nuc-android-20260812T160000Z claimed_at=2026-08-12T16:00:00Z avd=Pixel_10a serial=emulator-5554 adb_port=5555 state=device\n";
    let slot = android::parse_slot_status(leased, 1).unwrap();
    assert_eq!(
        android::lease_holder_token(&slot.lease),
        "qaren-nuc-android-20260812T160000Z"
    );
    assert_eq!(slot.state, "device");
}

#[test]
fn farm_status_fields_come_from_the_authoritative_prefix_not_lease_noise() {
    // Everything after lease= is flattened lease-file content; the parser must
    // take the first occurrence of each field (the farm-emitted prefix).
    let adversarial = "slot=1 avd=Pixel_10a serial=emulator-5554 adb_port=5555 lease=evil avd=Fake serial=usb-PHONE adb_port=9999 state=device\n";
    let slot = android::parse_slot_status(adversarial, 1).unwrap();
    assert_eq!(slot.avd, "Pixel_10a");
    assert_eq!(slot.serial, "emulator-5554");
    assert_eq!(slot.adb_port, 5555);
    assert_eq!(android::lease_holder_token(&slot.lease), "evil");
}

#[test]
fn farm_status_rejects_malformed_lines() {
    assert!(android::parse_slot_status(
        "slot=1 avd= serial=emulator-5554 adb_port=5555 lease=free state=down",
        1
    )
    .is_none());
    assert!(android::parse_slot_status(
        "slot=1 avd=Pixel serial=usb-SERIAL adb_port=5555 lease=free state=down",
        1
    )
    .is_none());
    assert!(android::parse_slot_status(
        "slot=1 avd=Pixel serial=emulator-5554 adb_port=0 lease=free state=down",
        1
    )
    .is_none());
    assert!(android::parse_slot_status(
        "slot=1 avd=Pixel serial=emulator-5554 adb_port=5555 lease=free",
        1
    )
    .is_none());
}

#[test]
fn farm_start_output_parses() {
    let started = android::parse_started(
        "started slot=1 serial=emulator-5554 adb_port=5555 lease=qaren-x\nmac_tunnel: ssh -N ...\n",
        1,
    )
    .unwrap();
    assert_eq!(started.serial, "emulator-5554");
    assert_eq!(started.adb_port, 5555);
    assert_eq!(started.lease, "qaren-x");
    assert!(android::parse_started("error: slot 1 already leased by: someone", 1).is_none());
    assert!(
        android::parse_started("started slot=1 serial=usb-PHONE adb_port=5555 lease=x", 1)
            .is_none()
    );
    assert!(
        android::parse_started("started slot=1 serial=emulator-5554 adb_port=0 lease=x", 1)
            .is_none()
    );
    assert!(android::parse_started(
        "started slot=2 serial=emulator-5556 adb_port=5557 lease=x",
        1
    )
    .is_none());
    assert!(android::parse_started("started slot=1 serial= adb_port=5555 lease=x", 1).is_none());
}

#[test]
fn farm_commands_are_exact() {
    let status = android::farm_status_spec("nuc", "bin/android-farm");
    assert_eq!(status.program, "ssh");
    assert_eq!(
        status.args,
        vec![
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            "nuc",
            "~/bin/android-farm",
            "status"
        ]
    );
    let start = android::farm_start_spec("nuc", "bin/android-farm", 1, "qaren-run", 420);
    assert_eq!(
        start.args,
        vec![
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            "nuc",
            "~/bin/android-farm",
            "start",
            "1",
            "qaren-run"
        ]
    );
    assert_eq!(start.timeout_seconds, 480);
    let stop = android::farm_stop_spec("nuc", "bin/android-farm", 2);
    assert_eq!(
        stop.args,
        vec![
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            "--",
            "nuc",
            "~/bin/android-farm",
            "stop",
            "2"
        ]
    );
}

#[test]
fn tunnel_binds_loopback_only() {
    let tunnel = android::tunnel_spec("nuc", 5555);
    assert!(tunnel
        .args
        .contains(&"127.0.0.1:5555:127.0.0.1:5555".to_string()));
    assert!(tunnel
        .args
        .contains(&"ExitOnForwardFailure=yes".to_string()));
    assert!(tunnel.args.contains(&"-N".to_string()));
}

#[test]
fn adb_commands_pin_the_serial_and_private_server() {
    let adb = Path::new("/sdk/platform-tools/adb");
    for spec in [
        android::adb_get_state_spec(adb, 15037, "127.0.0.1:5555"),
        android::pm_path_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp"),
        android::pidof_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp"),
    ] {
        assert_eq!(spec.args[0], "-s", "{} must pin -s", spec.label);
        assert_eq!(spec.args[1], "127.0.0.1:5555");
        assert!(
            spec.env.contains(&(
                "ADB_SERVER_SOCKET".to_string(),
                "tcp:127.0.0.1:15037".to_string()
            )),
            "{} must address the private adb server",
            spec.label
        );
    }
    for spec in [
        android::adb_connect_spec(adb, 15037, "127.0.0.1:5555"),
        android::adb_disconnect_spec(adb, 15037, "127.0.0.1:5555"),
    ] {
        assert_eq!(spec.args[1], "127.0.0.1:5555");
        assert!(spec.env.contains(&(
            "ADB_SERVER_SOCKET".to_string(),
            "tcp:127.0.0.1:15037".to_string()
        )));
    }
}

#[test]
fn private_adb_server_binds_loopback_with_vendor_key() {
    let adb = Path::new("/sdk/platform-tools/adb");
    let spec = android::adb_server_spec(
        adb,
        15037,
        "127.0.0.1:5555",
        Path::new("/runs/x/nuc-adbkey"),
    );
    assert_eq!(
        spec.args,
        vec![
            "--one-device",
            "127.0.0.1:5555",
            "-L",
            "tcp:15037",
            "server",
            "nodaemon"
        ]
    );
    assert!(spec.env.contains(&(
        "ADB_VENDOR_KEYS".to_string(),
        "/runs/x/nuc-adbkey".to_string()
    )));
}

#[test]
fn tunneled_serial_allowlist() {
    assert!(android::is_tunneled_serial("127.0.0.1:5555"));
    assert!(!android::is_tunneled_serial("emulator-5554"));
    assert!(!android::is_tunneled_serial("R58M12ABCDE"));
    assert!(!android::is_tunneled_serial("127.0.0.1:0"));
    assert!(!android::is_tunneled_serial("192.168.1.4:5555"));
}

#[test]
fn android_build_command_pins_device_port_and_serial_env() {
    let spec = android::build_spec(
        Path::new("/repo/test-app"),
        "127.0.0.1:5555",
        15037,
        8792,
        2400,
    );
    assert_eq!(spec.program, "pnpm");
    assert_eq!(
        spec.args,
        vec!["exec", "expo", "run:android", "--port", "8792"]
    );
    assert!(spec
        .env
        .contains(&("ANDROID_SERIAL".to_string(), "127.0.0.1:5555".to_string())));
    assert!(spec.env.contains(&(
        "ADB_SERVER_SOCKET".to_string(),
        "tcp:127.0.0.1:15037".to_string()
    )));
    assert!(spec.env.contains(&("CI".to_string(), "1".to_string())));
    assert_eq!(spec.cwd.as_deref(), Some(Path::new("/repo/test-app")));
    assert_eq!(spec.timeout_seconds, 2400);
}

#[test]
fn ios_build_command_pins_udid_and_port() {
    let spec = ios::build_spec(Path::new("/repo/test-app"), "ABCD-UDID", 8791, 2400);
    assert_eq!(
        spec.args,
        vec![
            "exec",
            "expo",
            "run:ios",
            "--device",
            "ABCD-UDID",
            "--port",
            "8791"
        ]
    );
    assert!(spec.env.contains(&("CI".to_string(), "1".to_string())));
    assert_eq!(spec.timeout_seconds, 2400);
}

#[test]
fn ios_sim_lifecycle_commands_are_exact() {
    assert_eq!(
        ios::create_spec("qaren-run1", "devtype", "runtime").args,
        vec!["simctl", "create", "qaren-run1", "devtype", "runtime"]
    );
    let bootstatus = ios::bootstatus_spec("UDID", 420);
    assert_eq!(bootstatus.args, vec!["simctl", "bootstatus", "UDID", "-b"]);
    assert_eq!(bootstatus.timeout_seconds, 420);
    assert_eq!(
        ios::shutdown_spec("UDID").args,
        vec!["simctl", "shutdown", "UDID"]
    );
    assert_eq!(
        ios::delete_spec("UDID").args,
        vec!["simctl", "delete", "UDID"]
    );
    assert_eq!(
        ios::app_container_spec("UDID", "com.x.y").args,
        vec!["simctl", "get_app_container", "UDID", "com.x.y", "app"]
    );
}

#[test]
fn sim_presence_parses_simctl_json() {
    let json = r#"{"devices":{"com.apple.CoreSimulator.SimRuntime.iOS-26-4":[
        {"udid":"AAAA","name":"qaren-run1","state":"Booted"},
        {"udid":"BBBB","name":"other","state":"Shutdown"}]}}"#;
    assert_eq!(
        ios::parse_sim_presence(json, "AAAA"),
        ios::SimPresence::Present {
            name: "qaren-run1".to_string(),
            state: "Booted".to_string()
        }
    );
    assert_eq!(
        ios::parse_sim_presence(json, "CCCC"),
        ios::SimPresence::Absent
    );
    assert_eq!(
        ios::parse_sim_presence("not json", "AAAA"),
        ios::SimPresence::Unparseable
    );
    let missing_name = r#"{"devices":{"rt":[{"udid":"AAAA","state":"Booted"}]}}"#;
    assert_eq!(
        ios::parse_sim_presence(missing_name, "AAAA"),
        ios::SimPresence::Unparseable
    );
}

#[test]
fn selected_ios_simulator_requires_unique_canonical_available_stable_metadata() {
    let udid = "1DC408C4-51DA-4C4F-ACA1-39881C916FDD";
    let runtime = "com.apple.CoreSimulator.SimRuntime.iOS-26-5";
    let device_type = "com.apple.CoreSimulator.SimDeviceType.iPhone-17";
    let sim = serde_json::json!({"udid":udid,"name":"selected","state":"Shutdown",
        "isAvailable":true,"deviceTypeIdentifier":device_type});
    let inventory = |rt: &str, entries: Vec<serde_json::Value>| {
        serde_json::json!({"devices":{rt:entries}}).to_string()
    };
    for (state, expected) in [
        ("Shutdown", ios::SimState::Shutdown),
        ("Booted", ios::SimState::Booted),
    ] {
        let mut entry = sim.clone();
        entry["state"] = state.into();
        let selected =
            ios::parse_selected_sim(&inventory(runtime, vec![entry]), &udid.to_lowercase())
                .unwrap();
        assert_eq!(selected.udid, udid);
        assert_eq!(selected.name, "selected");
        assert_eq!(selected.device_type, device_type);
        assert_eq!(selected.runtime, runtime);
        assert_eq!(selected.state, expected);
    }
    for (field, value) in [
        ("udid", serde_json::json!(udid.to_lowercase())),
        ("udid", serde_json::json!("not-a-uuid")),
        (
            "udid",
            serde_json::json!("76709EFC-0104-4A66-8908-F4F85A76F025"),
        ),
        ("name", serde_json::json!("")),
        ("name", serde_json::json!("   ")),
        ("deviceTypeIdentifier", serde_json::json!("")),
        ("deviceTypeIdentifier", serde_json::json!(42)),
        ("isAvailable", serde_json::json!(false)),
        ("isAvailable", serde_json::json!("true")),
        ("state", serde_json::json!("Booting")),
        ("state", serde_json::json!("Shutting Down")),
        ("state", serde_json::json!("Unknown")),
    ] {
        let mut entry = sim.clone();
        entry[field] = value;
        assert!(
            ios::parse_selected_sim(&inventory(runtime, vec![entry]), udid).is_none(),
            "{field}"
        );
    }
    for field in [
        "udid",
        "name",
        "state",
        "isAvailable",
        "deviceTypeIdentifier",
    ] {
        let mut entry = sim.clone();
        entry.as_object_mut().unwrap().remove(field);
        assert!(
            ios::parse_selected_sim(&inventory(runtime, vec![entry]), udid).is_none(),
            "missing {field}"
        );
    }
    let mut lowercase = sim.clone();
    lowercase["udid"] = udid.to_lowercase().into();
    for json in [
        "not json".into(), "{}".into(), r#"{"devices":[]}"#.into(),
        r#"{"devices":{"bad":{}}}"#.into(),
        inventory(runtime, vec![]),
        inventory(runtime, vec![sim.clone(), sim.clone()]),
        inventory(runtime, vec![sim.clone(), lowercase]),
        inventory("", vec![sim.clone()]),
        inventory("com.apple.CoreSimulator.SimRuntime.iOS-", vec![sim.clone()]),
        inventory("com.apple.CoreSimulator.SimRuntime.watchOS-26-5", vec![sim.clone()]),
        inventory("com.apple.CoreSimulator.SimRuntime.tvOS-26-5", vec![sim.clone()]),
        serde_json::json!({"devices":{runtime:[sim.clone()], "com.apple.CoreSimulator.SimRuntime.watchOS-26-5":[sim.clone()]}}).to_string(),
    ] {
        assert!(ios::parse_selected_sim(&json, udid).is_none(), "{json}");
    }
    for invalid in [
        "",
        "booted",
        "selected",
        "1DC408C451DA4C4FACA139881C916FDD",
        "1DC408C4-51DA-4C4F-ACA1-39881C916FDG",
    ] {
        assert!(ios::parse_selected_sim(&inventory(runtime, vec![sim.clone()]), invalid).is_none());
    }
}

#[test]
fn launchctl_parsing_requires_live_pid_and_exact_label() {
    let running = "512\t0\tUIKitApplication:com.rndevagent.testapp[a1b2][rb-legacy]";
    assert!(ios::app_running_in_launchctl(
        running,
        "com.rndevagent.testapp"
    ));
    let dead = "-\t0\tUIKitApplication:com.rndevagent.testapp[a1b2][rb-legacy]";
    assert!(!ios::app_running_in_launchctl(
        dead,
        "com.rndevagent.testapp"
    ));
    let other_app = "512\t0\tUIKitApplication:com.rndevagent.testapp.other[a1b2]";
    assert!(!ios::app_running_in_launchctl(
        other_app,
        "com.rndevagent.testapp"
    ));
}

#[test]
fn port_owner_parsing_is_strict() {
    let free = CmdOutput {
        exit_code: Some(1),
        ..Default::default()
    };
    assert_eq!(metro::parse_port_owner(&free), metro::PortOwners::Free);
    let owned = CmdOutput::success("4242\n");
    assert_eq!(
        metro::parse_port_owner(&owned),
        metro::PortOwners::Owned(4242)
    );
    let multiple = CmdOutput::success("4242\n4243\n");
    assert_eq!(
        metro::parse_port_owner(&multiple),
        metro::PortOwners::Multiple
    );
    let garbled = CmdOutput::success("4242\nnot-a-pid\n");
    assert_eq!(
        metro::parse_port_owner(&garbled),
        metro::PortOwners::Unknown
    );
    let error_exit = CmdOutput::failed(2, "lsof: bad flag");
    assert_eq!(
        metro::parse_port_owner(&error_exit),
        metro::PortOwners::Unknown
    );
    let exit1_with_stderr = CmdOutput {
        exit_code: Some(1),
        stderr: "warning".to_string(),
        ..Default::default()
    };
    assert_eq!(
        metro::parse_port_owner(&exit1_with_stderr),
        metro::PortOwners::Unknown
    );
    let timed_out = CmdOutput {
        timed_out: true,
        ..Default::default()
    };
    assert_eq!(
        metro::parse_port_owner(&timed_out),
        metro::PortOwners::Unknown
    );
}

#[test]
fn holder_and_sim_name_derive_from_run_id() {
    assert_eq!(
        android::holder("nuc-android-20260812T160000Z"),
        "qaren-nuc-android-20260812T160000Z"
    );
    assert_eq!(
        ios::sim_name("ios-simulator-20260812T160000Z"),
        "qaren-ios-simulator-20260812T160000Z"
    );
}

#[test]
fn app_removal_commands_are_exact_and_routed_through_the_private_server() {
    let adb = Path::new("/sdk/platform-tools/adb");
    let private = (
        "ADB_SERVER_SOCKET".to_string(),
        "tcp:127.0.0.1:15037".to_string(),
    );
    let apk = "/data/app/~~AbC==/com.rndevagent.testapp-XyZ==/base.apk";

    let list =
        android::pm_list_packages_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp");
    assert_eq!(list.label, "adb-pm-list-packages");
    assert_eq!(list.program, "/sdk/platform-tools/adb");
    assert_eq!(
        list.args,
        vec![
            "-s",
            "127.0.0.1:5555",
            "shell",
            "pm",
            "list",
            "packages",
            "com.rndevagent.testapp"
        ]
    );
    assert_eq!(list.env, vec![private.clone()]);

    let hash = android::sha256sum_spec(adb, 15037, "127.0.0.1:5555", apk);
    assert_eq!(hash.label, "adb-sha256sum");
    assert_eq!(
        hash.args,
        vec!["-s", "127.0.0.1:5555", "shell", "sha256sum", apk]
    );
    assert_eq!(hash.env, vec![private.clone()]);

    let uninstall = android::uninstall_spec(adb, 15037, "127.0.0.1:5555", "com.rndevagent.testapp");
    assert_eq!(uninstall.label, "adb-uninstall");
    assert_eq!(
        uninstall.args,
        vec![
            "-s",
            "127.0.0.1:5555",
            "uninstall",
            "com.rndevagent.testapp"
        ],
        "no -k: the app's data must go with the package"
    );
    assert_eq!(uninstall.env, vec![private]);
    assert_eq!(uninstall.timeout_seconds, 120);
}

#[test]
fn app_removal_parsers_are_strict() {
    let apk = "/data/app/~~AbC-1==/com.rndevagent.testapp-XyZ_2==/base.apk";
    assert_eq!(
        android::pm_path_packages(&format!("package:{apk}\n")),
        vec![apk.to_string()]
    );
    assert!(android::pm_path_packages("").is_empty());
    assert!(android::pm_path_packages("error: device offline\n").is_empty());

    assert!(android::is_user_base_apk_path(apk));
    assert!(android::is_user_base_apk_path(
        "/data/app/com.foo-1/base.apk"
    ));
    for bad in [
        "/system/priv-app/Foo/base.apk",
        "/data/app/../../system/base.apk",
        "/data/app/x/split_config.arm64_v8a.apk",
        "/data/app/x/base.apk; rm -rf /",
        "/data/app/x/base.apk\n/data/app/y/base.apk",
        "/data/app/x y/base.apk",
        "",
    ] {
        assert!(!android::is_user_base_apk_path(bad), "{bad:?}");
    }

    let sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    assert_eq!(
        android::parse_sha256sum(&format!("{sha}  {apk}\n"), apk).as_deref(),
        Some(sha)
    );
    assert_eq!(
        android::parse_sha256sum(&format!("{}  {apk}\n", sha.to_uppercase()), apk).as_deref(),
        Some(sha),
        "hex case is normalised"
    );
    for bad in [
        format!("{sha}  /data/app/other/base.apk\n"),
        format!("{sha}\n"),
        format!("{}  {apk}\n", &sha[..63]),
        format!("{sha}  {apk}\n{sha}  {apk}\n"),
        format!("{sha}  {apk} trailing\n"),
        "sha256sum: No such file or directory\n".to_string(),
        String::new(),
    ] {
        assert!(android::parse_sha256sum(&bad, apk).is_none(), "{bad:?}");
    }

    assert!(android::package_list_has_exact(
        "package:com.rndevagent.testapp.dev\npackage:com.rndevagent.testapp\n",
        "com.rndevagent.testapp"
    ));
    assert!(!android::package_list_has_exact(
        "package:com.rndevagent.testapp.dev\n",
        "com.rndevagent.testapp"
    ));
    assert!(!android::package_list_has_exact(
        "",
        "com.rndevagent.testapp"
    ));
}
