# #210 Device-Session Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On iOS, make `device_*` self-diagnosing and self-healing — `cdp_status` reports the rn-fast-runner state, `device_find/press/fill` auto-spawn the runner (cold-build-safe), and `device_screenshot` never hard-fails (simctl fallback) even during a Maestro flow.

**Architecture:** Reuse-first wiring — no new device backend. Surface `probeFastRunnerLiveness()` in `cdp_status`; gate `ensureFastRunner()` on `hasBuiltTestProduct()` from the `device_*` dispatch choke point; route `device_screenshot` to the existing `tryRawScreenshot()` (simctl) when the runner can't serve it or a flow owns the device, via a narrow arbiter fallback allowlist.

**Tech Stack:** TypeScript (Node ≥22, ESM, NodeNext), `node:test` + `node:assert/strict` unit tests in `test/unit/*.test.js` importing from `dist/`, changesets, signed commits, tracked `dist/`.

**Conventions:** Tests are plain `.js` importing built `dist/` (run `npm run build` first). Inject side-effecting deps (the codebase uses `deps = {}` parameter objects and `_setForTest` seams). No unnecessary comments. Explicit `import type`. Add `meta.timings_ms` where a new path has variable cost.

---

## Amendments applied from the multi-LLM plan review (2026-06-08, Codex + Gemini)

Both reviewers confirmed the WDA client is correctly avoided and the reuse is sound, but found **5 HIGH + 2 MEDIUM + 1 LOW** wiring defects. All verified against the code and folded into the tasks below:

- **A1 (HIGH, C1) — default iOS sessions store `platform: undefined`.** `device-session.ts:180` normalizes `platform` for the lock but `:222` stores raw `args.platform`. So `activeSession.platform` is `undefined` for an omitted-platform open, and `runAgentDevice`'s iOS branch (`opts.platform ?? activeSession?.platform`) — hence the new auto-spawn — is skipped. **Fix:** Task 2 Step 1 stores the normalized `platform`.
- **A2 (HIGH, C2/G1) — `runIOS()` THROWS when the runner is down** (`postCommand` rejects), it doesn't return `{isError}`. The screenshot fallback's `if (result.isError)` is dead code → handler crashes. **Fix:** Task 4 wraps `runAgentDeviceFn` in try/catch.
- **A3 (HIGH, C3/G2) — `device_screenshot` could hit XCUITest UNLEASED during a flow** (route falls to `'runner'` when platform is null, or simctl-failure falls through). **Fix:** Task 4 — when `arbiter.flowActive`, screenshot is **raw-only**; never call `runAgentDeviceFn`; unresolved platform or raw failure → `SCREENSHOT_FAILED`. `chooseScreenshotPath` returns `'simctl'|'runner'|'fail'`.
- **A4 (HIGH, C4/G3) — `deviceSession` not actually iOS-gated.** Plan prose said "gate on iOS" but the helper probed `:22088` + ran `detectIosExternalRunner` (a host-wide `ps ax`) for ANY session, including Android. **Fix:** Task 1 — `getDeviceSessionHealth` probes + detects **only** when `session.platform === 'ios'`; Android → `rnFastRunner:'dead'`, no probe, no scan.
- **A5 (HIGH, C5) — `RN_FAST_RUNNER_DOWN` is not in `ToolErrorCode`** → compile blocker. **Fix:** Task 2 Step 2 adds it to the union in `types.ts`.
- **A6 (MED, C6) — `ensureFastRunner` swallows start errors** (`catch { console.error }`), so a failed spawn degrades into the unstructured `postCommand` throw. **Fix:** Task 2 adds `ensureRunnerForCommand()` — one probe, gate, start, **re-verify**, structured `{ ok } | { ok:false, message }`.
- **A7 (MED, C7/G4) — pure-helper tests miss the wiring risk.** **Fix:** Tasks 2 & 4 add integration-style tests that inject a **throwing** `runAgentDeviceFn` + a held flow lease + an Android session (assert the iOS detector is NOT called) + a normalized default-iOS `device_press`.
- **A8 (LOW, C8) — telemetry mislabels Android raw capture as `simctl`.** **Fix:** Task 4 emits `via: 'simctl' | 'adb'`.

Also (from A3): `createDeviceScreenshotHandler` resolves platform from `getActiveSession()?.platform` too, so flow-active captures have a platform.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/tools/device-session-health.ts` | Assemble `{ sessionOpen, rnFastRunner, appId?, deviceId?, foreignRunner? }` from existing probes | **Create** |
| `src/types.ts` | `StatusResult.deviceSession` field | Modify (after `reconnect`, ~line 139) |
| `src/tools/status.ts` | Call `getDeviceSessionHealth()` + add to result | Modify (`buildStatusResult`, ~line 64-109) |
| `src/runners/rn-fast-runner-client.ts` | Export `derivedDataPathForRunner()`; upgrade `postCommand` not-started message | Modify |
| `src/agent-device-wrapper.ts` | Auto-spawn-or-actionable-error in the iOS dispatch short-circuit | Modify (~line 664-673) |
| `src/tools/device-screenshot-raw.ts` | Export `resolveBootedIosUdid()` (reuse `defaultIosResolver`) | Modify |
| `src/lifecycle/device-arbiter.ts` | `FLOW_FALLBACK_TOOLS` allowlist + `flowActive` getter | Modify |
| `src/tools/device-list.ts` | `captureAndResizeScreenshot` simctl fallback (flow-active + on-error) | Modify (~line 206-253) |
| `CLAUDE.md`, `docs-site/...` | 3-layer contract + reframed (iii) + state model | Modify |
| `.changeset/gh-210-device-session-visibility.md` | Patch × both packages | Create |

Note on the `deviceSession.foreignRunner` shape: the spec wrote `{ tool: string }`; this plan uses `{ detected: true }` to avoid coupling to `IosExternalRunnerWarning`'s internal fields (we only need the boolean signal — "a Maestro/WDA flow owns the device"). The detector is injected so the helper unit-tests without `ps`.

---

## Task 1: `cdp_status.deviceSession` visibility (Fix i)

**Files:**
- Create: `src/tools/device-session-health.ts`
- Create: `test/unit/gh-210-device-session-health.test.js`
- Modify: `src/types.ts` (StatusResult, after `reconnect` block ~line 139)
- Modify: `src/tools/status.ts` (import + populate in `buildStatusResult`)

- [ ] **Step 1: Write the failing test** — `test/unit/gh-210-device-session-health.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getDeviceSessionHealth } from '../../dist/tools/device-session-health.js';

