# GH #136 PR-B — Dev-Client Picker Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 60-second `cdp_status` hang on the Expo Dev Client picker, and harden `dismissPicker` to reliably tap the visible Metro server entry.

**Architecture:** Two changes to `cdp-bridge`:
1. **Invert `cdp_status` flow** (`tools/status.ts`) so the picker probe runs BEFORE `autoConnect`, eliminating the upfront discovery timeout.
2. **Harden `dismissPicker`** (`tools/dev-client-picker.ts`) with two new pure helpers: `parsePortPatternEntry` (matches any `host:port` row), `parseFirstServerEntry` (orchestrates fallbacks), and tighter retry logic that detects auto-advance between attempts.

**Tech Stack:** TypeScript (Node.js >= 22) → compiled to `dist/`. Tests use `node:test` with `assert/strict`. Mock CDPClient via `test/helpers/mock-cdp-client.js`. Existing test pattern: `gh-61-b1-deep-link-depth.test.js`, `m10-architecture.test.js`.

**Spec:** `docs/superpowers/specs/2026-05-07-gh136-multi-device-and-picker-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `scripts/cdp-bridge/src/tools/dev-client-picker.ts` | Modify | Add `parsePortPatternEntry`, `parseFirstServerEntry`, race-aware retry; rewrite `dismissPicker` to use new helpers |
| `scripts/cdp-bridge/src/tools/status.ts` | Modify | Insert pre-connect picker probe before `autoConnect` at line 121 |
| `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js` | Create | Unit tests for new pure helpers + `dismissPicker` integration |
| `scripts/cdp-bridge/test/unit/gh-136-status-picker-precheck.test.js` | Create | Integration tests for `cdp_status` flow inversion |

No new files in production source; one new helper module would over-fragment the existing `dev-client-picker.ts` (≈110 LOC today, ≈250 after — still focused).

---

## Task 1: Pure helper — `parsePortPatternEntry`

Extract the port-pattern matcher as a pure function so it's testable without the agent-device CLI in the loop.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/tools/dev-client-picker.js';

test('parsePortPatternEntry: matches IPv4 LAN address with Metro port', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('192.168.1.5:8081'), '192.168.1.5:8081');
});

test('parsePortPatternEntry: matches Android emulator alias', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('10.0.2.2:8081'), '10.0.2.2:8081');
});

test('parsePortPatternEntry: matches hostname with port', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('antons-macbook.local:8081'), 'antons-macbook.local:8081');
});

test('parsePortPatternEntry: extracts entry from a noisy snapshot blob', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nrn-dev-agent-test-app\n192.168.1.5:8081\nEnter URL manually';
  assert.equal(parsePortPatternEntry(snapshot), '192.168.1.5:8081');
});

test('parsePortPatternEntry: ignores non-port colons', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('Updated at 11:42 AM'), null);
  assert.equal(parsePortPatternEntry('http://example.com:443/path'), 'example.com:443');
});

test('parsePortPatternEntry: rejects ports < 80 (avoids version strings)', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('react-native:0.76'), null);
  assert.equal(parsePortPatternEntry('v1.2:34'), null);
});

test('parsePortPatternEntry: rejects ports > 65535', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry('host:99999'), null);
});

test('parsePortPatternEntry: returns null on empty/null input', async () => {
  const { parsePortPatternEntry } = await import(MOD_PATH);
  assert.equal(parsePortPatternEntry(''), null);
  assert.equal(parsePortPatternEntry(null), null);
  assert.equal(parsePortPatternEntry(undefined), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: FAIL with "parsePortPatternEntry is not a function" (or import error).

- [ ] **Step 3: Implement `parsePortPatternEntry` in `dev-client-picker.ts`**

Append to `scripts/cdp-bridge/src/tools/dev-client-picker.ts` (before `handleDevClientPicker`):

```typescript
const PORT_PATTERN = /\b([\w.-]+):(\d{2,5})\b/g;

