# Metro-Port Selection + Worktree Disambiguation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `cdp_status`/discovery picks the Metro port that actually has the app attached (never a detached sibling-worktree Metro), auto-selects the Metro whose serving directory matches this worktree, and warns when the connected bundle is from a different worktree.

**Architecture:** Replace first-match port discovery with best-match: probe all candidate ports in parallel, prefer one with attached Hermes targets, and when several have apps, pick the one whose `lsof`-resolved serving cwd equals this bridge's project root. A new fail-open `cdp/metro-cwd.ts` does PID→cwd resolution; `cdp_status` independently enumerates candidates + emits a cwd-mismatch warning (decoupled from the connect path so it works even when already connected).

**Tech Stack:** TypeScript (Node ≥22), `node --test` unit tests importing compiled `dist/`, `lsof` (macOS-first, fail-open), Chrome DevTools Protocol over WebSocket.

---

## File Structure

- **Create** `scripts/cdp-bridge/src/cdp/metro-cwd.ts` — PID/cwd resolution from a TCP port (`lsof`), memoized `pid→cwd`, macOS-gated, fail-open; plus `resolveProjectRoot()`.
- **Modify** `scripts/cdp-bridge/src/cdp/discovery.ts` — add `discoverAllMetroPorts`, `selectMetroPort`, `enumerateMetroCandidates`; rewrite `discover()` selection; extend `AppDetachedError` with running-port list.
- **Modify** `scripts/cdp-bridge/src/types.ts` — extend `StatusResult.metro` with `candidates`/`projectRoot`/`servingCwd` and add the `MetroCandidate` type.
- **Modify** `scripts/cdp-bridge/src/tools/status.ts` — populate the new `metro.*` fields and emit the cwd-mismatch warning.
- **Create** tests: `test/unit/metro-cwd.test.js`, `test/unit/discover-port-selection.test.js`, `test/unit/status-metro-mismatch.test.js`.
- **Create** `.changeset/metro-port-selection.md`.

All test files import from compiled `../../dist/...` (the `test` script runs `npm run build` first).

---

## Task 1: `metro-cwd.ts` — resolve a Metro's serving cwd from its port

**Files:**
- Create: `scripts/cdp-bridge/src/cdp/metro-cwd.ts`
- Test: `scripts/cdp-bridge/test/unit/metro-cwd.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/metro-cwd.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseLsofPid,
  parseLsofCwd,
  cwdForPort,
  pathMatchesRoot,
  _resetMetroCwdCacheForTest,
} from '../../dist/cdp/metro-cwd.js';

test('parseLsofPid: first numeric line from `lsof -ti` output', () => {
  assert.equal(parseLsofPid('12345\n'), 12345);
  assert.equal(parseLsofPid('12345\n12346\n'), 12345);
});

test('parseLsofPid: null on empty / non-numeric', () => {
  assert.equal(parseLsofPid(''), null);
  assert.equal(parseLsofPid('\n  \n'), null);
});

test('parseLsofCwd: extracts the n-field from `lsof -Fn` machine output', () => {
  const out = 'p12345\nfcwd\nn/Users/anton/GitHub/ix3030/test-app\n';
  assert.equal(parseLsofCwd(out), '/Users/anton/GitHub/ix3030/test-app');
});

test('parseLsofCwd: null when no n-field present', () => {
  assert.equal(parseLsofCwd('p12345\nfcwd\n'), null);
});

test('cwdForPort: composes pid→cwd via injected exec', () => {
  _resetMetroCwdCacheForTest();
  const calls = [];
  const exec = (cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('-ti')) return '777\n';
    return 'p777\nfcwd\nn/repo/worktreeA\n';
  };
  assert.equal(cwdForPort(8081, exec), '/repo/worktreeA');
});

test('cwdForPort: memoizes pid→cwd but re-resolves port→pid each call', () => {
  _resetMetroCwdCacheForTest();
  let pidCalls = 0;
  let cwdCalls = 0;
  const exec = (cmd, args) => {
    if (args.includes('-ti')) { pidCalls++; return '777\n'; }
    cwdCalls++; return 'p777\nfcwd\nn/repo/worktreeA\n';
  };
  cwdForPort(8081, exec);
  cwdForPort(8081, exec);
  assert.equal(pidCalls, 2, 'port→pid re-resolved each call (guards port reuse)');
  assert.equal(cwdCalls, 1, 'pid→cwd memoized');
});

test('cwdForPort: fail-open — null when exec throws or returns junk', () => {
  _resetMetroCwdCacheForTest();
  const throwing = () => { throw new Error('lsof not found'); };
  assert.equal(cwdForPort(8081, throwing), null);
  _resetMetroCwdCacheForTest();
  const noPid = (cmd, args) => (args.includes('-ti') ? '' : '');
  assert.equal(cwdForPort(8081, noPid), null);
});

test('pathMatchesRoot: equal paths match', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA', '/repo/worktreeA'), true);
});

test('pathMatchesRoot: serving cwd nested under root matches (monorepo app subdir, both directions)', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA/app', '/repo/worktreeA'), true);
  assert.equal(pathMatchesRoot('/repo/worktreeA', '/repo/worktreeA/app'), true);
});

test('pathMatchesRoot: sibling worktrees do NOT match (the #303 case)', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeB', '/repo/worktreeA'), false);
});

test('pathMatchesRoot: shared prefix without a separator boundary does NOT match', () => {
  assert.equal(pathMatchesRoot('/repo/worktreeA-2', '/repo/worktreeA'), false);
});

test('pathMatchesRoot: null/undefined operands → false (fail-open)', () => {
  assert.equal(pathMatchesRoot(null, '/repo/worktreeA'), false);
  assert.equal(pathMatchesRoot('/repo/worktreeA', undefined), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/metro-cwd.test.js`