const session = (over = {}) => ({ name: 's', platform: 'ios', deviceId: 'UDID-1', openedAt: 'now', appId: 'com.x', ...over });

test('#210 health: no active session → sessionOpen:false, rnFastRunner:dead, probe NOT called', async () => {
  let probed = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => null,
    probeLiveness: async () => { probed++; return 'alive'; },
  });
  assert.deepEqual(h, { sessionOpen: false, rnFastRunner: 'dead' });
  assert.equal(probed, 0, 'must not probe /health when no session is open');
});

test('#210 health: Android session → rnFastRunner:dead, probe + detectForeign NOT called (iOS-only)', async () => {
  let probed = 0, detected = 0;
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session({ platform: 'android' }),
    probeLiveness: async () => { probed++; return 'alive'; },
    detectForeign: async () => { detected++; return { detected: true }; },
  });
  assert.equal(h.sessionOpen, true);
  assert.equal(h.rnFastRunner, 'dead', 'Android never uses the iOS runner');
  assert.equal(probed, 0, 'must not probe :22088 on Android');
  assert.equal(detected, 0, 'must not run the ps-scan on Android');
  assert.equal(h.foreignRunner, undefined);
});

test('#210 health: session open + runner alive → reports alive + appId/deviceId', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => 'alive',
  });
  assert.equal(h.sessionOpen, true);
  assert.equal(h.rnFastRunner, 'alive');
  assert.equal(h.appId, 'com.x');
  assert.equal(h.deviceId, 'UDID-1');
});

test('#210 health: session open + runner stale → reports stale', async () => {
  const h = await getDeviceSessionHealth({ getActiveSession: () => session(), probeLiveness: async () => 'stale' });
  assert.equal(h.rnFastRunner, 'stale');
});

test('#210 health: probe throws → degrades to dead (never throws)', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => { throw new Error('boom'); },
  });
  assert.equal(h.rnFastRunner, 'dead');
});

test('#210 health: foreign Maestro/WDA flow detected → foreignRunner.detected', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => 'alive',
    detectForeign: async (udid) => (udid === 'UDID-1' ? { detected: true } : null),
  });
  assert.deepEqual(h.foreignRunner, { detected: true });
});

