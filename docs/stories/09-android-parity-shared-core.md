# Story 09 — Android runner parity + shared client core (+ optional adb-stream transport)

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Closes the iOS/Android reliability asymmetry; collapses copy-pasted client logic into one "retry brain"; (stretch) eliminates the adb-forward port-contention class
**Effort:** M (stretch phase is L on its own — explicitly severable)
**Depends on:** Story 02 (health payload, state files)

## Problem

1. **Liveness asymmetry.** iOS has tri-state liveness (`alive|stale|dead`) with stale-reaping (SIGTERM→500ms→SIGKILL) before restart (`rn-fast-runner-client.ts:379-533`, `agent-device-wrapper.ts:639-658`). Android only checks PID-alive (`isAndroidRunnerAvailable`) — a PID-alive-but-wedged instrumentation is never proactively reaped, only caught by per-command timeouts.
2. **Duplication.** `buildRunIOSArgs`/`buildRunAndroidArgs` are near-identical switch statements (`agent-device-wrapper.ts:283-573`); `postCommand`, the runner-timeout shim, ready-handshake polling, and state-file bootstrap are copy-pasted between the two clients. Every reliability improvement currently must be written twice (and historically has drifted — see #1).
3. **Port contention.** Android needs `adb forward tcp:<hostPort> tcp:22089`; the host port is probed for freeness and *contended across projects* (`rn-android-runner-client.ts:18, 375-382`).

## What Maestro does

- One shared composition layer (`Maestro.kt`) over a thin per-platform `Driver` primitive port; platform differences expressed as **capability flags** (`Capability.FAST_HIERARCHY`), not parallel implementations.
- Android death taxonomy: gRPC `UNAVAILABLE`/`DEADLINE_EXCEEDED` → probe adbd with a bounded 1 s connect → **DeviceServerDied** (recoverable: re-instrument) vs **DeviceUnreachable** (device gone); infra failures never masquerade as test failures (`AndroidDeviceConnection.kt:294-338`).
- **No `adb forward` at all:** gRPC rides the adb stream through a custom `SocketFactory` whose sockets delegate to a dadb `AdbStream` (`AdbSocketFactory.kt:14-113`, `AndroidDeviceConnection.kt:94-101`) — zero host ports, zero forward leaks.
- Matched keepalives host↔device (client ping 2 min / server permits 30 s, both 20 s ack) and a 120 s stub deadline.

## Design

### Phase 1 — Android tri-state liveness

`classifyAndroidRunnerLiveness(serial): 'alive'|'stale'|'dead'` mirroring the iOS classifier:
- instrumentation process present (`adb shell pidof` of the test package) + `/health` ok (incl. Story 02 protocol/version match) → **alive**
- process present but `/health` timeout/500/mismatch → **stale** → reap: `adb shell am force-stop <testPkg>` + remove the adb forward + restart instrumentation
- process absent → **dead** → normal start

`startAndroidRunner` reaps stale before starting (same call shape as `ensureFastRunner`). The existing GH#243 lesson (logcat replays old ready-lines; `/health` polling is the truth) stays load-bearing.

### Phase 2 — `runners/client-core.ts` (the shared brain)

Extract into one module, parameterized by a small platform port:

```ts
interface RunnerPort {
  platform: 'ios'|'android';
  healthUrl(): string; commandUrl(): string;
  start(): Promise<void>; reap(): Promise<void>;   // platform-specific lifecycle
}
// shared: postCommand (fetch + AbortController + timeout table {default:10s, slow:35s}),
// runner-timeout shim (type-timeout-is-success, meta.runnerTimeoutShim),
// ready-handshake poller, tri-state classifier skeleton, secure state-file IO (Story 02),
// COMMAND_SPECS: declarative {verb: {endpointFields, slowCommand?, mutating?}} table
```

`COMMAND_SPECS` replaces both `buildRunIOSArgs`/`buildRunAndroidArgs` switches with one table + per-platform field adapters — the switch statements become data. Mutating-verb knowledge (`SNAPSHOT_MUTATING_VERBS`) moves into the same table so Story 04/05 read it from one place.

Migration is mechanical and testable: existing unit tests for both arg builders become table-driven tests that must pass unchanged against the new core (behavioral pin before deleting the old code).

### Phase 3 (stretch, severable) — adb-stream transport

Replace `adb forward` with direct adb-server tunneling from Node: a ~150-line client speaking the adb smart protocol to `127.0.0.1:5037` — `host:transport:<serial>` then `tcp:22089` — exposing a `net.Socket`-compatible duplex the HTTP client dials through (undici `connect` option accepts a custom dialer). Precedent: Maestro's `AdbSocketFactory` + dadb. Wins: no host port, no cross-project contention, no forward leaks to clean up. Keep `adb forward` as fallback behind `RN_ADB_TUNNEL=0` and for adb-server protocol surprises. Ship only with Phase B nightly smoke (Story 06) exercising it.

## Implementation steps

1. Phase 1: classifier + reap path + unit matrix (pidof yes/no × health ok/timeout/mismatch); wire into `startAndroidRunner`.
2. Phase 2: extract `client-core.ts` bottom-up (state IO → postCommand+shim → handshake poller → COMMAND_SPECS last); each extraction lands as its own PR with the pinned tests.
3. Phase 3: adb protocol client + dialer integration + fallback flag; nightly-smoke soak before default-on.

## Acceptance criteria

- A wedged Android instrumentation (simulated: SIGSTOP the process) is detected as `stale` and transparently reaped+restarted on the next device tool call — today it wedges until the 35 s command timeout, every call.
- `git grep -n 'runnerTimeoutShim' scripts/cdp-bridge/src/runners/` returns exactly one implementation site.
- Behavioral pin: full existing unit suite green with both clients on the shared core; no envelope shape changes.
- (Phase 3) Two projects on two emulators run concurrently with zero host-port allocation; `adb forward --list` shows no plugin-owned forwards.

## Test plan

- Unit: liveness matrix, COMMAND_SPECS table completeness (every verb in `RN_FAST_RUNNER_COMMANDS`/`RN_ANDROID_RUNNER_COMMANDS` has a spec — CI-enforced), adb-protocol framing (golden byte fixtures).
- Integration: fake-runner harness runs the same scripted scenarios against both platform ports.
- Live: Story 06 Phase B golden set on Android before/after each phase.

## Risks & open questions

- **Extraction regressions:** mitigated by pin-tests-first, one-extraction-per-PR, and the shim/timeout tables being data (diffable) rather than logic.
- **adb server protocol variance** (Phase 3): the smart protocol is stable and dadb ships it in production, but emulator vendors' adb versions vary — hence fallback flag + nightly soak, and Phase 3 is explicitly droppable without weakening Phases 1–2.
- **Instrumentation restart cost:** reap+restart is ~3–5 s; still strictly better than repeated 35 s timeouts.
