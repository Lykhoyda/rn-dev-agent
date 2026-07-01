# Story 02 — Version the runner wire protocol + relocate `/tmp` state files

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Prevents an already-observed bug class (bridge/runner skew); removes predictable shared `/tmp` paths
**Effort:** S
**Depends on:** —

## Problem

Two related gaps, both confirmed by code inspection:

1. **The runner HTTP `/command` contract is unversioned.** The JS-injection contract *is* versioned (`__HELPERS_VERSION__` with an idempotent re-inject guard, `scripts/cdp-bridge/src/injected-helpers.ts:9-11`), but neither the Swift nor the Kotlin runner carries any `protocolVersion` in requests, responses, or `/health`. A bridge upgrade against a still-running older runner (or vice versa) has no compatibility guard. This exact class fired live on 2026-07-01: the supervisor ran plugin cache 0.57.3 while the mirrored dist was 0.57.1, and nothing detected the skew.
2. **Runner state lives at fixed, project-global `/tmp` paths** — `/tmp/rn-fast-runner-state.json` (`rn-fast-runner-client.ts:19`) and `/tmp/rn-android-runner-state.json` (`rn-android-runner-client.ts:20`). Correctness of cross-project reuse relies solely on `shouldReuseRunner` deviceId matching. The session file was already migrated off `/tmp` for a symlink-race CVE (`agent-device-wrapper.ts:56-73`); the runner state files were not.

## What Maestro does

Maestro sidesteps most of this by never reusing a runner across driver versions — the runner artifact is embedded in the CLI release, so client and runner are version-locked by construction, and `simctl launch --terminate-running-process` guarantees a clean single instance (`LocalSimulatorUtils.kt:342-367`). Since we deliberately *do* reuse warm runners (that's a perf feature Maestro lacks), we need the explicit handshake Maestro gets implicitly.

## Design

### Protocol version handshake

- New `scripts/cdp-bridge/src/runners/protocol.ts`:
  ```ts
  export const RUNNER_PROTOCOL_VERSION = 1;
  export const MIN_SUPPORTED_RUNNER_PROTOCOL = 1;
  ```
- Swift (`scripts/rn-fast-runner/RnFastRunner/.../RunnerProtocol.swift`) and Kotlin (`scripts/rn-android-runner/app/.../RunnerProtocol.kt`) mirror the constant. A unit test on the TS side greps all three files and asserts the constants agree (same pattern as the existing version-sync CI guard).
- `/health` response becomes:
  ```json
  {"ok": true, "protocolVersion": 1, "runnerVersion": "0.58.0", "capabilities": ["SCREEN_STATIC"]}
  ```
  (`capabilities` is the negotiation hook Stories 04/05 build on — Maestro's `Capability.FAST_HIERARCHY` pattern, `maestro-client/.../Capability.kt`.)
- Bridge-side gate in the liveness classifiers (`classifyFastRunnerLiveness`, and the Android equivalent from Story 09): a reachable runner whose `protocolVersion` is missing (legacy) or `< MIN_SUPPORTED_RUNNER_PROTOCOL`, or whose `runnerVersion` mismatches the plugin version, is classified **stale** → existing reap-then-restart path handles it automatically. Only if reinstall then fails do we surface a new typed error `RUNNER_PROTOCOL_MISMATCH` (added to `ToolErrorCode` in `types.ts`).
- Every `/command` response body gains a cheap `"v": 1` field as defense-in-depth (checked only when present, so rollout is order-independent).

### State-file relocation

- New location: `~/Library/Application Support/rn-dev-agent/runner-state/ios-<udid>.json` and `android-<serial>.json` (per-device keying replaces the single global file, eliminating cross-project contention on the file itself).
- Reuse the hardened IO already written for the session file — mode 0600, symlink-refusing open (`agent-device-wrapper.ts:40-108`) — extracted into `util/secure-state-file.ts` so session file, runner state, and any future state share one implementation.
- State schema gains `{schemaVersion: 1, protocolVersion, runnerVersion, provenance}` (provenance from Story 01).
- Migration: on first run, if a legacy `/tmp/rn-*-runner-state.json` exists → ignore and best-effort delete. No attempt to migrate contents (a runner restart is cheap and correct).

## Implementation steps

1. `protocol.ts` + Swift/Kotlin mirror constants + tri-file sync test.
2. `/health` enrichment in both runners (Swift handler; Kotlin NanoHTTPD handler) — additive, old bridges ignore unknown fields.
3. `secure-state-file.ts` extraction + both clients switched to per-device paths; delete the `/tmp` constants.
4. Liveness gates: extend `shouldReuseRunner` and the tri-state classifier (`rn-fast-runner-client.ts:379-533`) to require protocol + version match.
5. `RUNNER_PROTOCOL_MISMATCH` in `types.ts` + doctor surfacing.

## Acceptance criteria

- Bridge vN+1 against a live runner vN: first device tool call transparently reaps and reinstalls the runner; `meta.note` records `runner upgraded (protocol/version mismatch)`; no user-visible failure.
- No file under `/tmp` is read or written by either runner client (grep-enforced in a unit test, same style as the gh-374 static-invariant guard, per D1288).
- Two projects driving two different devices concurrently never touch the same state file.
- Legacy `/tmp` files present → ignored, deleted, logged at debug level.

## Test plan

- Unit: constant-sync test; classifier matrix (missing version / older / equal / newer protocol × health-ok / health-timeout); secure-state-file symlink refusal + 0600 assertions; migration branch.
- Integration: extend `gh-264-supervisor-respawn`-style harness with a fake runner serving an old `/health` payload → assert stale classification + restart request.

## Risks & open questions

- **Rollout ordering:** an old runner has no `protocolVersion` → classified stale → restarted. That is the desired behavior, but the first tool call after upgrade pays one runner restart; document in CHANGELOG.
- **Windows/Linux host paths for Android:** use `env-paths`-style resolution (the session file code already resolves the platform-appropriate app-support dir — reuse it).