test('#210 health: detectForeign throws → omitted (best-effort, never throws)', async () => {
  const h = await getDeviceSessionHealth({
    getActiveSession: () => session(),
    probeLiveness: async () => 'alive',
    detectForeign: async () => { throw new Error('ps failed'); },
  });
  assert.equal(h.foreignRunner, undefined);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-210-device-session-health.test.js`
Expected: FAIL — `Cannot find module '../../dist/tools/device-session-health.js'`.

- [ ] **Step 3: Create the module** — `src/tools/device-session-health.ts`

```ts
import type { FastRunnerLiveness } from '../runners/rn-fast-runner-client.js';
import type { SessionState } from '../types.js';
import { getActiveSession as defaultGetActiveSession } from '../agent-device-wrapper.js';
import { probeFastRunnerLiveness } from '../runners/rn-fast-runner-client.js';

export interface DeviceSessionHealth {
  sessionOpen: boolean;
  rnFastRunner: FastRunnerLiveness;
  appId?: string;
  deviceId?: string;
  foreignRunner?: { detected: true };
}

export interface DeviceSessionHealthDeps {
  getActiveSession?: () => SessionState | null;
  probeLiveness?: () => Promise<FastRunnerLiveness>;
  detectForeign?: (udid?: string) => Promise<{ detected: true } | null>;
}

export async function getDeviceSessionHealth(deps: DeviceSessionHealthDeps = {}): Promise<DeviceSessionHealth> {
  const getSession = deps.getActiveSession ?? defaultGetActiveSession;
  const probe = deps.probeLiveness ?? probeFastRunnerLiveness;

  const session = getSession();
  if (!session) return { sessionOpen: false, rnFastRunner: 'dead' };

  const health: DeviceSessionHealth = { sessionOpen: true, rnFastRunner: 'dead' };
  if (session.appId) health.appId = session.appId;
  if (session.deviceId) health.deviceId = session.deviceId;

  // A4: the rn-fast-runner (:22088) and the foreign-runner `ps ax` scan are iOS-only.
  // For Android (or an unknown platform) leave rnFastRunner:'dead' and skip both —
  // probing the iOS port / shelling out `ps` on every cdp_status would be wrong + slow.
  if (session.platform === 'ios') {
    try { health.rnFastRunner = await probe(); } catch { health.rnFastRunner = 'dead'; }
    if (deps.detectForeign) {
      try {
        const f = await deps.detectForeign(session.deviceId);
        if (f) health.foreignRunner = f;
      } catch { /* best-effort: a failed ps scan must never fail cdp_status */ }
    }
  }
  return health;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-210-device-session-health.test.js`
Expected: PASS (6/6).

- [ ] **Step 5: Add the `deviceSession` field to `StatusResult`** — `src/types.ts`, immediately after the `reconnect: { ... }` block (~line 139):

```ts
  /**
   * #210: iOS device-session visibility. `sessionOpen` is whether a device
   * session has been opened; `rnFastRunner` is the XCUITest runner's liveness
   * (only probed when a session is open — `dead` otherwise, never misreported as
   * down when simply never started). `foreignRunner.detected` means a Maestro/WDA
   * flow currently owns the device. iOS-focused; on Android `rnFastRunner` is
   * always `'dead'` (the iOS runner is never used). Always populated.
   */
  deviceSession?: {
    sessionOpen: boolean;
    rnFastRunner: 'alive' | 'stale' | 'dead';
    appId?: string;
    deviceId?: string;
    foreignRunner?: { detected: true };
  };
```

- [ ] **Step 6: Populate it in `buildStatusResult`** — `src/tools/status.ts`. Add the import near the top (after line 12):

```ts
import { getDeviceSessionHealth } from './device-session-health.js';
import { detectIosExternalRunner } from '../runners/external-runner-detect.js';
```

Then inside `buildStatusResult`, before the `return {`, compute the health (gate the foreign detector on iOS):

```ts
  const deviceSession = await getDeviceSessionHealth({
    detectForeign: async (udid) =>
      (await detectIosExternalRunner(undefined, udid)) ? { detected: true } : null,
  });
```

And add `deviceSession,` to the returned object, immediately after `reconnect: client.reconnectState,` (line 102):

```ts
    reconnect: client.reconnectState,
    deviceSession,
```

- [ ] **Step 7: Run the build + status + health tests**

Run: `npm run build && node --test test/unit/gh-210-device-session-health.test.js test/unit/gh-208-status-detached-recovery.test.js`
Expected: PASS (existing status tests still green; new shape additive).

- [ ] **Step 8: Commit**

```bash
git add src/tools/device-session-health.ts src/types.ts src/tools/status.ts dist/ test/unit/gh-210-device-session-health.test.js
git commit -S -m "feat(#210): cdp_status.deviceSession reports rn-fast-runner liveness"
```

---

## Task 2: lazy auto-spawn, cold-build-safe (Fix ii)

**Files:**
- Modify: `src/tools/device-screenshot-raw.ts` (export `resolveBootedIosUdid`)
- Modify: `src/runners/rn-fast-runner-client.ts` (export `derivedDataPathForRunner`; upgrade `postCommand` message)
- Modify: `src/agent-device-wrapper.ts` (auto-spawn-or-error in iOS short-circuit)
- Create: `test/unit/gh-210-ios-autospawn.test.js`

The auto-spawn lives in `runAgentDevice`'s iOS short-circuit (agent-device-wrapper.ts:664-673), not `postCommand` — this choke point already has `activeSession` (deviceId + appId). It is gated so a missing **prebuilt** rig (`.xctestrun`) never triggers a silent multi-minute `xcodebuild test`; instead it returns an actionable error. `device_screenshot` is exempt (it has the simctl fallback in Task 4).

- [ ] **Step 1: Write the failing test** — `test/unit/gh-210-ios-autospawn.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideRunnerSpawn } from '../../dist/agent-device-wrapper.js';

// Pure decision helper: given liveness + whether the rig is prebuilt + whether a
// deviceId is resolvable, decide spawn / proceed / actionable-error.
test('#210 spawn-decision: runner alive → proceed (no spawn)', () => {
  assert.deepEqual(decideRunnerSpawn({ liveness: 'alive', prebuilt: false, deviceId: 'U' }), { action: 'proceed' });
});

test('#210 spawn-decision: down + prebuilt + deviceId → spawn', () => {
  assert.deepEqual(decideRunnerSpawn({ liveness: 'dead', prebuilt: true, deviceId: 'U' }), { action: 'spawn', deviceId: 'U' });
});

test('#210 spawn-decision: stale + prebuilt → spawn (ensureFastRunner reaps then starts)', () => {
  assert.deepEqual(decideRunnerSpawn({ liveness: 'stale', prebuilt: true, deviceId: 'U' }), { action: 'spawn', deviceId: 'U' });
});

test('#210 spawn-decision: down + NOT prebuilt → actionable error (no silent cold build)', () => {
  const d = decideRunnerSpawn({ liveness: 'dead', prebuilt: false, deviceId: 'U' });
  assert.equal(d.action, 'error');
  assert.match(d.message, /device_snapshot action=open/);
  assert.match(d.message, /build-for-testing|one-time|cold build/i);
});

test('#210 spawn-decision: down + prebuilt + NO deviceId → actionable error', () => {
  const d = decideRunnerSpawn({ liveness: 'dead', prebuilt: true, deviceId: null });
  assert.equal(d.action, 'error');
  assert.match(d.message, /no booted iOS simulator|device_snapshot action=open/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-210-ios-autospawn.test.js`
Expected: FAIL — `decideRunnerSpawn` is not exported.

- [ ] **Step 3: Add the pure decision helper** — `src/agent-device-wrapper.ts` (near the iOS short-circuit, module scope):

```ts
import type { FastRunnerLiveness } from './runners/rn-fast-runner-client.js';

export type RunnerSpawnDecision =
  | { action: 'proceed' }
  | { action: 'spawn'; deviceId: string }
  | { action: 'error'; message: string };

export function decideRunnerSpawn(input: {
  liveness: FastRunnerLiveness;
  prebuilt: boolean;
  deviceId: string | null;
}): RunnerSpawnDecision {
  if (input.liveness === 'alive') return { action: 'proceed' };
  if (!input.deviceId) {
    return { action: 'error', message:
      'rn-fast-runner not started and no booted iOS simulator found. Boot a simulator and run `device_snapshot action=open appId=<your.app.id> platform=ios` first.' };
  }
  if (!input.prebuilt) {
    return { action: 'error', message:
      'rn-fast-runner not started and not prebuilt. Run `device_snapshot action=open appId=<your.app.id> platform=ios` first (one-time cold build, ~minutes), then retry — or pre-build once with `xcodebuild build-for-testing` (see plugin Prerequisites).' };
  }
  return { action: 'spawn', deviceId: input.deviceId };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-210-ios-autospawn.test.js`
Expected: PASS (5/5).

- [ ] **Step 5: Export the reusable booted-UDID resolver** — `src/tools/device-screenshot-raw.ts`, after `defaultIosResolver` (line 80):

```ts
/** #210: resolve the booted iOS simulator UDID (reuses the simctl probe used for raw screenshots). null if none booted. */
export async function resolveBootedIosUdid(): Promise<string | null> {
  return defaultIosResolver();
}
```

- [ ] **Step 6: Export the runner DerivedData path** — `src/runners/rn-fast-runner-client.ts`. The path is currently computed inline in `startFastRunner` (line 194). Extract it:

```ts
/** #210: the DerivedData path the runner builds into — used to check `hasBuiltTestProduct` before auto-spawn. */
export function derivedDataPathForRunner(): string {
  return join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');
}
```

Then in `startFastRunner`, replace the inline `const derivedDataPath = join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');` (line 194) with `const derivedDataPath = derivedDataPathForRunner();` (no behavior change).

- [ ] **Step 7: Upgrade the bare `postCommand` not-started message** — `src/runners/rn-fast-runner-client.ts:552` (defense-in-depth floor for any path that bypasses the dispatch gate):

```ts
    throw new Error('rn-fast-runner not started — run `device_snapshot action=open appId=<your.app.id> platform=ios` first (auto-spawns the runner).');
```

- [ ] **Step 8 (A1): Normalize+store the session platform** — `src/tools/device-session.ts`. Line 180 already computes `const platform = (args.platform ?? 'ios').toLowerCase();`. Change the `setActiveSession` call (line 220-226) to store that normalized value so a default (omitted-platform) iOS session reports `platform:'ios'` — otherwise `runAgentDevice`'s iOS branch (and the auto-spawn) is skipped:

```ts
        setActiveSession({
          name: sessionName,
          platform,            // A1: normalized ('ios' when omitted), NOT raw args.platform
          deviceId,
          openedAt: new Date().toISOString(),
          appId,
        });
```

Add a regression test in `test/unit/gh-210-ios-autospawn.test.js` asserting `setActiveSession({platform: undefined-equivalent})` path is not what we ship — i.e. a focused test of the normalization is covered by the device-session suite; if none exists, assert via `getActiveSession().platform === 'ios'` after an injected open. (If the device-session open path is hard to unit-test hermetically, note it for the device-verification step instead — do NOT skip the source change.)

- [ ] **Step 9 (A5): Add `RN_FAST_RUNNER_DOWN` to `ToolErrorCode`** — `src/types.ts`, in the `ToolErrorCode` union (~line 159-219). Add the member (alphabetical/grouped with the other device codes):

```ts
  | 'RN_FAST_RUNNER_DOWN'
```

Run `npm run build` — confirm `tsc` is clean before using the code in Step 11.

- [ ] **Step 10 (A6): Add the structured `ensureRunnerForCommand` helper + test** — `src/agent-device-wrapper.ts`. `ensureFastRunner` swallows start errors, so a failed spawn would degrade into the unstructured `postCommand` throw. This helper probes once, gates via `decideRunnerSpawn`, spawns, then **re-verifies** and returns a structured result. Write the failing test first in `test/unit/gh-210-ios-autospawn.test.js`:

```js
import { ensureRunnerForCommand } from '../../dist/agent-device-wrapper.js';

test('#210 ensureRunnerForCommand: alive → ok (no spawn)', async () => {
  let spawned = 0;
  const r = await ensureRunnerForCommand('U', 'com.x', { probe: async () => 'alive', ensure: async () => { spawned++; }, prebuilt: () => true });
  assert.deepEqual(r, { ok: true });
  assert.equal(spawned, 0);
});

test('#210 ensureRunnerForCommand: dead+prebuilt → spawns, re-verifies alive → ok', async () => {
  let n = 0;
  const r = await ensureRunnerForCommand('U', 'com.x', {
    probe: async () => (n++ === 0 ? 'dead' : 'alive'), // dead, then alive after spawn
    ensure: async () => {}, prebuilt: () => true,
  });
  assert.deepEqual(r, { ok: true });
});

test('#210 ensureRunnerForCommand: dead+NOT prebuilt → actionable error (no spawn)', async () => {
  let spawned = 0;
  const r = await ensureRunnerForCommand('U', 'com.x', { probe: async () => 'dead', ensure: async () => { spawned++; }, prebuilt: () => false });
  assert.equal(r.ok, false);
  assert.match(r.message, /device_snapshot action=open/);
  assert.equal(spawned, 0);
});

test('#210 ensureRunnerForCommand: spawn does not bring it up (swallowed error) → structured fail, NOT a throw', async () => {
  const r = await ensureRunnerForCommand('U', 'com.x', { probe: async () => 'dead', ensure: async () => {}, prebuilt: () => true });
  assert.equal(r.ok, false);
  assert.match(r.message, /did not become ready/i);
});

test('#210 ensureRunnerForCommand: no deviceId → actionable error', async () => {
  const r = await ensureRunnerForCommand(null, 'com.x', { probe: async () => 'dead', ensure: async () => {}, prebuilt: () => true });
  assert.equal(r.ok, false);
  assert.match(r.message, /no booted iOS simulator|device_snapshot action=open/i);
});
```

Then implement it (module scope in `src/agent-device-wrapper.ts`), reusing `decideRunnerSpawn`:

```ts
export interface EnsureRunnerDeps {
  probe?: () => Promise<FastRunnerLiveness>;
  ensure?: (deviceId: string, bundleId: string) => Promise<void>;
  prebuilt?: () => boolean;
}

export async function ensureRunnerForCommand(
  deviceId: string | null,
  bundleId: string,
  deps: EnsureRunnerDeps = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const probe = deps.probe ?? probeFastRunnerLiveness;
  const ensure = deps.ensure ?? ensureFastRunner;
  const prebuilt = deps.prebuilt ?? (() => hasBuiltTestProduct(derivedDataPathForRunner()));

  const liveness = await probe();
  const decision = decideRunnerSpawn({ liveness, prebuilt: prebuilt(), deviceId });
  if (decision.action === 'proceed') return { ok: true };
  if (decision.action === 'error') return { ok: false, message: decision.message };

  await ensure(decision.deviceId, bundleId);     // alive→noop, stale→reap+start, dead→start (swallows on failure)
  const after = await probe();                    // A6: re-verify — ensureFastRunner swallows start errors
  if (after === 'alive') return { ok: true };
  return { ok: false, message:
    'rn-fast-runner did not become ready after auto-spawn. Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.' };
}
```

Add imports at the top of `agent-device-wrapper.ts`: `import { probeFastRunnerLiveness, hasBuiltTestProduct, derivedDataPathForRunner } from './runners/rn-fast-runner-client.js';`, `import { resolveBootedIosUdid } from './tools/device-screenshot-raw.js';`, and confirm `failResult` is imported (add `import { failResult } from './utils.js';` if absent). Run the build + tests — expect the 5 new `ensureRunnerForCommand` tests + the 5 `decideRunnerSpawn` tests green.

- [ ] **Step 11: Wire `ensureRunnerForCommand` into the iOS short-circuit** — `src/agent-device-wrapper.ts`, the `if (targetPlatform === 'ios' && !opts.skipSession && RN_FAST_RUNNER_COMMANDS.has(cliArgs[0]))` block (664-673). Replace the body:

```ts
  if (
    targetPlatform === 'ios' &&
    !opts.skipSession &&
    RN_FAST_RUNNER_COMMANDS.has(cliArgs[0])
  ) {
    const appId = activeSession?.appId ?? resolveBundleId('ios') ?? undefined;
    // A2/#210: device_screenshot has its own simctl fallback (device-list.ts) — never
    // block it here; the gate is only for verbs that genuinely require the runner.
    if (cliArgs[0] !== 'screenshot') {
      const deviceId = activeSession?.deviceId ?? (await resolveBootedIosUdid());
      const ready = await ensureRunnerForCommand(deviceId ?? null, appId ?? '');
      if (!ready.ok) return failResult(ready.message, 'RN_FAST_RUNNER_DOWN');
    }
    const { runIOS } = await import('./runners/rn-fast-runner-client.js');
    const ios = buildRunIOSArgs(cliArgs, appId);
    return runIOS(ios);
  }
```

- [ ] **Step 12: Run the full build + targeted tests**

Run: `npm run build && node --test test/unit/gh-210-ios-autospawn.test.js`
Expected: PASS (10/10 — `decideRunnerSpawn` + `ensureRunnerForCommand`). Also `node --test test/unit/*fast-runner*.test.js test/unit/*agent-device*.test.js test/unit/*device-session*.test.js` — expect green (existing runner-override tests force the runner up so the new gate's `probe()` returns alive → proceed; the platform-normalization change makes default-iOS sessions report `'ios'`, which existing tests either already pass explicitly or are unaffected — fix any that asserted the old `undefined`).

- [ ] **Step 13: Commit**

```bash
git add src/agent-device-wrapper.ts src/runners/rn-fast-runner-client.ts src/tools/device-screenshot-raw.ts src/tools/device-session.ts src/types.ts dist/ test/unit/gh-210-ios-autospawn.test.js
git commit -S -m "feat(#210): auto-spawn rn-fast-runner on device_* (cold-build-safe, structured); normalize session platform"
```

---

## Task 3: arbiter screenshot fallback exception (Fix iii-a)

**Files:**
- Modify: `src/lifecycle/device-arbiter.ts`
- Create: `test/unit/gh-210-arbiter-screenshot.test.js`

`device_screenshot` is classified `interaction` and refused with `BUSY_FLOW_ACTIVE` during a flow. simctl screenshot is OS-level (no XCUITest), so it is safe alongside a flow. Add a narrow allowlist: when an interaction tool in `FLOW_FALLBACK_TOOLS` is refused **only** because a flow holds the lease, run it unleased (the handler then takes the simctl path). Add a `flowActive` getter so the handler knows to do so.

- [ ] **Step 1: Write the failing test** — `test/unit/gh-210-arbiter-screenshot.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeviceSessionArbiter, arbiterWrap } from '../../dist/lifecycle/device-arbiter.js';

test('#210 arbiter: flowActive getter reflects a held flow lease', () => {
  const a = new DeviceSessionArbiter();
  assert.equal(a.flowActive, false);
  a.tryAcquire('flow', 'maestro_run');
  assert.equal(a.flowActive, true);
});

test('#210 arbiter: device_screenshot runs UNLEASED during a flow (fallback allowlist)', async () => {
  const a = new DeviceSessionArbiter();
  a.tryAcquire('flow', 'maestro_run');
  let ran = 0;
  const wrapped = arbiterWrap('device_screenshot', async () => { ran++; return { content: [] }; }, a);
  const res = await wrapped();
  assert.equal(ran, 1, 'screenshot handler must run during a flow (simctl path is flow-safe)');
  assert.ok(!res.isError, 'must not refuse device_screenshot during a flow');
});

test('#210 arbiter: a NON-allowlisted interaction tool is still refused during a flow', async () => {
  const a = new DeviceSessionArbiter();
  a.tryAcquire('flow', 'maestro_run');
  const wrapped = arbiterWrap('device_press', async () => ({ content: [] }), a);
  const res = await wrapped();
  assert.equal(res.isError, true);
});

test('#210 arbiter: device_screenshot still acquires a lease when NO flow (coordinates normally)', async () => {
  const a = new DeviceSessionArbiter();
  let snapshotDuring = -1;
  const wrapped = arbiterWrap('device_screenshot', async () => { snapshotDuring = a.snapshot.activeOps; return { content: [] }; }, a);
  await wrapped();
  assert.equal(snapshotDuring, 1, 'with no flow, screenshot holds an interaction lease while running');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-210-arbiter-screenshot.test.js`
Expected: FAIL — `a.flowActive` is undefined; `device_screenshot` is refused during a flow.

- [ ] **Step 3: Add the `flowActive` getter** — `src/lifecycle/device-arbiter.ts`, in the class (after `snapshot` getter ~line 86):

```ts
  get flowActive(): boolean {
    return this.flowLeaseHeldBy !== null;
  }
```

- [ ] **Step 4: Add the allowlist + the unleased-run branch** — `src/lifecycle/device-arbiter.ts`. Add the set near the plane sets (~line 120):

```ts
// #210: interaction tools that have a flow-SAFE fallback (OS-level, no XCUITest) and
// may therefore run UNLEASED while a flow owns the device, instead of refusing.
// device_screenshot falls back to `xcrun simctl io screenshot`, which cannot conflict
// with a Maestro/WDA flow. The handler MUST consult `arbiter.flowActive` and take the
// simctl path when true.
const FLOW_FALLBACK_TOOLS = new Set<string>(['device_screenshot']);
```

Then in `arbiterWrap`, change the refusal branch (line 153) so an allowlisted tool refused due to a flow runs unleased:

```ts
    const res = inst.tryAcquire(plane, name);
    if (!res.ok) {
      if (FLOW_FALLBACK_TOOLS.has(name)) {
        // Flow owns the device; this tool has an OS-level fallback. Run it without a
        // lease — it must not touch XCUITest while the flow holds the device.
        return await handler(...args);
      }
      const who = res.holder ? `${res.holder.tool} (${res.holder.plane})` : 'a Maestro flow';
      return failResult(
        `Refusing ${name}: blocked by ${who} on this device — reads and taps can't interleave ` +
        `with a running Maestro flow. Retry after it completes; if it appears stuck, ` +
        `run cdp_status({ resetArbiter: true }).`,
        res.code,
        { holder: res.holder, conflict: true },
      );
    }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-210-arbiter-screenshot.test.js`
Expected: PASS (4/4).

- [ ] **Step 6: Run the existing arbiter suite (no regression)**

Run: `node --test test/unit/*arbiter*.test.js`
Expected: PASS (the change only adds an allowlisted branch; non-allowlisted tools behave exactly as before).

- [ ] **Step 7: Commit**

```bash
git add src/lifecycle/device-arbiter.ts dist/ test/unit/gh-210-arbiter-screenshot.test.js
git commit -S -m "feat(#210): allow device_screenshot to run unleased during a flow (simctl-safe)"
```

---

## Task 4: `device_screenshot` simctl fallback (Fix iii-b)

**Files:**
- Modify: `src/tools/device-list.ts` (`captureAndResizeScreenshot`)
- Create: `test/unit/gh-210-screenshot-fallback.test.js`

When a flow owns the device, OR the rn-fast-runner path errors, `device_screenshot` falls back to `tryRawScreenshot()` (simctl/adb) so it always returns pixels. Inject `flowActive` + `tryRawScreenshot` + `runAgentDeviceFn` for hermetic tests.

- [ ] **Step 1: Write the failing test** — `test/unit/gh-210-screenshot-fallback.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseScreenshotPath } from '../../dist/tools/device-list.js';

// Pure routing helper: simctl (flow-safe) / runner / fail. It must NEVER return
// 'runner' while a flow is active (A3 — that would hit XCUITest unleased and crash the flow).
test('#210 screenshot-route: flow active + platform → simctl (skip runner)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: 'ios' }), 'simctl');
});

test('#210 screenshot-route: no flow → runner first', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: 'ios' }), 'runner');
});

test('#210 screenshot-route: no flow + no platform → runner (agent-device resolves default)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: false, platform: null }), 'runner');
});

test('#210 screenshot-route: flow active + NO platform → fail (must NOT touch the runner during a flow)', () => {
  assert.equal(chooseScreenshotPath({ flowActive: true, platform: null }), 'fail');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/gh-210-screenshot-fallback.test.js`
Expected: FAIL — `chooseScreenshotPath` not exported.

- [ ] **Step 3: Add the routing helper** — `src/tools/device-list.ts` (module scope, near `captureAndResizeScreenshot`):

```ts
/**
 * #210: pick the screenshot backend.
 * - flow active + platform known → 'simctl' (OS-level, flow-safe).
 * - flow active + platform unknown → 'fail' (NEVER the runner — would hit XCUITest
 *   unleased and crash the flow, A3).
 * - no flow → 'runner' (rn-fast-runner primary; its own simctl fallback fires on error).
 */
export function chooseScreenshotPath(input: { flowActive: boolean; platform: 'ios' | 'android' | null }): 'simctl' | 'runner' | 'fail' {
  if (input.flowActive) return input.platform ? 'simctl' : 'fail';
  return 'runner';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/gh-210-screenshot-fallback.test.js`
Expected: PASS (4/4).

- [ ] **Step 5: Wire the fallback into `captureAndResizeScreenshot`** — `src/tools/device-list.ts`. Add imports: `import { arbiter } from '../lifecycle/device-arbiter.js';` and ensure `tryRawScreenshot` is imported (it already is for the explicit-platform path). Replace the dispatch region (lines 222-244) so flow-active and runner-error both fall back to simctl:

```ts
  const rawResultOk = (path: string, platform: 'ios' | 'android'): ToolResult => ({
    content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, data: { path, via: platform === 'android' ? 'adb' : 'simctl' } }) }], // A8: accurate backend name
  });
  const rawResultFail = (platform: 'ios' | 'android', reason: string): ToolResult => {
    const cli = platform === 'ios' ? 'xcrun simctl' : 'adb';
    const hint = reason === 'no-device'
      ? `No booted ${platform === 'ios' ? 'iOS Simulator' : 'Android emulator'} detected by ${cli}. Boot one and retry; if your emulator is in 'offline' or 'unauthorized' state, restart it.`
      : `Capture command failed (${cli}). The device may be transitioning state (booting, OOM, locked). Retry once it stabilizes.`;
    return failResult(`device_screenshot platform=${platform} failed: ${hint}`, 'SCREENSHOT_FAILED', { platform, reason });
  };

  let result: ToolResult | undefined;
  const flowActive = arbiter.flowActive;
  const route = chooseScreenshotPath({ flowActive, platform: args.platform ?? null });

  // A3: a Maestro flow owns the device and we cannot resolve a platform to simctl on →
  // refuse rather than touch the XCUITest runner (which would crash the flow).
  if (route === 'fail') {
    return failResult(
      'device_screenshot: a Maestro flow owns the device and the platform could not be resolved for a simctl fallback. Pass platform=ios|android, or retry after the flow completes.',
      'SCREENSHOT_FAILED',
      { flowActive: true },
    );
  }

  // simctl path: a flow owns the device (raw-ONLY — never fall through to the runner, A3),
  // OR the existing GH#136 explicit-platform disambiguation (no flow). Both hard-fail on error.
  if ((route === 'simctl' || args.platformExplicit) && (args.platform === 'ios' || args.platform === 'android')) {
    const raw = await tryRawScreenshot(args.platform, requestedPath);
    if (raw.ok) result = rawResultOk(raw.path, args.platform);
    else return rawResultFail(args.platform, raw.reason);
  }

  if (!result) {
    // route === 'runner' (NO flow — runAgentDevice can never run while a flow is active here).
    // A2: runIOS()/postCommand THROW when the runner is down — catch it (the `isError` check
    // alone is dead code for that path), then fall back to simctl so iOS never hard-fails.
    try {
      result = await runAgentDeviceFn(buildScreenshotArgs(argsWithPath), { platform: args.platform ?? null });
    } catch (err) {
      result = failResult(err instanceof Error ? err.message : String(err), 'SCREENSHOT_FAILED');
    }
    if (result.isError && (args.platform === 'ios' || args.platform === 'android')) {
      const raw = await tryRawScreenshot(args.platform, requestedPath);
      if (raw.ok) result = rawResultOk(raw.path, args.platform);
    }
  }
  if (result.isError) return result;
```

- [ ] **Step 6 (A3): Resolve platform from the active session in the handler** — `src/tools/device-list.ts`, `createDeviceScreenshotHandler` (line 271-275). Add `getActiveSession` to the platform resolution so a flow-active capture has a platform (else route is `'fail'`). Import `getActiveSession` from `../agent-device-wrapper.js`:

```ts
  return async (args) => {
    const platformExplicit = args.platform === 'ios' || args.platform === 'android';
    const platform: 'ios' | 'android' | null =
      args.platform
      ?? (getClient?.()?.connectedTarget?.platform as 'ios' | 'android' | undefined)
      ?? (getActiveSession()?.platform as 'ios' | 'android' | undefined)
      ?? null;
    return captureAndResizeScreenshot({ ...args, platform, platformExplicit });
  };
```

- [ ] **Step 7 (A7): Add integration tests for the wiring** — append to `test/unit/gh-210-screenshot-fallback.test.js`. These inject a **throwing** `runAgentDeviceFn` + a held flow lease — the cases the pure helper can't catch (A2/A3). Use the existing seams: `_setForTest` (device-screenshot-raw) for the simctl capturer, the exported `arbiter` for the flow lease, and the `captureAndResizeScreenshot` `deps`/override the module uses for `runAgentDeviceFn` (confirm the injection seam name when implementing — `device-list.ts` already wires `runAgentDeviceFn`; expose a test setter if none exists, following the `_setRunAgentDeviceForTest` precedent).

```js
import { captureAndResizeScreenshot } from '../../dist/tools/device-list.js';
import { arbiter } from '../../dist/lifecycle/device-arbiter.js';
import { _setForTest as setRawForTest, _resetForTest as resetRawForTest } from '../../dist/tools/device-screenshot-raw.js';

test('#210 screenshot-int: runner THROWS (down) + raw succeeds → simctl fallback, no crash', async () => {
  setRawForTest({ iosCapturer: async () => true });
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'ios', platformExplicit: false, maxWidth: 0,
      __runAgentDeviceFnForTest: async () => { throw new Error('rn-fast-runner not started'); }, // injected throwing runner
    });
    assert.ok(!res.isError, 'a thrown runner error must be caught and routed to simctl');
  } finally { resetRawForTest(); }
});