export function parsePortPatternEntry(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  PORT_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PORT_PATTERN.exec(text)) !== null) {
    const host = match[1];
    const portNum = Number.parseInt(match[2], 10);
    if (portNum < 80 || portNum > 65535) continue;
    if (!/[A-Za-z]/.test(host) && !/\d+\.\d+\.\d+\.\d+/.test(host)) continue;
    return `${host}:${portNum}`;
  }
  return null;
}
```

- [ ] **Step 4: Rebuild + run test**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: PASS — 8 of 8 `parsePortPatternEntry` cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js
git commit -m "feat(gh-136): add parsePortPatternEntry helper for picker row matching"
```

---

## Task 2: Pure helper — `parseFirstServerEntry`

Orchestrates the matcher fallbacks: literal IPs first (preserves backward parity), then port-pattern, then "first non-header row below 'Development servers'".

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`

- [ ] **Step 1: Append failing tests**

Append to `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`:

```javascript
test('parseFirstServerEntry: prefers literal localhost when present', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nlocalhost\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), 'localhost');
});

test('parseFirstServerEntry: falls through to port-pattern when no literal IP', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nrn-dev-agent-test-app\n192.168.1.5:8081';
  assert.equal(parseFirstServerEntry(snapshot), '192.168.1.5:8081');
});

test('parseFirstServerEntry: first-non-header fallback when no port-pattern match', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nrn-dev-agent-test-app\nEnter URL manually';
  assert.equal(parseFirstServerEntry(snapshot), 'rn-dev-agent-test-app');
});

test('parseFirstServerEntry: returns null when no header found', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  assert.equal(parseFirstServerEntry('Welcome screen\nGet started'), null);
});