Expected: FAIL — `Cannot find module '../../dist/cdp/metro-cwd.js'`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/cdp/metro-cwd.ts
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { findProjectRoot } from '../nav-graph/storage.js';

export const CWD_LSOF_TIMEOUT_MS = 800;

export type ExecFn = (cmd: string, args: string[]) => string;

const defaultExec: ExecFn = (cmd, args) =>
  execFileSync(cmd, args, {
    timeout: CWD_LSOF_TIMEOUT_MS,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const pidCwdCache = new Map<number, string | null>();

export function _resetMetroCwdCacheForTest(): void {
  pidCwdCache.clear();
}

export function parseLsofPid(stdout: string): number | null {
  for (const line of stdout.split('\n')) {
    const n = parseInt(line.trim(), 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return null;
}

export function parseLsofCwd(stdout: string): string | null {
  for (const line of stdout.split('\n')) {
    if (line.startsWith('n')) {
      const path = line.slice(1).trim();
      if (path) return path;
    }
  }
  return null;
}

function pidForPort(port: number, exec: ExecFn): number | null {
  try {
    return parseLsofPid(exec('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN']));
  } catch {
    return null;
  }
}

function cwdForPid(pid: number, exec: ExecFn): string | null {
  if (pidCwdCache.has(pid)) return pidCwdCache.get(pid) ?? null;
  let cwd: string | null = null;
  try {
    cwd = parseLsofCwd(exec('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']));
  } catch {
    cwd = null;
  }
  pidCwdCache.set(pid, cwd);
  return cwd;
}

function realpathOrResolve(p: string): string {
  try {
    return realpathSync(resolve(p)); // lsof reports realpaths; normalize both sides the same way
  } catch {
    return resolve(p); // path may not exist (unit fixtures / race) — fail-open to normalized
  }
}

export function cwdForPort(port: number, exec: ExecFn = defaultExec): string | null {
  // Platform guard only when using the real lsof; injected-exec tests still run on Linux CI.
  if (exec === defaultExec && process.platform !== 'darwin') return null;
  const pid = pidForPort(port, exec);
  if (pid == null) return null;
  const cwd = cwdForPid(pid, exec);
  return cwd ? realpathOrResolve(cwd) : null;
}

/**
 * Match a Metro's serving cwd against the bridge's project root. `lsof -d cwd`
 * reports a realpath-resolved cwd, so BOTH sides are realpath-normalized before
 * comparison (plain `resolve()` does not follow symlinks — a symlinked worktree
 * or `/tmp`→`/private/tmp` would never `===`). Match = equal OR one contains the
 * other on a path-separator boundary (Metro launched from a monorepo root serving
 * an app subdir, or vice versa). Sibling worktrees never match.
 */
export function pathMatchesRoot(servingCwd: string | null, projectRoot: string | null | undefined): boolean {
  if (!servingCwd || !projectRoot) return false;
  const a = realpathOrResolve(servingCwd);
  const b = realpathOrResolve(projectRoot);
  if (a === b) return true;
  return a.startsWith(b + sep) || b.startsWith(a + sep);
}

/**
 * Bridge project root via the CANONICAL resolver (`findProjectRoot`: RN_PROJECT_ROOT
 * → CLAUDE_USER_CWD → cwd → walk-up → sibling scan), realpath-normalized. Returns
 * null when no RN project is found → cwd auto-pick + mismatch warning stay silent
 * (fail-open). NOTE: must NOT re-derive from CLAUDE_USER_CWD/cwd directly — that is
 * a different value than the rest of the bridge's project-root notion (plan review F1).
 */
export function resolveBridgeProjectRoot(): string | null {
  const root = findProjectRoot();
  return root ? realpathOrResolve(root) : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/metro-cwd.test.js`
Expected: PASS (all 12 tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin
git add scripts/cdp-bridge/src/cdp/metro-cwd.ts scripts/cdp-bridge/test/unit/metro-cwd.test.js
git commit -S -m "feat(#303): metro-cwd — resolve a Metro's serving cwd from its port (fail-open)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `discoverAllMetroPorts` + `selectMetroPort` (pure selection)

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp/discovery.ts` (add two exports + extend `AppDetachedError`)
- Test: `scripts/cdp-bridge/test/unit/discover-port-selection.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/discover-port-selection.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectMetroPort, AppDetachedError } from '../../dist/cdp/discovery.js';

const T = (description) => ({ id: 'page-1', title: 'RN', vm: 'Hermes', description });

test('selectMetroPort: single attached port wins, no warning', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.app')] }],
    [8081, 8082],
    { currentPort: 8082, cwdForPort: () => null },
  );
  assert.equal(res.port, 8081);
  assert.equal(res.warning, undefined);
});

test('selectMetroPort: zero attached → AppDetachedError listing running ports', () => {
  assert.throws(
    () => selectMetroPort([], [8081, 8082], { currentPort: 8081, cwdForPort: () => null }),
    (err) => err instanceof AppDetachedError && err.runningPorts.includes(8082),
  );
});

test('selectMetroPort: projectRoot cwd-match beats sticky currentPort', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.app')] }, { port: 8082, targets: [T('com.app')] }],
    [8081, 8082],
    {
      currentPort: 8082, // sticky would pick 8082
      projectRoot: '/repo/worktreeA',
      cwdForPort: (p) => (p === 8081 ? '/repo/worktreeA' : '/repo/worktreeB'),
    },
  );
  assert.equal(res.port, 8081, 'cwd match wins over stickiness');
});

test('selectMetroPort: preferredBundleId port-level tie-break when one port matches', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.other')] }, { port: 8082, targets: [T('com.app')] }],
    [8081, 8082],
    { currentPort: 8081, preferredBundleId: 'com.app', cwdForPort: () => null },
  );
  assert.equal(res.port, 8082);
});

test('selectMetroPort: no cwd match, no pref → sticky currentPort + warning lists candidates', () => {
  const res = selectMetroPort(
    [{ port: 8081, targets: [T('com.app')] }, { port: 8082, targets: [T('com.app')] }],
    [8081, 8082],
    { currentPort: 8082, projectRoot: '/repo/none', cwdForPort: () => null },
  );
  assert.equal(res.port, 8082, 'sticky currentPort chosen');
  assert.match(res.warning, /8081/);
  assert.match(res.warning, /metroPort/);
});

test('selectMetroPort: sticky falls back to lowest attached when currentPort detached', () => {
  const res = selectMetroPort(
    [{ port: 8082, targets: [T('com.app')] }, { port: 19000, targets: [T('com.app')] }],
    [8081, 8082, 19000],
    { currentPort: 8081, cwdForPort: () => null },
  );
  assert.equal(res.port, 8082);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/discover-port-selection.test.js`
Expected: FAIL — `selectMetroPort` is not exported.

- [ ] **Step 3: Write minimal implementation**

Edit `src/cdp/discovery.ts`. Add the cwd import at the top of the file (used by `selectMetroPort` and, in Task 3, `discover()`):

```ts
import { cwdForPort, resolveBridgeProjectRoot, pathMatchesRoot } from './metro-cwd.js';
```

First extend `AppDetachedError` to carry running ports. (`.port` is preserved for the message/back-compat only — verified in plan review: `recover-detached.ts` relaunches by the active *session's* deviceId/appId and never reads `.port`, and `status.ts` only does `err instanceof AppDetachedError`. So `.port` pointing at an arbitrary detached running port is harmless.)

```ts
export class AppDetachedError extends Error {
  readonly port: number;
  readonly runningPorts: number[];
  constructor(port: number, runningPorts: number[] = [port]) {
    super(
      `Metro is up on port ${port}` +
      (runningPorts.length > 1 ? ` (also running: ${runningPorts.join(', ')})` : '') +
      ` but no live Metro advertises a Hermes debug target — the app isn't attached ` +
      `(it may be on the Expo dev launcher, backgrounded, or crashed). Relaunch the app, ` +
      `or call cdp_status to auto-relaunch and reconnect.`,
    );
    this.name = 'AppDetachedError';
    this.port = port;
    this.runningPorts = runningPorts;
  }
}
```

Add `discoverAllMetroPorts` (parallel probe) near `discoverMetroPort`:

```ts
export async function discoverAllMetroPorts(ports: number[], timeout: number): Promise<number[]> {
  const checks = await Promise.all(
    ports.map(async (p) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeout);
      try {
        const resp = await fetch(`http://127.0.0.1:${p}/status`, { signal: ctrl.signal });
        const text = await resp.text();
        return text.includes('packager-status:running') ? p : null;
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  return checks.filter((p): p is number => p !== null);
}
```

Add `selectMetroPort` (pure):

```ts
export interface AttachedPort {
  port: number;
  targets: HermesTarget[];
}

export interface SelectMetroPortCtx {
  currentPort: number;
  projectRoot?: string;
  preferredBundleId?: string;
  cwdForPort: (port: number) => string | null;
}

export function selectMetroPort(
  attached: AttachedPort[],
  runningPorts: number[],
  ctx: SelectMetroPortCtx,
): { port: number; warning?: string } {
  if (attached.length === 0) {
    throw new AppDetachedError(runningPorts[0] ?? ctx.currentPort, runningPorts);
  }
  if (attached.length === 1) {
    return { port: attached[0].port };
  }

  // 1. projectRoot cwd-match (most specific worktree signal). pathMatchesRoot
  //    realpath-normalizes both sides and allows monorepo subdir containment.
  if (ctx.projectRoot) {
    const matches = attached.filter((a) => pathMatchesRoot(ctx.cwdForPort(a.port), ctx.projectRoot));
    if (matches.length === 1) return { port: matches[0].port };
  }

  // 2. preferredBundleId port-level tie-break (exactly one port has a target with it).
  if (ctx.preferredBundleId) {
    const pref = ctx.preferredBundleId.toLowerCase();
    const prefPorts = attached.filter((a) =>
      a.targets.some((t) => (t.description ?? '').toLowerCase() === pref),
    );
    if (prefPorts.length === 1) return { port: prefPorts[0].port };
  }

  // 3. sticky currentPort if attached, else lowest attached port + disambiguation warning.
  const attachedPortNums = attached.map((a) => a.port).sort((x, y) => x - y);
  const chosen = attachedPortNums.includes(ctx.currentPort) ? ctx.currentPort : attachedPortNums[0];
  const list = attached
    .map((a) => `:${a.port}${ctx.cwdForPort(a.port) ? ` (${ctx.cwdForPort(a.port)})` : ''}`)
    .join(', ');
  return {
    port: chosen,
    warning: `Multiple live Metros with an attached app: ${list}. Picked :${chosen}. Pass metroPort explicitly to choose a different worktree.`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/discover-port-selection.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/cdp/discovery.ts scripts/cdp-bridge/test/unit/discover-port-selection.test.js
git commit -S -m "feat(#303): discoverAllMetroPorts + selectMetroPort (prefer attached, cwd auto-pick)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Wire best-match selection into `discover()`

**Files:**
- Modify: `scripts/cdp-bridge/src/cdp/discovery.ts` (`discover()` body)
- Test: extend `scripts/cdp-bridge/test/unit/discover-port-selection.test.js`

- [ ] **Step 1: Write the failing test**

Append to `discover-port-selection.test.js`. `discover()` uses module-level `fetch`, so stub `globalThis.fetch`:

```js
test('discover: skips detached first port for attached second port', async () => {
  const { discover } = await import('../../dist/cdp/discovery.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/status')) return { text: async () => 'packager-status:running' };
    if (u.includes(':8082/json/list')) return { json: async () => [] }; // detached
    if (u.includes(':8081/json/list')) return {
      json: async () => [{
        id: 'page-1', title: 'RN', vm: 'Hermes', description: 'com.app',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?page=1',
      }],
    };
    return { json: async () => [], text: async () => '' };
  };
  try {
    const res = await discover(8082, {}); // currentPort 8082 is the detached one
    assert.equal(res.port, 8081, 'discovery chose the attached port, not the running-but-detached one');
    assert.equal(res.targets.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('discover: all-detached still throws AppDetachedError', async () => {
  const { discover, AppDetachedError } = await import('../../dist/cdp/discovery.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/status')) return { text: async () => 'packager-status:running' };
    return { json: async () => [] };
  };
  try {
    await assert.rejects(discover(8081, {}), (e) => e instanceof AppDetachedError);
  } finally {
    globalThis.fetch = realFetch;
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/discover-port-selection.test.js`
Expected: FAIL — current `discover()` returns `:8082` (first running) and throws `AppDetachedError`.

- [ ] **Step 3: Write minimal implementation**

Replace the body of `discover()` (the section from `const metroPort = await discoverMetroPort(...)` through `if (validTargets.length === 0) throw new AppDetachedError(metroPort);`) with best-match selection. (The `./metro-cwd.js` import was added at the top of `discovery.ts` in Task 2.)

New `discover()` core (keep the existing `ports`/`hints`/logging prefix and the trailing `inferPlatforms`/`selectTarget`/return):

```ts
  const runningPorts = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
  if (runningPorts.length === 0) {
    throw new Error(
      'Metro not found on ports ' + ports.join(', ') +
      '. Is the dev server running? Try: npx expo start or npx react-native start',
    );
  }

  const perPort = await Promise.all(
    runningPorts.map(async (p) => {
      try {
        const raw = await fetchTargets(p, DISCOVERY_TIMEOUT_MS * 2);
        const valid = filterValidTargets(raw).filter((t) => {
          try {
            const { hostname } = new URL(t.webSocketDebuggerUrl!);
            return hostname === '127.0.0.1' || hostname === 'localhost';
          } catch {
            return false;
          }
        });
        return { port: p, targets: valid };
      } catch {
        return { port: p, targets: [] as HermesTarget[] };
      }
    }),
  );

  const attached = perPort.filter((pp) => pp.targets.length > 0);
  const { port: metroPort, warning: portWarning } = selectMetroPort(attached, runningPorts, {
    currentPort,
    projectRoot: resolveBridgeProjectRoot() ?? undefined,
    preferredBundleId: filters.preferredBundleId,
    cwdForPort: (p) => cwdForPort(p),
  });
  logger.info('CDP', `Metro selected on port ${metroPort} (running: ${runningPorts.join(', ')})`);

  const validTargets = attached.find((pp) => pp.port === metroPort)!.targets;

  inferPlatforms(validTargets);
  const { targets: sorted, warning: selectWarning } = selectTarget(validTargets, filters);
  const warning = [portWarning, selectWarning].filter(Boolean).join(' | ') || undefined;

  logger.debug('CDP', `Found ${sorted.length} valid target(s): ${sorted.map(t => `${t.id} (${t.title}, platform=${t.platform ?? '?'})`).join(', ')}`);
  return { port: metroPort, targets: sorted, warning };
```

`selectMetroPort` throws `AppDetachedError` when `attached` is empty, preserving the existing catch in `status.ts`.

Also fix `discoverForList()` (the backing for `cdp_targets`, called from `cdp-client.ts:192`) so it can't disagree with the now-fixed `discover()` about which Metro it inspects (plan review F2). It does not need cwd auto-pick — just prefer a port with an attached target over a merely-running one. Replace its `discoverMetroPort` first-match call:

```ts
export async function discoverForList(
  currentPort: number,
  portHint?: number,
): Promise<{ port: number; targets: HermesTarget[] }> {
  const ports = [...new Set([portHint ?? currentPort, ...DEFAULT_PORTS])];
  const running = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
  if (running.length === 0) {
    throw new Error('Metro not found on ports ' + ports.join(', '));
  }
  // Prefer a running port that has at least one valid target; else first running.
  let chosen = running[0];
  let targets: HermesTarget[] = [];
  for (const p of running) {
    try {
      const valid = filterValidTargets(await fetchTargets(p, DISCOVERY_TIMEOUT_MS * 2));
      if (valid.length > 0) { chosen = p; targets = valid; break; }
    } catch { /* try next running port */ }
  }
  inferPlatforms(targets);
  return { port: chosen, targets };
}
```

Add a test in `discover-port-selection.test.js` for it:

```js
test('discoverForList: prefers a running port WITH targets over a detached one', async () => {
  const { discoverForList } = await import('../../dist/cdp/discovery.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/status')) return { text: async () => 'packager-status:running' };
    if (u.includes(':8082/json/list')) return { json: async () => [] };
    if (u.includes(':8081/json/list')) return {
      json: async () => [{
        id: 'page-1', title: 'RN', vm: 'Hermes', description: 'com.app',
        webSocketDebuggerUrl: 'ws://127.0.0.1:8081/inspector/debug?page=1',
      }],
    };
    return { json: async () => [], text: async () => '' };
  };
  try {
    const res = await discoverForList(8082);
    assert.equal(res.port, 8081);
    assert.equal(res.targets.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/discover-port-selection.test.js`
Expected: PASS (9 tests). Then run the discovery's existing tests to confirm no regression:
Run: `node --test test/unit/*discovery*.test.js 2>/dev/null; node --test test/unit/*discover*.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/cdp/discovery.ts scripts/cdp-bridge/test/unit/discover-port-selection.test.js
git commit -S -m "feat(#303): discover() picks the attached port, auto-selects by worktree cwd

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: `cdp_status` candidates + cwd-mismatch warning

**Files:**
- Modify: `scripts/cdp-bridge/src/types.ts` (extend `StatusResult.metro`)
- Modify: `scripts/cdp-bridge/src/cdp/discovery.ts` (add `enumerateMetroCandidates`)
- Modify: `scripts/cdp-bridge/src/tools/status.ts` (`buildStatusResult` + handler warning)
- Test: `scripts/cdp-bridge/test/unit/status-metro-mismatch.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/unit/status-metro-mismatch.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetroMismatch } from '../../dist/tools/status.js';

test('computeMetroMismatch: warns when servingCwd !== projectRoot', () => {
  const r = computeMetroMismatch({ servingCwd: '/repo/worktreeB', projectRoot: '/repo/worktreeA', port: 8082 });
  assert.equal(r.mismatch, true);
  assert.match(r.warning, /different worktree/i);
  assert.match(r.warning, /8082/);
});

test('computeMetroMismatch: silent when equal', () => {
  const r = computeMetroMismatch({ servingCwd: '/repo/worktreeA', projectRoot: '/repo/worktreeA', port: 8081 });
  assert.equal(r.mismatch, false);
  assert.equal(r.warning, undefined);
});

test('computeMetroMismatch: silent when serving cwd is an app subdir of the project root (monorepo)', () => {
  const r = computeMetroMismatch({ servingCwd: '/repo/worktreeA/app', projectRoot: '/repo/worktreeA', port: 8081 });
  assert.equal(r.mismatch, false);
});

test('computeMetroMismatch: silent when servingCwd unresolved (fail-open)', () => {
  const r = computeMetroMismatch({ servingCwd: null, projectRoot: '/repo/worktreeA', port: 8081 });
  assert.equal(r.mismatch, false);
});

test('computeMetroMismatch: silent when projectRoot unknown', () => {
  const r = computeMetroMismatch({ servingCwd: '/repo/worktreeA', projectRoot: undefined, port: 8081 });
  assert.equal(r.mismatch, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/status-metro-mismatch.test.js`
Expected: FAIL — `computeMetroMismatch` not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/types.ts`, add the candidate type and extend `StatusResult.metro` (add fields after `eventsReason`):

```ts
export interface MetroCandidate {
  port: number;
  attached: boolean;
  cwd: string | null;
  isConnected: boolean;
  matchesProjectRoot: boolean;
}
```

```ts
    // GH #303: worktree disambiguation diagnostics.
    candidates?: MetroCandidate[];
    projectRoot?: string;
    servingCwd?: string | null;
    timings_ms?: { probe: number; cwd: number };
```

In `src/cdp/discovery.ts`, add an enumeration helper for status (best-effort, reuses the probe + cwd):

```ts
export async function enumerateMetroCandidates(
  connectedPort: number,
  projectRoot: string | undefined,
): Promise<{ candidates?: MetroCandidate[]; servingCwd: string | null; timings_ms: { probe: number; cwd: number } }> {
  const t0 = performance.now();
  const ports = [...new Set([connectedPort, ...DEFAULT_PORTS])];
  const running = await discoverAllMetroPorts(ports, DISCOVERY_TIMEOUT_MS);
  const tProbe = performance.now();

  // Fast path (honors the spec's "single-Metro = one lsof"): only the connected
  // Metro is up → skip per-port fetchTargets + extra lsof; resolve just the
  // connected port's cwd for the mismatch check, and omit the candidates array.
  if (running.length <= 1) {
    const servingCwd = cwdForPort(connectedPort);
    return { servingCwd, timings_ms: { probe: tProbe - t0, cwd: performance.now() - tProbe } };
  }

  // Ambiguous: >1 Metro running — enumerate attach state + cwd per port.
  const candidates: MetroCandidate[] = [];
  let servingCwd: string | null = null;
  for (const p of running) {
    let attached = false;
    try {
      attached = filterValidTargets(await fetchTargets(p, DISCOVERY_TIMEOUT_MS)).length > 0;
    } catch { /* treat as detached */ }
    const cwd = cwdForPort(p);
    if (p === connectedPort) servingCwd = cwd;
    candidates.push({
      port: p,
      attached,
      cwd,
      isConnected: p === connectedPort,
      matchesProjectRoot: pathMatchesRoot(cwd, projectRoot),
    });
  }
  if (servingCwd === null) servingCwd = cwdForPort(connectedPort);
  return { candidates, servingCwd, timings_ms: { probe: tProbe - t0, cwd: performance.now() - tProbe } };
}
```

Add `import type { MetroCandidate } from '../types.js';` to `discovery.ts`. (`performance` is the Node global — no import needed.)

In `src/tools/status.ts`, add the pure helper and wire it. Add imports:

```ts
import { enumerateMetroCandidates } from '../cdp/discovery.js';
import { resolveBridgeProjectRoot, pathMatchesRoot } from '../cdp/metro-cwd.js';
```

Pure helper (exported for the unit test) — uses `pathMatchesRoot` so a monorepo app subdir / symlinked path is NOT flagged as a mismatch:

```ts
export function computeMetroMismatch(args: {
  servingCwd: string | null;
  projectRoot: string | undefined;
  port: number | null;
}): { mismatch: boolean; warning?: string } {
  const { servingCwd, projectRoot, port } = args;
  if (!servingCwd || !projectRoot || pathMatchesRoot(servingCwd, projectRoot)) return { mismatch: false };
  return {
    mismatch: true,
    warning:
      `Connected Metro on :${port} is serving ${servingCwd}, but this session's project root is ${projectRoot} ` +
      `— you may be verifying against a different worktree's bundle. Restart Metro in this worktree or pass metroPort.`,
  };
}
```

In `buildStatusResult`, after building the `metro` object, enrich it (best-effort) and return. Replace the `metro: { ... }` block's surroundings so that after `deviceSession` is computed you do:

```ts
  const projectRoot = resolveBridgeProjectRoot() ?? undefined;
  let candidates: import('../types.js').MetroCandidate[] | undefined;
  let servingCwd: string | null | undefined;
  let metroTimings: { probe: number; cwd: number } | undefined;
  try {
    const enriched = await enumerateMetroCandidates(client.metroPort, projectRoot);
    servingCwd = enriched.servingCwd;
    candidates = enriched.candidates; // already omitted by the fast path when ≤1 Metro
    metroTimings = enriched.timings_ms;
  } catch { /* fail-open: omit diagnostics */ }
```

and add to the returned `metro` object (the `timings_ms` makes the added `cdp_status` discovery cost visible per the repo convention):

```ts
      candidates,
      projectRoot,
      servingCwd,
      timings_ms: metroTimings,
```

In `createStatusHandler`, just before the final `return okResult(status, ...)` (after the `helpersInjected` block), insert the mismatch gate:

```ts
      const mismatch = computeMetroMismatch({
        servingCwd: status.metro.servingCwd ?? null,
        projectRoot: status.metro.projectRoot,
        port: status.metro.port,
      });
      if (mismatch.mismatch) {
        return warnResult(status, mismatch.warning!);
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/status-metro-mismatch.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/types.ts scripts/cdp-bridge/src/cdp/discovery.ts scripts/cdp-bridge/src/tools/status.ts scripts/cdp-bridge/test/unit/status-metro-mismatch.test.js
git commit -S -m "feat(#303): cdp_status surfaces Metro candidates + warns on worktree cwd mismatch

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Changeset, full suite, dist, device-verify

**Files:**
- Create: `.changeset/metro-port-selection.md`

- [ ] **Step 1: Write the changeset**

```markdown
---
"rn-dev-agent": patch
"cdp-bridge": patch
---

Fix #303: Metro-port discovery now prefers the port with an attached Hermes target
over a merely-running one, auto-selects the Metro whose serving directory matches
this worktree's project root, and cdp_status surfaces all candidate Metros plus a
warning when the connected bundle comes from a different worktree. Prevents silently
verifying against the wrong worktree's JS bundle. Fail-open (macOS lsof).
```

- [ ] **Step 2: Run the full unit suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — all existing tests plus the ~26 new ones green. If a snapshot/count test asserts a fixed tool count, it is unaffected (no tools added).

- [ ] **Step 3: Verify dist is rebuilt and committed**

Run: `cd /Users/anton_personal/GitHub/claude-react-native-dev-plugin && git status --short scripts/cdp-bridge/dist`
Expected: rebuilt `dist/cdp/metro-cwd.js`, `dist/cdp/discovery.js`, `dist/tools/status.js`, `dist/types.js` present. Stage them.

- [ ] **Step 4: Commit changeset + dist**

```bash
git add .changeset/metro-port-selection.md scripts/cdp-bridge/dist
git commit -S -m "chore(#303): changeset + rebuilt dist for Metro-port selection

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

- [ ] **Step 5: Device-verify (manual, dev machine)**

Two-worktree repro: start Metro in two worktrees (`:8081` app attached, `:8082` no app). Confirm:
1. `cdp_status` (no `metroPort`) connects to `:8081`, not `:8082`.
2. `metro.candidates` lists both with correct `attached`/`cwd`; the connected one has `isConnected: true`.
3. With the app on a *different*-worktree Metro than this session's root, `cdp_status` returns the cwd-mismatch warning.
4. With *all* Metros detached, `cdp_status` still returns `APP_DETACHED` and the iOS auto-relaunch path is unchanged.

---

## Self-Review

**1. Spec coverage:**
- Correctness (prefer attached) → Task 2 `selectMetroPort` + Task 3 `discover()`. ✓
- `AppDetachedError` only when no live Metro attached + lists running ports → Task 2/3. ✓
- cwd auto-pick by projectRoot → Task 1 (`metro-cwd`) + Task 2 (precedence). ✓
- preferredBundleId port-level tie-break → Task 2. ✓
- `cdp_status` candidates/projectRoot/servingCwd + mismatch warning → Task 4. ✓
- Fail-open everywhere → Task 1 (null returns), Task 4 (`try/catch` enrichment). ✓
- pid→cwd memoization, port→pid re-resolve → Task 1 test + impl. ✓
- Testing matrix → Tasks 1–4 tests; device-verify → Task 5. ✓
- `meta.timings_ms`: now IN SCOPE per plan review — `metro.timings_ms { probe, cwd }` is emitted from `enumerateMetroCandidates` and surfaced in the `cdp_status` result (Task 4). Makes the added discovery cost visible.
- `discoverForList`/`cdp_targets` consistency → Task 3 (prefer attached port, so it can't disagree with `discover()`). (Added in plan review F2.)
- projectRoot resolution via canonical `findProjectRoot()` + realpath + containment match → Task 1 (`resolveBridgeProjectRoot`/`pathMatchesRoot`). (Fixes plan review F1 — the headline feature would otherwise be dead/false-positive.)

**2. Placeholder scan:** No TBD/TODO; every code step has full code. ✓

**3. Type consistency:** `selectMetroPort(attached: AttachedPort[], runningPorts, ctx)` — same name/shape in Task 2 def and Task 3 call. `cwdForPort(port, exec?)` / `pathMatchesRoot` / `resolveBridgeProjectRoot` consistent across Tasks 1/2/3/4. `MetroCandidate` defined in types.ts (Task 4), imported in discovery.ts + used in status.ts. `computeMetroMismatch` signature identical in test (Task 4 Step 1) and impl (Step 3). `AppDetachedError(port, runningPorts?)` extended in Task 2, thrown in Task 2/3; `.port` is diagnostic-only (recover-detached relaunches by session, never reads it). ✓

---

## Amendments applied from the multi-LLM plan review (antigravity + codex, 2026-06-16)

Both reviewers ran against the plan + spec + the real source before any code. Findings applied:

- **F1 (BLOCKING — projectRoot was the wrong value).** The cwd auto-pick + mismatch warning compared `lsof`-realpath'd Metro cwd against `resolve(CLAUDE_USER_CWD ?? cwd)`, which (a) is not the bridge's canonical project root (that's `findProjectRoot()` — honors `RN_PROJECT_ROOT`, walks up to the RN `package.json`, sibling-scans) and (b) ignores symlinks (`lsof` returns realpaths like `/private/tmp/...`). The feature would have been dead/false-positive and the unit tests (hand-fed equal strings) wouldn't catch it. **Fix:** `resolveBridgeProjectRoot()` delegates to `findProjectRoot()` + `realpathSync`; new `pathMatchesRoot()` realpath-normalizes both sides and matches on equality OR path-separator-boundary containment (monorepo app subdir); siblings never match. Used in `selectMetroPort` step 1 and `computeMetroMismatch`.
- **F2 (IMPORTANT — `cdp_targets` left on the buggy path).** `discoverForList()` still used first-match `discoverMetroPort`, so `cdp_targets` could inspect a different Metro than the now-fixed `discover()`/`cdp_status`. **Fix:** Task 3 routes `discoverForList` through `discoverAllMetroPorts` + attached-preference (no cwd auto-pick needed).
- **F4 (IMPORTANT — hot-path double-probe).** `enumerateMetroCandidates` ran a full multi-port probe + per-port `fetchTargets`/`lsof` on every `cdp_status`, violating the spec's "single-Metro = one lsof." **Fix:** fast path returns just `cwdForPort(connectedPort)` (one lsof, no candidates) when ≤1 Metro is running; full enumeration only when >1.
- **meta.timings_ms (convention).** Promoted from deferred to in-scope: `metro.timings_ms { probe, cwd }` surfaced on the `cdp_status` result.
- **Verified clean by both:** lsof flags/parse correct; `cwdForPort` `exec===defaultExec` platform guard + memo test sound; test fetch stubs match `resp.json()`/`resp.text()`; `AppDetachedError`/`recover-detached` contract safe (no `.port` dependency); ports dedup + `RN_METRO_PORT` precedence preserved.
