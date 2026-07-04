# #432 Packaged-Artifact Smoke Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CI validates the artifact users actually run — committed `dist/`, production-only lockfile-pinned install, `supervisor.js` stdio spawn, MCP handshake, tool registry, observe SPA — so staleness/registration/packaging regressions go red before release.

**Architecture:** Three independent pieces gated in the existing CI `test` job: (1) `scripts/check-dist-fresh.sh` clean-rebuilds `dist/` and requires an empty `git status --porcelain`; (2) `test/integration/packaged-artifact-smoke.test.js` replicates the exact user install in a temp dir and drives the real supervisor over line-delimited JSON-RPC; (3) a committed golden `test/fixtures/tool-registry.json` (78 names) with a deliberate regeneration script. The gh-264 supervisor harness is extracted to a shared helper.

**Tech Stack:** `node:test` + `node:assert/strict` (NO vitest/jest in this repo), bash guard tests in `scripts/test/*.test.sh` house style, ESM (`"type": "module"`), Node >= 22.

**Spec:** `docs/superpowers/specs/2026-07-03-packaged-artifact-smoke-gate-design.md` · **Issue:** [#432](https://github.com/Lykhoyda/rn-dev-agent/issues/432)

## Global Constraints

- Repo root: all paths below are relative to the repo root (the `rn-dev-agent` checkout).
- ESM everywhere; JS test files use `node:test`; no new dependencies may be added.
- The user install is **byte-for-byte** what `scripts/ensure-cdp-deps.sh:24-27` does: copy `package.json` AND (when present) the committed `scripts/cdp-bridge/package-lock.json`, then `npm install --production --ignore-scripts` (plus `--no-audit --no-fund` for output hygiene). Do NOT "modernize" `--production` to `--omit=dev`, and do NOT omit the lockfile — users get a lockfile-pinned prod tree (Codex plan review 2026-07-04).
- The committed `scripts/cdp-bridge/package-lock.json` is stale (its `version` field says 0.38.23 vs package.json 0.53.0). Do NOT refresh it in this PR — that changes what users install and is out of scope; it is a filed follow-up.
- The golden has **78** tool names (verified live 2026-07-04: `tools/list` on the packaged server returns 78; the 79th `trackedTool(` grep hit in `src/index.ts` is the function definition).
- NO changeset: nothing under `scripts/cdp-bridge/src/` changes (require-changeset WATCHED set untouched).
- Lint/format must pass at repo root: `npm run lint` (oxlint) and `npm run format:check` (oxfmt).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Verified live baseline (2026-07-04 probe): install ~3s/95 pkgs; `initialize` → `serverInfo.name === 'rn-dev-agent-cdp-bridge'`; `observe start` → `{ok:true,data:{url:'http://127.0.0.1:<port>',port,running:true,hint}}`; `GET /` → 200, body contains `__E2E_CSRF__`, ~222 KB; SIGTERM → exit 0.

---

### Task 1: Extract the supervisor JSON-RPC harness into a shared helper

**Files:**
- Create: `scripts/cdp-bridge/test/helpers/supervisor-harness.js`
- Modify: `scripts/cdp-bridge/test/integration/gh-264-supervisor-respawn.test.js` (delete inline `startSupervisor`, lines ~12–53; import the helper instead)

**Interfaces:**
- Produces: `startSupervisor({ supervisorPath?, workerPath?, env?, cwd?, lineTimeoutMs? }) → { child, nextLine(): Promise<string>, send(method, params?): number, notify(method): void, stderrText(): string }` — consumed by Tasks 3 and 4. `supervisorPath` defaults to the repo's `dist/supervisor.js`; `workerPath`, when given, is exported as `RN_BRIDGE_WORKER_PATH` (how gh-264 injects fake workers); `env` merges over `process.env`; `send` returns the JSON-RPC id it used; `lineTimeoutMs` defaults to 15_000 (gh-264's original budget). `nextLine()` rejects early — with the captured stderr tail — if the supervisor process exits before producing a line, so a boot crash (the exact class this gate hunts) reports the real diagnostic instead of a generic timeout.

