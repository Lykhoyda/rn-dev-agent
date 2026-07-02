# Observe Autostart + Lifecycle Implementation Plan (PR 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The observability web UI autostarts when the MCP worker boots in an RN project, on a stable default port (7333), with `.rn-agent/config.json` opt-out, env overrides, a new `restart` action, and a per-project state file recording the live URL.

**Architecture:** All logic lives in `scripts/cdp-bridge`. New config resolvers in `project-config.ts` follow the existing `resolveAutoConnect` precedence pattern (env > config > default). The observe tool keeps its module-global server; a small DI-testable `autostartObserve()` is called from `index.ts` `main()`. The supervisor process stays socket-free (documented invariant) — only the worker listens.

**Tech Stack:** TypeScript (ESM, `tsc` build), `node:test` + `node:assert/strict` tests running against compiled `dist/` output, changesets for versioning.

**Source spec:** `docs/superpowers/specs/2026-07-02-observe-ui-autostart-design.md`

## Global Constraints

- Node >= 22; no new runtime dependencies.
- Tests are `node:test` files in `scripts/cdp-bridge/test/unit/*.test.js`, importing from `../../dist/...` (compiled output). `npm test` runs `tsc` first.
- All commands below run from `scripts/cdp-bridge/` unless stated otherwise.
- Default observe port: **7333**. Env vars: `RN_AGENT_OBSERVE_AUTOSTART` (autostart on/off), `RN_AGENT_OBSERVE_PORT` (port pin, already exists).
- Config file: `.rn-agent/config.json` → `{ "observe": { "autoStart": boolean, "port": number } }`.
- Autostart failure must NEVER break MCP boot (warn once, continue).
- Do not touch `src/supervisor.ts` — it must keep zero network sockets.
- In tool-level tests, always pin a unique `RN_AGENT_OBSERVE_PORT` per test file (or unset it and accept any port) — never assert on the literal default 7333 in a test that binds a socket, because parallel test files could collide and trigger the ephemeral fallback.
- Repo-root gates before finishing: `npx oxlint` and `npx oxfmt --check` (root `package.json` has `lint`/`format:check` scripts).

---

### Task 1: Config resolvers in `project-config.ts`

**Files:**
- Modify: `scripts/cdp-bridge/src/project-config.ts` (append after `resolveAutoConnect`, line 140)
- Test: `scripts/cdp-bridge/test/unit/observe-config.test.js` (create)

**Interfaces:**
- Consumes: existing `readRnAgentConfig`, `RnAgentConfig` from `project-config.ts`.
- Produces (used by Tasks 2 and 4):
  - `parsePort(raw: string | undefined): number | undefined`
  - `DEFAULT_OBSERVE_PORT = 7333`
  - `resolveObserveAutostart(deps?: { env?: string; readConfig?: () => RnAgentConfig | null }): { enabled: boolean; source: 'env' | 'config' | 'default' }`
  - `resolveObservePort(deps?: { env?: string; readConfig?: () => RnAgentConfig | null }): { port: number; source: 'env' | 'config' | 'default' }`
  - `RnAgentConfig` gains `observe?: { autoStart?: boolean; port?: number }`

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/observe-config.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePort,
  DEFAULT_OBSERVE_PORT,
  resolveObserveAutostart,
  resolveObservePort,
} from '../../dist/project-config.js';

// Spec 2026-07-02-observe-ui-autostart-design: precedence is
// env > .rn-agent/config.json observe block > default. Config errors fail open.

test('parsePort accepts a valid port and rejects junk / NaN / out-of-range', () => {
  assert.equal(parsePort('51234'), 51234);
  assert.equal(parsePort(undefined), undefined);
  assert.equal(parsePort(''), undefined);
  assert.equal(parsePort('abc'), undefined);
  assert.equal(parsePort('0'), undefined);
  assert.equal(parsePort('70000'), undefined, 'out of range');
});

test('resolveObserveAutostart: env "0"/"false" wins over config true', () => {
  const readConfig = () => ({ observe: { autoStart: true } });
  assert.deepEqual(resolveObserveAutostart({ env: '0', readConfig }), {
    enabled: false,
    source: 'env',
  });
  assert.deepEqual(resolveObserveAutostart({ env: 'false', readConfig }), {
    enabled: false,
    source: 'env',
  });
});

