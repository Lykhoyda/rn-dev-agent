use qaren::buildplan::{
    claim_lock, decide, lock_dir, release_lock, ArtifactKind, ArtifactStatus, BuildDecision,
    CachedArtifact, DecisionInputs, LockHolder, LockOutcome, LockPolicy, NativeCacheState,
    ReleaseOutcome, StateStatus, CACHE_SCHEMA,
};
use qaren::exec::{CmdOutput, MockRunner};
use qaren::runrecord::PidIdentity;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn temp_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "qaren-lock-test-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

const FP: &str = "rnfp1:aaaa";
const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

fn artifact() -> CachedArtifact {
    CachedArtifact {
        path: PathBuf::from("/cache/testapp.app"),
        sha256: "f".repeat(64),
        kind: ArtifactKind::AppBundle,
    }
}

fn state(worktree: &Path, fingerprint: &str) -> NativeCacheState {
    NativeCacheState {
        schema: CACHE_SCHEMA.to_string(),
        platform: "ios".to_string(),
        app_id: "com.rndevagent.testapp".to_string(),
        worktree_root: worktree.to_path_buf(),
        fingerprint: fingerprint.to_string(),
        built_at: "2026-08-13T00:00:00Z".to_string(),
        candidate_sha: SHA_A.to_string(),
        lockfile_sha256: "c".repeat(64),
        generated_native_dirs: vec!["ios".to_string()],
        artifact: Some(artifact()),
    }
}

fn inputs<'a>(worktree: &'a Path, fingerprint: &'a str) -> DecisionInputs<'a> {
    DecisionInputs {
        platform: "ios",
        app_id: "com.rndevagent.testapp",
        worktree_root: worktree,
        candidate_sha: SHA_B,
        fingerprint,
        fingerprint_complete: true,
        incompleteness: &[],
        scheme: Some("rndatest"),
        force_clean: false,
        native_dir_exists: true,
        native_dir_in_candidate: false,
    }
}

#[test]
fn matching_fingerprint_with_verified_artifact_and_scheme_reuses() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        Some(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Reuse);
    assert!(plan.artifact.is_some());
    // The sha comparison must be visible evidence: reuse across candidates is
    // proven by the fingerprint, never inferred from the sha.
    assert!(
        plan.evidence
            .iter()
            .any(|e| e.contains(SHA_A) && e.contains(SHA_B)),
        "evidence must record the candidate sha comparison: {:?}",
        plan.evidence
    );
}

#[test]
fn stale_artifact_content_is_never_reused() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        Some(ArtifactStatus::Mismatch),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(
        plan.artifact.is_none(),
        "a stale binary must never be claimed"
    );
    assert!(plan.reason.contains("stale"), "{}", plan.reason);
}

#[test]
fn missing_artifact_file_downgrades_to_incremental() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        Some(ArtifactStatus::MissingFile),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(plan.artifact.is_none());
}

#[test]
fn wrong_platform_artifact_kind_is_never_reused() {
    let worktree = temp_dir();
    let mut wrong_kind = state(&worktree, FP);
    wrong_kind.artifact = Some(CachedArtifact {
        path: PathBuf::from("/cache/app.apk"),
        sha256: "f".repeat(64),
        kind: ArtifactKind::Apk,
    });
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(wrong_kind)),
        Some(ArtifactStatus::Verified),
    );
    assert_ne!(plan.decision, BuildDecision::Reuse);
    assert!(plan.artifact.is_none());
    assert!(plan.reason.contains("kind"), "{}", plan.reason);
}

#[test]
fn missing_scheme_downgrades_matching_fingerprint_to_incremental() {
    let worktree = temp_dir();
    let mut no_scheme = inputs(&worktree, FP);
    no_scheme.scheme = None;
    let plan = decide(
        &no_scheme,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        Some(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(plan.reason.contains("dev_client_scheme"), "{}", plan.reason);
}

#[test]
fn incomplete_fingerprint_forbids_reuse_even_when_everything_matches() {
    let worktree = temp_dir();
    let incompleteness = vec!["app.config.ts is a dynamic config".to_string()];
    let mut incomplete = inputs(&worktree, FP);
    incomplete.fingerprint_complete = false;
    incomplete.incompleteness = &incompleteness;
    let plan = decide(
        &incomplete,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        Some(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(plan.evidence.iter().any(|e| e.contains("dynamic config")));
}

#[test]
fn changed_fingerprint_with_proven_provenance_builds_incrementally() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, "rnfp1:changed"),
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Incremental);
    assert!(
        plan.evidence
            .iter()
            .any(|e| e.contains(FP) && e.contains("rnfp1:changed")),
        "old and new fingerprints must be evidence: {:?}",
        plan.evidence
    );
}

#[test]
fn missing_state_mandates_clean_build() {
    let worktree = temp_dir();
    let plan = decide(&inputs(&worktree, FP), &StateStatus::Missing, None);
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        plan.regenerate_native_dir,
        "a generated dir must be regenerated"
    );
}

#[test]
fn corrupt_state_mandates_clean_build() {
    let worktree = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Invalid("bad json".to_string()),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.evidence.iter().any(|e| e.contains("bad json")));
}

