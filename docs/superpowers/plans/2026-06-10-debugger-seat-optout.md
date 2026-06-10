# Debugger-Seat Opt-Out + Silent Hook-Mode Network Transport — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users opt the CDP bridge out of background reconnection (so React Native DevTools can hold the single debugger seat), and stop hook-mode network capture from spamming `__RN_NET__` lines into every console consumer.

**Architecture:** A resolved `autoConnect` setting (env `RN_CDP_AUTOCONNECT` > `.rn-agent/config.json` > default `true`) gates exactly the *background* reconnect paths in `cdp/reconnection.ts` via a new optional `ReconnectContext.isAutoConnectEnabled` callback; on-demand connection during tool calls is untouched. Separately, the hook-mode network callback writes to an in-app ring buffer (`globalThis.__RN_AGENT_NET_BUF__`) instead of `console.log`, and the bridge drains that buffer on demand inside the three network-reading tools.

**Tech Stack:** TypeScript (Node >= 22), Node built-in test runner (`node --test`, tests are plain JS importing from `dist/`), changesets.

**Spec:** `docs/superpowers/specs/2026-06-10-debugger-seat-optout-design.md`

**Working directory for all commands:** `scripts/cdp-bridge/` unless stated otherwise.

**Conventions that apply to every task:**
- Tests live in `scripts/cdp-bridge/test/unit/*.test.js`, import from `../../dist/...`, use `node:test` + `node:assert/strict`.
- Run a single test file: `npm run build && node --test test/unit/<file>.test.js`
- Run the full suite before any PR: `npm test`
- Use explicit type imports (`import type { ... }`). No unnecessary comments.
- Commit after each task (small, signed commits — repo uses 1Password SSH signing, just `git commit` normally).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/project-config.ts` | Modify | + `readRnAgentConfig()` (`.rn-agent/config.json` reader, fail-open) and `resolveAutoConnect()` (precedence env > config > default) |
| `src/cdp/reconnection.ts` | Modify | + `isAutoConnectEnabled?` on `ReconnectContext`; gate `handleClose` + `startBackgroundPoll` |
| `src/cdp-client.ts` | Modify | + `autoConnectState` getter; pass `isAutoConnectEnabled` in `buildReconnectCtx()` |
| `src/tools/status.ts` | Modify | + `autoConnect` field in status payload |
| `src/cdp/event-handlers.ts` | Modify | Extract `applyNetworkHookEntry()` from `parseNetworkHookMessage()` (shared by drain) |
| `src/injected-helpers.ts` | Modify | + `NETWORK_CB_BUFFERED_SCRIPT` (ring-buffer callback definition) |
| `src/cdp/setup.ts` | Modify | Evaluate `NETWORK_CB_BUFFERED_SCRIPT` instead of the console.log callback; + `RN_FORCE_NETWORK_HOOK` test seam |
| `src/cdp/net-hook-drain.ts` | Create | `drainNetworkHookBuffer()` — evaluate-drain the in-app buffer into `DeviceBufferManager`, fail-open |
| `src/tools/network-log.ts` | Modify | Drain before reads/clear in hook mode |
| `src/tools/wait-for-network.ts` | Modify | Drain before phase-1 scan and on each poll iteration in hook mode |
| `src/tools/network-body.ts` | Modify | Drain at top of the hook branch |
| `test/unit/auto-connect-config.test.js` | Create | Task 1 tests |
| `test/unit/reconnection-passive-mode.test.js` | Create | Task 2 tests |
| `test/unit/status-auto-connect.test.js` | Create | Task 3 tests |
| `test/unit/net-hook-buffered-transport.test.js` | Create | Tasks 4–6 tests |
| `test/unit/net-hook-drain-integration.test.js` | Create | Task 7 tests |
| `commands/doctor.md` (repo root) | Modify | + auto-connect row (14 → 15 rows) |
| `CLAUDE.md`, `CLAUDE-MD-TEMPLATE.md` (repo root) | Modify | Document the opt-out + DevTools coexistence |
| `docs-site/src/content/docs/...` | Modify | User-facing coexistence doc |
| `.changeset/debugger-seat-optout.md` | Create | Release notes |

---

### Task 1: `autoConnect` config resolution (`project-config.ts`)

**Files:**
- Modify: `scripts/cdp-bridge/src/project-config.ts`
- Test: `scripts/cdp-bridge/test/unit/auto-connect-config.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/auto-connect-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRnAgentConfig, resolveAutoConnect } from '../../dist/project-config.js';

// Spec 2026-06-10-debugger-seat-optout: autoConnect resolution precedence is
// env RN_CDP_AUTOCONNECT > .rn-agent/config.json > default true. Config file
// errors are fail-open (never block a session).

function makeProjectRoot(configJson) {
  const root = mkdtempSync(join(tmpdir(), 'rn-agent-cfg-'));
  if (configJson !== undefined) {
    mkdirSync(join(root, '.rn-agent'), { recursive: true });
    writeFileSync(join(root, '.rn-agent', 'config.json'), configJson);
  }
  return root;
}