- [ ] **Step 1: Create the helper**

`scripts/cdp-bridge/test/helpers/supervisor-harness.js`:

```js
// Line-delimited JSON-RPC harness around a spawned dist/supervisor.js.
// Extracted from gh-264-supervisor-respawn.test.js (GH #432) so the
// packaged-artifact smoke test and scripts/update-tool-registry.mjs share it.
// Hardened over the original (Codex plan review): stderr is captured, and
// nextLine() rejects early with the stderr tail when the supervisor dies
// before answering — a packaged boot crash must surface its diagnostic, not
// a generic timeout.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SUPERVISOR = resolve(__dirname, '../../dist/supervisor.js');

export function startSupervisor({
  supervisorPath = DEFAULT_SUPERVISOR,
  workerPath,
  env = {},
  cwd,
  lineTimeoutMs = 15_000,
} = {}) {
  const child = spawn(process.execPath, [supervisorPath, '--no-lock'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd,
    env: {
      ...process.env,
      ...(workerPath ? { RN_BRIDGE_WORKER_PATH: workerPath } : {}),
      ...env,
    },
  });
  const stderrChunks = [];
  child.stderr.on('data', (c) => stderrChunks.push(c.toString('utf8')));
  const stderrText = () => stderrChunks.join('');
  let buf = '';
  let exited = null;
  const pendingLines = [];
  const waiters = []; // { resolve, reject, timer }
  const deathError = () =>
    new Error(
      `supervisor exited (code=${exited.code} signal=${exited.signal}) before answering; stderr tail:\n${stderrText().slice(-2000)}`,
    );
  child.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) {
      if (!p.length) continue;
      const w = waiters.shift();
      if (w) {
        clearTimeout(w.timer);
        w.resolve(p);
      } else pendingLines.push(p);
    }
  });
  child.on('exit', (code, signal) => {
    exited = { code, signal };
    while (waiters.length) {
      const w = waiters.shift();
      clearTimeout(w.timer);
      w.reject(deathError());
    }
  });
  const nextLine = () =>
    new Promise((resolveLine, reject) => {
      const queued = pendingLines.shift();
      if (queued !== undefined) return resolveLine(queued);
      if (exited) return reject(deathError());
      const entry = { resolve: resolveLine, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        reject(
          new Error(
            `timeout (${lineTimeoutMs}ms) waiting for supervisor stdout line; stderr tail:\n${stderrText().slice(-2000)}`,
          ),
        );
      }, lineTimeoutMs);
      waiters.push(entry);
    });
  let id = 0;
  const send = (method, params = {}) => {
    id += 1;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return id;
  };
  const notify = (method) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
  return { child, nextLine, send, notify, stderrText };
}
```

- [ ] **Step 2: Refactor gh-264 to consume it**

In `scripts/cdp-bridge/test/integration/gh-264-supervisor-respawn.test.js`:
1. Delete ONLY the inline `startSupervisor` function (the block starting `function startSupervisor(workerPath, extraEnv = {}) {` through its closing `}` — roughly lines 12–53) and the now-unused `SUPERVISOR` const (line 8; the helper resolves the same `../../dist/supervisor.js` as its default).
2. **Keep the `spawn` import** — it is still used at ~line 213 by the `GH#264 worker SIGUSR2 exits 1` test, which spawns `dist/index.js` directly (Codex plan review BLOCKER: deleting it makes the whole file throw `ReferenceError` at load).
3. Add `import { startSupervisor } from '../helpers/supervisor-harness.js';`
4. Rewrite every call site mechanically — the file's test bodies must not otherwise change:
   - `startSupervisor(FAKE)` → `startSupervisor({ workerPath: FAKE })`
   - `startSupervisor(CRASHER)` → `startSupervisor({ workerPath: CRASHER })`
   - `startSupervisor(X, { SOME_ENV: '1' })` → `startSupervisor({ workerPath: X, env: { SOME_ENV: '1' } })`
   Keep `FAKE`/`CRASHER`/`REAL_WORKER` path constants — all still referenced.