test('resolveObserveAutostart: env "1"/"true" forces on over config false', () => {
  const readConfig = () => ({ observe: { autoStart: false } });
  assert.deepEqual(resolveObserveAutostart({ env: '1', readConfig }), {
    enabled: true,
    source: 'env',
  });
  assert.deepEqual(resolveObserveAutostart({ env: 'true', readConfig }), {
    enabled: true,
    source: 'env',
  });
});

test('resolveObserveAutostart: unset env falls through to config', () => {
  const r = resolveObserveAutostart({
    env: undefined,
    readConfig: () => ({ observe: { autoStart: false } }),
  });
  assert.deepEqual(r, { enabled: false, source: 'config' });
});

test('resolveObserveAutostart: no config / non-boolean value → default true', () => {
  assert.deepEqual(resolveObserveAutostart({ env: undefined, readConfig: () => null }), {
    enabled: true,
    source: 'default',
  });
  assert.deepEqual(
    resolveObserveAutostart({
      env: undefined,
      readConfig: () => ({ observe: { autoStart: 'nope' } }),
    }),
    { enabled: true, source: 'default' },
  );
});

test('resolveObservePort: valid env wins over config', () => {
  const r = resolveObservePort({
    env: '51888',
    readConfig: () => ({ observe: { port: 51999 } }),
  });
  assert.deepEqual(r, { port: 51888, source: 'env' });
});

test('resolveObservePort: invalid env falls through to config', () => {
  const r = resolveObservePort({
    env: 'abc',
    readConfig: () => ({ observe: { port: 51999 } }),
  });
  assert.deepEqual(r, { port: 51999, source: 'config' });
});

test('resolveObservePort: invalid config port falls through to default', () => {
  assert.deepEqual(
    resolveObservePort({ env: undefined, readConfig: () => ({ observe: { port: 0 } }) }),
    { port: DEFAULT_OBSERVE_PORT, source: 'default' },
  );
  assert.deepEqual(
    resolveObservePort({ env: undefined, readConfig: () => ({ observe: { port: 99999 } }) }),
    { port: DEFAULT_OBSERVE_PORT, source: 'default' },
  );
  assert.deepEqual(
    resolveObservePort({ env: undefined, readConfig: () => ({ observe: { port: 7.5 } }) }),
    { port: DEFAULT_OBSERVE_PORT, source: 'default' },
  );
});

