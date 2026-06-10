# Device Control Phase 4 — Eradicate Legacy Runner Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At iOS device-open, detect the legacy `com.callstack.agentdevice.runner` apps *installed on the simulator* and `simctl terminate` + `simctl uninstall` them — so iOS can never relaunch them into the foreground mid-flow (the #202 2026-06-08 comment repro).

**Architecture:** Extend `ensureSingleRunner()` (the existing single-runner enforcement module) with an app-eradication step: a pure selector over `simctl listapps` output (reusing the existing `parseSimctlListapps` plist parser), an error-safe orchestrator with injectable deps, and a per-(process, udid) memo so steady-state device-opens stay free. All existing call sites inherit the behavior through `ensureSingleRunner`; the `RN_DEVICE_KILL_LEGACY=0` opt-out at the call site keeps gating everything.

**Tech Stack:** TypeScript (Node >= 22), `node --test` unit tests against `dist/`, `xcrun simctl` via `execFileSync`, changesets.

**Spec:** `docs/superpowers/specs/2026-06-10-device-control-phase4-6-rethink-design.md` §1.

**Workflow reminder (repo standard):** run the multi-LLM plan review (`/brainstorm gemini,codex` with this plan + `ensure-single-runner.ts`) BEFORE Task 1; amend this plan with findings. TDD per task; signed, small commits on branch `feat/202-phase4-6-rethink`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `scripts/cdp-bridge/src/runners/ensure-single-runner.ts` | Modify | `LEGACY_BUNDLE_IDS`, `selectInstalledLegacyApps`, `eradicateLegacyRunnerApps`, wiring + memo, deps + result extension |
| `scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js` | Create | unit tests for all of the above |
| `scripts/cdp-bridge/src/tools/device-session.ts` (~line 277) | Modify | log `removedApps` at the device-open call site |
| `CLAUDE.md` (lines 106, 139) · `docs-site/src/content/docs/architecture.mdx` (line 154) | Modify | document automatic uninstall |
| `.changeset/phase4-legacy-app-eradication.md` | Create | release note |
| `scripts/cdp-bridge/eval/gate-202-phase4-legacy-uninstall.mjs` | Create (gitignored, local-only) | live gate on a booted simulator |

Notes for the engineer:
- Unit tests import from `../../dist/...` — run `npm run build` before `node --test`. A missing export fails at import time; that IS the red state.
- `parseSimctlListapps` already exists in `src/cdp/discovery.ts` (B116/D639) — import it; do not re-implement plist parsing.
- House rules: explicit type imports (`import type {...}`), no unnecessary comments, `meta.timings_ms` on new steps, fail-open on infra errors (warnings, never a blocked session).

---

### Task 1: Pure selector — `selectInstalledLegacyApps`

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/ensure-single-runner.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_BUNDLE_IDS,
  selectInstalledLegacyApps,
} from '../../dist/runners/ensure-single-runner.js';

// Realistic `xcrun simctl listapps <udid>` excerpt (NeXTSTEP plist; top-level
// bundle-id keys at exactly 4-space indent — same shape parseSimctlListapps
// was field-verified against in B116/D639).
const LISTAPPS_WITH_LEGACY = [
  '{',
  '    "com.callstack.agentdevice.runner" =     {',
  '        ApplicationType = User;',
  '        Bundle = "file:///...";',
  '    };',
  '    "com.callstack.agentdevice.runner.uitests.xctrunner" =     {',
  '        ApplicationType = User;',
  '    };',
  '    "com.rndevagent.testapp" =     {',
  '        ApplicationType = User;',
  '        GroupContainers =         {',
  '        "group.com.callstack.agentdevice.runner" =             {',
  '        };',
  '    };',
  '    "dev.lykhoyda.rndevagent.fastrunner" =     {',
  '        ApplicationType = User;',
  '    };',
  '}',
].join('\n');

const LISTAPPS_CLEAN = [
  '{',
  '    "com.rndevagent.testapp" =     {',
  '        ApplicationType = User;',
  '    };',
  '    "dev.lykhoyda.rndevagent.fastrunner" =     {',
  '        ApplicationType = User;',
  '    };',
  '}',
].join('\n');