- [ ] **Step 3: Run the refactored test — must stay green (refactor-only)**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/integration/gh-264-supervisor-respawn.test.js
```
Expected: all gh-264 tests PASS (3 tests, same as before the refactor).

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp-bridge/test/helpers/supervisor-harness.js scripts/cdp-bridge/test/integration/gh-264-supervisor-respawn.test.js
git commit -m "test: extract supervisor JSON-RPC harness for reuse (#432)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `check-dist-fresh.sh` + bash guard test (TDD)

**Files:**
- Create: `scripts/check-dist-fresh.sh`
- Create: `scripts/test/check-dist-fresh.test.sh`

**Interfaces:**
- Produces: `bash scripts/check-dist-fresh.sh` — exit 0 + `dist fresh` when committed `scripts/cdp-bridge/dist/` equals a clean rebuild; exit 1 with porcelain output otherwise. Env overrides for the guard test: `REPO_ROOT` (repo to operate on), `DIST_BUILD_CMD` (build command run inside `$REPO_ROOT/scripts/cdp-bridge`, default `npm run build` — NOT `npx tsc`, which in non-interactive CI would auto-install `typescript@latest` if resolution ever failed, producing nondeterministic output; `npm run build` fails closed). Consumed by Task 5 (CI step).

- [ ] **Step 1: Write the failing guard test**

`scripts/test/check-dist-fresh.test.sh` (house style of `require-changeset.test.sh`: `check` helper + fake repo in mktemp):

```bash
#!/usr/bin/env bash
# Regression test for check-dist-fresh.sh — the CI gate that fails when the
# committed scripts/cdp-bridge/dist/ is not a clean rebuild of src/. Users run
# the COMMITTED dist (plugin.json mcpServers.cdp); CI rebuilding before tests
# silently repairs a stale artifact in CI only (GH #432, audit 2026-07-03).
#
# Run: bash scripts/test/check-dist-fresh.test.sh

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GUARD="$SCRIPT_DIR/check-dist-fresh.sh"

fail=0
check() { # description expected_exit actual_exit
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 — expected exit $2, got $3"
    fail=1
  fi
}

# Fake repo: scripts/cdp-bridge/{src,dist}; the "compiler" copies src/*.js
# into dist/ — enough to exercise stale/orphan/uncommitted porcelain states
# without a real tsc.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
BRIDGE="$tmp/scripts/cdp-bridge"
mkdir -p "$BRIDGE/src" "$BRIDGE/dist"
git -C "$tmp" init -q
git -C "$tmp" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
BUILD='cp src/*.js dist/'

# 1. committed dist == clean rebuild -> passes
echo 'console.log(1);' > "$BRIDGE/src/a.js"
cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm fresh
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" bash "$GUARD" >/dev/null 2>&1
check "fresh dist passes" 0 $?

# 2. src changed, committed dist stale (' M') -> fails
echo 'console.log(2);' > "$BRIDGE/src/a.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "src change, no rebuild"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" bash "$GUARD" >/dev/null 2>&1
check "stale committed dist fails" 1 $?
git -C "$tmp" checkout -q -- . && cp "$BRIDGE/src/a.js" "$BRIDGE/dist/a.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm rebuilt

# 3. committed orphan the build no longer emits (' D') -> fails
echo 'orphan' > "$BRIDGE/dist/gone.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm orphan
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" bash "$GUARD" >/dev/null 2>&1
check "committed orphan fails" 1 $?
git -C "$tmp" rm -q "scripts/cdp-bridge/dist/gone.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "drop orphan"