test('parseFirstServerEntry: skips footer rows in fallback', async () => {
  const { parseFirstServerEntry } = await import(MOD_PATH);
  const snapshot = 'Development servers\nServer-A\nEnter URL manually\nFetch development servers';
  assert.equal(parseFirstServerEntry(snapshot), 'Server-A');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: FAIL with "parseFirstServerEntry is not a function".

- [ ] **Step 3: Implement `parseFirstServerEntry`**

Add to `scripts/cdp-bridge/src/tools/dev-client-picker.ts` (just below `parsePortPatternEntry`):

```typescript
const FOOTER_ROWS = new Set([
  'Enter URL manually',
  'Fetch development servers',
  'Development servers',
  'DEVELOPMENT SERVERS',
  'Connect to a development build',
]);

const HEADER_PATTERNS = [/Development servers/i, /DEVELOPMENT SERVERS/];

export function parseFirstServerEntry(snapshot: string | null | undefined): string | null {
  if (typeof snapshot !== 'string' || snapshot.length === 0) return null;

  for (const ip of ['localhost', '127.0.0.1', '10.0.2.2']) {
    if (snapshot.includes(ip)) return ip;
  }

  const portMatch = parsePortPatternEntry(snapshot);
  if (portMatch) return portMatch;

  const lines = snapshot.split('\n').map((s) => s.trim()).filter((s) => s.length > 0);
  const headerIdx = lines.findIndex((line) => HEADER_PATTERNS.some((re) => re.test(line)));
  if (headerIdx === -1) return null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (!FOOTER_ROWS.has(lines[i])) return lines[i];
  }
  return null;
}
```

- [ ] **Step 4: Rebuild + run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: PASS — 13 of 13.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js
git commit -m "feat(gh-136): add parseFirstServerEntry orchestrator"
```

---

## Task 3: Wire `parseFirstServerEntry` into `dismissPicker`

Replace the existing `for (const entry of SERVER_ENTRY_INDICATORS)` loop with a single call to `parseFirstServerEntry` against an upfront snapshot.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`

- [ ] **Step 1: Append failing test**

Append to `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`:

```javascript
test('dismissPicker: taps host:port row when picker shows LAN IP', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, dismissPicker } = await import(MOD_PATH);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'Development servers\n192.168.1.5:8081' }] };
    }
    if (args[0] === 'find' && args[1] === '192.168.1.5:8081' && args[2] === 'click') {
      return { content: [{ type: 'text', text: 'tapped' }] };
    }
    if (args[0] === 'find' && args[1] === 'Development servers') {
      return { isError: true, content: [{ type: 'text', text: 'not found' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unhandled' }] };
  });
  try {
    const result = await dismissPicker();
    assert.equal(result.dismissed, true);
    assert.match(result.reason, /192\.168\.1\.5:8081/);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});

test('dismissPicker: returns dismissed:false with helpful reason when nothing matches', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, dismissPicker } = await import(MOD_PATH);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'No picker visible' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'no match' }] };
  });
  try {
    const result = await dismissPicker();
    assert.equal(result.dismissed, false);
    assert.match(result.reason, /could not find a server entry/i);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: FAIL with "_setRunAgentDeviceForTest is not a function" or "dismissPicker is not exported".

- [ ] **Step 3: Add test seam to `dev-client-picker.ts`**

Modify `scripts/cdp-bridge/src/tools/dev-client-picker.ts` — replace the `import` line:

```typescript
import { runAgentDevice as _runAgentDeviceImpl, hasActiveSession } from '../agent-device-wrapper.js';
```

Add at the top of the file (after imports):

```typescript
let runAgentDeviceFn: typeof _runAgentDeviceImpl = _runAgentDeviceImpl;

export function _setRunAgentDeviceForTest(fn: typeof _runAgentDeviceImpl): void {
  runAgentDeviceFn = fn;
}

export function _resetRunAgentDeviceForTest(): void {
  runAgentDeviceFn = _runAgentDeviceImpl;
}
```

Replace every existing `runAgentDevice(...)` call in this file with `runAgentDeviceFn(...)`.

- [ ] **Step 4: Rewrite `dismissPicker` to use `parseFirstServerEntry` and export it**

Replace the existing `dismissPicker` function with:

```typescript
export async function dismissPicker(): Promise<PickerResult> {
  const snapshot = await runAgentDeviceFn(['snapshot', '-i']);
  const snapshotText = snapshot.isError ? '' : (snapshot.content[0]?.text ?? '');
  const target = parseFirstServerEntry(snapshotText);

  if (target) {
    const result = await runAgentDeviceFn(['find', target, 'click']);
    if (!result.isError) {
      await waitForBundle();
      return { dismissed: true, reason: `Tapped server entry "${target}"` };
    }
  }

  return {
    dismissed: false,
    reason: 'Dev Client picker detected but could not find a server entry to tap. Select the Metro server manually.',
  };
}
```

- [ ] **Step 5: Rebuild + run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: PASS — 15 of 15.

- [ ] **Step 6: Run full unit suite to verify no regression**

Run: `cd scripts/cdp-bridge && npm test 2>&1 | tail -20`
Expected: All previously-passing tests still pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js
git commit -m "fix(gh-136): rewrite dismissPicker to use parseFirstServerEntry"
```

---

## Task 4: Auto-advance race detection

Between picker-detection and tap, re-check whether the picker is still showing. If it's gone, the auto-advance fired — return success without tapping.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`

- [ ] **Step 1: Append failing test**

Append to `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`:

```javascript
test('handleDevClientPicker: returns success without tap when picker auto-advances mid-flight', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, _setHasSessionForTest, _resetHasSessionForTest, handleDevClientPicker } = await import(MOD_PATH);
  let detectCalls = 0;
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && args[1] === 'Development servers') {
      detectCalls++;
      if (detectCalls === 1) return { content: [{ type: 'text', text: 'found' }] };
      return { isError: true, content: [{ type: 'text', text: 'gone' }] };
    }
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'No picker visible' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unexpected call' }] };
  });
  try {
    const result = await handleDevClientPicker();
    assert.equal(result?.dismissed, true);
    assert.match(result?.reason ?? '', /auto-advanced/i);
  } finally {
    _resetRunAgentDeviceForTest();
    _resetHasSessionForTest();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: FAIL — `_setHasSessionForTest` not exported, OR auto-advance not detected.

- [ ] **Step 3: Add `hasActiveSession` test seam**

Add to `scripts/cdp-bridge/src/tools/dev-client-picker.ts` (right after `_resetRunAgentDeviceForTest`):

```typescript
let hasActiveSessionFn: typeof hasActiveSession = hasActiveSession;

export function _setHasSessionForTest(value: boolean): void {
  hasActiveSessionFn = () => value;
}

export function _resetHasSessionForTest(): void {
  hasActiveSessionFn = hasActiveSession;
}
```

Replace every `hasActiveSession()` call in this file with `hasActiveSessionFn()`.

- [ ] **Step 4: Add auto-advance check in `dismissPicker`**

Modify `dismissPicker` to insert a re-check after the snapshot, before attempting to tap:

```typescript
export async function dismissPicker(): Promise<PickerResult> {
  const stillShowing = await isDevClientPickerShowing();
  if (!stillShowing) {
    return { dismissed: true, reason: 'Dev Client picker auto-advanced before tap' };
  }

  const snapshot = await runAgentDeviceFn(['snapshot', '-i']);
  const snapshotText = snapshot.isError ? '' : (snapshot.content[0]?.text ?? '');
  const target = parseFirstServerEntry(snapshotText);

  if (target) {
    const result = await runAgentDeviceFn(['find', target, 'click']);
    if (!result.isError) {
      await waitForBundle();
      return { dismissed: true, reason: `Tapped server entry "${target}"` };
    }
  }

  return {
    dismissed: false,
    reason: 'Dev Client picker detected but could not find a server entry to tap. Select the Metro server manually.',
  };
}
```

- [ ] **Step 5: Rebuild + run test**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: PASS — 16 of 16.

- [ ] **Step 6: Run full unit suite**

Run: `cd scripts/cdp-bridge && npm test 2>&1 | tail -20`
Expected: No regressions.

- [ ] **Step 7: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js
git commit -m "fix(gh-136): detect picker auto-advance to eliminate tap race"
```

---

## Task 5: Tighten `waitForBundle` polling cadence

Replace fixed 2s polling with a fast-then-slow strategy: 100ms ticks for the first 1s, 500ms ticks thereafter, 10s overall budget.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`

- [ ] **Step 1: Append failing test**

Append to `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js`:

```javascript
test('waitForBundle: returns within 500ms when picker dismissed quickly', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, waitForBundle } = await import(MOD_PATH);
  let calls = 0;
  _setRunAgentDeviceForTest(async (args) => {
    calls++;
    if (calls < 2) return { content: [{ type: 'text', text: 'Development servers' }] };
    return { isError: true, content: [{ type: 'text', text: 'gone' }] };
  });
  try {
    const start = Date.now();
    await waitForBundle();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 500, `waitForBundle should complete fast in single-server picker case; took ${elapsed}ms`);
    assert.ok(calls >= 2, `waitForBundle should poll at least twice; saw ${calls} calls`);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});