test('GH#202-P4 LEGACY_BUNDLE_IDS: exactly the two callstack runner bundles', () => {
  assert.deepEqual([...LEGACY_BUNDLE_IDS], [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 selectInstalledLegacyApps: finds installed legacy bundles, ignores nested keys and our own apps', () => {
  assert.deepEqual(selectInstalledLegacyApps(LISTAPPS_WITH_LEGACY), [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 selectInstalledLegacyApps: empty on a clean simulator and on garbage input', () => {
  assert.deepEqual(selectInstalledLegacyApps(LISTAPPS_CLEAN), []);
  assert.deepEqual(selectInstalledLegacyApps(''), []);
  assert.deepEqual(selectInstalledLegacyApps('not a plist at all'), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`
Expected: FAIL — `SyntaxError: ... does not provide an export named 'LEGACY_BUNDLE_IDS'`

- [ ] **Step 3: Write minimal implementation**

In `scripts/cdp-bridge/src/runners/ensure-single-runner.ts`, add below the imports (and add the new import):

```typescript
import { parseSimctlListapps } from '../cdp/discovery.js';
```

```typescript
// GH#202 Phase 4: the legacy upstream runner ships as TWO installed apps.
// Killing their processes (Phase 1) is insufficient — iOS relaunches an
// installed XCUITest runner to the foreground during WDA sessions. The only
// correct end-state on iOS (where agent-device is retired, D1219) is
// "not installed".
export const LEGACY_BUNDLE_IDS = [
  'com.callstack.agentdevice.runner',
  'com.callstack.agentdevice.runner.uitests.xctrunner',
] as const;

export function selectInstalledLegacyApps(listappsOutput: string): string[] {
  const installed = parseSimctlListapps(listappsOutput);
  return LEGACY_BUNDLE_IDS.filter((id) => installed.has(id));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/ensure-single-runner.ts scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js
git commit -m "feat(#202-p4): selector for installed legacy runner apps from simctl listapps"
```

---

### Task 2: Orchestrator — `eradicateLegacyRunnerApps`

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/ensure-single-runner.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```javascript
import { eradicateLegacyRunnerApps } from '../../dist/runners/ensure-single-runner.js';

function appDeps(over = {}) {
  return {
    listApps: () => LISTAPPS_WITH_LEGACY,
    terminateApp: () => {},
    uninstallApp: () => {},
    ...over,
  };
}

test('GH#202-P4 eradicate: terminates then uninstalls every installed legacy bundle', async () => {
  const calls = [];
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    terminateApp: (udid, id) => calls.push(`term:${udid}:${id}`),
    uninstallApp: (udid, id) => calls.push(`unin:${udid}:${id}`),
  }));
  assert.deepEqual(r.removedApps, [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.clean, true);
  assert.deepEqual(calls, [
    'term:UDID-A:com.callstack.agentdevice.runner',
    'unin:UDID-A:com.callstack.agentdevice.runner',
    'term:UDID-A:com.callstack.agentdevice.runner.uitests.xctrunner',
    'unin:UDID-A:com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 eradicate: clean simulator is a clean no-op', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({ listApps: () => LISTAPPS_CLEAN }));
  assert.deepEqual(r.removedApps, []);
  assert.equal(r.clean, true);
});

test('GH#202-P4 eradicate: terminate failure is ignored (app may not be running), uninstall still runs', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    terminateApp: () => { throw new Error('found nothing to terminate'); },
  }));
  assert.equal(r.removedApps.length, 2);
  assert.equal(r.clean, true);
});

test('GH#202-P4 eradicate: uninstall failure -> warning with the manual command, other bundle still removed, not clean', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    uninstallApp: (udid, id) => {
      if (id === 'com.callstack.agentdevice.runner') throw new Error('Device busy');
    },
  }));
  assert.deepEqual(r.removedApps, ['com.callstack.agentdevice.runner.uitests.xctrunner']);
  assert.equal(r.clean, false);
  assert.ok(r.warnings.some((w) => w.includes('xcrun simctl uninstall UDID-A com.callstack.agentdevice.runner')));
});

