mod common;

use qaren::failure::{Failure, FailureCode};
use qaren::receipt::{Receipt, ReceiptResult};
use qaren::redact::PRIVATE_KEY_WITHHELD;
use qaren::runrecord::{Phase, RunRecord};
use std::path::Path;

const BODY: &str = "FAKEKEYBODY";

fn raw_failure() -> Failure {
    Failure {
        phase: "allocate".to_string(),
        code: FailureCode::TunnelFailed,
        detail: format!("{BODY}1 -----end private key-----"),
        evidence: vec!["clean".to_string(), format!("PRIVATE KEY {BODY}2")],
        next_action: format!("<redacted private key> {BODY}3"),
    }
}

#[test]
fn run_json_and_receipts_withhold_key_strings_a_writer_did_not_redact() {
    let dir = common::temp_repo();
    let mut record = common::base_record(
        &dir,
        &common::ios_scenario_yaml(8793),
        "sinkrun",
        Phase::Failed,
    );
    record.failure = Some(raw_failure());
    record.save(&dir).unwrap();
    let mut receipt = Receipt::new(
        "prepare",
        "sinkrun",
        ReceiptResult::Failed,
        "allocate",
        String::new(),
    );
    receipt.failure = Some(raw_failure());
    receipt.next_action = format!("Private Key {BODY}4");
    let recorded = std::fs::read_to_string(RunRecord::path(&dir, "sinkrun")).unwrap();
    for durable in [recorded, receipt.to_json()] {
        assert!(!durable.contains(BODY), "{durable}");
        assert!(durable.contains(PRIVATE_KEY_WITHHELD), "{durable}");
        assert!(durable.contains("\"clean\""), "{durable}");
    }
    let reloaded = RunRecord::load(&dir, "sinkrun").unwrap();
    assert_eq!(reloaded.failure.unwrap().detail, PRIVATE_KEY_WITHHELD);
    std::fs::remove_dir_all(dir).unwrap();
}

fn production_source(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap();
    match text.find("#[cfg(test)]") {
        Some(at) => text[..at].to_string(),
        None => text,
    }
}

fn rust_files(dir: &Path, out: &mut Vec<std::path::PathBuf>) {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            rust_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

// Every durable file write is listed with what keeps key material out of it.
const FILE_WRITERS: &[(&str, usize, &str)] = &[
    ("buildplan.rs", 1, "durable_json"),
    ("runrecord.rs", 1, "durable_json"),
    ("handoff.rs", 1, "durable_json"),
    ("run.rs", 1, "durable_json ledger"),
    ("report.rs", 1, "every dynamic field passes redact_secrets"),
    ("exec.rs", 1, "mock runner log, redact_secrets"),
    ("exec/log.rs", 1, "log helper withholds the whole command"),
    (
        "commands/prepare.rs",
        1,
        "the vendor key file itself, mode 0600",
    ),
];

#[test]
fn no_durable_writer_bypasses_the_private_key_sink() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files = Vec::new();
    rust_files(&src, &mut files);
    let mut writers = std::collections::BTreeMap::new();
    for path in files {
        let rel = path
            .strip_prefix(&src)
            .unwrap()
            .to_string_lossy()
            .into_owned();
        let source = production_source(&path);
        if rel != "redact.rs" {
            for serializer in ["to_vec_pretty", "to_string_pretty", "to_writer"] {
                assert!(
                    !source.contains(serializer),
                    "{rel} serializes durable JSON without redact::durable_json"
                );
            }
        }
        let count =
            source.matches("fs::write(").count() + source.matches("OpenOptions::new()").count();
        if count > 0 {
            writers.insert(rel, count);
        }
    }
    let expected = FILE_WRITERS
        .iter()
        .map(|(file, count, _)| (file.to_string(), *count))
        .collect();
    assert_eq!(
        writers, expected,
        "a durable file writer changed; route it through the private-key sink and list it here"
    );
}