test('#210 screenshot-int: flow active → runner fn is NEVER called (raw-only)', async () => {
  setRawForTest({ iosCapturer: async () => true });
  const lease = arbiter.tryAcquire('flow', 'maestro_run');
  let runnerCalls = 0;
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'ios', platformExplicit: false, maxWidth: 0,
      __runAgentDeviceFnForTest: async () => { runnerCalls++; return { content: [] }; },
    });
    assert.equal(runnerCalls, 0, 'during a flow, the XCUITest runner must never be invoked');
    assert.ok(!res.isError);
  } finally { if (lease.ok) arbiter.release(lease.lease); resetRawForTest(); }
});

test('#210 screenshot-int: flow active + raw fails → SCREENSHOT_FAILED, runner still NEVER called', async () => {
  setRawForTest({ iosCapturer: async () => false });
  const lease = arbiter.tryAcquire('flow', 'maestro_run');
  let runnerCalls = 0;
  try {
    const res = await captureAndResizeScreenshot({
      platform: 'ios', platformExplicit: false, maxWidth: 0,
      __runAgentDeviceFnForTest: async () => { runnerCalls++; return { content: [] }; },
    });
    assert.equal(res.isError, true);
    assert.equal(runnerCalls, 0, 'must NOT fall through to the runner when simctl fails during a flow');
  } finally { if (lease.ok) arbiter.release(lease.lease); resetRawForTest(); }
});
```

> Implementation note: add a `__runAgentDeviceFnForTest` (or a module `_setRunAgentDeviceFnForTest` seam mirroring `device-screenshot-raw`'s `_setForTest`) so `captureAndResizeScreenshot` can take an injected runner fn without booting a device. The production default stays `runAgentDevice`.

- [ ] **Step 8: Run build + the screenshot + device-list suites**

Run: `npm run build && node --test test/unit/gh-210-screenshot-fallback.test.js test/unit/*device-list*.test.js test/unit/*screenshot*.test.js`
Expected: PASS — existing explicit-platform GH#136 behavior preserved (explicit + no-flow still hard-fails on a real no-device); new flow-raw-only + thrown-runner fallbacks green.

- [ ] **Step 9: Commit**

```bash
git add src/tools/device-list.ts dist/ test/unit/gh-210-screenshot-fallback.test.js
git commit -S -m "feat(#210): device_screenshot simctl fallback (flow-safe, throw-safe, never hard-fails on iOS)"
```

---

## Task 5: docs + changeset + full suite

**Files:**
- Modify: `CLAUDE.md` (3-layer contract section)
- Modify: `docs-site/src/content/docs/...` (the "Using rn-dev-agent with maestro-mcp" / device-control page)
- Create: `.changeset/gh-210-device-session-visibility.md`

- [ ] **Step 1: Update the 3-layer contract** — in `CLAUDE.md`, under the "Three-layer device-control contract" section, add a `#210` note: rn-fast-runner is THE `device_*` interaction backend; it auto-spawns from any `device_*` verb when prebuilt; `cdp_status.deviceSession` reports its liveness; `device_screenshot` falls back to `simctl` during a flow; mid-flow tree/state via `cdp_component_tree`/`cdp_store_state` (introspection coexists). Note that the issue's "ride WDA" was rejected (see the spec §8).

- [ ] **Step 2: Mirror the note in docs-site** — add the same coexistence guidance to the maestro-interop / device-control page under `docs-site/`.

- [ ] **Step 3: Write the changeset** — `.changeset/gh-210-device-session-visibility.md`:

```md
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

Fix #210: iOS device-session visibility + self-healing. `cdp_status` now reports `deviceSession: { sessionOpen, rnFastRunner: 'alive'|'stale'|'dead', appId?, deviceId?, foreignRunner? }` so the agent can see the XCUITest runner state before calling `device_*`. `device_find/press/fill` auto-spawn the runner when a session/booted simulator exists and the rig is prebuilt (cold-build-safe — a missing prebuilt rig returns an actionable error naming `device_snapshot action=open` instead of a silent multi-minute build). `device_screenshot` now falls back to `xcrun simctl io screenshot` whenever the runner can't serve it — including while a Maestro flow owns the device — so it never hard-fails on iOS. Reframes the issue's "ride Maestro's WDA" suggestion (rejected: WDA is per-flow/ephemeral and a WDA client would add a second XCUITest backend rather than unify; mid-flow pixels use simctl, mid-flow state uses CDP introspection).
```

- [ ] **Step 4: Full build + entire unit suite**

Run: `npm run build && npm test`
Expected: PASS — all existing tests + the new `gh-210-*` tests green; `tsc` clean.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs-site .changeset/gh-210-device-session-visibility.md dist/
git commit -S -m "docs(#210): 3-layer contract + changeset for device-session visibility"
```

- [ ] **Step 6: Device verification (manual, end of branch)**

iOS simulator (booted, Metro running):
1. With NO session: `device_screenshot` → returns pixels via simctl (`meta`/`via` indicates fallback). `cdp_status.deviceSession` → `sessionOpen:false, rnFastRunner:'dead'`.
2. `device_snapshot action=open` → `cdp_status.deviceSession` → `sessionOpen:true, rnFastRunner:'alive'`.
3. `device_find` after the runner is up → works (auto-spawn no-op).
4. During a `maestro_run` flow: `device_screenshot` → returns pixels (simctl), NOT `BUSY_FLOW_ACTIVE`; `device_press` → still refuses.

Android emulator: `device_screenshot` + `device_find` still work (no regression); `cdp_status.deviceSession.rnFastRunner` is `'dead'` (iOS-only field).

---

## Self-Review (completed during planning)

- **Spec coverage:** (i) Task 1 ✓; (ii) Task 2 ✓; (iii reframed) Tasks 3+4 ✓; docs + rejection record Task 5 ✓; state-model table → `device-session-health` tests Task 1 ✓.
- **Placeholder scan:** all code blocks concrete; the only `<your.app.id>` tokens are literal user-facing message placeholders, not plan gaps.
- **Type consistency:** `FastRunnerLiveness` ('alive'|'stale'|'dead') reused across Tasks 1–2; `DeviceSessionHealth`, `RunnerSpawnDecision`, `chooseScreenshotPath` signatures consistent between their defining task and tests; `deviceSession.foreignRunner` is `{ detected: true }` in both types.ts (Task 1.5) and the helper (Task 1.3).
- **Post-amendment (2026-06-08):** the multi-LLM plan review (Codex + Gemini) found 5 HIGH + 2 MED + 1 LOW wiring defects — all folded in; see the "Amendments applied" section at the top. `RN_FAST_RUNNER_DOWN` is now added explicitly (Task 2 Step 9); `SCREENSHOT_FAILED` already exists (`device-list.ts:236`).
- **Open verification for the implementer:** confirm `failResult` import in `agent-device-wrapper.ts`; confirm the `runAgentDeviceFn` injection seam in `device-list.ts` (Task 4 Step 7 needs `__runAgentDeviceFnForTest` or equivalent); confirm the exact `docs-site` device-control page path; the `device-session.ts` platform-normalization (A1) may not be hermetically unit-testable — verify on device if so.