test('GH#202-P4 eradicate: listapps failure -> warning, no throw, not clean', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    listApps: () => { throw new Error('Invalid device state'); },
  }));
  assert.deepEqual(r.removedApps, []);
  assert.equal(r.clean, false);
  assert.ok(r.warnings.some((w) => /listapps failed/.test(w)));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`
Expected: FAIL — missing export `eradicateLegacyRunnerApps`

- [ ] **Step 3: Write minimal implementation**

In `ensure-single-runner.ts`, extend the deps interface (three new members at the end of `EnsureSingleRunnerDeps`):

```typescript
export interface EnsureSingleRunnerDeps {
  listProcesses: () => string;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isAlive: (pid: number) => boolean;
  readDaemonPid: () => number | null;
  fileExists: (path: string) => boolean;
  removeFile: (path: string) => void;
  delay: (ms: number) => Promise<void>;
  listApps: (udid: string) => string;
  terminateApp: (udid: string, bundleId: string) => void;
  uninstallApp: (udid: string, bundleId: string) => void;
}
```

Extend `defaultDeps()` with (inside the returned object):

```typescript
    listApps: (udid) =>
      execFileSync('xcrun', ['simctl', 'listapps', udid], { encoding: 'utf8', timeout: 5_000 }),
    terminateApp: (udid, bundleId) => {
      execFileSync('xcrun', ['simctl', 'terminate', udid, bundleId], { encoding: 'utf8', timeout: 5_000 });
    },
    uninstallApp: (udid, bundleId) => {
      execFileSync('xcrun', ['simctl', 'uninstall', udid, bundleId], { encoding: 'utf8', timeout: 10_000 });
    },
```

Add the orchestrator (below `selectInstalledLegacyApps`; `eradicateLegacyRunnerApps` takes full deps so callers reuse one deps object):

```typescript
export interface EradicateLegacyAppsResult {
  removedApps: string[];
  warnings: string[];
  clean: boolean;
}