# 4. build emits a file never committed ('??') -> fails
echo 'console.log(3);' > "$BRIDGE/src/b.js"
git -C "$tmp" add "$BRIDGE/src/b.js"
git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "new src, dist not committed"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" bash "$GUARD" >/dev/null 2>&1
check "emitted-but-uncommitted file fails" 1 $?

# 5. web-dist is preserved, not rebuilt, not flagged
mkdir -p "$BRIDGE/dist/observability/web-dist"
echo '<html>spa</html>' > "$BRIDGE/dist/observability/web-dist/index.html"
cp "$BRIDGE/src/b.js" "$BRIDGE/dist/b.js"
git -C "$tmp" add -A && git -C "$tmp" -c user.email=t@t -c user.name=t commit -qm "web-dist + fresh dist"
REPO_ROOT="$tmp" DIST_BUILD_CMD="$BUILD" bash "$GUARD" >/dev/null 2>&1
check "web-dist preserved and ignored" 0 $?
[ -f "$BRIDGE/dist/observability/web-dist/index.html" ]
check "web-dist file survives the clean-slate delete" 0 $?

exit $fail
```

- [ ] **Step 2: Run it — must fail (script doesn't exist)**

```bash
bash scripts/test/check-dist-fresh.test.sh
```
Expected: every `check` line prints `FAIL` (or bash errors on the missing `$GUARD`); exit non-zero.

- [ ] **Step 3: Write the script**

`scripts/check-dist-fresh.sh`:

```bash
#!/usr/bin/env bash
# CI gate: the committed compiled MCP server (scripts/cdp-bridge/dist/) must
# equal a CLEAN rebuild from src/. Users run the committed dist via
# plugin.json mcpServers.cdp; CI's rebuild-before-test silently repairs a
# stale artifact in CI while shipping it broken (GH #432, audit 2026-07-03).
# Clean-slate so all three drift shapes surface in porcelain:
#   ' M' stale committed file, '??' emitted-but-uncommitted, ' D' orphan.
# observability/web-dist/ is preserved — Vite output owned by
# check-web-bundle.sh (tsconfig excludes src/observability/web).
# Env overrides (guard test): REPO_ROOT, DIST_BUILD_CMD.
set -euo pipefail

ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
BRIDGE="$ROOT/scripts/cdp-bridge"
DIST_REL="scripts/cdp-bridge/dist"
# npm run build (= tsc) fails closed; bare `npx tsc` would auto-install
# typescript@latest in non-interactive CI if resolution ever broke.
BUILD_CMD="${DIST_BUILD_CMD:-npm run build}"

find "$BRIDGE/dist" -mindepth 1 -maxdepth 1 ! -name observability -exec rm -rf {} +
if [ -d "$BRIDGE/dist/observability" ]; then
  find "$BRIDGE/dist/observability" -mindepth 1 -maxdepth 1 ! -name web-dist -exec rm -rf {} +
fi

( cd "$BRIDGE" && eval "$BUILD_CMD" )

STATUS="$(git -C "$ROOT" status --porcelain -- "$DIST_REL")"
if [ -n "$STATUS" ]; then
  echo "ERROR: committed $DIST_REL is not a clean rebuild of src/."
  echo "$STATUS"
  echo "  ' M' = stale committed file, '??' = emitted but uncommitted, ' D' = orphan no longer emitted"
  echo "  Fix: (cd scripts/cdp-bridge && npm run build) && git add $DIST_REL"
  exit 1
