# Android Post-Flow Lifecycle (#243 + #244) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the first `device_*` after a Maestro flow reliable (#243) and let `open → flow → close` round-trip cleanly (#244), both regressions from the #237 Android slot-release.

**Architecture:** #243 — gate `startAndroidRunner` readiness on the runner's own `GET /health` (HTTP-truthful) instead of the stale-prone `adb logcat` ring buffer, and surface a structured `RN_ANDROID_RUNNER_DOWN` instead of a bare `fetch failed`. #244 — extract a dependency-injected `closeDeviceSession(deps)` (mirroring #210's `getDeviceSessionHealth`) that treats a "session already gone" close error as benign: clean up local state and return ok.

**Tech Stack:** TypeScript (Node ≥22) compiled with `tsc` to a git-tracked `dist/`; tests are plain JS under `scripts/cdp-bridge/test/unit/*.test.js` run with `node --test` against `dist/`. The Android runner client already exposes `_setFetchForTest` / `_setAndroidRunnerStateForTest` seams.

**Conventions for every commit:** `dist/` is tracked — after `npm run build`, `git add` the rebuilt `dist/` files alongside `src/` and `test/`. Commits are signed (`git commit -S`). No unnecessary comments. Explicit type imports.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` | Android runner spawn + HTTP dispatch | Add `waitForAndroidRunnerHealth`; gate `startAndroidRunner` on it (drop logcat readiness); structured `RN_ANDROID_RUNNER_DOWN` in `runAndroid` |
| `scripts/cdp-bridge/src/types.ts` | `ToolErrorCode` union | Add `'RN_ANDROID_RUNNER_DOWN'` member |
| `scripts/cdp-bridge/src/tools/device-session-close.ts` *(new)* | Close a device session; tolerate a gone underlying session | Create `closeDeviceSession(deps)` + `isBenignSessionGoneError` |
| `scripts/cdp-bridge/src/tools/device-session.ts` | `device_snapshot` handler | `close` branch delegates to `closeDeviceSession` |
| `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js` *(new)* | #243 tests | health poll + `RN_ANDROID_RUNNER_DOWN` |
| `scripts/cdp-bridge/test/unit/gh-244-close-session-gone.test.js` *(new)* | #244 tests | `closeDeviceSession` decision table |
| `.changeset/gh-243-244-android-post-flow-lifecycle.md` *(new)* | Release note | patch bump |

---

## Task 1: `waitForAndroidRunnerHealth` + health-gated readiness (#243 part 1)

**Files:**
- Create: `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js`
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts`

- [ ] **Step 1: Write the failing test** — create `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js`:

```js
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitForAndroidRunnerHealth,
  _setFetchForTest,
} from '../../dist/runners/rn-android-runner-client.js';

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
});

test('#243 waitForAndroidRunnerHealth resolves true once /health returns {ok:true}', async () => {
  _setFetchForTest(async (url) => {
    assert.match(String(url), /\/health$/);
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(healthy, true);
});

test('#243 waitForAndroidRunnerHealth keeps polling until healthy (no premature ready off a dead port)', async () => {
  let n = 0;
  _setFetchForTest(async () => {
    n += 1;
    if (n < 3) throw new Error('fetch failed'); // server socket not bound yet
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 1000, intervalMs: 10 });
  assert.equal(healthy, true);
  assert.ok(n >= 3, 'must keep polling until /health actually succeeds');
});

test('#243 waitForAndroidRunnerHealth returns false on timeout (never throws)', async () => {
  _setFetchForTest(async () => { throw new Error('fetch failed'); });
  const healthy = await waitForAndroidRunnerHealth(22089, { timeoutMs: 60, intervalMs: 10 });
  assert.equal(healthy, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-243-android-runner-health.test.js`
Expected: FAIL — `waitForAndroidRunnerHealth` is not an exported function (import resolves to `undefined`; calling it throws `TypeError`).

- [ ] **Step 3: Add `waitForAndroidRunnerHealth`** to `rn-android-runner-client.ts`. Insert these constants near the other module constants (after `const INSTRUMENTATION = ...` / `const MAIN_LOOP_CLASS = ...`, around line 19):