// GH#202 Phase 4: error-safe by contract — every failure becomes a warning;
// a device-open is never blocked on eradication. `clean` gates the caller's
// memo: only a warning-free pass may be skipped next time.
export async function eradicateLegacyRunnerApps(
  udid: string,
  deps: EnsureSingleRunnerDeps,
): Promise<EradicateLegacyAppsResult> {
  const removedApps: string[] = [];
  const warnings: string[] = [];
  let listOut: string;
  try {
    listOut = deps.listApps(udid);
  } catch (err) {
    return { removedApps, warnings: [`listapps failed: ${msg(err)}`], clean: false };
  }
  for (const id of selectInstalledLegacyApps(listOut)) {
    try { deps.terminateApp(udid, id); } catch { /* not running — uninstall regardless */ }
    try {
      deps.uninstallApp(udid, id);
      removedApps.push(id);
    } catch (err) {
      warnings.push(
        `uninstall ${id} failed: ${msg(err)} — remove manually: xcrun simctl uninstall ${udid} ${id}`,
      );
    }
  }
  return { removedApps, warnings, clean: warnings.length === 0 };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/ensure-single-runner.ts scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js
git commit -m "feat(#202-p4): eradicateLegacyRunnerApps — terminate + uninstall installed legacy bundles, fail-open"
```

---

### Task 3: Wire into `ensureSingleRunner` — result field, memo, timings

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/ensure-single-runner.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the test file (note the memo reset in each test — module state persists across tests in one process):

```javascript
import {
  ensureSingleRunner,
  resetLegacyAppMemoForTests,
} from '../../dist/runners/ensure-single-runner.js';

function fullDeps(over = {}) {
  return {
    listProcesses: () => '',
    kill: () => {},
    isAlive: () => false,
    readDaemonPid: () => null,
    fileExists: () => false,
    removeFile: () => {},
    delay: async () => {},
    listApps: () => LISTAPPS_WITH_LEGACY,
    terminateApp: () => {},
    uninstallApp: () => {},
    ...over,
  };
}

test('GH#202-P4 ensureSingleRunner(udid): result carries removedApps + appEradication timing', async () => {
  resetLegacyAppMemoForTests();
  const r = await ensureSingleRunner({ udid: 'UDID-A' }, fullDeps());
  assert.deepEqual(r.removedApps, [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
  assert.ok('appEradication' in r.meta.timings_ms);
});

test('GH#202-P4 ensureSingleRunner: clean pass memoizes — second open on the same UDID skips listapps', async () => {
  resetLegacyAppMemoForTests();
  let listCalls = 0;
  const deps = fullDeps({ listApps: () => { listCalls += 1; return LISTAPPS_CLEAN; } });
  await ensureSingleRunner({ udid: 'UDID-A' }, deps);
  await ensureSingleRunner({ udid: 'UDID-A' }, deps);
  assert.equal(listCalls, 1);
  await ensureSingleRunner({ udid: 'UDID-B' }, deps);
  assert.equal(listCalls, 2);
});

test('GH#202-P4 ensureSingleRunner: a warning pass does NOT memoize — next open retries', async () => {
  resetLegacyAppMemoForTests();
  let listCalls = 0;
  const deps = fullDeps({
    listApps: () => { listCalls += 1; return LISTAPPS_WITH_LEGACY; },
    uninstallApp: () => { throw new Error('Device busy'); },
  });
  const r1 = await ensureSingleRunner({ udid: 'UDID-A' }, deps);
  assert.ok(r1.warnings.length > 0);
  await ensureSingleRunner({ udid: 'UDID-A' }, deps);
  assert.equal(listCalls, 2);
});

test('GH#202-P4 ensureSingleRunner (startup, no udid): never touches simctl', async () => {
  resetLegacyAppMemoForTests();
  let touched = false;
  const r = await ensureSingleRunner({}, fullDeps({ listApps: () => { touched = true; return ''; } }));
  assert.equal(touched, false);
  assert.deepEqual(r.removedApps, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`
Expected: FAIL — missing export `resetLegacyAppMemoForTests` (and `removedApps` undefined on the result)

- [ ] **Step 3: Implement the wiring**

In `ensure-single-runner.ts`:

1. Module-level memo (above `ensureSingleRunner`):

```typescript
// GH#202 Phase 4: per-(process, udid) memo — after one warning-free scan the
// steady-state device-open pays nothing. A mid-session reinstall of the legacy
// agent-device is not re-detected until the next bridge process; accepted.
const cleanedUdids = new Set<string>();

export function resetLegacyAppMemoForTests(): void {
  cleanedUdids.clear();
}
```

2. Extend the result interface:

```typescript
export interface EnsureSingleRunnerResult {
  killedPids: number[];
  removedFiles: string[];
  removedApps: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}
```

3. Inside `ensureSingleRunner`, declare `const removedApps: string[] = [];` next to the other accumulators; inside the existing `if (opts.udid) { ... }` block, after `timings.scopedKill = Date.now() - t;`, add:

```typescript
    if (!cleanedUdids.has(opts.udid)) {
      const tApps = Date.now();
      const apps = await eradicateLegacyRunnerApps(opts.udid, deps);
      removedApps.push(...apps.removedApps);
      warnings.push(...apps.warnings);
      if (apps.clean) cleanedUdids.add(opts.udid);
      timings.appEradication = Date.now() - tApps;
    }
```

4. Return `removedApps` in the result object:

```typescript
  return { killedPids, removedFiles, removedApps, warnings, meta: { timings_ms: timings } };
```

- [ ] **Step 4: Run the full unit suite (not just the new file — the result-shape change touches existing tests)**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS, including the pre-existing `gh-202-ensure-single-runner.test.js` (its `baseDeps` objects lack the three new deps members — they are only reached when legacy apps need eradication, and those tests use udid `UDID-A` with the old deps... **if any pre-existing test throws on a missing `listApps`, fix it by adding `listApps: () => ''` to that test's `baseDeps` helper — an empty string parses to zero bundles, preserving the old assertions**).
Expected total: ~1908+ tests passing.

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/ensure-single-runner.ts scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js scripts/cdp-bridge/test/unit/gh-202-ensure-single-runner.test.js
git commit -m "feat(#202-p4): wire app eradication into ensureSingleRunner with clean-scan memo"
```

---

### Task 4: Call-site logging in device-session

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (~line 277, inside the `ensureSingleRunner` result handling)

- [ ] **Step 1: Add the log line**

In the device-open block that already logs `killedPids` / `removedFiles`, add after the `removedFiles` log:

```typescript
            if (r.removedApps.length) {
              logger.info('rn-device', `ensureSingleRunner: uninstalled legacy runner app(s) ${r.removedApps.join(', ')} from ${deviceId}`);
            }
```

- [ ] **Step 2: Build + typecheck + lint**

Run: `cd scripts/cdp-bridge && npm run build && npm run lint`
Expected: clean (no type errors — `removedApps` exists on the result from Task 3)

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-session.ts
git commit -m "feat(#202-p4): log uninstalled legacy runner apps at device-open"
```

---

### Task 5: Documentation updates

**Files:**
- Modify: `CLAUDE.md` (line 106 troubleshooting row; line 139 architecture paragraph)
- Modify: `docs-site/src/content/docs/architecture.mdx` (line 154)

- [ ] **Step 1: Update CLAUDE.md line 106** — replace the row's middle sentence so it reads:

```markdown
- **Legacy `AgentDeviceRunner` re-appears on the simulator** → A stale `~/.agent-device/daemon.json` is respawning the upstream runner. Since #202 the plugin terminates stale `AgentDeviceRunner` processes at session-open by default (scoped to the target simulator UDID), clears orphaned `~/.agent-device/daemon.{json,lock}`, and (Phase 4) **uninstalls the legacy runner apps** (`com.callstack.agentdevice.runner` + its xctrunner) from the target simulator — killing the process alone was insufficient because iOS relaunches an installed XCUITest runner mid-flow. This should fully self-heal. If you've opted out via `RN_DEVICE_KILL_LEGACY=0`, clean up one-time: `pkill -f AgentDeviceRunner && rm -f ~/.agent-device/daemon.json ~/.agent-device/daemon.lock && xcrun simctl uninstall <udid> com.callstack.agentdevice.runner && xcrun simctl uninstall <udid> com.callstack.agentdevice.runner.uitests.xctrunner`.
```

- [ ] **Step 2: Update CLAUDE.md line 139** — append to the existing sentence (after "...fights our `RnFastRunner` for focus."):

```markdown
Phase 4 (#202) extends this to the installed apps themselves: at device-open, `ensureSingleRunner` also `simctl terminate` + `simctl uninstall`s the legacy `com.callstack.agentdevice.runner{,.uitests.xctrunner}` bundles (memoized per UDID after a clean scan; same `RN_DEVICE_KILL_LEGACY=0` opt-out), because killing processes can't stop iOS relaunching an installed XCUITest runner mid-flow.
```

- [ ] **Step 3: Update `docs-site/src/content/docs/architecture.mdx` line 154** — replace the sentence ending "opt out with `RN_DEVICE_KILL_LEGACY=0`." with:

```markdown
A stale `~/.agent-device/daemon.json` can respawn the upstream `AgentDeviceRunner` and fight the in-tree `rn-fast-runner` for focus on iOS. Since #202 the plugin terminates stale `AgentDeviceRunner` processes at session-open by default (scoped to the target simulator UDID), clears orphaned `~/.agent-device/daemon.{json,lock}`, and uninstalls the legacy runner apps (`com.callstack.agentdevice.runner` and its xctrunner companion) from the target simulator — an installed XCUITest runner is otherwise relaunched by iOS mid-flow even after its process is killed. Opt out with `RN_DEVICE_KILL_LEGACY=0`.
```

- [ ] **Step 4: Build docs-site to validate MDX**

Run: `cd docs-site && npm run build`
Expected: build succeeds

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs-site/src/content/docs/architecture.mdx
git commit -m "docs(#202-p4): legacy runner apps are now uninstalled automatically at device-open"
```

---

### Task 6: Changeset + full verification

**Files:**
- Create: `.changeset/phase4-legacy-app-eradication.md`

- [ ] **Step 1: Write the changeset**

```markdown
---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

#202 Phase 4 — eradicate legacy runner apps, not just processes.

At iOS device-open, `ensureSingleRunner` now detects the legacy upstream runner apps installed on the target simulator (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) and `simctl terminate` + `simctl uninstall`s them. Killing the host processes (Phase 1) was insufficient: iOS relaunches an installed XCUITest runner into the foreground mid-`maestro_run`, backgrounding the app under test and wedging CDP. Memoized per UDID after a clean scan; error-safe (warnings, never a blocked session); opt out with `RN_DEVICE_KILL_LEGACY=0`. Results surface as `removedApps` + `meta.timings_ms.appEradication`.
```

- [ ] **Step 2: Full suite + stage rebuilt dist**

Run: `cd scripts/cdp-bridge && npm test && npm run lint`
Expected: all tests pass, lint clean. Then stage the tracked `dist/` rebuild output per repo convention.

- [ ] **Step 3: Commit**

```bash
git add .changeset/phase4-legacy-app-eradication.md scripts/cdp-bridge/dist
git commit -m "chore(#202-p4): changeset + rebuilt dist"
```

---

### Task 7: Live gate on a booted simulator (manual, local-only)

**Files:**
- Create: `scripts/cdp-bridge/eval/gate-202-phase4-legacy-uninstall.mjs` (directory is gitignored — local harness, not committed)

- [ ] **Step 1: Write the gate script**

```javascript
#!/usr/bin/env node
// Live gate for #202 Phase 4: plant a stub app under the legacy bundle id on
// the booted simulator, run ensureSingleRunner({udid}), assert it is gone.
// Stub strategy: duplicate an installed app bundle we own (RnFastRunner.app
// from DerivedData) and rewrite its CFBundleIdentifier with PlistBuddy — a
// valid, installable bundle without building anything.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSingleRunner, resetLegacyAppMemoForTests, LEGACY_BUNDLE_IDS } from '../dist/runners/ensure-single-runner.js';

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const udid = sh('xcrun', ['simctl', 'list', 'devices', 'booted', '-j'])
  .match(/"udid"\s*:\s*"([A-F0-9-]+)"/)?.[1];
if (!udid) { console.error('GATE FAIL: no booted simulator'); process.exit(1); }

const SRC_APP = new URL('../../rn-fast-runner/build/DerivedData/Build/Products/Debug-iphonesimulator/RnFastRunner.app', import.meta.url).pathname;
const LEGACY_ID = 'com.callstack.agentdevice.runner';

const tmp = mkdtempSync(join(tmpdir(), 'gate-p4-'));
const stub = join(tmp, 'AgentDeviceRunner.app');
cpSync(SRC_APP, stub, { recursive: true });
sh('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${LEGACY_ID}`, join(stub, 'Info.plist')]);
sh('xcrun', ['simctl', 'install', udid, stub]);

const installed = () => sh('xcrun', ['simctl', 'listapps', udid]).includes(`"${LEGACY_ID}"`);
if (!installed()) { console.error('GATE FAIL: stub install did not take'); process.exit(1); }
console.log(`planted ${LEGACY_ID} on ${udid}`);

resetLegacyAppMemoForTests();
const r = await ensureSingleRunner({ udid });
console.log(JSON.stringify({ removedApps: r.removedApps, warnings: r.warnings, timings: r.meta.timings_ms }, null, 2));

rmSync(tmp, { recursive: true, force: true });
if (installed()) { console.error('GATE FAIL: legacy app still installed'); process.exit(1); }
if (!r.removedApps.includes(LEGACY_ID)) { console.error('GATE FAIL: removedApps missing the legacy id'); process.exit(1); }
console.log('GATE PASS: legacy app eradicated at device-open path');
console.log(`note: LEGACY_BUNDLE_IDS covers ${LEGACY_BUNDLE_IDS.length} bundles; xctrunner variant exercised by unit tests`);
```

- [ ] **Step 2: Run the gate against the booted simulator**

Precondition: a simulator is booted and the rn-fast-runner DerivedData build exists (run any `device_snapshot action=open` once if not — it self-builds).

Run: `cd scripts/cdp-bridge && npm run build && node eval/gate-202-phase4-legacy-uninstall.mjs`
Expected: `GATE PASS: legacy app eradicated at device-open path`

- [ ] **Step 3: Record the result**

Paste the gate output (removedApps + timings) into the PR body as the live-verification proof. Nothing to commit (eval/ is gitignored).

---

### Task 8: Finish the branch

- [ ] **Step 1: Push + PR**

```bash
git push -u origin feat/202-phase4-6-rethink
gh pr create --title "feat(#202): Phase 4 — eradicate legacy runner apps (uninstall, not just pkill)" --body "<summary + spec link + gate output>"
```

PR body must reference the spec (`docs/superpowers/specs/2026-06-10-device-control-phase4-6-rethink-design.md` §1), the #202 2026-06-08 comment it closes out, and include the Task 7 gate output.

- [ ] **Step 2: Multi-review + merge per repo workflow**

Run `/multi-review` on the diff; wait for CI; address review threads; merge. Post the re-think summary comment on #202 (per spec §4) when the PR lands, noting Phases 5 (#264) and 6 (#186) follow on this spec.

---

## Self-review notes (done at authoring time)

- **Spec §1 coverage:** detection/terminate/uninstall (Tasks 1–2), gate via existing env at call site (unchanged — verified `device-session.ts:268` gates `RN_DEVICE_KILL_LEGACY !== '0'` before calling), all call sites inherit (Task 3 wires inside `ensureSingleRunner`), memo (Task 3), failure handling + `removedApps` + timings (Tasks 2–3), docs (Task 5), unit + live gate (Tasks 1–3, 7). Boot-time call (`index.ts:130`, no udid) untouched by design.
- **Type consistency:** `EnsureSingleRunnerDeps` gains `listApps/terminateApp/uninstallApp` (Task 2) before `fullDeps` uses them (Task 3); `EnsureSingleRunnerResult.removedApps` (Task 3) before `device-session.ts` reads it (Task 4). `msg()` helper already exists at module bottom.
- **Known risk, decided:** pre-existing `gh-202-ensure-single-runner.test.js` deps objects lack the new members — TypeScript doesn't check JS test files, and the new code path only calls `deps.listApps` when a udid is present, which those tests use. Task 3 Step 4 explicitly instructs the fix (`listApps: () => ''`) if any throw at runtime.