fi
echo "dist fresh"
```

- [ ] **Step 4: Run the guard test — must pass**

```bash
bash scripts/test/check-dist-fresh.test.sh
```
Expected: 6 × `ok:` lines, exit 0.

- [ ] **Step 5: Run against the real repo — must pass**

```bash
npm ci >/dev/null 2>&1 || true   # only if node_modules is missing
bash scripts/check-dist-fresh.sh
```
Expected: `dist fresh`, exit 0. If it fails with ` M` lines, the committed dist genuinely IS stale on this branch — run the printed fix, commit `dist/` separately as `fix: refresh stale committed dist (#432 gate)`, then re-run.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-dist-fresh.sh scripts/test/check-dist-fresh.test.sh
git commit -m "ci: dist-freshness gate — committed dist must equal a clean rebuild (#432)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Golden tool registry + regeneration script

**Files:**
- Create: `scripts/update-tool-registry.mjs`
- Create (generated): `scripts/cdp-bridge/test/fixtures/tool-registry.json`

**Interfaces:**
- Consumes: `startSupervisor` from Task 1.
- Produces: `scripts/cdp-bridge/test/fixtures/tool-registry.json` — a sorted JSON array of exactly 78 tool-name strings, trailing newline. Consumed by Task 4. Regeneration command (also cited in Task 4's failure message): `node scripts/update-tool-registry.mjs`.

- [ ] **Step 1: Write the regeneration script**

`scripts/update-tool-registry.mjs`:

```js
#!/usr/bin/env node
// Regenerates test/fixtures/tool-registry.json — the committed golden of the
// MCP tool surface asserted by packaged-artifact-smoke.test.js (GH #432).
// Deliberate friction, same philosophy as require-changeset.sh: adding,
// removing, or renaming a tool means running this, reviewing the diff, and
// committing. Run from the repo root AFTER a build:
//   (cd scripts/cdp-bridge && npm run build) && node scripts/update-tool-registry.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startSupervisor } from './cdp-bridge/test/helpers/supervisor-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(here, 'cdp-bridge');
const GOLDEN = resolve(BRIDGE, 'test/fixtures/tool-registry.json');

const s = startSupervisor({ supervisorPath: resolve(BRIDGE, 'dist/supervisor.js') });
try {
  const initId = s.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'update-tool-registry', version: '0.0.0' },
  });
  const init = JSON.parse(await s.nextLine());
  if (init.id !== initId || !init.result) throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  s.notify('notifications/initialized');
  s.send('tools/list');
  const list = JSON.parse(await s.nextLine());
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  if (names.length === 0) throw new Error('tools/list returned zero tools — refusing to write an empty golden');
  writeFileSync(GOLDEN, JSON.stringify(names, null, 2) + '\n');
  console.log(`wrote ${names.length} tool names to ${GOLDEN}`);
} finally {
  s.child.kill('SIGTERM');
}
```

- [ ] **Step 2: Generate the golden**

```bash
(cd scripts/cdp-bridge && npm run build) && node scripts/update-tool-registry.mjs
```
Expected: `wrote 78 tool names to .../test/fixtures/tool-registry.json`

- [ ] **Step 3: Sanity-check the golden**

```bash
node -e "const g=require('./scripts/cdp-bridge/test/fixtures/tool-registry.json'); console.log(g.length, g.includes('observe'), g.includes('cdp_connect'), g[0]);"
```
Expected: `78 true true cdp_auto_login`

- [ ] **Step 4: Commit**

```bash
git add scripts/update-tool-registry.mjs scripts/cdp-bridge/test/fixtures/tool-registry.json
git commit -m "test: committed golden of the 78-tool MCP surface + regeneration script (#432)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: The packaged-artifact smoke test

**Files:**
- Create: `scripts/cdp-bridge/test/integration/packaged-artifact-smoke.test.js`

**Interfaces:**
- Consumes: `startSupervisor` (Task 1), `test/fixtures/tool-registry.json` (Task 3).
- Produces: the CI-facing smoke; phase-prefixed assertion messages `SMOKE_INSTALL` / `SMOKE_HANDSHAKE` / `SMOKE_REGISTRY` / `SMOKE_OBSERVE` / `SMOKE_SHUTDOWN` are the contract for failure attribution (referenced in the spec and PR body).

- [ ] **Step 1: Write the test**

`scripts/cdp-bridge/test/integration/packaged-artifact-smoke.test.js`:

```js
// GH #432: validate the artifact users actually run. Copies the COMMITTED
// dist/ + package.json + package-lock.json to a temp dir — exactly the files
// ensure-cdp-deps.sh:24-25 copies — installs production-only with
// --ignore-scripts (lockfile-pinned, matching user machines), then drives
// dist/supervisor.js over stdio: MCP handshake, tools/list vs the committed
// golden, observe start + SPA fetch, clean SIGTERM. CI runs the
// dist-freshness gate first, so the "fresh" dist this exercises is provably
// identical to the committed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const pexecFile = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, '../..');
const GOLDEN = JSON.parse(
  await readFile(resolve(__dirname, '../fixtures/tool-registry.json'), 'utf8'),
);

// ensure-cdp-deps.sh:27 verbatim (+ --no-audit --no-fund: output hygiene only).
const INSTALL_ARGS = ['install', '--production', '--ignore-scripts', '--no-audit', '--no-fund'];

test(
  'GH#432 packaged-artifact smoke: the user install path serves the full tool surface',
  { timeout: 300_000 },
  async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'rn-agent-packaged-'));
    let s = null;
    try {
      await cp(resolve(BRIDGE, 'dist'), join(tmp, 'dist'), { recursive: true });
      await cp(resolve(BRIDGE, 'package.json'), join(tmp, 'package.json'));
      // Conditional, mirroring ensure-cdp-deps.sh:25 — the lock ships today,
      // but the smoke must not hard-fail if it is ever removed.
      await cp(resolve(BRIDGE, 'package-lock.json'), join(tmp, 'package-lock.json')).catch(
        () => {},
      );

      try {
        await pexecFile('npm', INSTALL_ARGS, { cwd: tmp, timeout: 180_000 });
      } catch (first) {
        // One retry: registry flake must not read as a product regression.
        await pexecFile('npm', INSTALL_ARGS, { cwd: tmp, timeout: 180_000 }).catch((second) => {
          throw new Error(`SMOKE_INSTALL: production install failed twice: ${second.message}`, {
            cause: first,
          });
        });
      }

      const port = 17000 + Math.floor(Math.random() * 4000);
      s = startSupervisor({
        supervisorPath: join(tmp, 'dist/supervisor.js'),
        cwd: tmp,
        env: { RN_AGENT_OBSERVE_PORT: String(port) },
        // Cold worker boot right after a cold install on a loaded 2-core CI
        // runner — double gh-264's 15s interactive budget.
        lineTimeoutMs: 30_000,
      });

      const initId = s.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'packaged-smoke', version: '0.0.0' },
      });
      const init = JSON.parse(await s.nextLine());
      assert.equal(init.id, initId, 'SMOKE_HANDSHAKE: initialize must be answered first');
      assert.ok(
        init.result?.serverInfo?.name,
        `SMOKE_HANDSHAKE: no serverInfo in ${JSON.stringify(init)}`,
      );
      s.notify('notifications/initialized');

      s.send('tools/list');
      const list = JSON.parse(await s.nextLine());
      const actual = (list.result?.tools ?? []).map((t) => t.name).sort();
      const missing = GOLDEN.filter((n) => !actual.includes(n));
      const unexpected = actual.filter((n) => !GOLDEN.includes(n));
      assert.deepEqual(
        { missing, unexpected },
        { missing: [], unexpected: [] },
        'SMOKE_REGISTRY: tool surface drifted from test/fixtures/tool-registry.json.\n' +
          `  missing (in golden, not served): ${JSON.stringify(missing)}\n` +
          `  unexpected (served, not in golden): ${JSON.stringify(unexpected)}\n` +
          '  Intentional change? node scripts/update-tool-registry.mjs, review the diff, commit.',
      );

      s.send('tools/call', { name: 'observe', arguments: { action: 'start' } });
      const call = JSON.parse(await s.nextLine());
      const envelope = JSON.parse(call.result?.content?.[0]?.text ?? '{}');
      assert.equal(
        envelope.ok,
        true,
        `SMOKE_OBSERVE: observe start failed: ${JSON.stringify(call)}`,
      );
      const res = await fetch(envelope.data.url);
      const body = await res.text();
      assert.equal(res.status, 200, 'SMOKE_OBSERVE: observe server must serve GET /');
      assert.ok(
        body.includes('__E2E_CSRF__'),
        'SMOKE_OBSERVE: expected the real SPA bundle (CSRF marker), not the "SPA bundle not built" branch — is dist/observability/web-dist/ in the packaged tree?',
      );

      s.child.kill('SIGTERM');
      const code = await new Promise((r) => s.child.on('exit', r));
      assert.equal(code, 0, 'SMOKE_SHUTDOWN: supervisor must exit 0 on SIGTERM');
      s = null;
    } finally {
      if (s) s.child.kill('SIGKILL');
      await rm(tmp, { recursive: true, force: true });
    }
  },
);
```

- [ ] **Step 2: Run it — must pass (healthy product; the probe already proved the path)**

```bash
cd scripts/cdp-bridge && npm run build && node --test test/integration/packaged-artifact-smoke.test.js
```
Expected: 1 test PASS in ~10–40 s (install dominates).

- [ ] **Step 3: Test the test — registry drift must fail with the SMOKE_REGISTRY message**

```bash
cd scripts/cdp-bridge
node -e "const f='test/fixtures/tool-registry.json',g=JSON.parse(require('fs').readFileSync(f));g.push('zz_fake_tool');require('fs').writeFileSync(f,JSON.stringify(g,null,2)+'\n')"
node --test test/integration/packaged-artifact-smoke.test.js; echo "exit=$?"
git checkout -- test/fixtures/tool-registry.json
```
Expected: FAIL, output contains `SMOKE_REGISTRY` and `missing (in golden, not served): ["zz_fake_tool"]`; `exit=1`. The checkout restores the golden.

- [ ] **Step 4: Run the full integration suite (gh-264 + smoke + others together)**

```bash
cd scripts/cdp-bridge && node --test 'test/integration/*.test.js'
```
Expected: all PASS. (The smoke uses `--no-lock` and an ephemeral observe port, so it cannot collide with gh-264's supervisors.)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/test/integration/packaged-artifact-smoke.test.js
git commit -m "test: packaged-artifact smoke — user install path, MCP handshake, golden registry, observe SPA (#432)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: CI wiring, lint/format, full suite, PR

**Files:**
- Modify: `.github/workflows/ci.yml` (the `test` job: replace the `TypeScript build` step; add the guard-test step after the other bash guards)

**Interfaces:**
- Consumes: `scripts/check-dist-fresh.sh` (Task 2). The freshness step MUST run where the build step ran (before unit/integration steps) — it both builds and gates, and the smoke's transitive validity depends on it.

- [ ] **Step 1: Edit ci.yml**

Replace:

```yaml
      - name: TypeScript build
        run: npm run build
        working-directory: scripts/cdp-bridge
