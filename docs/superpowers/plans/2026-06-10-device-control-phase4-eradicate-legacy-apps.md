# Device Control Phase 4 — Eradicate Legacy Runner Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** At iOS device-open, detect the legacy `com.callstack.agentdevice.runner` apps *installed on the simulator* and `simctl uninstall` them — so iOS can never relaunch them into the foreground mid-flow (the #202 2026-06-08 comment repro).

**Architecture:** Extend `ensureSingleRunner()` (the existing single-runner enforcement module) with an app-eradication step: a pure selector over the parsed `simctl listapps` set (reusing the existing `parseSimctlListapps` plist parser) and an error-safe orchestrator with injectable deps. Runs at every device-open (one `listapps`, ~tens of ms — no memo; review-2 showed a memo can't be made safe against another session reinstalling on the same UDID). The udid-bearing call site inherits the behavior through `ensureSingleRunner`; the `RN_DEVICE_KILL_LEGACY=0` opt-out at the call site keeps gating everything.

**Tech Stack:** TypeScript (Node >= 22), `node --test` unit tests against `dist/`, `xcrun simctl` via `execFileSync`, changesets.

**Spec:** `docs/superpowers/specs/2026-06-10-device-control-phase4-6-rethink-design.md` §1.

**Workflow reminder (repo standard):** run the multi-LLM plan review (`/brainstorm gemini,codex` with this plan + `ensure-single-runner.ts`) BEFORE Task 1; amend this plan with findings. TDD per task; signed, small commits on branch `feat/202-phase4-6-rethink`.

---

## File map

| File | Action | Responsibility |
|---|---|---|
| `scripts/cdp-bridge/src/runners/ensure-single-runner.ts` | Modify | `LEGACY_BUNDLE_IDS`, `selectInstalledLegacyApps`, `eradicateLegacyRunnerApps`, wiring, deps + result extension |
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
import { parseSimctlListapps } from '../../dist/cdp/discovery.js';

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
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps(LISTAPPS_WITH_LEGACY)), [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 selectInstalledLegacyApps: empty on a clean simulator and on garbage input', () => {
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps(LISTAPPS_CLEAN)), []);
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps('')), []);
  assert.deepEqual(selectInstalledLegacyApps(parseSimctlListapps('not a plist at all')), []);
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

export function selectInstalledLegacyApps(installed: Set<string>): string[] {
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
    uninstallApp: () => {},
    ...over,
  };
}

// No separate `terminate` step (review-2 finding #4): `simctl uninstall`
// terminates a running app itself, and Phase 1's process-kill (scopedKill)
// has already run by the time eradication is reached.
test('GH#202-P4 eradicate: uninstalls every installed legacy bundle', async () => {
  const calls = [];
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    uninstallApp: (udid, id) => calls.push(`unin:${udid}:${id}`),
  }));
  assert.deepEqual(r.removedApps, [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(calls, [
    'unin:UDID-A:com.callstack.agentdevice.runner',
    'unin:UDID-A:com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
});

test('GH#202-P4 eradicate: clean simulator is a warning-free no-op', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({ listApps: () => LISTAPPS_CLEAN }));
  assert.deepEqual(r.removedApps, []);
  assert.deepEqual(r.warnings, []);
});

test('GH#202-P4 eradicate: uninstall failure -> warning with the manual command, other bundle still removed', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    uninstallApp: (udid, id) => {
      if (id === 'com.callstack.agentdevice.runner') throw new Error('Device busy');
    },
  }));
  assert.deepEqual(r.removedApps, ['com.callstack.agentdevice.runner.uitests.xctrunner']);
  assert.ok(r.warnings.some((w) => w.includes('xcrun simctl uninstall UDID-A com.callstack.agentdevice.runner')));
});