test('readRnAgentConfig: parses cdp.autoConnect=false', () => {
  const root = makeProjectRoot(JSON.stringify({ cdp: { autoConnect: false } }));
  try {
    assert.deepEqual(readRnAgentConfig(root), { cdp: { autoConnect: false } });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readRnAgentConfig: missing file returns null', () => {
  const root = makeProjectRoot(undefined);
  try {
    assert.equal(readRnAgentConfig(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('readRnAgentConfig: malformed JSON is fail-open (null, no throw)', () => {
  const root = makeProjectRoot('{ not json');
  try {
    assert.equal(readRnAgentConfig(root), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveAutoConnect: env "0" wins over config true', () => {
  const r = resolveAutoConnect({ env: '0', readConfig: () => ({ cdp: { autoConnect: true } }) });
  assert.deepEqual(r, { enabled: false, source: 'env' });
});

test('resolveAutoConnect: env "false" disables', () => {
  assert.deepEqual(resolveAutoConnect({ env: 'false', readConfig: () => null }),
    { enabled: false, source: 'env' });
});

test('resolveAutoConnect: env "1" forces on over config false', () => {
  const r = resolveAutoConnect({ env: '1', readConfig: () => ({ cdp: { autoConnect: false } }) });
  assert.deepEqual(r, { enabled: true, source: 'env' });
});

test('resolveAutoConnect: unset env falls through to config', () => {
  const r = resolveAutoConnect({ env: undefined, readConfig: () => ({ cdp: { autoConnect: false } }) });
  assert.deepEqual(r, { enabled: false, source: 'config' });
});

test('resolveAutoConnect: non-boolean config value ignored → default', () => {
  const r = resolveAutoConnect({ env: undefined, readConfig: () => ({ cdp: { autoConnect: 'nope' } }) });
  assert.deepEqual(r, { enabled: true, source: 'default' });
});

test('resolveAutoConnect: nothing set → default true', () => {
  assert.deepEqual(resolveAutoConnect({ env: undefined, readConfig: () => null }),
    { enabled: true, source: 'default' });
});

test('resolveAutoConnect: unrecognized env value falls through (not an off-switch typo trap)', () => {
  const r = resolveAutoConnect({ env: 'banana', readConfig: () => null });
  assert.deepEqual(r, { enabled: true, source: 'default' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/unit/auto-connect-config.test.js`
Expected: FAIL — `readRnAgentConfig`/`resolveAutoConnect` are not exported (SyntaxError on import).

- [ ] **Step 3: Implement in `src/project-config.ts`**

Append to the file (it already imports `existsSync, readFileSync` from `node:fs`, `join` from `node:path`, and `findProjectRoot`):

```ts
import { logger } from './logger.js';

export interface RnAgentConfig {
  cdp?: { autoConnect?: boolean };
}

let warnedBadConfig = false;

/**
 * Read `.rn-agent/config.json` from the project root. Fail-open: a missing,
 * unreadable, or malformed file returns null (logged once) — config must
 * never block a session (same philosophy as the device ownership lock).
 */
export function readRnAgentConfig(projectRoot?: string | null): RnAgentConfig | null {
  const root = projectRoot ?? findProjectRoot();
  if (!root) return null;
  const p = join(root, '.rn-agent', 'config.json');
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as RnAgentConfig;
  } catch (err) {
    if (!warnedBadConfig) {
      warnedBadConfig = true;
      logger.warn('CONFIG', `.rn-agent/config.json is unreadable — ignoring it: ${err instanceof Error ? err.message : err}`);
    }
    return null;
  }
}

export interface AutoConnectResolution {
  enabled: boolean;
  source: 'env' | 'config' | 'default';
}

/**
 * Resolve whether background auto-reconnect is enabled.
 * Precedence: RN_CDP_AUTOCONNECT env var > .rn-agent/config.json cdp.autoConnect > true.
 * Env parse mirrors RN_DEVICE_KILL_LEGACY ('0'/'false' = off); unrecognized
 * values fall through rather than silently disabling.
 */
export function resolveAutoConnect(deps: {
  env?: string;
  readConfig?: () => RnAgentConfig | null;
} = {}): AutoConnectResolution {
  const envRaw = 'env' in deps ? deps.env : process.env.RN_CDP_AUTOCONNECT;
  if (envRaw === '0' || envRaw === 'false') return { enabled: false, source: 'env' };
  if (envRaw === '1' || envRaw === 'true') return { enabled: true, source: 'env' };
  const cfg = (deps.readConfig ?? readRnAgentConfig)();
  if (typeof cfg?.cdp?.autoConnect === 'boolean') {
    return { enabled: cfg.cdp.autoConnect, source: 'config' };
  }
  return { enabled: true, source: 'default' };
}
```

Note: the `import { logger }` line goes at the top of the file with the other imports, not mid-file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/auto-connect-config.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/project-config.ts test/unit/auto-connect-config.test.js
git commit -m "feat(cdp): resolve autoConnect from RN_CDP_AUTOCONNECT env + .rn-agent/config.json"
```

---

### Task 2: Passive-mode gating in `reconnection.ts`

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp/reconnection.ts` (interface `ReconnectContext` ~line 49; `handleClose` ~line 76; `startBackgroundPoll` ~line 191)
- Test: `scripts/cdp-bridge/test/unit/reconnection-passive-mode.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/reconnection-passive-mode.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleClose, startBackgroundPoll } from '../../dist/cdp/reconnection.js';

// Spec 2026-06-10-debugger-seat-optout: with autoConnect disabled, the
// BACKGROUND seat-grabbing paths (handleClose reconnect loop, background
// poll) must not run. On-demand connect during tool calls is untouched.

function makeCtx(overrides = {}) {
  const calls = { discover: 0, stateSet: [] };
  const ctx = {
    isDisposed: () => false,
    isReconnecting: () => false,
    isConnected: () => false,
    isSoftReconnectRequested: () => false,
    setReconnecting: () => {},
    setSoftReconnectRequested: () => {},
    setState: (s) => calls.stateSet.push(s),
    setReconnectAttempt: () => {},
    closeWs: () => {},
    rejectAllPending: () => {},
    discoverAndConnect: async () => { calls.discover++; return 'ws://x'; },
    getResettableState: () => ({
      setState: () => {}, setHelpersInjected: () => {}, setBridgeDetected: () => {},
      setBridgeVersion: () => {}, setConnectedTarget: () => {}, setConnectedAt: () => {},
      setLogDomainEnabled: () => {}, setProfilerAvailable: () => {},
      setHeapProfilerAvailable: () => {}, clearScripts: () => {},
    }),
    getPort: () => 8081,
    setBgPollTimer: (t) => { ctx._timer = t; },
    getBgPollTimer: () => ctx._timer ?? null,
    _timer: null,
    ...overrides,
  };
  return { ctx, calls };
}

test('handleClose: passive mode → state disconnected, no reconnect loop', async () => {
  const { ctx, calls } = makeCtx({ isAutoConnectEnabled: () => false });
  handleClose(ctx, 1006);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.discover, 0, 'reconnect loop must not start');
  assert.ok(calls.stateSet.includes('disconnected'));
  assert.ok(!calls.stateSet.includes('reconnecting'));
});

test('handleClose: default (no isAutoConnectEnabled) → reconnect starts (back-compat)', async () => {
  const { ctx, calls } = makeCtx();
  handleClose(ctx, 1006);
  // attempt 0 has 0ms delay → discoverAndConnect fires on the microtask queue
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.discover >= 1, 'reconnect loop must start when callback absent');
  assert.ok(calls.stateSet.includes('reconnecting'));
});

test('handleClose: autoConnect enabled → reconnect starts', async () => {
  const { ctx, calls } = makeCtx({ isAutoConnectEnabled: () => true });
  handleClose(ctx, 1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(calls.discover >= 1);
});

test('startBackgroundPoll: passive mode → no timer installed', () => {
  const { ctx } = makeCtx({ isAutoConnectEnabled: () => false });
  startBackgroundPoll(ctx);
  assert.equal(ctx.getBgPollTimer(), null, 'background poll must not be armed');
});

test('startBackgroundPoll: enabled → timer installed (and cleaned up)', () => {
  const { ctx } = makeCtx({ isAutoConnectEnabled: () => true });
  startBackgroundPoll(ctx);
  assert.notEqual(ctx.getBgPollTimer(), null);
  clearInterval(ctx.getBgPollTimer());
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/unit/reconnection-passive-mode.test.js`
Expected: FAIL — `handleClose: passive mode` and `startBackgroundPoll: passive mode` (reconnect/timer fire despite the flag). The back-compat tests pass already.

- [ ] **Step 3: Implement the gates**

In `src/cdp/reconnection.ts`, add to `ReconnectContext` (after `isConnected`):

```ts
  /**
   * Debugger-seat opt-out (spec 2026-06-10): when present and false, the
   * BACKGROUND reconnect paths (handleClose loop, background poll) are
   * disabled — the bridge yields the single RN debugger seat to a human
   * DevTools until the next explicit tool call. Optional so existing
   * ReconnectContext consumers/tests keep today's behavior.
   */
  isAutoConnectEnabled?: () => boolean;
```

In `handleClose`, after the `isDisposed/isReconnecting` early return:

```ts
export function handleClose(ctx: ReconnectContext, code: number): void {
  resetState(ctx.getResettableState());

  if (ctx.isDisposed() || ctx.isReconnecting()) return;

  if (ctx.isAutoConnectEnabled && !ctx.isAutoConnectEnabled()) {
    ctx.setState('disconnected');
    clearActiveFlag();
    logger.info('CDP', `WebSocket closed (code ${code}); auto-reconnect disabled — staying down`);
    console.error(
      'CDP: connection closed (code ' + code + '). Auto-reconnect is disabled ' +
      '(RN_CDP_AUTOCONNECT or .rn-agent/config.json cdp.autoConnect) — ' +
      'the bridge will reconnect on the next CDP tool call. ' +
      'Re-enable with RN_CDP_AUTOCONNECT=1 or by removing the config override.',
    );
    return;
  }
  // ... existing body unchanged from here (logger.info, code-1006 branch, setReconnecting, reconnect)
}
```

In `startBackgroundPoll`, extend the existing guard:

```ts
export function startBackgroundPoll(ctx: ReconnectContext): void {
  if (ctx.getBgPollTimer() || ctx.isDisposed()) return;
  if (ctx.isAutoConnectEnabled && !ctx.isAutoConnectEnabled()) return;
  // ... existing body unchanged
}
```

(`clearActiveFlag` and `logger` are already imported in this file.)

**Policy note (plan-review finding, decided):** `cdp_status`'s recovery branches (`softReconnect` on dev-`false`/isPaused, `recoverWedge`) and `recover-detached` are **not** gated. They only run inside a foreground tool call, which by the approved spec knowingly reclaims the seat — same as any other tool. Consequence for users: in passive mode, *any* CDP tool call including `cdp_status` takes the seat back while it runs. This must be stated in the Task 8 docs and respected in Gate 1 (no CDP tool calls during the coexistence window).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/reconnection-passive-mode.test.js`
Expected: PASS (5 tests). Also run `node --test test/unit/gh-208-status-storm-preempt.test.js` to confirm no regression in existing reconnection consumers.

- [ ] **Step 5: Commit**

```bash
git add src/cdp/reconnection.ts test/unit/reconnection-passive-mode.test.js
git commit -m "feat(cdp): gate background reconnect paths behind autoConnect (passive mode)"
```

---

### Task 3: Wire into `CDPClient` + surface in `cdp_status`

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp-client.ts` (`buildReconnectCtx()` ~line 563; getters near `reconnectState` ~line 138)
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (payload object, next to `reconnect: client.reconnectState` ~line 109)
- Test: `scripts/cdp-bridge/test/unit/status-auto-connect.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/status-auto-connect.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';

// Spec 2026-06-10-debugger-seat-optout: cdp_status must surface the resolved
// autoConnect mode + its source so users/doctor can see why the bridge does
// (or does not) fight for the debugger seat.

test('cdp_status: payload includes autoConnect resolution', async () => {
  const client = createMockClient({
    _isConnected: true,
    _helpersInjected: true,
    autoConnectState: { enabled: false, source: 'env' },
  });
  const handler = createStatusHandler(() => client);
  const result = await handler({});
  const data = expectOk(result);
  assert.deepEqual(data.autoConnect, { enabled: false, source: 'env' });
});
```

Adjust the `createMockClient` seed fields to whatever the existing status tests
(`test/unit/gh-136-status-picker-precheck.test.js`) use for a *connected* client —
copy their connected-client setup verbatim if `_isConnected/_helpersInjected`
alone is not enough (e.g. an `evaluate` stub returning the status-probe JSON;
that file's `makeStatusProbe()` helper shows the exact shape).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/status-auto-connect.test.js`
Expected: FAIL — `data.autoConnect` is `undefined`.

- [ ] **Step 3: Implement**

`src/cdp-client.ts` — add import and getter:

```ts
import { resolveAutoConnect } from './project-config.js';
import type { AutoConnectResolution } from './project-config.js';
```

Near the other getters (after `reconnectState`, ~line 140):

```ts
  private _autoConnectResolution: AutoConnectResolution | null = null;

  /** Resolved once per process — env/config don't change mid-session. */
  get autoConnectState(): AutoConnectResolution {
    if (!this._autoConnectResolution) this._autoConnectResolution = resolveAutoConnect();
    return this._autoConnectResolution;
  }
```

In `buildReconnectCtx()` (~line 563), add one line to the returned object:

```ts
      isAutoConnectEnabled: () => this.autoConnectState.enabled,
```

`src/tools/status.ts` — in the payload object, directly after `reconnect: client.reconnectState,`:

```ts
    autoConnect: client.autoConnectState,
```

If `createMockClient` does not already proxy unknown override keys onto the mock, add `autoConnectState: { enabled: true, source: 'default' }` to the mock's defaults in `test/helpers/mock-cdp-client.js` so other status tests keep passing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/status-auto-connect.test.js test/unit/gh-136-status-picker-precheck.test.js test/unit/gh-208-status-detached-recovery.test.js`
Expected: PASS — new test green, existing status tests unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/cdp-client.ts src/tools/status.ts test/unit/status-auto-connect.test.js test/helpers/mock-cdp-client.js
git commit -m "feat(cdp): surface autoConnect resolution in cdp_status and wire passive mode into CDPClient"
```

---

### Task 4: Extract `applyNetworkHookEntry` in `event-handlers.ts`

The drain path (Task 6) and the legacy console-event path must apply hook entries identically. Extract the shared application logic first.

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp/event-handlers.ts` (`parseNetworkHookMessage` ~line 104)
- Test: `scripts/cdp-bridge/test/unit/net-hook-buffered-transport.test.js` (started here, extended in Tasks 5–6)

- [ ] **Step 1: Write the failing tests**

Create `test/unit/net-hook-buffered-transport.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyNetworkHookEntry } from '../../dist/cdp/event-handlers.js';
import { DeviceBufferManager } from '../../dist/ring-buffer.js';

// Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network transport
// moves from console.log lines to an in-app ring buffer. applyNetworkHookEntry
// is the shared "entry → DeviceBufferManager" logic used by BOTH the legacy
// console-event path (back-compat, one release) and the new drain path.

function makeManager() {
  // Same construction as test/helpers/mock-cdp-client.js (the class lives in
  // src/ring-buffer.ts and takes an options object).
  return new DeviceBufferManager({
    capacityPerDevice: 100,
    maxDevices: 10,
    indexKey: (e) => e.id,
    timestampOf: (e) => new Date(e.timestamp).getTime(),
  });
}

test('applyNetworkHookEntry: request entry pushes into the buffer', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('request', { id: 'r1', method: 'POST', url: '/api/x' }, mgr, 'dev1');
  const all = mgr.getLast('dev1', 10);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, 'r1');
  assert.equal(all[0].method, 'POST');
  assert.equal(all[0].url, '/api/x');
  assert.ok(all[0].timestamp);
});

test('applyNetworkHookEntry: response entry completes the matching request', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('request', { id: 'r1', method: 'GET', url: '/a' }, mgr, 'dev1');
  applyNetworkHookEntry('response', { id: 'r1', status: 204, duration_ms: 17 }, mgr, 'dev1');
  const entry = mgr.getByKey('dev1', 'r1');
  assert.equal(entry.status, 204);
  assert.equal(entry.duration_ms, 17);
});

test('applyNetworkHookEntry: response without a matching request is a no-op', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('response', { id: 'ghost', status: 200, duration_ms: 1 }, mgr, 'dev1');
  assert.equal(mgr.getLast('dev1', 10).length, 0);
});

test('applyNetworkHookEntry: unknown type is a no-op (forward-compat)', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('telemetry', { id: 'x' }, mgr, 'dev1');
  assert.equal(mgr.getLast('dev1', 10).length, 0);
});
```

Also add a dedup test (plan-review finding: `RingBuffer.push` does not dedup by key — a duplicate request push creates a second row while `getByKey` returns only the newest; a stale console-path callback coexisting with the new buffered callback during a cross-version hot-reload could double-apply the same id):

```js
test('applyNetworkHookEntry: duplicate request id is not pushed twice', () => {
  const mgr = makeManager();
  applyNetworkHookEntry('request', { id: 'r1', method: 'GET', url: '/a' }, mgr, 'dev1');
  applyNetworkHookEntry('request', { id: 'r1', method: 'GET', url: '/a' }, mgr, 'dev1');
  assert.equal(mgr.getLast('dev1', 10).length, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/unit/net-hook-buffered-transport.test.js`
Expected: FAIL — `applyNetworkHookEntry` not exported.

- [ ] **Step 3: Implement the extraction**

In `src/cdp/event-handlers.ts`, refactor `parseNetworkHookMessage` (keep its export and behavior identical) by extracting the entry-application block:

```ts
export function applyNetworkHookEntry(
  type: string,
  data: { id: string; method?: string; url?: string; status?: number; duration_ms?: number },
  networkManager: DeviceBufferManager<NetworkEntry, string>,
  deviceKey: string,
): void {
  if (type === 'request') {
    if (networkManager.getByKey(deviceKey, data.id)) return;
    networkManager.push(deviceKey, {
      id: data.id,
      method: data.method ?? 'GET',
      url: data.url ?? '',
      timestamp: new Date().toISOString(),
    });
  } else if (type === 'response') {
    const entry = networkManager.getByKey(deviceKey, data.id);
    if (entry) {
      entry.status = data.status;
      entry.duration_ms = data.duration_ms;
    }
  }
}

export function parseNetworkHookMessage(
  params: unknown,
  networkMode: 'cdp' | 'hook' | 'none',
  networkManager: DeviceBufferManager<NetworkEntry, string>,
  deviceKey: string,
): void {
  if (networkMode !== 'hook') return;
  const p = params as { args?: Array<{ value?: unknown }> };
  const firstArg = p.args?.[0]?.value;
  if (typeof firstArg !== 'string' || !firstArg.startsWith('__RN_NET__:')) return;

  try {
    const parts = firstArg.split(':');
    const type = parts[1];
    const data = JSON.parse(parts.slice(2).join(':'));
    applyNetworkHookEntry(type, data, networkManager, deviceKey);
  } catch (err) {
    console.error('CDP: malformed network hook message dropped:', typeof firstArg === 'string' ? firstArg.slice(0, 100) : typeof firstArg, err instanceof Error ? err.message : '');
  }
}
```

The `__RN_NET__:` console-filter lines (`event-handlers.ts:22` and the `parseNetworkHookMessage` consumer) stay — back-compat guard for a stale injected callback from an older bridge, removable next release.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/net-hook-buffered-transport.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cdp/event-handlers.ts test/unit/net-hook-buffered-transport.test.js
git commit -m "refactor(cdp): extract applyNetworkHookEntry with duplicate-id dedup"
```

---

### Task 5: Buffered network callback script (`injected-helpers.ts` + `setup.ts`)

**Files:**
- Modify: `scripts/cdp-bridge/src/injected-helpers.ts` (near `NETWORK_HOOK_SCRIPT`, ~line 1896)
- Modify: `scripts/cdp-bridge/src/cdp/setup.ts` (hook fallback block, ~lines 93–105; probe call ~line 89)
- Test: extend `test/unit/net-hook-buffered-transport.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/net-hook-buffered-transport.test.js`:

```js
import { NETWORK_CB_BUFFERED_SCRIPT } from '../../dist/injected-helpers.js';

// The callback definition is a JS string evaluated inside the app's Hermes
// context. Execute it here against an isolated fake globalThis to verify the
// ring-buffer semantics without a device.

function runCbScript() {
  const fakeGlobal = {};
  new Function('globalThis', NETWORK_CB_BUFFERED_SCRIPT)(fakeGlobal);
  return fakeGlobal;
}

test('NETWORK_CB_BUFFERED_SCRIPT: defines callback that pushes to __RN_AGENT_NET_BUF__', () => {
  const g = runCbScript();
  assert.equal(typeof g.__RN_AGENT_NETWORK_CB__, 'function');
  g.__RN_AGENT_NETWORK_CB__('request', { id: 'a', method: 'GET', url: '/x' });
  assert.deepEqual(g.__RN_AGENT_NET_BUF__, [{ t: 'request', d: { id: 'a', method: 'GET', url: '/x' } }]);
});

test('NETWORK_CB_BUFFERED_SCRIPT: never calls console.log (the whole point)', () => {
  assert.ok(!NETWORK_CB_BUFFERED_SCRIPT.includes('console.log'));
  assert.ok(!NETWORK_CB_BUFFERED_SCRIPT.includes('__RN_NET__'));
});

test('NETWORK_CB_BUFFERED_SCRIPT: ring buffer caps at 100 (drop-oldest)', () => {
  const g = runCbScript();
  for (let i = 0; i < 150; i++) {
    g.__RN_AGENT_NETWORK_CB__('request', { id: 'r' + i, method: 'GET', url: '/x' });
  }
  assert.equal(g.__RN_AGENT_NET_BUF__.length, 100);
  assert.equal(g.__RN_AGENT_NET_BUF__[0].d.id, 'r50');
  assert.equal(g.__RN_AGENT_NET_BUF__[99].d.id, 'r149');
});

test('NETWORK_CB_BUFFERED_SCRIPT: re-running preserves an existing buffer', () => {
  const g = runCbScript();
  g.__RN_AGENT_NETWORK_CB__('request', { id: 'keep', method: 'GET', url: '/x' });
  new Function('globalThis', NETWORK_CB_BUFFERED_SCRIPT)(g);
  assert.equal(g.__RN_AGENT_NET_BUF__.length, 1, 'reinjection must not wipe undrained entries');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/unit/net-hook-buffered-transport.test.js`
Expected: FAIL — `NETWORK_CB_BUFFERED_SCRIPT` not exported.

- [ ] **Step 3: Implement**

`src/injected-helpers.ts`, next to `NETWORK_HOOK_SCRIPT`:

```ts
/**
 * Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network callback.
 * Pushes entries into an in-app ring buffer instead of console.log so the
 * shared console stream (Metro logs, user DevTools) stays clean. The bridge
 * drains the buffer on demand (cdp/net-hook-drain.ts). Idempotent: preserves
 * an existing buffer so reinjection doesn't lose undrained entries.
 */
export const NETWORK_CB_BUFFERED_SCRIPT = `
(function() {
  globalThis.__RN_AGENT_NET_BUF__ = globalThis.__RN_AGENT_NET_BUF__ || [];
  var MAX = 100;
  globalThis.__RN_AGENT_NETWORK_CB__ = function(type, data) {
    var buf = globalThis.__RN_AGENT_NET_BUF__;
    buf.push({ t: type, d: data });
    if (buf.length > MAX) buf.splice(0, buf.length - MAX);
  };
})();
`;
```

`src/cdp/setup.ts` — two changes:

1. Replace the console.log callback (lines ~98–102):

```ts
    const hookResult = await evaluate(NETWORK_HOOK_SCRIPT);
    if (hookResult.error) {
      console.error('CDP: failed to inject network hooks:', hookResult.error);
    } else {
      await evaluate(NETWORK_CB_BUFFERED_SCRIPT);
      networkMode = 'hook';
    }
```

Add `NETWORK_CB_BUFFERED_SCRIPT` to the existing import from `../injected-helpers.js`.

2. Test seam for live verification on modern RN (which would otherwise take the CDP path): just before the `if (networkMode === 'cdp')` probe block (~line 89):

```ts
  // Test seam: force the hook fallback on RN >= 0.83 so the buffered
  // transport can be live-verified without an old-RN app.
  if (process.env.RN_FORCE_NETWORK_HOOK === '1') networkMode = 'none';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/net-hook-buffered-transport.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/injected-helpers.ts src/cdp/setup.ts test/unit/net-hook-buffered-transport.test.js
git commit -m "feat(cdp): buffered in-app transport for hook-mode network capture (no console spam)"
```

---

### Task 6: Drain module (`src/cdp/net-hook-drain.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/cdp/net-hook-drain.ts`
- Test: extend `test/unit/net-hook-buffered-transport.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/net-hook-buffered-transport.test.js`:

```js
import { drainNetworkHookBuffer } from '../../dist/cdp/net-hook-drain.js';

function makeDrainClient(bufEntries, mgr) {
  return {
    networkMode: 'hook',
    activeDeviceKey: 'dev1',
    networkBufferManager: mgr,
    evaluate: async () => ({ value: JSON.stringify(bufEntries) }),
  };
}

test('drainNetworkHookBuffer: merges drained entries into the manager', async () => {
  const mgr = makeManager();
  const client = makeDrainClient([
    { t: 'request', d: { id: 'q1', method: 'POST', url: '/api/otp' } },
    { t: 'response', d: { id: 'q1', status: 200, duration_ms: 758 } },
  ], mgr);
  const drained = await drainNetworkHookBuffer(client);
  assert.equal(drained, 2);
  const entry = mgr.getByKey('dev1', 'q1');
  assert.equal(entry.status, 200);
  assert.equal(entry.url, '/api/otp');
});

test('drainNetworkHookBuffer: no-op outside hook mode', async () => {
  const mgr = makeManager();
  const client = makeDrainClient([{ t: 'request', d: { id: 'x' } }], mgr);
  client.networkMode = 'cdp';
  assert.equal(await drainNetworkHookBuffer(client), 0);
  assert.equal(mgr.getLast('dev1', 10).length, 0);
});

test('drainNetworkHookBuffer: evaluate failure is fail-open (0, no throw)', async () => {
  const mgr = makeManager();
  const client = makeDrainClient([], mgr);
  client.evaluate = async () => ({ error: 'app reloaded' });
  assert.equal(await drainNetworkHookBuffer(client), 0);
});

test('drainNetworkHookBuffer: evaluate throw is fail-open (0, no throw)', async () => {
  const mgr = makeManager();
  const client = makeDrainClient([], mgr);
  client.evaluate = async () => { throw new Error('socket closed'); };
  assert.equal(await drainNetworkHookBuffer(client), 0);
});

test('drainNetworkHookBuffer: malformed payload is fail-open', async () => {
  const mgr = makeManager();
  const client = makeDrainClient([], mgr);
  client.evaluate = async () => ({ value: '{ not json' });
  assert.equal(await drainNetworkHookBuffer(client), 0);
});

test('drainNetworkHookBuffer: malformed single entries are skipped, valid ones applied', async () => {
  const mgr = makeManager();
  const client = makeDrainClient([
    null,
    { nope: true },
    { t: 'request', d: { id: 'ok1', method: 'GET', url: '/good' } },
  ], mgr);
  const drained = await drainNetworkHookBuffer(client);
  assert.equal(drained, 1);
  assert.equal(mgr.getByKey('dev1', 'ok1').url, '/good');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/unit/net-hook-buffered-transport.test.js`
Expected: FAIL — module `dist/cdp/net-hook-drain.js` does not exist.

- [ ] **Step 3: Implement `src/cdp/net-hook-drain.ts`**

```ts
import { applyNetworkHookEntry } from './event-handlers.js';
import { logger } from '../logger.js';
import type { DeviceBufferManager } from '../ring-buffer.js';
import type { NetworkEntry } from '../types.js';

const DRAIN_EXPR = `(function(){
  var b = globalThis.__RN_AGENT_NET_BUF__ || [];
  globalThis.__RN_AGENT_NET_BUF__ = [];
  return JSON.stringify(b);
})()`;

interface DrainableClient {
  networkMode: 'cdp' | 'hook' | 'none';
  activeDeviceKey: string;
  networkBufferManager: DeviceBufferManager<NetworkEntry, string>;
  evaluate: (expr: string) => Promise<{ value?: unknown; error?: string }>;
}

/**
 * Drain the in-app hook-mode network ring buffer into the bridge's
 * DeviceBufferManager. Called on demand by the network-reading tools
 * (cdp_network_log, cdp_wait_for_network, cdp_network_body) — MCP is
 * pull-based, so buffering lives app-side until someone reads.
 *
 * Fail-open by contract: a read tool must never error because the drain
 * failed (app mid-reload, stale helpers); it just returns what the bridge
 * already buffered. Returns the number of entries applied.
 */
export async function drainNetworkHookBuffer(client: DrainableClient): Promise<number> {
  if (client.networkMode !== 'hook') return 0;
  try {
    const result = await client.evaluate(DRAIN_EXPR);
    if (result.error || typeof result.value !== 'string') return 0;
    const entries = JSON.parse(result.value) as Array<{ t?: unknown; d?: unknown }>;
    if (!Array.isArray(entries)) return 0;
    let applied = 0;
    for (const e of entries) {
      if (!e || typeof e.t !== 'string' || !e.d || typeof (e.d as { id?: unknown }).id !== 'string') continue;
      applyNetworkHookEntry(
        e.t,
        e.d as { id: string; method?: string; url?: string; status?: number; duration_ms?: number },
        client.networkBufferManager,
        client.activeDeviceKey,
      );
      applied++;
    }
    return applied;
  } catch (err) {
    logger.warn('CDP', `net-hook drain failed (fail-open): ${err instanceof Error ? err.message : err}`);
    return 0;
  }
}
```

Two plan-review notes worth keeping in mind (documented, accepted):
- **Destructive read with two bridges:** `DRAIN_EXPR` swaps the buffer for `[]`, so if two bridge processes were connected to the same app (L1 introspection is shared), the first drain steals entries from the second. The old console transport fanned out to all consumers. Accepted: the #202 device-ownership lock makes the two-bridge case rare, and single-bridge agent-first is the norm. The swap itself IS atomic within the app — Hermes JS is single-threaded.
- **Response bodies are orthogonal:** the drain carries only request/response metadata. `cdp_network_body`'s hook branch reads `globalThis.__RN_AGENT_RESPONSE_BODIES__`, a separate cache populated by `NETWORK_HOOK_SCRIPT` — unaffected by this transport change.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/net-hook-buffered-transport.test.js`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cdp/net-hook-drain.ts test/unit/net-hook-buffered-transport.test.js
git commit -m "feat(cdp): on-demand drain of the in-app network hook buffer"
```

---

### Task 7: Wire the drain into the three network-reading tools

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/network-log.ts` (handler top, after `scope` is computed)
- Modify: `scripts/cdp-bridge/src/tools/wait-for-network.ts` (phase-1 scan ~line 76; poll loop ~line 101)
- Modify: `scripts/cdp-bridge/src/tools/network-body.ts` (top of the `networkMode === 'hook'` branch ~line 56)
- Test: `scripts/cdp-bridge/test/unit/net-hook-drain-integration.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/net-hook-drain-integration.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createNetworkLogHandler } from '../../dist/tools/network-log.js';
import { createWaitForNetworkHandler } from '../../dist/tools/wait-for-network.js';

// Spec 2026-06-10-debugger-seat-optout Part 2: the network-reading tools
// drain the in-app hook buffer before serving reads, so hook-mode entries
// flow without any console transport.

const BUF = [
  { t: 'request', d: { id: 'q1', method: 'POST', url: '/api/v1/auth/otp' } },
  { t: 'response', d: { id: 'q1', status: 200, duration_ms: 758 } },
];

function hookClient(extra = {}) {
  let drained = false;
  const client = createMockClient({
    _isConnected: true,
    _helpersInjected: true,
    networkMode: 'hook',
    evaluate: async (expr) => {
      if (expr.includes('__RN_AGENT_NET_BUF__')) {
        const payload = drained ? [] : BUF;
        drained = true;
        return { value: JSON.stringify(payload) };
      }
      return { value: 'null' };
    },
    ...extra,
  });
  return client;
}

test('cdp_network_log: hook mode drains the in-app buffer before reading', async () => {
  const client = hookClient();
  const handler = createNetworkLogHandler(() => client);
  const data = expectOk(await handler({ limit: 20, clear: false }));
  assert.equal(data.count, 1);
  assert.equal(data.requests[0].id, 'q1');
  assert.equal(data.requests[0].status, 200);
});

test('cdp_network_log: cdp mode does not evaluate a drain', async () => {
  let evaluated = 0;
  const client = hookClient({
    networkMode: 'cdp',
    evaluate: async () => { evaluated++; return { value: 'null' }; },
  });
  const handler = createNetworkLogHandler(() => client);
  expectOk(await handler({ limit: 20, clear: false }));
  assert.equal(evaluated, 0);
});

test('cdp_network_log: clear also empties freshly drained entries', async () => {
  const client = hookClient();
  const handler = createNetworkLogHandler(() => client);
  expectOk(await handler({ limit: 20, clear: true }));
  const data = expectOk(await handler({ limit: 20, clear: false }));
  assert.equal(data.count, 0, 'in-app entries drained during clear must be cleared too');
});

test('cdp_wait_for_network: retroactive match against drained entries', async () => {
  const client = hookClient();
  const handler = createWaitForNetworkHandler(() => client);
  const data = expectOk(await handler({
    url_pattern: '/auth/otp',
    timeout_ms: 500,
    since: '2000-01-01T00:00:00.000Z',
  }));
  assert.equal(data.matched, true);
  assert.equal(data.mutation.id, 'q1');
});
```

Check `createMockClient` defaults: the mock must expose `networkBufferManager` (a real or mock `DeviceBufferManager`) and `activeDeviceKey` — existing network tests (`test/unit/wait-for-network.test.js`) show how the mock seeds the buffer; reuse that setup. If `createMockClient` hard-codes `networkMode`, pass it via overrides as shown.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run build && node --test test/unit/net-hook-drain-integration.test.js`
Expected: FAIL — counts are 0 / `matched` is false (nothing drains the buffer).

- [ ] **Step 3: Implement the three call sites**

`src/tools/network-log.ts` — add import and one drain call at the top of the handler, before the `args.clear` branch (so `clear` wipes drained entries too):

```ts
import { drainNetworkHookBuffer } from '../cdp/net-hook-drain.js';
```

```ts
  return withConnection(getClient, async (args: NetworkLogArgs, client) => {
    const scope = args.device ?? client.activeDeviceKey;
    await drainNetworkHookBuffer(client);

    if (args.clear) {
```

`src/tools/wait-for-network.ts` — same import; drain before the phase-1 scan, and inside the poll loop **throttled to at most one drain per 500ms** (plan-review finding: the default 100ms poll over a 5s timeout would otherwise fire ~50 evaluate round-trips per call):

```ts
    await drainNetworkHookBuffer(client);
    const existing = client.networkBufferManager.filter(scope, predicate);
```

and inside the poll loop, immediately after the `setTimeout` await (~line 101):

```ts
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      if (Date.now() - lastDrainAt >= DRAIN_MIN_INTERVAL_MS) {
        lastDrainAt = Date.now();
        await drainNetworkHookBuffer(client);
      }
      const matches = client.networkBufferManager.filter(scope, predicate);
```

with, above the loop:

```ts
    const DRAIN_MIN_INTERVAL_MS = 500;
    let lastDrainAt = Date.now();
```

Also update the now-stale `requireHelpers: false` comment at `createWaitForNetworkHandler` (~line 62) — it currently claims the tool "never evaluates JS in Hermes":

```ts
  // requireHelpers: false — this tool reads the in-process network buffer
  // (mutated by event-handlers.ts on Network.* CDP events). In hook mode it
  // additionally drains the in-app __RN_AGENT_NET_BUF__ via evaluate
  // (fail-open, throttled); the freshness probe is still unnecessary work.
```

`src/tools/network-body.ts` — same import; first line inside the `if (client.networkMode === 'hook') {` branch:

```ts
    if (client.networkMode === 'hook') {
      await drainNetworkHookBuffer(client);
```

(`drainNetworkHookBuffer` is a no-op outside hook mode, so the unconditional call in network-log/wait-for-network is safe — the cdp-mode test above proves it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/net-hook-drain-integration.test.js test/unit/wait-for-network.test.js`
Expected: PASS — new tests green, existing wait-for-network tests unaffected.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all green (~1850 tests).

- [ ] **Step 6: Commit**

```bash
git add src/tools/network-log.ts src/tools/wait-for-network.ts src/tools/network-body.ts test/unit/net-hook-drain-integration.test.js
git commit -m "feat(cdp): drain hook-mode network buffer on demand in the network-reading tools"
```

---

### Task 8: Docs + changeset

**Files:**
- Modify: `commands/doctor.md` (repo root) — the "14-row table" instruction
- Modify: `CLAUDE.md` (repo root) — Troubleshooting section
- Modify: `CLAUDE-MD-TEMPLATE.md` (repo root) — Troubleshooting section (template injected into user projects)
- Modify: `docs-site/src/content/docs/` — the page covering DevTools / maestro coexistence (`grep -rl "maestro-mcp\|DevTools" docs-site/src/content/docs/` to locate; follow that page's structure)
- Create: `.changeset/debugger-seat-optout.md`

- [ ] **Step 1: doctor command row**

In `commands/doctor.md`, change "14-row table" to "15-row table" and add a row spec alongside the existing rows: **CDP auto-reconnect** — read `autoConnect` from `cdp_status` output; report `ON (default)`, `OFF (env)`, or `OFF (config)`; OFF is informational (YELLOW, not RED) with the note "React Native DevTools can hold the debugger seat; the bridge reconnects only on tool calls".

- [ ] **Step 2: Troubleshooting entries (CLAUDE.md + CLAUDE-MD-TEMPLATE.md)**

Add one entry to both Troubleshooting sections (match each file's existing bullet style):

> **"Disconnected due to opening a second DevTools window" / React Native DevTools keeps getting kicked** → RN allows exactly one debugger frontend per app, and the bridge auto-reconnects by default (agent-first). To let the visual DevTools hold the seat, set `RN_CDP_AUTOCONNECT=0` (or `.rn-agent/config.json` → `{ "cdp": { "autoConnect": false } }`). The bridge then reconnects only when a CDP tool actually runs, and yields again once you reopen DevTools. Note: **any** CDP tool call — including `cdp_status` — reclaims the seat while it runs; passive mode only stops *background* re-grabs. Check the resolved mode in `cdp_status` → `autoConnect`.

- [ ] **Step 3: docs-site coexistence section**

On the located docs-site page, add a "Using rn-dev-agent with React Native DevTools" section: one paragraph on the single-seat constraint, the default agent-first posture, the two opt-out surfaces with examples, and a note that hook-mode network capture no longer writes `__RN_NET__` lines to the console (fixed transport, no action needed).

- [ ] **Step 4: Changeset**

Create `.changeset/debugger-seat-optout.md`:

```md
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

Debugger-seat coexistence with React Native DevTools + silent hook-mode network capture.

- New opt-out for background auto-reconnect: `RN_CDP_AUTOCONNECT=0` or `.rn-agent/config.json` `{ "cdp": { "autoConnect": false } }`. In passive mode the bridge yields the single RN debugger seat to the visual DevTools and reconnects only on explicit tool calls. Resolved mode is visible in `cdp_status` → `autoConnect` and `/doctor`.
- Hook-mode network capture (RN < 0.83 fallback) no longer transports entries via `console.log("__RN_NET__:…")` — entries go to an in-app ring buffer drained on demand, so Metro logs and the user's DevTools console stay clean.
```

- [ ] **Step 5: Rebuild dist if tracked**

`dist/` is tracked in this repo: run `npm run build` in `scripts/cdp-bridge` and stage the rebuilt output.

- [ ] **Step 6: Commit**

```bash
git add commands/doctor.md CLAUDE.md CLAUDE-MD-TEMPLATE.md docs-site/ .changeset/debugger-seat-optout.md scripts/cdp-bridge/dist
git commit -m "docs: DevTools coexistence (autoConnect opt-out) + changeset"
```

---

### Task 9: Live gates (booted simulator + test-app)

Manual verification with the workspace test-app (`cd ../rn-dev-agent-workspace/test-app && npx expo start`, app loaded on a booted iOS simulator). Both gates drive the freshly built `dist/`.

- [ ] **Gate 1 — passive mode yields the seat:**
  1. Start the bridge session with `RN_CDP_AUTOCONNECT=0` in the MCP server env (or temporarily export it where the bridge process is spawned).
  2. `cdp_status` → confirm `autoConnect: { enabled: false, source: 'env' }` and connected.
  3. Open React Native DevTools (press `j` in the Metro terminal).
  4. Wait 30s **without issuing any CDP tool call** (any tool — including `cdp_status` — reclaims the seat by design; watch the bridge stderr/logs only): DevTools must stay connected (no "second DevTools window" eviction); bridge logs show the "auto-reconnect disabled" message.
  5. Call `cdp_component_tree` → bridge reconnects on demand (DevTools gets kicked — expected, the agent knowingly took the seat back).
  6. Reopen DevTools → it holds the seat again (bridge stays down).

- [ ] **Gate 2 — control (default fights):** without the env var, opening DevTools gets evicted within ~1s (today's behavior preserved).

- [ ] **Gate 3 — silent hook transport:**
  1. Restart the bridge with `RN_FORCE_NETWORK_HOOK=1`.
  2. `cdp_status` → `capabilities.networkFallback: true` (hook mode).
  3. Trigger app network traffic (navigate around the test-app).
  4. Watch the Metro terminal: **zero** `__RN_NET__:` lines.
  5. `cdp_network_log` → entries present with status/duration (drained from the in-app buffer).
  6. `cdp_network_body` on one request id → body returned from the hook cache.

- [ ] **Record results** as a short note for the PR body (pass/fail per gate + any observations).

---

## Self-review (done at plan-writing time)

- **Spec coverage:** config precedence (Task 1), passive gating of all three background paths — `handleClose` loop, background poll, Metro-detected reconnect-after-exhaustion (Tasks 2; the third path is the poll's `reconnect()` call, gated because the poll itself never arms) — status visibility (Task 3), doctor row + docs (Task 8), buffered transport + drain + three tool call sites + back-compat filter retention (Tasks 4–7), fail-open error handling (Tasks 1, 6), unit tests per behavior, live gates incl. DevTools coexistence and zero-spam verification (Task 9). No gaps found.
- **Placeholder scan:** clean — every code step has complete code; the remaining "copy from existing test" note (mock-client connected seeds, Task 3) is a verification instruction against existing code.
- **Type consistency:** `AutoConnectResolution { enabled, source }` used identically in Tasks 1/3 and the status payload; `applyNetworkHookEntry(type, data, manager, deviceKey)` signature matches between Tasks 4 and 6; `NETWORK_CB_BUFFERED_SCRIPT` name consistent across Tasks 5 and the file-structure table.

## Amendments applied from the multi-LLM plan review (2026-06-10)

External providers both failed (Gemini 429 capacity, Codex usage limit); amendments come from the coordinator's file-verified Claude research:
1. **BLOCKER fixed:** `DeviceBufferManager` lives in `src/ring-buffer.ts` and takes an options object — corrected all test/`net-hook-drain.ts` imports and `makeManager()` (Tasks 4/6).
2. **Seat policy decided:** `cdp_status` recovery (`softReconnect`, `recoverWedge`) and `recover-detached` stay ungated — foreground tool calls knowingly reclaim the seat. Documented in Task 2 policy note, the Task 8 troubleshooting entry, the spec, and Gate 1 (no CDP tool calls during the coexistence window).
3. **Drain throttled in `cdp_wait_for_network`:** min 500ms between in-loop drains (was ~50 evaluates per 5s wait); stale `requireHelpers: false` comment updated (Task 7).
4. **Status payload shape reconciled:** top-level `autoConnect` (spec said `connection.autoConnect`; no `connection` envelope exists) — spec amended.
5. **Hardening + notes:** duplicate-id dedup in `applyNetworkHookEntry` (+ test, Task 4); destructive-read two-bridge note and body-cache-orthogonal note (Task 6).