```

with:

```yaml
      # GH#432: build + freshness in one gate. Users run the COMMITTED dist;
      # an unconditional rebuild here silently repairs a stale artifact in CI
      # while shipping it broken to installs.
      - name: TypeScript build + dist freshness gate
        run: bash scripts/check-dist-fresh.sh
```

After the `Feedback telemetry staleness guard` step, add:

```yaml
      # GH#432: the freshness gate is itself tested (house rule for CI guards).
      - name: Dist-freshness guard unit test
        run: bash scripts/test/check-dist-fresh.test.sh
```

- [ ] **Step 2: Lint + format at repo root**

```bash
npm run lint && npm run format:check
```
Expected: both clean. If oxfmt flags the new JS files, run `npm run format` and re-check.

- [ ] **Step 3: Full suite exactly as CI runs it**

```bash
cd scripts/cdp-bridge && npm run build && node --test 'test/unit/*.test.js' 'test/unit/**/*.test.js' && node --test 'test/integration/*.test.js' 'test/integration/**/*.test.js'
cd ../.. && bash scripts/check-dist-fresh.sh && bash scripts/test/check-dist-fresh.test.sh
```
Expected: all suites PASS; `dist fresh`; 6 × `ok:`.

- [ ] **Step 4: Commit, push, open PR**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: gate the test job on dist freshness; run the guard's own test (#432)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
git push -u origin tierra-crag
gh pr create --repo Lykhoyda/rn-dev-agent --base main \
  --title "CI: packaged-artifact smoke gate — validate the artifact users actually run (#432)" \
  --body "$(cat <<'EOF'
Closes #432. P0-A of the 2026-07-03 test-confidence audit.

## What
- **`scripts/check-dist-fresh.sh`** — CI now fails when the committed `scripts/cdp-bridge/dist/` is not a clean rebuild of `src/` (stale ` M`, uncommitted `??`, orphaned ` D`). Replaces the unconditional build step that silently repaired staleness in CI only. Guard-tested (`scripts/test/check-dist-fresh.test.sh`, 6 cases incl. web-dist preservation).
- **`test/integration/packaged-artifact-smoke.test.js`** — replicates the exact user runtime: committed `dist/` + `package.json` + `package-lock.json` (the files `ensure-cdp-deps.sh` copies) + `npm install --production --ignore-scripts` in a temp dir → `dist/supervisor.js` stdio spawn → real MCP handshake → `tools/list` vs committed golden (exact set, 78 names) → `observe start` → SPA fetch (CSRF marker) → clean SIGTERM. Phase-prefixed failures: `SMOKE_INSTALL/HANDSHAKE/REGISTRY/OBSERVE/SHUTDOWN`.
- **`test/fixtures/tool-registry.json`** + `scripts/update-tool-registry.mjs` — deliberate-update golden of the MCP tool surface (require-changeset philosophy).
- Supervisor JSON-RPC harness extracted from gh-264 into `test/helpers/supervisor-harness.js` (refactor-only, shared by smoke + updater).

## Why
Escaped-bug classes this closes at CI time: the cold-registration invariant behind #419's symptom (a packaged server that registers fewer tools than claimed now goes red — #419's mid-session-upgrade trigger itself stays open), #424-adjacent packaging drift, #361/#363 delivery gap, devDependency leaks (CI installs devDeps; users don't), "src change inert in installs" (pre-#356). Spec: `docs/superpowers/specs/2026-07-03-packaged-artifact-smoke-gate-design.md`.

## Notes
- No changeset: no `scripts/cdp-bridge/src/` changes (test/CI surface only).
- The smoke's install is lockfile-pinned exactly like user machines (`ensure-cdp-deps.sh` copies the committed lock); `SMOKE_INSTALL` prefix + one retry keep registry flake distinguishable from product regressions.
- Found during review, deliberately NOT fixed here: the committed `scripts/cdp-bridge/package-lock.json` is stale (`version` 0.38.23 vs 0.53.0) — refreshing it changes what users install and gets its own follow-up issue.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review (completed)

- **Spec coverage:** freshness script incl. orphan detection (Task 2), user-path smoke with all five phases (Task 4), golden + updater (Task 3), harness extraction (Task 1), CI placement + guard test of the gate (Task 5), no-changeset constraint (global). ✔
- **Placeholders:** none — every code block is complete and every command has expected output. ✔
- **Type consistency:** `startSupervisor` options object identical across Tasks 1/3/4; golden path `test/fixtures/tool-registry.json` identical across Tasks 3/4; phase prefixes identical across Task 4 and the PR body. ✔
- **Measured facts:** 78 tools, envelope shape, CSRF marker, exit 0 — verified by live probe 2026-07-04, not assumed. ✔