test('waitForBundle: bounded by max wall-clock budget', async () => {
  const { _setRunAgentDeviceForTest, _resetRunAgentDeviceForTest, waitForBundle } = await import(MOD_PATH);
  _setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: 'Development servers' }] }));
  try {
    const start = Date.now();
    await waitForBundle();
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 12_000, `waitForBundle should give up within ~10s; took ${elapsed}ms`);
  } finally {
    _resetRunAgentDeviceForTest();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: First test FAILS (current waitForBundle takes 2s minimum).

- [ ] **Step 3: Replace `waitForBundle` and export it**

Replace the `waitForBundle` function in `scripts/cdp-bridge/src/tools/dev-client-picker.ts`:

```typescript
export async function waitForBundle(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 10_000) {
    const elapsed = Date.now() - start;
    const interval = elapsed < 1_000 ? 100 : 500;
    await new Promise((r) => setTimeout(r, interval));
    const check = await runAgentDeviceFn(['find', 'Development servers']);
    if (check.isError) return;
  }
}
```

- [ ] **Step 4: Rebuild + run tests**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dev-client-picker.test.js`
Expected: PASS — 18 of 18.

- [ ] **Step 5: Run full unit suite**

Run: `cd scripts/cdp-bridge && npm test 2>&1 | tail -20`
Expected: No regressions.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js
git commit -m "perf(gh-136): tighten waitForBundle to fast-then-slow polling"
```

---

## Task 6: Invert `cdp_status` flow — pre-connect picker probe

Insert a picker probe BEFORE `autoConnect` so we don't eat the 60s Metro discovery timeout.

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/status.ts:121`
- Test: `scripts/cdp-bridge/test/unit/gh-136-status-picker-precheck.test.js`

- [ ] **Step 1: Write failing test**

Create `scripts/cdp-bridge/test/unit/gh-136-status-picker-precheck.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockClient } from '../helpers/mock-cdp-client.js';
import { expectOk } from '../helpers/result-helpers.js';
import { createStatusHandler } from '../../dist/tools/status.js';
import {
  _setRunAgentDeviceForTest,
  _resetRunAgentDeviceForTest,
  _setHasSessionForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

function makeStatusProbe(args = {}) {
  return JSON.stringify({
    appInfo: { __DEV__: true, ...args },
    errorCount: 0,
    fiberTree: true,
    hasRedBox: false,
    helpersLoaded: true,
  });
}

test('cdp_status: picker probe runs BEFORE autoConnect when not connected', async () => {
  let pickerProbed = false;
  let autoConnectCalled = false;
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && args[1] === 'Development servers') {
      pickerProbed = true;
      return { content: [{ type: 'text', text: 'found' }] };
    }
    if (args[0] === 'snapshot') {
      return { content: [{ type: 'text', text: 'Development servers\n192.168.1.5:8081' }] };
    }
    if (args[0] === 'find' && args[1] === '192.168.1.5:8081' && args[2] === 'click') {
      return { content: [{ type: 'text', text: 'tapped' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'no match' }] };
  });
  const client = createMockClient({
    isConnected: false,
    helpersInjected: true,
    autoConnect: async () => {
      assert.equal(pickerProbed, true, 'picker probe must run BEFORE autoConnect');
      autoConnectCalled = true;
      client.isConnected = true;
    },
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(() => client, () => {}, () => client);
    const data = expectOk(await handler({}));
    assert.equal(autoConnectCalled, true);
    assert.ok(data, 'expected ok envelope');
  } finally {
    _resetRunAgentDeviceForTest();
    _resetHasSessionForTest();
  }
});