test('GH#202-P4 eradicate: listapps failure -> warning, no throw', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    listApps: () => { throw new Error('Invalid device state'); },
  }));
  assert.deepEqual(r.removedApps, []);
  assert.ok(r.warnings.some((w) => /listapps failed/.test(w)));
});

// Plan-review amendment (Gemini, 2026-06-10): a booted simulator ALWAYS has
// built-in system apps, so zero parsed bundle ids proves a parse/format
// failure (e.g. a future Xcode reformats listapps output away from the
// 4-space-indent plist parseSimctlListapps expects) — NOT a clean device.
// Surfacing it as a warning keeps the breakage visible instead of reading
// as "no legacy apps installed".
test('GH#202-P4 eradicate: zero parsed apps from a successful listapps -> parse-failure warning', async () => {
  const r = await eradicateLegacyRunnerApps('UDID-A', appDeps({
    listApps: () => 'totally reformatted output the parser cannot read',
  }));
  assert.deepEqual(r.removedApps, []);
  assert.ok(r.warnings.some((w) => /0 apps/.test(w)));
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
  uninstallApp: (udid: string, bundleId: string) => void;
}
```

Extend `defaultDeps()` with (inside the returned object):

```typescript
    listApps: (udid) =>
      execFileSync('xcrun', ['simctl', 'listapps', udid], { encoding: 'utf8', timeout: 5_000 }),
    uninstallApp: (udid, bundleId) => {
      execFileSync('xcrun', ['simctl', 'uninstall', udid, bundleId], { encoding: 'utf8', timeout: 10_000 });
    },
```

Also update the doc comment on `parseSimctlListapps` in `scripts/cdp-bridge/src/cdp/discovery.ts` (line ~78) to note it is now also relied on for the `simctl listapps <udid>` form (same plist shape as `booted`; the Task 7 live gate proves it against a real device):

```typescript
/**
 * B116 (D639): extract top-level bundle IDs from `xcrun simctl listapps booted`.
 * Also used (GH#202 Phase 4) against `simctl listapps <udid>` — same plist
 * shape; live-gated against a real device in Phase 4.
 * Output is NeXTSTEP plist; top-level keys are quoted bundle IDs at exactly
 * 4-space indentation, e.g. `    "com.foo.bar" = {`. We match that pattern
 * explicitly so we don't pick up nested keys like GroupContainers entries.
 */
```

Add the orchestrator (below `selectInstalledLegacyApps`; `eradicateLegacyRunnerApps` takes full deps so callers reuse one deps object):

```typescript
export interface EradicateLegacyAppsResult {
  removedApps: string[];
  warnings: string[];
}

// GH#202 Phase 4: error-safe by contract — every failure becomes a warning;
// a device-open is never blocked on eradication. Runs on EVERY device-open
// (no memo): the scan is one simctl listapps (~tens of ms), and a memo would
// go stale whenever another bridge/agent-device session reinstalls the legacy
// app on the same UDID — the device lock's degraded fail-open path cannot
// rule that out. async only for call-site uniformity with ensureSingleRunner
// (body is sync execFileSync).
export async function eradicateLegacyRunnerApps(
  udid: string,
  deps: EnsureSingleRunnerDeps,
): Promise<EradicateLegacyAppsResult> {
  const removedApps: string[] = [];
  const warnings: string[] = [];
  let installed: Set<string>;
  try {
    installed = parseSimctlListapps(deps.listApps(udid));
  } catch (err) {
    return { removedApps, warnings: [`listapps failed: ${msg(err)}`] };
  }
  // A booted simulator always carries built-in system apps; zero parsed ids
  // means the listapps format changed (parse failure), not a clean device.
  if (installed.size === 0) {
    return { removedApps, warnings: [`listapps parsed 0 apps — treating as parse failure, not a clean device`] };
  }
  // No terminate step: `simctl uninstall` terminates a running app itself,
  // and the Phase 1 scopedKill has already SIGTERM/SIGKILLed legacy procs.
  for (const id of selectInstalledLegacyApps(installed)) {
    try {
      deps.uninstallApp(udid, id);
      removedApps.push(id);
    } catch (err) {
      warnings.push(
        `uninstall ${id} failed: ${msg(err)} — remove manually: xcrun simctl uninstall ${udid} ${id}`,
      );
    }
  }
  return { removedApps, warnings };
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

### Task 3: Wire into `ensureSingleRunner` — result field, timings (scan every open)

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/ensure-single-runner.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`

- [ ] **Step 1: Write the failing tests**

Append to the test file:

```javascript
import { ensureSingleRunner } from '../../dist/runners/ensure-single-runner.js';

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
    uninstallApp: () => {},
    ...over,
  };
}