test('resolveObservePort: no env, no config → default 7333', () => {
  assert.deepEqual(resolveObservePort({ env: undefined, readConfig: () => null }), {
    port: 7333,
    source: 'default',
  });
  assert.equal(DEFAULT_OBSERVE_PORT, 7333);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/observe-config.test.js`
Expected: FAIL — `parsePort`, `DEFAULT_OBSERVE_PORT`, `resolveObserveAutostart`, `resolveObservePort` are not exported from `dist/project-config.js` (SyntaxError on the named import).

- [ ] **Step 3: Write the implementation**

In `scripts/cdp-bridge/src/project-config.ts`:

(a) Extend the existing `RnAgentConfig` interface (currently `{ cdp?: { autoConnect?: boolean } }`):

```ts
export interface RnAgentConfig {
  cdp?: { autoConnect?: boolean };
  observe?: { autoStart?: boolean; port?: number };
}
```

(b) Append at the end of the file:

```ts
/**
 * Spec 2026-07-02 (observe autostart): shared port validation. Also re-exported
 * from tools/observe.ts as `parsePinnedPort` for backward compatibility.
 */
export function parsePort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}

export const DEFAULT_OBSERVE_PORT = 7333;

export interface ObserveAutostartResolution {
  enabled: boolean;
  source: 'env' | 'config' | 'default';
}

export function resolveObserveAutostart(
  deps: {
    env?: string;
    readConfig?: () => RnAgentConfig | null;
  } = {},
): ObserveAutostartResolution {
  // Present-but-undefined `env` means "treat as unset, do NOT fall back to
  // process.env" (test seam) — same contract as resolveAutoConnect.
  const envRaw = 'env' in deps ? deps.env : process.env.RN_AGENT_OBSERVE_AUTOSTART;
  if (envRaw === '0' || envRaw === 'false') return { enabled: false, source: 'env' };
  if (envRaw === '1' || envRaw === 'true') return { enabled: true, source: 'env' };
  const cfg = (deps.readConfig ?? readRnAgentConfig)();
  if (typeof cfg?.observe?.autoStart === 'boolean') {
    return { enabled: cfg.observe.autoStart, source: 'config' };
  }
  return { enabled: true, source: 'default' };
}

export interface ObservePortResolution {
  port: number;
  source: 'env' | 'config' | 'default';
}

export function resolveObservePort(
  deps: {
    env?: string;
    readConfig?: () => RnAgentConfig | null;
  } = {},
): ObservePortResolution {
  const envRaw = 'env' in deps ? deps.env : process.env.RN_AGENT_OBSERVE_PORT;
  const envPort = parsePort(envRaw);
  if (envPort !== undefined) return { port: envPort, source: 'env' };
  const cfg = (deps.readConfig ?? readRnAgentConfig)();
  const cfgPort = cfg?.observe?.port;
  if (typeof cfgPort === 'number' && Number.isInteger(cfgPort) && cfgPort > 0 && cfgPort <= 65535) {
    return { port: cfgPort, source: 'config' };
  }
  return { port: DEFAULT_OBSERVE_PORT, source: 'default' };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/observe-config.test.js`
Expected: PASS (all 8 tests).

- [ ] **Step 5: Run the full unit suite to check for regressions**

Run: `npm test`
Expected: PASS — in particular `auto-connect-config.test.js` and `project-config.test.js` still green.

- [ ] **Step 6: Commit**

```bash
git add src/project-config.ts test/unit/observe-config.test.js
git commit -m "feat(observe): config resolvers for autostart + port (env > .rn-agent/config.json > default 7333)"
```

---

### Task 2: `restart` action + resolved port in the observe tool

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/observe.ts` (full file replacement below)
- Test: `scripts/cdp-bridge/test/unit/observe-restart-action.test.js` (create)

**Interfaces:**
- Consumes: `resolveObservePort`, `parsePort` from Task 1; existing `ObservabilityServer`, `recorder`.
- Produces (used by Tasks 3 and 4):
  - `observeSchema.action` now `enum(['start', 'stop', 'restart', 'status'])`
  - `startObserveServer(): Promise<{ url: string; port: number }>` (exported — autostart entry point)
  - `parsePinnedPort` re-exported (existing test `observability-observe-tool.test.js` imports it)

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/observe-restart-action.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeHandler, startObserveServer } from '../../dist/tools/observe.js';
import { recorder } from '../../dist/observability/recorder.js';

// Pin a unique port for this file so parallel test files can't collide on the
// default 7333 (which would flake via the EADDRINUSE ephemeral fallback).
process.env.RN_AGENT_OBSERVE_PORT = '51733';

function parse(res) {
  return JSON.parse(res.content[0].text);
}

test('restart on a running server keeps the recorder timeline and serves again', async () => {
  recorder.record({ tool: 'device_press', params: { testID: 'x' }, status: 'PASS', latencyMs: 5 });
  const before = recorder.snapshot().length;
  assert.ok(before >= 1, 'recorder has at least the seeded event');

  const start = parse(await observeHandler({ action: 'start' }));
  assert.equal(start.ok, true);
  assert.equal(start.data.port, 51733);

  const restart = parse(await observeHandler({ action: 'restart' }));
  assert.equal(restart.ok, true);
  assert.equal(restart.data.running, true);
  assert.match(restart.data.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // The module-global recorder survives the HTTP server restart.
  assert.equal(recorder.snapshot().length, before);

  // The restarted server actually serves.
  const status = parse(await observeHandler({ action: 'status' }));
  assert.equal(status.data.running, true);

  await observeHandler({ action: 'stop' });
});

test('restart when nothing is running starts fresh', async () => {
  const restart = parse(await observeHandler({ action: 'restart' }));
  assert.equal(restart.ok, true);
  assert.equal(restart.data.running, true);
  await observeHandler({ action: 'stop' });
});

test('startObserveServer is idempotent and returns the same port', async () => {
  const a = await startObserveServer();
  const b = await startObserveServer();
  assert.equal(a.port, b.port);
  await observeHandler({ action: 'stop' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/observe-restart-action.test.js`
Expected: FAIL — `startObserveServer` is not exported / `restart` is rejected by the zod enum.

- [ ] **Step 3: Replace `src/tools/observe.ts` with**

```ts
import { z } from 'zod';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { ObservabilityServer } from '../observability/server.js';
import type { E2eServerDeps } from '../observability/server.js';
import { recorder } from '../observability/recorder.js';
import { resolveObservePort } from '../project-config.js';

// Back-compat alias: parsePinnedPort predates the shared resolver (spec
// 2026-07-02); the validation now lives in project-config.parsePort.
export { parsePort as parsePinnedPort } from '../project-config.js';

export const observeSchema = {
  action: z
    .enum(['start', 'stop', 'restart', 'status'])
    .default('status')
    .describe(
      'start = launch the web UI and return its URL; stop = tear it down for the rest of the session; restart = stop then start fresh (keeps the event timeline); status = report whether it is running',
    ),
};

export interface ObserveArgs {
  action?: 'start' | 'stop' | 'restart' | 'status';
}

let server: ObservabilityServer | null = null;
let e2eDeps: E2eServerDeps | undefined;

export function setObserveE2eDeps(d: E2eServerDeps): void {
  e2eDeps = d;
}

/**
 * Start (or return) the module-global observability server on the resolved
 * port (env RN_AGENT_OBSERVE_PORT > .rn-agent/config.json observe.port > 7333).
 * Exported as the autostart entry point so `observe status/stop` sees the
 * autostarted instance.
 */
export async function startObserveServer(): Promise<{ url: string; port: number }> {
  if (!server) server = new ObservabilityServer(recorder, e2eDeps);
  const { port } = resolveObservePort();
  return server.start(port);
}

async function stopObserveServer(): Promise<void> {
  await server?.stop();
  server = null;
}

export async function observeHandler(args: ObserveArgs): Promise<ToolResult> {
  const action = args.action ?? 'status';
  try {
    if (action === 'start' || action === 'restart') {
      if (action === 'restart') await stopObserveServer();
      const { url, port } = await startObserveServer();
      return okResult({ url, port, running: true, hint: `Open ${url} to watch the agent live.` });
    }
    if (action === 'stop') {
      await stopObserveServer();
      return okResult({ running: false });
    }
    if (server) {
      const { url, port } = await server.start();
      return okResult({ running: true, url, port });
    }
    return okResult({ running: false });
  } catch (e) {
    return failResult(e instanceof Error ? e.message : String(e));
  }
}
```

Note what changed vs. the old file: `parsePinnedPort` became a re-export; the schema gained `restart`; `start` logic moved into exported `startObserveServer()` and now resolves the port from config (not just env); `restart` = stop + start.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/observe-restart-action.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the existing observe-tool test for regressions**

Run: `node --test test/unit/observability-observe-tool.test.js`
Expected: PASS — `parsePinnedPort` re-export keeps its contract; start/status/stop behavior unchanged. (No rebuild needed — Step 4 built.)

- [ ] **Step 6: Commit**

```bash
git add src/tools/observe.ts test/unit/observe-restart-action.test.js
git commit -m "feat(observe): restart action + config-resolved port in observe tool"
```

---

### Task 3: Per-project state file (`observe-state.ts`)

**Files:**
- Create: `scripts/cdp-bridge/src/observability/observe-state.ts`
- Modify: `scripts/cdp-bridge/src/tools/observe.ts` (wire write/remove into start/stop)
- Test: `scripts/cdp-bridge/test/unit/observe-state-file.test.js` (create)

**Interfaces:**
- Consumes: `getStateDir`, `writeJsonStateFileAtomic`, `readJsonStateFile`, `deleteStateFile` from `src/util/secure-state-file.ts`; `findProjectRoot` from `src/nav-graph/storage.ts`.
- Produces (used by Task 4's exit hook):
  - `observeStatePath(projectRoot: string): string`
  - `writeObserveState(url: string, port: number, projectRoot?: string | null, now?: () => Date): void`
  - `removeObserveState(projectRoot?: string | null): void`
  - `interface ObserveState { url: string; port: number; pid: number; projectRoot: string; startedAt: string }`

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/observe-state-file.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

// Redirect the state dir BEFORE importing the module under test —
// getStateDir() reads XDG_STATE_HOME at call time, but keeping the env set
// for the whole file is the simplest correct setup.
const stateHome = mkdtempSync(join(tmpdir(), 'rn-observe-state-'));
process.env.XDG_STATE_HOME = stateHome;

const { observeStatePath, writeObserveState, removeObserveState } = await import(
  '../../dist/observability/observe-state.js'
);

const fakeRoot = '/Users/someone/projects/my app';

test('writeObserveState writes an atomic per-project state file', () => {
  writeObserveState('http://127.0.0.1:7333', 7333, fakeRoot, () => new Date('2026-07-02T10:00:00Z'));
  const p = observeStatePath(fakeRoot);
  assert.ok(p.startsWith(join(stateHome, 'rn-dev-agent', 'observe')), p);
  assert.ok(existsSync(p));
  const state = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(state, {
    url: 'http://127.0.0.1:7333',
    port: 7333,
    pid: process.pid,
    projectRoot: fakeRoot,
    startedAt: '2026-07-02T10:00:00.000Z',
  });
});

test('project roots with unsafe characters are sanitized in the filename', () => {
  const p = observeStatePath('/a/b?c:d e');
  const base = p.split('/').pop();
  assert.match(base, /^[A-Za-z0-9._-]+\.json$/);
});

test('removeObserveState deletes only a file owned by this pid', () => {
  const p = observeStatePath(fakeRoot);
  // Owned by us (written in the first test) → deleted.
  removeObserveState(fakeRoot);
  assert.ok(!existsSync(p));

  // Owned by another live session → left alone.
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    JSON.stringify({ url: 'x', port: 1, pid: process.pid + 1, projectRoot: fakeRoot, startedAt: 'x' }),
  );
  removeObserveState(fakeRoot);
  assert.ok(existsSync(p), 'foreign-pid state file must not be deleted');
});

test('null project root is a silent no-op', () => {
  writeObserveState('http://127.0.0.1:7333', 7333, null);
  removeObserveState(null);
});

test('cleanup', () => {
  rmSync(stateHome, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/observe-state-file.test.js`
Expected: FAIL — `dist/observability/observe-state.js` does not exist (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Create `src/observability/observe-state.ts`**

```ts
import { join } from 'node:path';
import {
  getStateDir,
  writeJsonStateFileAtomic,
  readJsonStateFile,
  deleteStateFile,
} from '../util/secure-state-file.js';
import { findProjectRoot } from '../nav-graph/storage.js';

/**
 * Spec 2026-07-02 (observe autostart): best-effort discovery aid. The MCP
 * worker records where the observe UI is listening so out-of-band consumers
 * (SessionStart hook, doctor, humans) can find the live URL without calling
 * the tool. Uses the GH #383 hardened state-file helpers (atomic writes,
 * symlink-refusing reads, per-user app-support dir). Every function here is
 * fail-safe: state-file problems must never affect the observe server itself.
 */
export interface ObserveState {
  url: string;
  port: number;
  pid: number;
  projectRoot: string;
  startedAt: string;
}

export function observeStatePath(projectRoot: string): string {
  const safe = projectRoot.replace(/[^A-Za-z0-9._-]/g, '_');
  return join(getStateDir(), 'observe', `${safe}.json`);
}

export function writeObserveState(
  url: string,
  port: number,
  projectRoot: string | null = findProjectRoot(),
  now: () => Date = () => new Date(),
): void {
  try {
    if (!projectRoot) return;
    const state: ObserveState = {
      url,
      port,
      pid: process.pid,
      projectRoot,
      startedAt: now().toISOString(),
    };
    writeJsonStateFileAtomic(observeStatePath(projectRoot), state);
  } catch {
    /* best-effort — never fail the caller */
  }
}

export function removeObserveState(projectRoot: string | null = findProjectRoot()): void {
  try {
    if (!projectRoot) return;
    const p = observeStatePath(projectRoot);
    const existing = readJsonStateFile<ObserveState>(p);
    // A different pid means another live session overwrote the file after we
    // started (port-collision fallback scenario) — their record, not ours.
    if (existing && existing.pid !== process.pid) return;
    deleteStateFile(p);
  } catch {
    /* best-effort */
  }
}
```

- [ ] **Step 4: Wire into the observe tool**

In `src/tools/observe.ts`, add the import:

```ts
import { writeObserveState, removeObserveState } from '../observability/observe-state.js';
```

Change `startObserveServer` to record the state after a successful listen:

```ts
export async function startObserveServer(): Promise<{ url: string; port: number }> {
  if (!server) server = new ObservabilityServer(recorder, e2eDeps);
  const { port } = resolveObservePort();
  const res = await server.start(port);
  writeObserveState(res.url, res.port);
  return res;
}
```

Change `stopObserveServer` to clean up:

```ts
async function stopObserveServer(): Promise<void> {
  await server?.stop();
  server = null;
  removeObserveState();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && node --test test/unit/observe-state-file.test.js test/unit/observe-restart-action.test.js test/unit/observability-observe-tool.test.js`
Expected: PASS. (The tool tests run outside a project root, so `findProjectRoot()` returns null and state writes are silent no-ops — exactly the fail-safe contract.)

- [ ] **Step 6: Commit**

```bash
git add src/observability/observe-state.ts src/tools/observe.ts test/unit/observe-state-file.test.js
git commit -m "feat(observe): per-project state file records the live UI url (GH #383 state-file pattern)"
```

---

### Task 4: Autostart module + `index.ts` wiring

**Files:**
- Create: `scripts/cdp-bridge/src/observability/autostart.ts`
- Modify: `scripts/cdp-bridge/src/index.ts` (two small additions, exact locations below)
- Test: `scripts/cdp-bridge/test/unit/observe-autostart.test.js` (create)

**Interfaces:**
- Consumes: `resolveObserveAutostart` (Task 1), `startObserveServer` (Task 2), `removeObserveState` (Task 3), existing `findProjectRoot`, `logger`.
- Produces: `autostartObserve(deps: AutostartDeps): Promise<{ url: string } | null>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/observe-autostart.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autostartObserve } from '../../dist/observability/autostart.js';

function deps(overrides = {}) {
  const calls = { start: 0, warn: [], info: [] };
  const d = {
    findRoot: () => '/some/project',
    resolveEnabled: () => ({ enabled: true, source: 'default' }),
    start: async () => {
      calls.start++;
      return { url: 'http://127.0.0.1:7333', port: 7333 };
    },
    warn: (m) => calls.warn.push(m),
    info: (m) => calls.info.push(m),
    ...overrides,
  };
  return { d, calls };
}

test('starts and reports the url when a project root exists and autostart is enabled', async () => {
  const { d, calls } = deps();
  const res = await autostartObserve(d);
  assert.deepEqual(res, { url: 'http://127.0.0.1:7333' });
  assert.equal(calls.start, 1);
  assert.equal(calls.warn.length, 0);
  assert.match(calls.info.join('\n'), /http:\/\/127\.0\.0\.1:7333/);
});

test('no project root → never starts', async () => {
  const { d, calls } = deps({ findRoot: () => null });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
});

test('disabled via env/config → never starts, logs the source', async () => {
  const { d, calls } = deps({ resolveEnabled: () => ({ enabled: false, source: 'config' }) });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.start, 0);
  assert.match(calls.info.join('\n'), /disabled \(config\)/);
});

test('start failure warns and returns null — never throws', async () => {
  const { d, calls } = deps({
    start: async () => {
      throw new Error('EACCES: boom');
    },
  });
  assert.equal(await autostartObserve(d), null);
  assert.equal(calls.warn.length, 1);
  assert.match(calls.warn[0], /EACCES: boom/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && node --test test/unit/observe-autostart.test.js`
Expected: FAIL — `dist/observability/autostart.js` does not exist.

- [ ] **Step 3: Create `src/observability/autostart.ts`**

```ts
/**
 * Spec 2026-07-02: autostart the observe web UI at MCP worker boot — but only
 * inside a detected RN project, only when enabled (env > config > default on),
 * and NEVER fatally: an autostart failure is a warning, not a boot error.
 * Dependency-injected so the gating logic is unit-testable without sockets.
 */
export interface AutostartDeps {
  findRoot: () => string | null;
  resolveEnabled: () => { enabled: boolean; source: 'env' | 'config' | 'default' };
  start: () => Promise<{ url: string; port: number }>;
  warn: (msg: string) => void;
  info: (msg: string) => void;
}

export async function autostartObserve(deps: AutostartDeps): Promise<{ url: string } | null> {
  try {
    if (!deps.findRoot()) return null;
    const res = deps.resolveEnabled();
    if (!res.enabled) {
      deps.info(`observe UI autostart disabled (${res.source})`);
      return null;
    }
    const { url } = await deps.start();
    deps.info(`observe UI autostarted: ${url}`);
    return { url };
  } catch (e) {
    deps.warn(`observe UI autostart failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && node --test test/unit/observe-autostart.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `src/index.ts`**

(a) Add imports next to the existing observe import (`import { observeHandler, observeSchema, setObserveE2eDeps } from './tools/observe.js';`, around line 118):

```ts
import { observeHandler, observeSchema, setObserveE2eDeps, startObserveServer } from './tools/observe.js';
import { autostartObserve } from './observability/autostart.js';
import { removeObserveState } from './observability/observe-state.js';
```

and add `resolveObserveAutostart` to the existing `./project-config.js` import in the same file.

(b) In `main()`, after the `recoverInterruptedRequests` block (the `{ const root = findProjectRoot(); ... }` block at the end of `main()`), append:

```ts
  await autostartObserve({
    findRoot: findProjectRoot,
    resolveEnabled: resolveObserveAutostart,
    start: startObserveServer,
    warn: (m) => logger.warn('OBSERVE', m),
    info: (m) => logger.info('OBSERVE', m),
  });
```

(c) Next to the existing `process.on('exit', () => stopParentWatch());` (around line 2410), add:

```ts
process.on('exit', () => removeObserveState());
```

(All exit paths — graceful shutdown, uncaught exception, parent death — funnel through `process.exit`, so this reliably clears our own state file; the pid guard in `removeObserveState` protects a newer session's file.)

- [ ] **Step 6: Build + full unit suite**

Run: `npm test`
Expected: PASS. `tsc` catching a typo in the `index.ts` wiring counts as this step's real gate — there is no unit test for `main()` itself (it owns a stdio transport); live verification happens in Task 6.

- [ ] **Step 7: Commit**

```bash
git add src/observability/autostart.ts src/index.ts test/unit/observe-autostart.test.js
git commit -m "feat(observe): autostart web UI at MCP boot in RN projects (non-fatal, env/config gated)"
```

---

### Task 5: SessionStart hook notice + `/observe` command rewrite

**Files:**
- Modify: `hooks/detect-rn-project.sh` (append inside the `has_rn_config` block, after the final `EOF` heredoc at line ~142)
- Modify: `commands/observe.md` (full replacement)

**Interfaces:**
- Consumes: the same env/config precedence as Task 1 — the shell snippet mirrors `resolveObserveAutostart` + `resolveObservePort` semantics (it cannot import them; keep the constants in sync: default on, default port 7333).
- Produces: one line of SessionStart context, e.g. `Observe UI: http://127.0.0.1:7333 — /rn-dev-agent:observe to stop/restart`.

- [ ] **Step 1: Append the notice to `hooks/detect-rn-project.sh`**

Insert after the closing `EOF` of the banner heredoc (still inside `if [ "$has_rn_config" = true ]; then ... fi`):

```bash
  # Observe UI autostart notice (spec 2026-07-02). The MCP worker autostarts
  # the observability web UI unless disabled via env/config; print the expected
  # URL so the user can open it without running /observe. Mirrors the
  # resolveObserveAutostart/resolveObservePort precedence (env > config >
  # default on, port 7333). Best-effort: any failure prints nothing.
  OBSERVE_LINE=$(node -e '
    let cfg = {};
    try { cfg = JSON.parse(require("fs").readFileSync(".rn-agent/config.json", "utf8")); } catch {}
    const o = cfg.observe || {};
    const autoEnv = process.env.RN_AGENT_OBSERVE_AUTOSTART;
    const auto = autoEnv === "0" || autoEnv === "false" ? false
      : autoEnv === "1" || autoEnv === "true" ? true
      : typeof o.autoStart === "boolean" ? o.autoStart : true;
    if (!auto) process.exit(0);
    const pe = Number.parseInt(process.env.RN_AGENT_OBSERVE_PORT ?? "", 10);
    const port = Number.isInteger(pe) && pe > 0 && pe <= 65535 ? pe
      : Number.isInteger(o.port) && o.port > 0 && o.port <= 65535 ? o.port : 7333;
    console.log("Observe UI: http://127.0.0.1:" + port + " — /rn-dev-agent:observe to stop/restart (disable autostart via .rn-agent/config.json observe.autoStart=false)");
  ' 2>/dev/null || true)
  if [ -n "$OBSERVE_LINE" ]; then
    echo ""
    echo "$OBSERVE_LINE"
  fi
```

- [ ] **Step 2: Verify the hook**

Syntax check: `bash -n hooks/detect-rn-project.sh` → no output.

Behavior check of the snippet in isolation (run from repo root):

```bash
cd "$(mktemp -d)"
# default: prints the 7333 URL
node -e '<paste the node -e body from Step 1>'
# config disable: prints nothing
mkdir -p .rn-agent && echo '{"observe":{"autoStart":false}}' > .rn-agent/config.json
node -e '<same body>'
# config port override
echo '{"observe":{"port":7440}}' > .rn-agent/config.json
node -e '<same body>'
# env beats config
RN_AGENT_OBSERVE_AUTOSTART=0 node -e '<same body>'
```

Expected: URL with 7333 / empty / URL with 7440 / empty.

- [ ] **Step 3: Replace `commands/observe.md` with**

```markdown
---
command: observe
description: Show the observability web UI URL (it autostarts with the session); stop or restart it.
---

The observe web UI autostarts when the session begins in an RN project. Permanent opt-out:
`.rn-agent/config.json` → `{ "observe": { "autoStart": false } }` (port via `observe.port`,
default 7333; env `RN_AGENT_OBSERVE_AUTOSTART` / `RN_AGENT_OBSERVE_PORT` override config).

- Default (`/observe` with no argument): call the `observe` MCP tool with `action: "status"`.
  If running, print the returned `url` prominently and tell the user to open it in a browser
  to watch the live tool-call timeline, device screenshot, and app state. If NOT running
  (autostart disabled or previously stopped), call `action: "start"` — an explicit /observe
  is an explicit request to see the UI — and print the URL.
- `/observe stop`: call with `action: "stop"`. The UI stays down for the rest of the session;
  mention the config opt-out if the user wants it permanent.
- `/observe restart`: call with `action: "restart"` and print the (possibly new) URL. The
  event timeline is preserved across restarts.
```

- [ ] **Step 4: Commit**

```bash
git add hooks/detect-rn-project.sh commands/observe.md
git commit -m "feat(observe): SessionStart URL notice + /observe command covers stop/restart and autostart opt-out"
```

---

### Task 6: Gates, changeset, live verification

**Files:**
- Create: `.changeset/observe-autostart-lifecycle.md`

- [ ] **Step 1: Full test suite + repo gates**

```bash
cd scripts/cdp-bridge && npm test
cd ../.. && npx oxlint && npx oxfmt --check
```

Expected: all pass. Fix any lint/format findings in the new files (run `npx oxfmt` to autoformat).

- [ ] **Step 2: Create the changeset**

Create `.changeset/observe-autostart-lifecycle.md`:

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

The observe web UI now autostarts when the MCP worker boots in an RN project, listening on a
stable default port (7333, `http://127.0.0.1:7333`) with an ephemeral fallback on collision.
New `.rn-agent/config.json` block `{ "observe": { "autoStart": boolean, "port": number } }`
plus `RN_AGENT_OBSERVE_AUTOSTART` env override (precedence env > config > default, matching
`cdp.autoConnect`). The `observe` tool gains a `restart` action; `stop` is session-scoped.
The live URL is recorded in a per-project state file and announced at SessionStart.
```

- [ ] **Step 3: Live verification (verify skill applies — drive the real flow)**

In a real RN project with the locally-built plugin active:

1. Start a fresh Claude Code session → SessionStart context shows `Observe UI: http://127.0.0.1:7333 …`.
2. Open the URL → UI loads, events stream.
3. `observe` tool `action: "restart"` → URL still works, previous timeline events still visible.
4. `action: "stop"` → port closed (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7333` fails to connect).
5. `.rn-agent/config.json` with `{"observe":{"autoStart":false}}` → new session does NOT listen on 7333 and the SessionStart notice is absent.
6. Check the state file: `cat "$HOME/Library/Application Support/rn-dev-agent/observe/"*.json` shows url/port/pid while running (macOS path; XDG path on Linux).

- [ ] **Step 4: Commit**

```bash
git add .changeset/observe-autostart-lifecycle.md
git commit -m "chore: changeset for observe autostart + lifecycle"
```