```ts
const HEALTH_POLL_INTERVAL_MS = 150;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;
```

Insert the function immediately before `export async function startAndroidRunner` (around line 136):

```ts
/**
 * GH#243: HTTP-truthful readiness. The runner logs RN_ANDROID_RUNNER_LISTENER_READY,
 * but `adb logcat` replays the ring buffer — a prior runner's ready line (same tag +
 * fixed port) fired readiness before the new ServerSocket bound, so the first
 * post-flow POST /command hit a dead port ("fetch failed"). Poll the runner's own
 * GET /health, which is true only once the socket is accepting. Bounded by timeoutMs
 * (defaults to the cold-start ready budget); never throws — returns false on timeout.
 */
export async function waitForAndroidRunnerHealth(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HEALTH_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      if (resp.ok) {
        const body = (await resp.json()) as { ok?: boolean };
        if (body?.ok === true) return true;
      }
    } catch {
      // server not accepting yet — keep polling
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-243-android-runner-health.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Gate `startAndroidRunner` on `/health`; remove logcat readiness.** Replace the whole `startAndroidRunner` body (current lines ~136-220) with:

```ts
export async function startAndroidRunner(deviceId?: string, bundleId?: string, port = DEFAULT_PORT): Promise<AndroidRunnerState> {
  if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId)) return runnerState!;

  const serial = adbSerialArgs(deviceId);
  await execFileAsync('adb', [...serial, 'forward', `tcp:${port}`, `tcp:${port}`]);

  return new Promise((resolve, reject) => {
    let resolved = false;

    const child = spawn('adb', [
      ...serial,
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'RN_ANDROID_RUNNER_PORT',
      String(port),
      '-e',
      'class',
      MAIN_LOOP_CLASS,
      INSTRUMENTATION,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runnerProcess = child;

    // GH#243: drain + tail the instrument's own output so a cold-start failure stays
    // debuggable now that logcat is gone, and so an unconsumed stdio:'pipe' can't fill
    // its ~64KB buffer and wedge the child.
    let diag = '';
    const capture = (chunk: Buffer) => { diag = (diag + chunk.toString('utf-8')).slice(-4_000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const finishReady = () => {
      if (resolved) return;
      resolved = true;
      const state: AndroidRunnerState = {
        port,
        pid: child.pid!,
        ...(deviceId ? { deviceId } : {}),
        ...(bundleId ? { bundleId } : {}),
        startedAt: new Date().toISOString(),
      };
      runnerState = state;
      try { writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8'); } catch { /* non-fatal */ }
      resolve(state);
    };

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`Failed to spawn Android runner instrumentation: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (runnerProcess === child) {
        runnerProcess = null;
        runnerState = null;
        try { unlinkSync(STATE_FILE); } catch { /* already removed */ }
      }
      if (!resolved) {
        resolved = true;
        reject(new Error(`Android runner instrumentation exited before readiness (code ${code})${diag ? `\n${diag.trim()}` : ''}`));
      }
    });

    // GH#243: readiness is the runner's own /health, not the (stale-prone) logcat
    // ring buffer. /health is true only once the ServerSocket is actually accepting.
    void waitForAndroidRunnerHealth(port).then((healthy) => {
      if (resolved) return;
      if (healthy) {
        finishReady();
        return;
      }
      resolved = true;
      child.kill('SIGTERM');
      reject(new Error(`Android runner did not become ready within ${READY_TIMEOUT_MS / 1000}s (no /health on port ${port})${diag ? `\n${diag.trim()}` : ''}`));
    });
  });
}
```

Then remove the now-unused logcat module state — the `am instrument` child's own captured
`diag` tail replaces logcat as the cold-start diagnostic. Delete the line
`let logcatProcess: ChildProcess | null = null;` (around line 78) and the logcat `spawn(...)`
block + its `logcatProcess.stdout!.on('data', ...)` readiness handler (the `pending` accumulator
goes with it); in `stopAndroidRunner` delete the line `logcatProcess?.kill('SIGTERM');` and the
line `logcatProcess = null;`. Leave the rest of `stopAndroidRunner` unchanged. (`spawn` and
`ChildProcess` are still used by the instrument `child` / `runnerProcess`.)

- [ ] **Step 6: Build to confirm no unused-symbol / type errors**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: exits 0. (If `tsc` flags an unused `spawn`/`ChildProcess` import — it must NOT, both are still used by the instrument `child` + `runnerProcess`.)

- [ ] **Step 7: Run the runner test suites to confirm no regression**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-243-android-runner-health.test.js test/unit/runners/rn-android-runner-client.test.js test/unit/android-runner-short-circuit.test.js`
Expected: PASS (all). The pre-seeded-live-state tests still short-circuit `startAndroidRunner` and never touch the spawn/health path.

- [ ] **Step 8: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/runners/rn-android-runner-client.ts \
        scripts/cdp-bridge/dist/runners/rn-android-runner-client.js \
        scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js
git commit -S -m "fix(#243): gate rn-android-runner readiness on GET /health, not stale logcat

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: structured `RN_ANDROID_RUNNER_DOWN` in `runAndroid` (#243 part 2)

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (add error code)
- Modify: `scripts/cdp-bridge/src/runners/rn-android-runner-client.ts` (`runAndroid` + helpers)
- Test: `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js` (append)

- [ ] **Step 1: Write the failing test** — append to `scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js`:

```js
import {
  runAndroid,
  isAndroidConnectionFailure,
  _setAndroidRunnerStateForTest,
} from '../../dist/runners/rn-android-runner-client.js';

// Proves the classifier recognizes BOTH failure origins — postCommand ("fetch failed")
// AND startAndroidRunner ("did not become ready") — so the structured RN_ANDROID_RUNNER_DOWN
// path is covered regardless of which call in the try{} rejects. RUNNER_TIMEOUT (a bound but
// wedged instrument) must NOT classify as a connection failure (it is rethrown).
test('#243 isAndroidConnectionFailure matches both startAndroidRunner + postCommand shapes, not RUNNER_TIMEOUT', () => {
  assert.equal(isAndroidConnectionFailure('fetch failed'), true);
  assert.equal(isAndroidConnectionFailure('Android runner did not become ready within 30s (no /health on port 22089)'), true);
  assert.equal(isAndroidConnectionFailure('connect ECONNREFUSED 127.0.0.1:22089'), true);
  assert.equal(isAndroidConnectionFailure('RUNNER_TIMEOUT: rn-android-runner did not respond to "snapshot" within 10000ms'), false);
});

test('#243 runAndroid returns RN_ANDROID_RUNNER_DOWN (not bare "fetch failed") on connection failure', async () => {
  _setAndroidRunnerStateForTest({
    port: 22089,
    pid: process.pid, // alive → startAndroidRunner short-circuits, no real adb spawn
    deviceId: 'emulator-5554',
    bundleId: 'com.example',
    startedAt: '2026-06-09T00:00:00.000Z',
  });
  _setFetchForTest(async () => { throw new Error('fetch failed'); });

  const result = await runAndroid({ command: 'snapshot', bundleId: 'com.example' });

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(text, /RN_ANDROID_RUNNER_DOWN/);
  assert.match(text, /not reachable/);
});
```

> Note: the two `import` lines above can be merged into the file's existing import block — kept separate here only so the task is self-contained.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-243-android-runner-health.test.js`
Expected: FAIL — the current `runAndroid` lets the raw `fetch failed` propagate (the test sees a thrown error / a result whose text lacks `RN_ANDROID_RUNNER_DOWN`).

- [ ] **Step 3: Add the error code** to `scripts/cdp-bridge/src/types.ts` — in the `ToolErrorCode` union, add a member directly under the existing `RN_FAST_RUNNER_DOWN` line:

```ts
  | 'RN_ANDROID_RUNNER_DOWN'    // #243: rn-android-runner not reachable (cold-start race / can't bind port)
```

- [ ] **Step 4: Add the classifier helpers + wrap `runAndroid`'s dispatch.** In `rn-android-runner-client.ts`, add these two helpers at the bottom of the file (after `mapRunnerNodesToFlat` or after `runAndroid`):

```ts
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAndroidConnectionFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|not started|did not become ready/i.test(message);
}
```

Then, inside `runAndroid`, replace the current sequence:

```ts
  await startAndroidRunner(args.deviceId, args.bundleId);

  const body: Record<string, unknown> = { command: args.command };
  if (args.bundleId) body.appBundleId = args.bundleId;
  if (args.x !== undefined) body.x = args.x;
  if (args.y !== undefined) body.y = args.y;
  if (args.x1 !== undefined) body.x1 = args.x1;
  if (args.y1 !== undefined) body.y1 = args.y1;
  if (args.x2 !== undefined) body.x2 = args.x2;
  if (args.y2 !== undefined) body.y2 = args.y2;
  if (args.text !== undefined) body.text = args.text;
  if (args.exact !== undefined) body.exact = args.exact;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.scale !== undefined) body.scale = args.scale;
  if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;

  const resp = await postCommand(body);
```

with (body building moved first, dispatch wrapped):

```ts
  const body: Record<string, unknown> = { command: args.command };
  if (args.bundleId) body.appBundleId = args.bundleId;
  if (args.x !== undefined) body.x = args.x;
  if (args.y !== undefined) body.y = args.y;
  if (args.x1 !== undefined) body.x1 = args.x1;
  if (args.y1 !== undefined) body.y1 = args.y1;
  if (args.x2 !== undefined) body.x2 = args.x2;
  if (args.y2 !== undefined) body.y2 = args.y2;
  if (args.text !== undefined) body.text = args.text;
  if (args.exact !== undefined) body.exact = args.exact;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.scale !== undefined) body.scale = args.scale;
  if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;

  let resp: RunnerResponse;
  try {
    await startAndroidRunner(args.deviceId, args.bundleId);
    resp = await postCommand(body);
  } catch (err) {
    const m = errMessage(err);
    // GH#243: a connection failure (runner just restarted after a flow, or can't
    // bind its port) must surface as a structured, retryable error — never a bare
    // "fetch failed". RUNNER_TIMEOUT (a wedged-but-bound instrument) is NOT a
    // connection failure and is rethrown unchanged.
    if (isAndroidConnectionFailure(m)) {
      return failResult(
        `rn-android-runner is not reachable: ${m}`,
        'RN_ANDROID_RUNNER_DOWN',
        { hint: 'The runner could not start or bind its port (e.g. just restarted after a Maestro flow). Retry the command; if it persists, ensure the emulator is booted and the app is installed.' },
      );
    }
    throw err;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-243-android-runner-health.test.js`
Expected: PASS (5 tests: 3 health + classifier + runner-down).

- [ ] **Step 6: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/types.ts \
        scripts/cdp-bridge/dist/types.js \
        scripts/cdp-bridge/src/runners/rn-android-runner-client.ts \
        scripts/cdp-bridge/dist/runners/rn-android-runner-client.js \
        scripts/cdp-bridge/test/unit/gh-243-android-runner-health.test.js
git commit -S -m "fix(#243): surface RN_ANDROID_RUNNER_DOWN instead of bare 'fetch failed'

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: `closeDeviceSession` benign-gone handling (#244)

**Files:**
- Create: `scripts/cdp-bridge/src/tools/device-session-close.ts`
- Create: `scripts/cdp-bridge/test/unit/gh-244-close-session-gone.test.js`
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (`close` branch + import)

- [ ] **Step 1: Write the failing test** — create `scripts/cdp-bridge/test/unit/gh-244-close-session-gone.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeDeviceSession,
  isBenignSessionGoneError,
} from '../../dist/tools/device-session-close.js';

const okClose = () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { closed: true } }) }] });
// Mirror the real runAgentDevice failure envelope: failResult(message, { code, hint }) puts the
// code under meta (utils.ts:67-73), so meta.code — not a top-level code — is authoritative.
const errClose = (error, code) => ({
  content: [{ type: 'text', text: JSON.stringify({ ok: false, error, ...(code ? { meta: { code } } : {}) }) }],
  isError: true,
});

test('#244 no in-memory session → ok no-op; underlying close NOT called', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => false,
    closeUnderlyingSession: async () => { calls.close++; return okClose(); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, undefined);
  assert.match(r.content[0].text, /No active session to close/);
  assert.equal(calls.close, 0);
});

test('#244 close succeeds → ok; cleanup all called once', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => { calls.close++; return okClose(); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, undefined);
  assert.deepEqual(calls, { clear: 1, stop: 1, release: 1, close: 1 });
});

test('#244 SESSION_NOT_FOUND after a flow → ok with sessionAlreadyGone; cleanup all called', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => { calls.close++; return errClose('No active session', 'SESSION_NOT_FOUND'); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, undefined);
  const env = JSON.parse(r.content[0].text);
  assert.equal(env.data.sessionAlreadyGone, true);
  assert.deepEqual(calls, { clear: 1, stop: 1, release: 1, close: 1 });
});

test('#244 unrelated close error → surfaced as-is; cleanup NOT called', async () => {
  const calls = { clear: 0, stop: 0, release: 0, close: 0 };
  const r = await closeDeviceSession({
    hasActiveSession: () => true,
    closeUnderlyingSession: async () => { calls.close++; return errClose('adb: device offline', 'BAD_RESPONSE'); },
    clearActiveSession: () => { calls.clear++; },
    stopFastRunner: () => { calls.stop++; },
    releaseDeviceLock: () => { calls.release++; },
  });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /device offline/);
  assert.deepEqual(calls, { clear: 0, stop: 0, release: 0, close: 1 });
});

test('#244 isBenignSessionGoneError matches only gone-session shapes', () => {
  assert.equal(isBenignSessionGoneError(errClose('No active session', 'SESSION_NOT_FOUND')), true); // meta.code
  assert.equal(isBenignSessionGoneError(errClose('session not found')), true);                      // message fallback
  assert.equal(isBenignSessionGoneError(errClose('adb: device offline', 'BAD_RESPONSE')), false);
  assert.equal(isBenignSessionGoneError(okClose()), false);
  // precision: an unrelated failure whose HINT mentions the phrase must NOT be swallowed
  const withHint = {
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: 'adb: device offline', meta: { code: 'BAD_RESPONSE', hint: 'no active session? call open first' } }) }],
    isError: true,
  };
  assert.equal(isBenignSessionGoneError(withHint), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-244-close-session-gone.test.js`
Expected: FAIL — `dist/tools/device-session-close.js` does not exist (import error).

- [ ] **Step 3: Create the module** `scripts/cdp-bridge/src/tools/device-session-close.ts`:

```ts
import type { ToolResult } from '../utils.js';
import { okResult } from '../utils.js';

export interface CloseDeviceSessionDeps {
  hasActiveSession: () => boolean;
  closeUnderlyingSession: () => Promise<ToolResult>;
  clearActiveSession: () => void;
  stopFastRunner: () => void;
  releaseDeviceLock: () => void;
}

/**
 * GH#244: after a Maestro flow tears down the runner/daemon (the #237 slot-release),
 * the in-memory session survives but the agent-device session that `close` routes
 * through is gone — the CLI returns SESSION_NOT_FOUND. Treat ONLY that shape as
 * benign; any other error is a real close failure and is surfaced unchanged.
 *
 * Match on the STRUCTURED code first (runAgentDevice → failResult(msg, { code, hint })
 * puts it under meta.code), then a narrow message fallback applied ONLY to the error
 * field — never the whole serialized envelope, so an unrelated failure whose hint
 * mentions the phrase can't be misclassified as benign.
 */
export function isBenignSessionGoneError(result: ToolResult): boolean {
  if (!result.isError) return false;
  const text = result.content?.[0]?.text ?? '';
  let envelope: { error?: string; code?: string; meta?: { code?: string } };
  try {
    envelope = JSON.parse(text) as { error?: string; code?: string; meta?: { code?: string } };
  } catch {
    return /no active session|session not found/i.test(text);
  }
  if ((envelope.meta?.code ?? envelope.code) === 'SESSION_NOT_FOUND') return true;
  return /no active session|session not found/i.test(envelope.error ?? '');
}

export async function closeDeviceSession(deps: CloseDeviceSessionDeps): Promise<ToolResult> {
  if (!deps.hasActiveSession()) {
    return okResult({ closed: true, message: 'No active session to close' });
  }

  const result = await deps.closeUnderlyingSession();

  if (!result.isError) {
    deps.clearActiveSession();
    deps.stopFastRunner();
    deps.releaseDeviceLock();
    return result;
  }

  if (isBenignSessionGoneError(result)) {
    deps.clearActiveSession();
    deps.stopFastRunner();
    deps.releaseDeviceLock();
    return okResult({
      closed: true,
      sessionAlreadyGone: true,
      message: 'Underlying device session was already gone (likely torn down by a Maestro flow); cleared local session state.',
    });
  }

  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-244-close-session-gone.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the handler.** In `scripts/cdp-bridge/src/tools/device-session.ts`, add the import next to the other `./...` tool imports (e.g. under the `runner-leak-recovery.js` import block, ~line 28):

```ts
import { closeDeviceSession } from './device-session-close.js';
```

Replace the existing `close` branch (current lines ~355-368):

```ts
    if (action === 'close') {
      const session = getActiveSession();
      if (!session) {
        return okResult({ closed: true, message: 'No active session to close' });
      }

      const result = await runAgentDevice(['close']);
      if (!result.isError) {
        clearActiveSession();
        stopFastRunner();
        releaseDeviceLockForSession();
      }
      return result;
    }
```

with the delegation:

```ts
    if (action === 'close') {
      return closeDeviceSession({
        hasActiveSession: () => getActiveSession() !== null,
        closeUnderlyingSession: () => runAgentDevice(['close']),
        clearActiveSession,
        stopFastRunner,
        releaseDeviceLock: releaseDeviceLockForSession,
      });
    }
```

- [ ] **Step 6: Build + run device-session suites to confirm no regression**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-244-close-session-gone.test.js test/unit/gh-210-device-session-health.test.js test/unit/device-session-parsing.test.js`
Expected: PASS (all). If `tsc` reports `okResult` now unused in `device-session.ts`, remove it from that file's `utils.js` import; re-run.

- [ ] **Step 7: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/tools/device-session-close.ts \
        scripts/cdp-bridge/dist/tools/device-session-close.js \
        scripts/cdp-bridge/src/tools/device-session.ts \
        scripts/cdp-bridge/dist/tools/device-session.js \
        scripts/cdp-bridge/test/unit/gh-244-close-session-gone.test.js
git commit -S -m "fix(#244): device_snapshot close tolerates a flow-torn-down session

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: changeset + full suite green

**Files:**
- Create: `.changeset/gh-243-244-android-post-flow-lifecycle.md`

- [ ] **Step 1: Write the changeset** — create `.changeset/gh-243-244-android-post-flow-lifecycle.md`:

```md
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(#243,#244): Android post-flow lifecycle. `rn-android-runner` readiness is now gated on its own `GET /health` instead of the `adb logcat` ring buffer — a prior runner's stale ready line (same tag + fixed port) used to fire readiness before the new socket bound, so the first `device_*` after a Maestro flow returned a bare `fetch failed`. When the runner genuinely can't come up, `runAndroid` now surfaces a structured `RN_ANDROID_RUNNER_DOWN` with a retry hint. Separately, `device_snapshot action=close` now tolerates an underlying session that a flow already tore down (the #237 slot-release): it cleans up local state and returns ok, so `open → flow → close` round-trips cleanly instead of erroring `SESSION_NOT_FOUND`.
```

- [ ] **Step 2: Run the FULL unit suite**

Run: `cd scripts/cdp-bridge && npm run test`
Expected: PASS — the entire `test/unit/**` suite green (build runs first). Note the total count for the PR body.

- [ ] **Step 3: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add .changeset/gh-243-244-android-post-flow-lifecycle.md
git commit -S -m "chore(#243,#244): changeset for Android post-flow lifecycle fixes

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## After the plan (not tasks — workflow steps)

1. **Multi-LLM plan review BEFORE heavy execution** is already done at the design/plan stage per the project workflow — run `/brainstorm gemini,codex` on this plan + key files, apply findings, amend the plan commit.
2. **Multi-review the finished diff** — `/multi-review` (Gemini + Codex) once Tasks 1-4 land.
3. **Device verification (Android emulator)** — the bugs are Android-only and reproduce only live:
   - Repro #243: `device_snapshot action=open platform=android …` → `maestro_run …` → `device_snapshot action=snapshot` (must NOT return `fetch failed` on the first post-flow call).
   - Repro #244: same open → `maestro_run` → `device_snapshot action=close` (must return ok, `sessionAlreadyGone:true`, not `SESSION_NOT_FOUND`).
   - Confirm the **real** CLI error shape for #244; if it differs from `SESSION_NOT_FOUND` / "No active session", widen `isBenignSessionGoneError`'s regex and re-run Task 3 tests.
4. **Finish the branch** — `superpowers:finishing-a-development-branch`; stacked PR. Update `ROADMAP.md` / `BUGS.md` / `DECISIONS.md` in the sibling workspace via `/end-session`.

## Self-review notes (done while writing)

- **Spec coverage:** #243 health-gate (Task 1), #243 structured error (Task 2), #244 benign-close (Task 3), changeset (Task 4) — all spec sections mapped.
- **Type consistency:** `waitForAndroidRunnerHealth(port, {timeoutMs,intervalMs})`, `RunnerResponse` (existing type reused for `resp`), `CloseDeviceSessionDeps` field names (`hasActiveSession`/`closeUnderlyingSession`/`clearActiveSession`/`stopFastRunner`/`releaseDeviceLock`) match between the module, the production wiring, and the tests. New error code `RN_ANDROID_RUNNER_DOWN` added to the union before first use.
- **No placeholders:** every code/command step is concrete.
- **DRY:** the cleanup triple is intentionally repeated in the two close branches (success vs benign-gone) rather than abstracted — they return different results, and a 3-line repeat reads clearer than a closure here.

## Amendments applied from the multi-LLM plan review (2026-06-09)

`/brainstorm gemini,codex` (Codex usage-capped; Gemini endorsed; substance was Claude's verified pass). Triaged with `receiving-code-review` rigor:

- **Task 1** — logcat spawn removed; the `am instrument` child's stdout/stderr is captured into a bounded ~4KB `diag` tail and appended to cold-start failure messages (preserves startup-failure visibility now that logcat is gone, and drains the child's pipes to avoid a buffer wedge). Resolves a spec↔plan contradiction.
- **Task 2** — `isAndroidConnectionFailure` is exported and unit-tested directly against both `fetch failed` (postCommand) and `did not become ready` (startAndroidRunner), so the classifier is proven for both failure origins (not just the postCommand short-circuit). `RUNNER_TIMEOUT` is asserted to NOT classify down.
- **Task 3** — `isBenignSessionGoneError` now parses the envelope and matches the structured `meta.code` (confirmed: `runAgentDevice` → `failResult(msg, { code, hint })` lands code under `meta`), with a narrow message fallback on the `error` field only; the test `errClose` fixture is corrected to `{ok:false, error, meta:{code}}`, plus a precision test that a hint mentioning the phrase is NOT swallowed.
- **Documented, not changed:** fixed-port (22089) cross-generation `/health` adoption is mitigated by #237's pre-flow `am force-stop` + immediate LISTEN-socket release; a native identity token is out of surgical scope. Device verification (After-the-plan §3) adds a back-to-back flow→device_* repro.
- **Rejected (verified false):** gating `child.on('exit')`'s state-wipe on `!resolved` — `am instrument -w` blocks on the infinite `mainLoop`, so the host process lives for the runner's whole life; an exit IS a death and must wipe state.
- **Declined (latent):** `stopAndroidRunner` hardcoded `tcp:${DEFAULT_PORT}` — no production caller uses a non-default port.