#[test]
fn state_bound_to_another_worktree_mandates_clean_build() {
    let worktree = temp_dir();
    let other = temp_dir();
    let plan = decide(
        &inputs(&worktree, FP),
        &StateStatus::Loaded(Box::new(state(&other, FP))),
        Some(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        plan.reason.contains("different worktree"),
        "{}",
        plan.reason
    );
}

#[test]
fn unproven_generated_native_dir_mandates_clean_regeneration() {
    let worktree = temp_dir();
    let mut unproven_state = state(&worktree, FP);
    unproven_state.generated_native_dirs.clear();
    let plan = decide(
        &inputs(&worktree, "rnfp1:changed"),
        &StateStatus::Loaded(Box::new(unproven_state)),
        None,
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(plan.regenerate_native_dir);
    assert!(plan.reason.contains("provenance"), "{}", plan.reason);
}

#[test]
fn git_visible_native_dir_is_never_regenerated() {
    let worktree = temp_dir();
    let mut tracked = inputs(&worktree, FP);
    tracked.native_dir_in_candidate = true;
    let plan = decide(&tracked, &StateStatus::Missing, None);
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        !plan.regenerate_native_dir,
        "a git-visible native dir is candidate input, never deleted"
    );
}

#[test]
fn scenario_forced_clean_overrides_everything() {
    let worktree = temp_dir();
    let mut forced = inputs(&worktree, FP);
    forced.force_clean = true;
    let plan = decide(
        &forced,
        &StateStatus::Loaded(Box::new(state(&worktree, FP))),
        Some(ArtifactStatus::Verified),
    );
    assert_eq!(plan.decision, BuildDecision::Clean);
    assert!(
        plan.reason.contains("build.strategy=clean"),
        "{}",
        plan.reason
    );
}

fn holder(name: &str, run_id: &str, identity: Option<PidIdentity>) -> LockHolder {
    LockHolder {
        holder: name.to_string(),
        run_id: run_id.to_string(),
        identity,
        at: "2026-08-13T00:00:00Z".to_string(),
    }
}

#[test]
fn strict_claim_refuses_even_a_dead_holder() {
    let root = temp_dir();
    let mut mock = MockRunner::new();
    let dead = PidIdentity {
        pid: 4242,
        started_at: "Wed Aug 13 10:00:00 2026".to_string(),
        command: "qaren prepare".to_string(),
    };
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "usb-SER",
            &holder("a", "run-a", Some(dead.clone())),
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));
    // The dead-holder probe still runs for the contention detail.
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    let outcome = claim_lock(
        &mut mock,
        &root,
        "usb-SER",
        &holder("b", "run-b", None),
        LockPolicy::Strict,
    );
    assert!(
        matches!(outcome, LockOutcome::Contended { .. }),
        "a device claim is never adopted, even from a dead holder: {outcome:?}"
    );
}

#[test]
fn adopt_dead_policy_takes_over_a_dead_holder_but_not_a_live_one() {
    let root = temp_dir();
    let mut mock = MockRunner::new();
    let identity = PidIdentity {
        pid: 4242,
        started_at: "Wed Aug 13 10:00:00 2026".to_string(),
        command: "qaren prepare".to_string(),
    };
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "native-build-ios",
            &holder("a", "run-a", Some(identity.clone())),
            LockPolicy::AdoptDead
        ),
        LockOutcome::Claimed {
            adopted_stale: false
        }
    ));
    // Live holder: contended.
    mock.expect_run("ps", CmdOutput::success("Wed Aug 13 10:00:00 2026\n"));
    mock.expect_run("ps", CmdOutput::success("S\n"));
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "native-build-ios",
            &holder("b", "run-b", None),
            LockPolicy::AdoptDead
        ),
        LockOutcome::Contended { .. }
    ));
    // Dead holder: adopted.
    mock.expect_run("ps", CmdOutput::failed(1, ""));
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "native-build-ios",
            &holder("b", "run-b", None),
            LockPolicy::AdoptDead
        ),
        LockOutcome::Claimed {
            adopted_stale: true
        }
    ));
}

#[test]
fn release_is_bound_to_holder_and_run_id() {
    let root = temp_dir();
    let mut mock = MockRunner::new();
    assert!(matches!(
        claim_lock(
            &mut mock,
            &root,
            "usb-SER",
            &holder("qaren-run-a", "run-a", None),
            LockPolicy::Strict
        ),
        LockOutcome::Claimed { .. }
    ));
    let dir = lock_dir(&root, "usb-SER");
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-b"),
        ReleaseOutcome::Foreign(_)
    ));
    assert!(matches!(
        release_lock(&dir, "qaren-run-b", "run-a"),
        ReleaseOutcome::Foreign(_)
    ));
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-a"),
        ReleaseOutcome::Removed
    ));
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-a"),
        ReleaseOutcome::Absent
    ));
}

#[test]
fn release_refuses_an_unreadable_holder_record() {
    let root = temp_dir();
    let dir = lock_dir(&root, "usb-SER");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("holder.json"), "not json").unwrap();
    assert!(matches!(
        release_lock(&dir, "qaren-run-a", "run-a"),
        ReleaseOutcome::Refused(_)
    ));
    assert!(dir.exists(), "an ambiguous lock must not be touched");
}