test('GH#202-P4 ensureSingleRunner(udid): result carries removedApps + appEradication timing', async () => {
  const r = await ensureSingleRunner({ udid: 'UDID-A' }, fullDeps());
  assert.deepEqual(r.removedApps, [
    'com.callstack.agentdevice.runner',
    'com.callstack.agentdevice.runner.uitests.xctrunner',
  ]);
  assert.ok('appEradication' in r.meta.timings_ms);
});

// Review-2 decision (2026-06-10): NO memo. Another bridge / agent-device
// session can reinstall the legacy app on the same UDID mid-session (the
// device lock's degraded fail-open path can't rule it out), so every open
// re-scans — the scan is one listapps, ~tens of ms.
test('GH#202-P4 ensureSingleRunner: every udid open re-scans (no memo)', async () => {
  let listCalls = 0;
  const deps = fullDeps({ listApps: () => { listCalls += 1; return LISTAPPS_CLEAN; } });
  await ensureSingleRunner({ udid: 'UDID-A' }, deps);
  await ensureSingleRunner({ udid: 'UDID-A' }, deps);
  assert.equal(listCalls, 2);
});

test('GH#202-P4 ensureSingleRunner (startup, no udid): never touches simctl', async () => {
  let touched = false;
  const r = await ensureSingleRunner({}, fullDeps({ listApps: () => { touched = true; return ''; } }));
  assert.equal(touched, false);
  assert.deepEqual(r.removedApps, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-phase4-eradicate-legacy-apps.test.js`
Expected: FAIL — `removedApps` undefined on the result (deepEqual against an array fails)

- [ ] **Step 3: Implement the wiring**

In `ensure-single-runner.ts`:

1. Extend the result interface:

```typescript
export interface EnsureSingleRunnerResult {
  killedPids: number[];
  removedFiles: string[];
  removedApps: string[];
  warnings: string[];
  meta: { timings_ms: Record<string, number> };
}
```

2. Inside `ensureSingleRunner`, declare `const removedApps: string[] = [];` next to the other accumulators; inside the existing `if (opts.udid) { ... }` block, after `timings.scopedKill = Date.now() - t;`, add:

```typescript
    // Runs on every device-open (no memo — see eradicateLegacyRunnerApps).
    // Stays on the awaited path on purpose: an installed legacy runner must
    // be GONE before the first maestro/WDA flow of the session, or iOS can
    // relaunch it into the foreground mid-flow (#202 comment 2026-06-08).
    const tApps = Date.now();
    const apps = await eradicateLegacyRunnerApps(opts.udid, deps);
    removedApps.push(...apps.removedApps);
    warnings.push(...apps.warnings);
    timings.appEradication = Date.now() - tApps;
```

3. Return `removedApps` in the result object:

```typescript
  return { killedPids, removedFiles, removedApps, warnings, meta: { timings_ms: timings } };
```

- [ ] **Step 4 (MANDATORY — plan-review blocker, Claude+Gemini consensus 2026-06-10): update the pre-existing suite's `baseDeps`**

The old `gh-202-ensure-single-runner.test.js` udid-bearing tests would reach `eradicateLegacyRunnerApps` with `deps.listApps === undefined`. That does NOT crash — the try/catch converts the `TypeError` into a `listapps failed:` warning — so the suite would stay green while silently exercising the failure path on every run. Do not wait for a failure signal that cannot arrive; update the helper unconditionally.

In `scripts/cdp-bridge/test/unit/gh-202-ensure-single-runner.test.js`, extend the `baseDeps` helper:

```javascript
function baseDeps(over = {}) {
  return {
    listProcesses: () => PS,
    kill: () => {},
    isAlive: () => false,
    readDaemonPid: () => null,
    fileExists: () => false,
    removeFile: () => {},
    delay: async () => {},
    listApps: () => LISTAPPS_NONE,
    uninstallApp: () => {},
    ...over,
  };
}
```

with a minimal fixture at the top of that file (one non-legacy app so the zero-apps parse guard doesn't add a warning to these tests):

```javascript
const LISTAPPS_NONE = '{\n    "com.rndevagent.testapp" =     {\n        ApplicationType = User;\n    };\n}';
```

- [ ] **Step 5: Run the full unit suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS, including the updated `gh-202-ensure-single-runner.test.js`, with zero `listapps failed:` warnings asserted implicitly (the old tests' `warnings` assertions stay valid). Expected total: ~1908+ tests passing.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/runners/ensure-single-runner.ts scripts/cdp-bridge/test/unit/gh-202-phase4-eradicate-legacy-apps.test.js scripts/cdp-bridge/test/unit/gh-202-ensure-single-runner.test.js
git commit -m "feat(#202-p4): wire app eradication into ensureSingleRunner (scan every open)"
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
Phase 4 (#202) extends this to the installed apps themselves: at device-open, `ensureSingleRunner` also `simctl uninstall`s the legacy `com.callstack.agentdevice.runner{,.uitests.xctrunner}` bundles (scanned at every open — one `simctl listapps`, ~tens of ms; same `RN_DEVICE_KILL_LEGACY=0` opt-out), because killing processes can't stop iOS relaunching an installed XCUITest runner mid-flow.
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

At iOS device-open, `ensureSingleRunner` now detects the legacy upstream runner apps installed on the target simulator (`com.callstack.agentdevice.runner` + `.uitests.xctrunner`) and `simctl uninstall`s them. Killing the host processes (Phase 1) was insufficient: iOS relaunches an installed XCUITest runner into the foreground mid-`maestro_run`, backgrounding the app under test and wedging CDP. Scanned at every device-open (one `simctl listapps`, ~tens of ms — no memo, so a reinstall by another session is always caught); error-safe (warnings, never a blocked session); opt out with `RN_DEVICE_KILL_LEGACY=0`. Results surface as `removedApps` + `meta.timings_ms.appEradication`.
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
import { ensureSingleRunner, LEGACY_BUNDLE_IDS } from '../dist/runners/ensure-single-runner.js';
import { parseSimctlListapps } from '../dist/cdp/discovery.js';

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

// Detect via the SAME parser production ships (review-2 BLOCKER): a raw
// .includes() also matches nested GroupContainers keys and would keep this
// gate green even if parseSimctlListapps stopped reading real listapps
// output — the exact regression this gate exists to catch.
const parsedApps = () => parseSimctlListapps(sh('xcrun', ['simctl', 'listapps', udid]));
const installed = () => parsedApps().has(LEGACY_ID);

// Prove the parser reads the real `listapps <udid>` form (it was field-
// verified only against `listapps booted` in B116): a booted sim always has
// system apps, so an empty parse means the format assumption broke.
if (parsedApps().size === 0) { console.error('GATE FAIL: parseSimctlListapps reads 0 apps from real listapps output'); process.exit(1); }

if (!installed()) { console.error('GATE FAIL: stub install did not take (or parser cannot see it)'); process.exit(1); }
console.log(`planted ${LEGACY_ID} on ${udid}`);

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

- **Spec §1 coverage:** detection/uninstall (Tasks 1–2), gate via existing env at call site (unchanged — verified `device-session.ts:268` gates `RN_DEVICE_KILL_LEGACY !== '0'` before calling), the udid-bearing call site inherits (Task 3 wires inside `ensureSingleRunner`), failure handling + `removedApps` + timings (Tasks 2–3), docs (Task 5), unit + live gate (Tasks 1–3, 7). Boot-time call (`index.ts:130`, no udid) untouched by design.
- **Type consistency:** `EnsureSingleRunnerDeps` gains `listApps/uninstallApp` (Task 2) before `fullDeps` uses them (Task 3); `EnsureSingleRunnerResult.removedApps` (Task 3) before `device-session.ts` reads it (Task 4). `msg()` helper already exists at module bottom.
- **Known risk, resolved by plan review:** pre-existing `gh-202-ensure-single-runner.test.js` deps objects lack the new members; the try/catch would swallow the resulting `TypeError` into a warning, keeping the suite green while silently running the failure path. Task 3 Step 4 now updates `baseDeps` unconditionally (review consensus: Claude + Gemini).

## Amendments applied from the multi-LLM plan review (2026-06-10)

**Round 1 — Gemini + coordinator's independent Claude research** (Codex quota-blocked):

1. **BLOCKER — mandatory `baseDeps` update** in the pre-existing suite (Task 3 Step 4): the missing-deps `TypeError` is swallowed by the fail-open try/catch, so the "fix if it throws" contingency could never trigger. Now unconditional, with a `LISTAPPS_NONE` fixture.
2. **SHOULD-FIX — zero-apps parse guard** (Task 2): a successful `listapps` that parses to 0 bundle ids is a parse/format failure (warning), not a clean device — a booted simulator always has system apps, so 0 proves the 4-space-indent plist assumption broke (e.g. future Xcode). New unit test added.
3. **Refactor fallout:** `selectInstalledLegacyApps` takes the parsed `Set<string>` (one parse per scan). `async` kept for call-site uniformity with a comment.
4. **Spec correction:** spec §1 claimed `cdp_repair_action` self-bootstrap as a second udid-bearing `ensureSingleRunner` caller — grep shows only `device-session.ts` (udid) and `index.ts` boot (no udid). Spec text amended.

**Round 2 — second-reviewer pass** (Antigravity MCP not registered in this session, so the reviewer agent performed a source-verified pass itself; register via `claude mcp add antigravity` for next time):

5. **BLOCKER — live gate detects via `parseSimctlListapps`, not `.includes()`** (Task 7): a raw substring also matches nested `GroupContainers` keys, so the gate could stay green while the production parser regressed — the exact drift the gate exists to catch. The gate now also asserts the parser reads real `listapps <udid>` output non-empty (it was field-verified only against `booted` in B116).
6. **SHOULD-FIX — memo dropped entirely** (Task 3): the memo's safety rested on "one bridge per UDID", but the Phase 1.5 device lock fails open in its degraded path (`device-lock.ts:108`), so another bridge/agent-device session can reinstall the legacy app on a memoized-clean UDID. Scan every open instead (one `listapps`, ~tens of ms); `clean` field and `resetLegacyAppMemoForTests` removed as fallout. Spec §1 cost bullet amended.
7. **SHOULD-FIX — `terminateApp` dropped** (Task 2): `simctl uninstall` terminates a running app itself, and Phase 1's scopedKill already ran; the unconditional catch around terminate masked real signals for zero benefit.
8. **Justified the awaited path** (Task 3 wiring comment): eradication must complete before the session's first maestro/WDA flow or iOS can relaunch the legacy runner mid-flow — same urgency argument as the Phase 1 kill.
9. **Changeset phrasing** fixed (no memo claim; scan-every-open).
10. `parseSimctlListapps` doc comment in `discovery.ts` updated to record the `<udid>` form reliance (Task 2).