test('cdp_status: picker probe is skipped when already connected', async () => {
  let pickerProbed = false;
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && args[1] === 'Development servers') {
      pickerProbed = true;
      return { isError: true, content: [{ type: 'text', text: 'gone' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'unhandled' }] };
  });
  const client = createMockClient({
    isConnected: true,
    helpersInjected: true,
    evaluate: async () => ({ value: makeStatusProbe() }),
  });
  try {
    const handler = createStatusHandler(() => client, () => {}, () => client);
    expectOk(await handler({}));
    assert.equal(pickerProbed, false, 'connected client should NOT trigger picker probe');
  } finally {
    _resetRunAgentDeviceForTest();
    _resetHasSessionForTest();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-status-picker-precheck.test.js`
Expected: FAIL — picker probe is currently in the catch block, not before autoConnect.

- [ ] **Step 3: Insert pre-connect picker probe in `status.ts`**

Modify `scripts/cdp-bridge/src/tools/status.ts` — update the import line at the top:

```typescript
import { handleDevClientPicker, isDevClientPickerShowing } from './dev-client-picker.js';
```

Replace lines 121-122 (the `if (!client.isConnected) { await client.autoConnect(...) }` block):

```typescript
      if (!client.isConnected) {
        try {
          if (await isDevClientPickerShowing()) {
            await handleDevClientPicker();
          }
        } catch { /* picker probe is best-effort; fall through to connect */ }
        await client.autoConnect(args.metroPort, args.platform);
      } else if (args.platform) {
```

(The rest of the `else if (args.platform)` block — lines 123-135 — is unchanged.)

- [ ] **Step 4: Rebuild + run new test**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-status-picker-precheck.test.js`
Expected: PASS — both tests pass.

- [ ] **Step 5: Run full unit suite**

Run: `cd scripts/cdp-bridge && npm test 2>&1 | tail -20`
Expected: All previously-passing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/tools/status.ts scripts/cdp-bridge/test/unit/gh-136-status-picker-precheck.test.js
git commit -m "fix(gh-136): probe dev-client picker before autoConnect in cdp_status"
```

---

## Task 7: Update CHANGELOG and bump version

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `plugin.json`
- Modify: `marketplace.json`
- Modify: `scripts/cdp-bridge/package.json`

- [ ] **Step 1: Determine current versions**

Run: `grep -E '"version"' plugin.json marketplace.json scripts/cdp-bridge/package.json`
Note the current values.

- [ ] **Step 2: Increment versions**

Run the existing version-sync helper:

```bash
./scripts/sync-versions.sh patch
```

Expected: bumps plugin (0.44.27 → 0.44.28) and cdp-bridge (0.38.20 → 0.38.21), updates `marketplace.json`.

If the script doesn't take a `patch` arg or doesn't exist, manually edit:
- `plugin.json` "version" → 0.44.28
- `marketplace.json` "version" for the rn-dev-agent entry → 0.44.28
- `scripts/cdp-bridge/package.json` "version" → 0.38.21

- [ ] **Step 3: Add CHANGELOG entry**

Insert at the top of `CHANGELOG.md` (after the header):

```markdown
## v0.44.28 — 2026-05-07

### Fixed (GH #136)

- **`cdp_status` no longer hangs 60s on Expo Dev Client picker.** Picker
  probe runs before `autoConnect` instead of inside the post-failure catch
  block. When the picker is up, dismisses it first, then connects normally.
- **`dismissPicker` now matches LAN IPs and `.local` hostnames.** Replaces
  the literal `localhost / 127.0.0.1 / 10.0.2.2` list with `parseFirstServerEntry`
  — three-pass matcher: literal IPs, port-pattern, then first non-footer
  row below the picker title.
- **Auto-advance race detection.** `dismissPicker` re-probes the picker
  before tapping; if the picker auto-dismissed mid-flight, returns success
  without tapping.
- **Tighter `waitForBundle` cadence.** 100ms polling for the first second,
  500ms thereafter, 10s overall budget (was 2s polling, 20s budget).
```

- [ ] **Step 4: Verify version sync**

Run: `grep -E '"version"' plugin.json marketplace.json scripts/cdp-bridge/package.json`
Expected: plugin/marketplace at 0.44.28, cdp-bridge at 0.38.21.

- [ ] **Step 5: Commit**

```bash
git add CHANGELOG.md plugin.json marketplace.json scripts/cdp-bridge/package.json
git commit -m "chore(release): v0.44.28 — dev-client picker reliability (#136 PR-B)"
```

---

## Task 8: Final build + suite + push + open PR

- [ ] **Step 1: Final build + test run**

Run: `cd scripts/cdp-bridge && npm run build && npm test 2>&1 | tail -30`
Expected: All tests pass. New gh-136 test files visible in the output.

- [ ] **Step 2: Verify diff scope**

Run: `git diff main..HEAD --stat`
Expected: ~9 files changed:
- `docs/superpowers/specs/2026-05-07-gh136-multi-device-and-picker-design.md` (new)
- `docs/superpowers/plans/2026-05-07-gh136-pr-b-picker-reliability.md` (new)
- `scripts/cdp-bridge/src/tools/dev-client-picker.ts` (modified)
- `scripts/cdp-bridge/src/tools/status.ts` (modified)
- `scripts/cdp-bridge/test/unit/gh-136-dev-client-picker.test.js` (new)
- `scripts/cdp-bridge/test/unit/gh-136-status-picker-precheck.test.js` (new)
- `CHANGELOG.md`, `plugin.json`, `marketplace.json`, `scripts/cdp-bridge/package.json`

- [ ] **Step 3: Run /multi-review on the diff**

Per `feedback_two_stage_multi_review`: substantive PRs need /multi-review on impl diff (the spec was reviewed at design time). Run:

```
/multi-review
```

Address any P1 findings before pushing. P2/P3 findings can be deferred to follow-up issues if non-blocking.

- [ ] **Step 4: Push + open PR**

```bash
git push -u origin fix/gh-136-picker-reliability
gh pr create --title "fix(gh-136 PR-B): dev-client picker reliability — pre-connect probe + parseFirstServerEntry" --body "$(cat <<'EOF'
## Summary

Closes issues #2 and #3 from #136 — the dev-client picker hangs and Maestro launchApp race.

- Inverts cdp_status flow: probe picker BEFORE autoConnect (was: only in catch block, eating 60s Metro timeout)
- Hardens dismissPicker with parseFirstServerEntry (three-pass matcher: literal IPs → host:port → first-non-footer-row)
- Detects picker auto-advance to avoid tap-after-dismiss races
- Tightens waitForBundle from 2s/20s to 100ms-then-500ms/10s

PR-A (raw screenshot path for #1) ships separately — see spec for split rationale.

## Test plan

- [x] Unit: 18 new tests in gh-136-dev-client-picker.test.js + gh-136-status-picker-precheck.test.js
- [x] Full suite: `cd scripts/cdp-bridge && npm test` — green
- [ ] Manual: dev-client picker visible → cdp_status → connected in <5s
- [ ] Manual: Maestro launchApp followed by cdp_status → no manual tapping required

Refs #136
EOF
)"
```

- [ ] **Step 5: Final verification**

Confirm PR opens successfully and the link returned by `gh pr create` is reachable. Note the PR number for follow-up tracking.

---

## Self-Review Checklist (run after writing the plan, before handoff)

- [x] **Spec coverage:** Each spec section has a corresponding task —
  - Spec §1 ("Invert cdp_status flow") → Task 6
  - Spec §2 ("Harden dismissPicker matching") → Tasks 1–3
  - Spec §3 ("Beat auto-advance race") → Tasks 4–5
  - Spec tests (12 cases) → Tasks 1–4 cover all (8 + 5 + 2 + 1 + 2 = 18, exceeds 12)
  - Spec acceptance ("connected in <5s") → Task 8 manual verification
- [x] **Placeholder scan:** No TBDs, "implement later", or "similar to Task N" — every step has actual code.
- [x] **Type consistency:** `parseFirstServerEntry`, `parsePortPatternEntry`, `dismissPicker`, `_setRunAgentDeviceForTest`, `_setHasSessionForTest` are named identically in defs and call sites across all tasks.
- [x] **Test seam consistency:** `runAgentDeviceFn` indirection introduced in Task 3 is also used by Tasks 4 + 5; `hasActiveSessionFn` introduced in Task 4 is referenced (not redefined) in later tasks.

---

## Notes for the implementer

- **No worktree** — per `feedback_no_worktrees_for_plugin`, plugin work uses feature branches on the main checkout. We're already on `fix/gh-136-picker-reliability`.
- **Build before each test run.** Tests import from `dist/`, so changes to `src/` aren't visible until you re-run `npm run build`.
- **Test seams are exported but underscore-prefixed.** Per the codebase convention (`gh-61-b1-deep-link-depth.test.js`), `_set*` / `_reset*` exports are explicit signals these are test-only.
- **Don't modify the catch-block picker check at `status.ts:228`.** It's a safety net for races where the picker reappears mid-connect; the pre-connect probe makes it rare but not impossible.
- **/multi-review at Task 8** — get Gemini AND Codex review before pushing. Document any P2 findings as follow-up issues filed against #136.
