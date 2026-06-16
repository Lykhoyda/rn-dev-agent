# GH #303 — Correct Metro-port selection + worktree disambiguation

**Status:** Approved (2026-06-16)
**Issue:** [#303](https://github.com/Lykhoyda/rn-dev-agent/issues/303) — `cdp_status` auto-detects the wrong Metro port with multiple worktree Metros, risking verification against the wrong bundle (`kano:must-be`, `priority:now`, `effort:m`)

## Problem

When two git worktrees each run their own Metro, `cdp_status` (called without `metroPort`) can lock onto the wrong port and return `APP_DETACHED`, masking that the app is attached and healthy on another port. The root cause is in discovery: `discoverMetroPort()` returns the **first** port that responds `packager-status:running` and never checks whether that Metro has an *attached Hermes target*. So with `:8081` (app attached) and `:8082` (no app), discovery can return `:8082`, `fetchTargets()` finds 0 valid targets, and `discover()` throws `AppDetachedError(8082)` — even though a healthy app sits on `:8081`.

Two downstream harms follow:

1. **Silent correctness trap.** An agent that trusts the default can drive/verify a feature against a *different worktree's JS bundle* and report success against code that isn't running. In the reporter's session the running app loaded JS from a sibling worktree (`homeaddress-gate` on `:8082`) while the changes under test lived in another worktree (`ix3030` on `:8081`).
2. **Misguided auto-relaunch.** `cdp_status` catches `AppDetachedError` and triggers the iOS cold-restart recovery (`recoverDetached`) for the *wrong* port — actively making things worse when the app is healthy elsewhere.

The fix replaces first-match with best-match, and — because the bridge already records its own `projectRoot` — makes "which worktree's bundle is live?" a deterministic equality check rather than a guess.

## Scope (chosen)

**Correctness + cwd auto-pick.** Three layers:

1. **Correctness (must-be):** discovery prefers a port with attached Hermes targets over a merely-running one; `AppDetachedError` fires only when *no* live Metro has an app.
2. **Worktree auto-pick:** when >1 live Metro has an app, resolve each Metro's serving cwd (PID→`lsof`) and auto-pick the one whose cwd matches this bridge's `projectRoot`.
3. **Diagnostics:** `cdp_status` surfaces all candidate Metros `{port, attached, cwd}` and **warns** when the connected Metro's cwd differs from `projectRoot` — catching the trap even with a single Metro running.

Every new path is **fail-open**: any `lsof` / non-macOS / permission failure degrades to the existing selection behavior. The fix can never *block* a connection it would have made before — it only makes a *better* choice when it can.

## Architecture

```
discover(currentPort, filters)                           [cdp/discovery.ts]
  ├─ discoverAllMetroPorts(ports, timeout): number[]      parallel /status probe (was: first-match)
  ├─ for each running port: fetchTargets(p) → valid[]     parallel
  ├─ attachedPorts = running.filter(valid.length > 0)
  ├─ selectMetroPort(attachedPorts, runningPorts, ctx):   pure selection (new, unit-tested)
  │     0 attached → AppDetachedError(runningPorts)
  │     1 attached → that port
  │     >1 attached → cwd-match(projectRoot) ▸ preferredBundleId ▸ sticky/lowest + warning
  │     cwd resolved via metroCwd.cwdForPort(p)            [cdp/metro-cwd.ts — new, lsof, cached, fail-open]
  └─ returns { port, targets, warning, candidates }

cdp_status (status.ts)
  ├─ metro.candidates / metro.projectRoot from discovery
  └─ mismatch warning when connected metro.cwd !== projectRoot
```

### Component: `src/cdp/metro-cwd.ts` (new)

Resolves a Metro listener's serving directory from its TCP port. macOS-first (`lsof`); fail-open everywhere else.

- `metroPidForPort(port, exec?): number | null` — listener PID via `lsof -ti tcp:<port> -sTCP:LISTEN`. First numeric line; `null` on any failure / no listener.
- `cwdForPid(pid, exec?): string | null` — `lsof -a -p <pid> -d cwd -Fn`, parse the `n`-prefixed field record (the `-F` machine format emits one field per line, `n<path>`). `null` on failure.
- `cwdForPort(port, exec?): string | null` — compose the two. **Memoize `pid→cwd` only** (a process's cwd is immutable for its lifetime); always re-resolve `port→pid` per call so a port reused by a *new* Metro process (old one died, new one bound the same port) never returns a stale cwd. The repeat-call saving is the second `lsof` (pid→cwd); the first (`port→pid`) is paid each time but is cheap.
- `exec` is an injectable seam (`(cmd, args) => string`) defaulting to `execFileSync` with a short timeout (`CWD_LSOF_TIMEOUT_MS = 800`) and `stdio: ['ignore','pipe','ignore']`. Unit tests pass fixtures — no subprocess in CI.
- **Platform guard:** on non-darwin `process.platform`, return `null` immediately (no spawn). The feature degrades to selection-without-cwd off macOS, which is acceptable (the worktree-Metro scenario is a developer-machine case).

### Component: `selectMetroPort()` (new, pure — in `discovery.ts`)

```
selectMetroPort(attached: number[], running: number[], ctx: {
  currentPort: number; projectRoot?: string; preferredBundleId?: string;
  cwdForPort: (port: number) => string | null;
}): { port: number; warning?: string }
```

Deterministic precedence when `attached.length > 1`:

1. **projectRoot-cwd match** — resolve cwd for each attached port; if exactly one `cwd === projectRoot` (path-normalized via `resolve()`), pick it. **This beats stickiness and preferredBundleId** — it is the most specific signal for "the worktree I belong to."
2. **preferredBundleId (port-level)** — if cwd matching is inconclusive (0 matches, >1 match, or no cwd resolved) and a `preferredBundleId` is configured, and **exactly one** attached port has a target whose `description === preferredBundleId`, pick that port. (This is a genuine port-level signal — distinct from `selectTarget()`'s within-port target tie-break, which still runs afterward to choose among that port's targets.) If 0 or >1 ports match, fall through.
3. **sticky / lowest + warning** — pick `currentPort` if it is in `attached` (avoids flapping), else the lowest attached port; attach a warning enumerating every candidate `{port, cwd}` and advising an explicit `metroPort`.

`attached.length === 0` → throw `AppDetachedError` carrying the running ports. `attached.length === 1` → that port, no warning.

### `AppDetachedError` change

Constructor accepts the resolved port (unchanged primary) and an optional list of all running ports so the message reads `Metro is up on 8082 (also running: 8081, 8082) but no live Metro advertises a Hermes target…`. The single-port message is preserved when only one Metro is running (back-compat with `recover-detached.ts`, which reads `.port`).

### `cdp_status` output + mismatch warning

`StatusResult.metro` gains:
- `candidates?: Array<{ port: number; attached: boolean; cwd: string | null; isConnected: boolean; matchesProjectRoot: boolean }>` — populated when discovery enumerated >1 running port; omitted for the single-Metro fast path to avoid needless `lsof`.
- `projectRoot?: string` — the bridge's resolved project root (already known to `DeviceLock`/lockfile).
- `servingCwd?: string | null` — the connected Metro's cwd.

**Mismatch warning** (the real payoff): after a successful status read, if `servingCwd` resolves and `!== projectRoot` (both normalized), return `warnResult(status, "Connected Metro on :<port> is serving <servingCwd>, but this session's project root is <projectRoot> — you may be verifying against a different worktree's bundle. Restart Metro in this worktree or pass metroPort.")`. Fires even with a single Metro running. **Conservative:** only when both paths are confidently resolved and genuinely differ — never when `servingCwd`/`projectRoot` is null/unknown (no false alarms when started from a parent dir or off-macOS).

## Data flow

1. `cdp_status({ platform: "ios" })` → `autoConnect` → `discover(currentPort, filters)`.
2. `discoverAllMetroPorts` probes `[currentPort, USER_METRO_PORT?, 8081, 8082, 19000, 19006]` (deduped) in parallel → running ports.
3. `fetchTargets` (parallel) → attached ports.
4. `selectMetroPort` picks the port (cwd-match for the worktree case).
5. `discover` returns `{ port, targets, candidates }`; client connects to the chosen port.
6. `buildStatusResult` attaches `metro.candidates / projectRoot / servingCwd`; the handler emits the mismatch warning if applicable.

## Error handling — fail-open

- `metro-cwd` never throws; all three functions return `null` on any error / non-macOS / no listener. Selection then skips step 1 and uses preferredBundleId/sticky.
- `discoverAllMetroPorts` tolerates per-port probe failures (a port that errors is simply "not running"); a global fetch failure for one running port drops it from `attached` (treated as detached) rather than aborting discovery.
- The mismatch warning is suppressed whenever either path is unresolved — an unknown cwd never produces a scary "wrong worktree" message.
- `meta.timings_ms` instrumented on `discover` (`probe`, `fetchTargets`, `cwd`) per the repo convention, so the added cost is visible.

## Performance

- **Single Metro (common):** one extra `lsof` for the connected port's cwd (best-effort, memoized, ~10–40ms) to enable the mismatch check. No `candidates` array.
- **Multiple Metros:** N parallel `/status` probes + N parallel `fetchTargets` + ≤N memoized `lsof` calls. Bounded by `DEFAULT_PORTS` (~5) and short timeouts (`DISCOVERY_TIMEOUT_MS = 1500`, `CWD_LSOF_TIMEOUT_MS = 800`).
- Parallelizing the port probes (vs today's serial short-circuit) keeps multi-port discovery roughly as fast as the single-port path.

## Testing (TDD)

- **`metro-cwd.test.js`** (pure, injected exec): parse macOS `lsof -Fn` fixture → cwd; `lsof -ti` → PID; memoization (second call doesn't re-exec); fail-open on non-zero exit / empty output / thrown exec; non-darwin returns null without spawning.
- **`discover-port-selection.test.js`** (mocked fetch + injected cwdForPort):
  - detached first port (`:8082` 0 targets) is skipped for attached second port (`:8081`) — the core regression.
  - 0 attached → `AppDetachedError` listing all running ports.
  - 1 attached → that port, no warning.
  - >1 attached, exactly one cwd === projectRoot → that port (beats stickiness: currentPort is the *other* attached port).
  - >1 attached, no cwd match → warning enumerates candidates; sticky currentPort chosen when attached, else lowest.
  - cwd unresolved (cwdForPort → null) → no crash, falls back to sticky/lowest + warning.
- **`status-metro-mismatch.test.js`**: mismatch warning fires when servingCwd ≠ projectRoot; silent when equal; silent when servingCwd null; `candidates`/`projectRoot` present in output for multi-Metro, absent for single-Metro fast path.
- Full existing suite stays green (no behavior change for the single-healthy-Metro path beyond the additive cwd read).

## Device verification

On the dev machine, reproduce the two-worktree setup (two Metros on `:8081`/`:8082`, app attached on one) and confirm: (a) `cdp_status` with no `metroPort` connects to the attached port, (b) `metro.candidates` enumerates both with correct `cwd`/`attached`, (c) the mismatch warning fires when the connected Metro's cwd ≠ this worktree, (d) genuine all-detached still returns `APP_DETACHED` + iOS auto-relaunch unchanged.

## Out of scope

The issue's "secondary friction" is unrelated to port selection and excluded from #303:
- maestro-runner login failing at "Checking WDA install" — separate WDA-lifecycle concern.
- `device_screenshot` reporting non-existent paths — already mitigated by the `xcrun simctl io screenshot` fallback (D1249); file separately if it recurs.

## Refs

GH #303. Touches `src/cdp/discovery.ts`, new `src/cdp/metro-cwd.ts`, `src/tools/status.ts`, `src/types.ts` (StatusResult.metro). Related: GH #208 (`AppDetachedError` / `recover-detached.ts`), B111/D643 (`selectTarget`), D1249 (screenshot fallback).
