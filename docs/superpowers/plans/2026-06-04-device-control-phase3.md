# Device-Control Phase 3 Implementation Plan — 3-layer contract + proactive foreign-runner warning

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Formalize the three-layer device-control contract in docs, and add a proactive, informational `FOREIGN_RUNNER_ACTIVE` warning when an iOS device session opens while a foreign maestro/WebDriverAgent automation session is present.

**Architecture:** Two new pure functions in `external-runner-detect.ts` (`detectIosExternalRunner` mirroring the existing Android detector, and `foreignRunnerNotice` which applies the arbiter-flow-lease gate + builds the result meta), thin glue in `device-session.ts`'s `action=open` success path, and three documentation edits. The *reactive* recovery (runner-leak reacquire + CDP re-pin) already shipped in #188 — this plan does not touch it.

**Tech Stack:** TypeScript (Node ≥22, ESM), `node --test` (hermetic, tests import compiled JS from `dist/`), Astro Starlight (`docs-site`), changesets.

**Spec:** `docs/superpowers/specs/2026-06-04-device-control-phase3-design.md` (see §0 reconciliation).

---

### Task 0: Live `ps` validation (DONE — 2026-06-04)

Performed before coding (per spec §4, and required by the multi-LLM plan review). Ran a real maestro flow against a booted iPhone 17 Pro (UDID `FC78646A-56D5-4737-9CD0-A360D622F3B3`) and captured `ps ax -o pid=,command=`. Findings that shaped Tasks 1 & 3:
- maestro's iOS driver is **`maestro-driver-iosUITests-Runner`** (not WebDriverAgent), and its process path **carries the target UDID** (`…/Devices/<UDID>/…`); `xcodebuild … -destination id=<UDID> … maestro-driver-ios-config.xctestrun` carries it too.
- the **idle** maestro-mcp server (`java … maestro.cli.AppKt mcp`) carries **no UDID**.

Conclusion: the detector is viable; the matcher targets `maestro` (not WebDriverAgent), and **UDID-scoping is mandatory** (it excludes the idle server + other-sim flows). No code in this task — it's the empirical basis for Task 1's matcher + tests.

---

### Task 1: `detectIosExternalRunner()` — iOS foreign-runner detector

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/external-runner-detect.ts` (append, after `detectAndroidExternalRunner`)
- Test: `scripts/cdp-bridge/test/unit/gh-202-detect-ios-external-runner.test.js`

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/gh-202-detect-ios-external-runner.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectIosExternalRunner } from '../../dist/runners/external-runner-detect.js';

const fakePs = (stdout) => async () => ({ stdout });

// Real signatures captured from a live `ps ax -o command=` during a maestro flow (Task 0).
const UDID = 'FC78646A-56D5-4737-9CD0-A360D622F3B3';
const OTHER_UDID = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
const MAESTRO_DRIVER = `18225 /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/data/Containers/Bundle/Application/155F/maestro-driver-iosUITests-Runner.app/maestro-driver-iosUITests-Runner`;
const MAESTRO_XCODEBUILD = `17754 /Applications/Xcode.app/.../xcodebuild test-without-building -xctestrun /tmp/${UDID}/maestro-driver-ios-config.xctestrun -destination id=${UDID}`;
const MAESTRO_MCP_IDLE = '14013 java -classpath /Users/x/.maestro/lib/* maestro.cli.AppKt mcp'; // NB: carries no UDID
const OUR_RUNNER = `99 /Users/x/Library/Developer/CoreSimulator/Devices/${UDID}/.../RnFastRunnerUITests-Runner.app/RnFastRunnerUITests-Runner`;

test('detectIosExternalRunner: flags a foreign maestro driver on the target UDID', async () => {
  const ps = fakePs(`${MAESTRO_DRIVER}\n${MAESTRO_XCODEBUILD}\n800 /usr/bin/login\n`);
  const w = await detectIosExternalRunner(ps, UDID);
  assert.ok(w);
  assert.equal(w.platform, 'ios');
  assert.equal(w.code, 'IOS_XCUITEST_COMPETITOR');
  assert.equal(w.processLines.length, 2);
  assert.match(w.processLines[0], /maestro-driver-iosUITests-Runner/);
});

test('detectIosExternalRunner: UDID-scopes — a maestro flow on a DIFFERENT sim is ignored', async () => {
  const ps = fakePs(MAESTRO_DRIVER + '\n');
  assert.equal(await detectIosExternalRunner(ps, OTHER_UDID), null);
});

test('detectIosExternalRunner: ignores the idle maestro-mcp server (no UDID)', async () => {
  const ps = fakePs(`${MAESTRO_MCP_IDLE}\n800 /usr/bin/login\n`);
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});

test('detectIosExternalRunner: excludes our own RnFastRunner even on the target UDID', async () => {
  const ps = fakePs(OUR_RUNNER + '\n');
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});

test('detectIosExternalRunner: null when no automation process present', async () => {
  const ps = fakePs('801 /usr/bin/login\n802 /System/Library/Foo\n');
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});

test('detectIosExternalRunner: error-safe when ps fails', async () => {
  const ps = async () => { throw new Error('ps blew up'); };
  assert.equal(await detectIosExternalRunner(ps, UDID), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-202-detect-ios-external-runner.test.js`
Expected: FAIL — `detectIosExternalRunner` is not exported (import resolves to `undefined`).

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/cdp-bridge/src/runners/external-runner-detect.ts` (the file already imports `execFile` from `node:child_process` and `promisify` from `node:util`):

```ts
export interface IosExternalRunnerWarning {
  platform: 'ios';
  code: 'IOS_XCUITEST_COMPETITOR';
  message: string;
  processLines: string[];
}

// Validated against live `ps` (2026-06-04): maestro's iOS driver is
// `maestro-driver-iosUITests-Runner` — the `maestro` token catches it, the
// `.xctestrun`, and the java CLI. `WebDriverAgent` is a harmless secondary for
// Appium/WDA-style foreign tools. `XCTRunner` is intentionally NOT matched (too
// generic). The UDID filter is the real defense: the idle maestro-mcp server
// (`java … maestro.cli.AppKt mcp`) carries NO UDID, so scoping excludes it.
const IOS_FOREIGN_RE = /maestro|WebDriverAgent/i;
const RN_FAST_RUNNER_RE = /RnFastRunner/i;

export async function detectIosExternalRunner(
  execFileImpl: typeof execFile = execFile,
  udid?: string,
): Promise<IosExternalRunnerWarning | null> {
  try {
    const opts = { timeout: 2_000, encoding: 'utf8' as const };
    const run = execFileImpl === execFile
      ? promisify(execFileImpl)
      : (execFileImpl as unknown as (
          b: string,
          a: string[],
          o: typeof opts,
        ) => Promise<{ stdout: string }>);
    const { stdout } = await run('ps', ['ax', '-o', 'pid=,command='], opts);
    const lines = stdout
      .split('\n')
      .filter((line) => IOS_FOREIGN_RE.test(line))
      .filter((line) => !RN_FAST_RUNNER_RE.test(line))
      .filter((line) => (udid ? line.includes(udid) : true))
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    if (lines.length === 0) return null;

    return {
      platform: 'ios',
      code: 'IOS_XCUITEST_COMPETITOR',
      message:
        'A foreign maestro/WebDriverAgent automation session is driving this simulator. ' +
        'Interleaving device_* with it may trigger a re-foreground of your app; CDP reads are unaffected. ' +
        '(If this is your own maestro flow, it is expected.)',
      processLines: lines,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Build + run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-detect-ios-external-runner.test.js`
Expected: PASS (6/6). (Tests import from `dist/`, so the build must run first.)

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/external-runner-detect.ts \
        scripts/cdp-bridge/dist/runners/external-runner-detect.js \
        scripts/cdp-bridge/test/unit/gh-202-detect-ios-external-runner.test.js
git commit -S -m "feat(#202): detectIosExternalRunner — iOS foreign maestro/WDA detection (Phase 3)"
```

---

### Task 2: `foreignRunnerNotice()` — gate + result-meta builder

This pure helper holds the arbiter-flow-lease gate and the meta shape, so the gating logic is unit-tested independently of `device-session.ts`'s hard module imports.

**Files:**
- Modify: `scripts/cdp-bridge/src/runners/external-runner-detect.ts` (append)
- Test: `scripts/cdp-bridge/test/unit/gh-202-foreign-runner-notice.test.js`

- [ ] **Step 1: Write the failing test**

```js
// scripts/cdp-bridge/test/unit/gh-202-foreign-runner-notice.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foreignRunnerNotice } from '../../dist/runners/external-runner-detect.js';

const detection = {
  platform: 'ios',
  code: 'IOS_XCUITEST_COMPETITOR',
  message: 'A foreign WebDriverAgent/maestro automation session is running on this simulator.',
  processLines: ['601 /opt/homebrew/bin/maestro test flow.yaml'],
};

test('foreignRunnerNotice: builds notice when foreign present and no flow lease', () => {
  const n = foreignRunnerNotice(detection, false);
  assert.ok(n);
  assert.equal(n.meta.foreignRunner.code, 'IOS_XCUITEST_COMPETITOR');
  assert.deepEqual(n.meta.foreignRunner.processLines, ['601 /opt/homebrew/bin/maestro test flow.yaml']);
  assert.match(n.warning, /^FOREIGN_RUNNER_ACTIVE:/);
});

test('foreignRunnerNotice: null when WE hold the flow lease (the WDA is ours)', () => {
  assert.equal(foreignRunnerNotice(detection, true), null);
});

test('foreignRunnerNotice: null when no foreign process detected', () => {
  assert.equal(foreignRunnerNotice(null, false), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-202-foreign-runner-notice.test.js`
Expected: FAIL — `foreignRunnerNotice` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `scripts/cdp-bridge/src/runners/external-runner-detect.ts`:

```ts
export interface ForeignRunnerNotice {
  meta: { foreignRunner: { code: string; message: string; processLines: string[] } };
  warning: string;
}

/**
 * GH#202 Phase 3: decide whether to surface a proactive foreign-runner heads-up
 * on an iOS device-session open. Returns null when there's nothing to say:
 *   - we currently hold the arbiter flow lease (the WebDriverAgent is our OWN
 *     L3 maestro-runner, not a foreign session), OR
 *   - no foreign process was detected.
 * Informational only — the caller never blocks the open on this.
 */
export function foreignRunnerNotice(
  detection: IosExternalRunnerWarning | null,
  flowLeaseHeld: boolean,
): ForeignRunnerNotice | null {
  if (flowLeaseHeld) return null;
  if (!detection) return null;
  return {
    meta: {
      foreignRunner: {
        code: detection.code,
        message: detection.message,
        processLines: detection.processLines,
      },
    },
    warning: `FOREIGN_RUNNER_ACTIVE: ${detection.message}`,
  };
}
```

- [ ] **Step 4: Build + run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-202-foreign-runner-notice.test.js`
Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/runners/external-runner-detect.ts \
        scripts/cdp-bridge/dist/runners/external-runner-detect.js \
        scripts/cdp-bridge/test/unit/gh-202-foreign-runner-notice.test.js
git commit -S -m "feat(#202): foreignRunnerNotice — flow-lease-gated heads-up builder (Phase 3)"
```

---

### Task 3: Wire the proactive warning into the iOS `action=open` success path

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-session.ts` (imports + the `action=open` success tail, ~lines 14, 28, 299–311)

- [ ] **Step 1: Extend the imports**

Change line 14 from:

```ts
import { detectAndroidExternalRunner } from '../runners/external-runner-detect.js';
```

to:

```ts
import { detectAndroidExternalRunner, detectIosExternalRunner, foreignRunnerNotice } from '../runners/external-runner-detect.js';
```

And add an arbiter import directly after the existing `device-lock` import (line 28, `import type { DeviceLockResult, DeviceLockBody } from '../lifecycle/device-lock.js';`):

```ts
import { arbiter } from '../lifecycle/device-arbiter.js';
```

- [ ] **Step 2: Replace the open-success tail**

Find this exact block (the iOS `ensureFastRunner` + `autoDetected` return + the `return result;`):

```ts
        if (args.platform === 'ios' && deviceId) {
          ensureFastRunner(deviceId, appId).catch(() => { /* non-fatal */ });
        }

        if (autoDetected) {
          return warnResult(
            JSON.parse(result.content[0].text).data,
            `appId auto-detected from app.json: ${appId}`,
          );
        }
      }

      return result;
```

Replace it with:

```ts
        if (args.platform === 'ios' && deviceId) {
          ensureFastRunner(deviceId, appId).catch(() => { /* non-fatal */ });
        }

        // GH#202 Phase 3: proactive foreign-runner heads-up (informational only).
        // Skip when opted out, or when WE hold the flow lease (a detected maestro
        // driver is then our own L3 run — external opens are already refused
        // BUSY_FLOW_ACTIVE upstream; this guard covers composite/internal callers).
        // UDID-scoped + best-effort: the detector never throws (can't fail the
        // open); its ≤2s latency is surfaced in meta.timings_ms.
        let foreign: ReturnType<typeof foreignRunnerNotice> = null;
        let foreignDetectMs: number | undefined;
        if (platform === 'ios' && process.env.RN_IOS_FOREIGN_WARN !== '0') {
          const flowHeld = arbiter.snapshot.flowLeaseHeldBy !== null;
          if (!flowHeld) {
            const t0 = Date.now();
            const detection = await detectIosExternalRunner(undefined, deviceId);
            foreignDetectMs = Date.now() - t0;
            foreign = foreignRunnerNotice(detection, false);
          }
          if (foreign) {
            logger.warn('rn-device', foreign.warning);
            for (const line of foreign.meta.foreignRunner.processLines) {
              logger.warn('rn-device', `  ${line}`);
            }
          }
        }

        if (autoDetected || foreign) {
          const data = JSON.parse(result.content[0].text).data;
          const warning = [
            autoDetected ? `appId auto-detected from app.json: ${appId}` : null,
            foreign ? foreign.warning : null,
          ].filter(Boolean).join('; ');
          const meta: Record<string, unknown> = { ...(foreign ? foreign.meta : {}) };
          if (foreignDetectMs !== undefined) meta.timings_ms = { foreignDetect: foreignDetectMs };
          return warnResult(data, warning, meta);
        }
      }

      return result;
```

- [ ] **Step 3: Build to verify types**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: `tsc` exits 0, no errors. (`platform` is already in scope — declared at line 178 as `(args.platform ?? 'ios').toLowerCase()`.)

- [ ] **Step 4: Run the detector + notice tests to confirm no regression**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-202-detect-ios-external-runner.test.js test/unit/gh-202-foreign-runner-notice.test.js`
Expected: PASS (8/8).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-session.ts \
        scripts/cdp-bridge/dist/tools/device-session.js
git commit -S -m "feat(#202): surface FOREIGN_RUNNER_ACTIVE on iOS device-session open (Phase 3)"
```

---

### Task 4: Documentation — formalize the three-layer contract + handoff page

**Files:**
- Modify: `CLAUDE.md` (add a contract subsection in the Architecture section)
- Modify: `docs-site/src/content/docs/architecture.mdx` (same contract table)
- Create: `docs-site/src/content/docs/guides/maestro-interop.mdx`
- Test: `scripts/cdp-bridge/test/unit/gh-202-contract-doc-presence.test.js`

- [ ] **Step 1: Write the failing doc-presence test**

```js
// scripts/cdp-bridge/test/unit/gh-202-contract-doc-presence.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('CLAUDE.md documents the three-layer device-control contract', () => {
  const md = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.match(md, /Three-layer device-control contract/i);
  assert.match(md, /L1 INTROSPECTION/);
  assert.match(md, /L2 INTERACTION/);
  assert.match(md, /L3 FLOW-REPLAY/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-202-contract-doc-presence.test.js`
Expected: FAIL — the heading does not exist in `CLAUDE.md` yet.

- [ ] **Step 3: Add the contract subsection to `CLAUDE.md`**

In `CLAUDE.md`, in the `## Architecture (for contributors)` section, immediately **before** the `### MCP Server (cdp-bridge)` heading, insert:

```markdown
### Three-layer device-control contract

One mechanism per capability tier. The device-session honors this contract (the L2 coexistence behavior shipped in #188; #202 Phase 3 wrote it down + added a proactive warning).

| Layer | Mechanism | Role | Exclusivity | Toward a foreign runner |
|---|---|---|---|---|
| **L1 INTROSPECTION** | CDP / Hermes | read store / network / component-tree / mmkv / native | **shared** | always safe — never touches XCUITest |
| **L2 INTERACTION** | iOS `RnFastRunner` / Android `agent-device`; `cdp_interact` | primitive taps / types / scrolls | **shared** | re-attach, don't evict (Tier-0 reacquire + CDP re-pin, #188) |
| **L3 FLOW-REPLAY** | `maestro-runner` (Go + WDA) | whole-`.yaml` E2E flows | **exclusive** | owns the device for the flow's duration |

**Coexistence rule:** L1 reads never conflict with a foreign runner; L2 re-attaches rather than evicts; L3 owns the device. On `device_snapshot action=open`, if a foreign maestro/WDA session is detected AND no local flow lease is held, the open result carries an informational `meta.foreignRunner` + `FOREIGN_RUNNER_ACTIVE` warning (see `runners/external-runner-detect.ts`). See [docs-site › Using rn-dev-agent with maestro-mcp](docs-site/src/content/docs/guides/maestro-interop.mdx).

```

- [ ] **Step 4: Add the same contract table to `architecture.mdx`**

In `docs-site/src/content/docs/architecture.mdx`, after the existing device-tier table (the row block ending with the `Fallback: ...` line), insert a new section:

```markdown
## Three-layer device-control contract

One mechanism per capability tier — **L1 + L2 coexist** (drive with XCTest, assert with CDP in the same per-step loop); **L3 is exclusive** (owns the device for the flow).

| Layer | Mechanism | Role | Exclusivity |
|---|---|---|---|
| **L1 INTROSPECTION** | CDP / Hermes | read store / network / component-tree / mmkv / native | shared |
| **L2 INTERACTION** | iOS `RnFastRunner` / Android `agent-device`; `cdp_interact` | primitive taps / types / scrolls | shared |
| **L3 FLOW-REPLAY** | `maestro-runner` (Go + WDA) | whole-`.yaml` E2E flows | exclusive |

**Foreign runners** (e.g. the standalone `maestro-mcp`): L1 reads are always safe; on an L2 leak the device-session re-attaches rather than evicts (#188); `device_snapshot action=open` surfaces an informational `FOREIGN_RUNNER_ACTIVE` warning when a foreign session is present and no local flow is running.
```

- [ ] **Step 5: Create the handoff guide**

Create `docs-site/src/content/docs/guides/maestro-interop.mdx`:

```mdx
---
title: Using rn-dev-agent with maestro-mcp
description: How rn-dev-agent coexists with the standalone maestro-mcp server on one iOS simulator.
---

rn-dev-agent and the standalone **maestro-mcp** server can be used together: maestro *executes* resilient flows, rn-dev-agent *verifies* internal state. They share one iOS simulator, so this page describes how they coexist.

## What is safe to interleave

- **L1 introspection (CDP reads)** — `cdp_navigation_state`, `cdp_store_state`, `cdp_component_tree`, etc. — is **always safe**. It reads Hermes over CDP and never touches the XCUITest automation channel maestro uses.
- **L2 interaction** (`device_*`) shares the XCUITest channel with maestro's WebDriverAgent. After a maestro run, the next `device_*` may find the channel evicted.

## What happens on handback (already automatic)

When an L2 call sees the runner-leak sentinel after a maestro run, the device-session performs a **state-preserving reacquire** — it re-foregrounds your app (no relaunch) and marks CDP stale so the next read transparently reconnects. You do **not** need a manual `cdp_status` re-pin (shipped in #188).

## The `FOREIGN_RUNNER_ACTIVE` warning

When you `device_snapshot action=open` while a foreign maestro/WebDriverAgent session is running (and rn-dev-agent is not itself running a flow), the open result carries an informational `meta.foreignRunner` and a `FOREIGN_RUNNER_ACTIVE` warning. It is a **heads-up only** — it does not block or change the open. It tells you the simulator is contended so you can expect a re-foreground if you interleave `device_*`.

## L3 flows own the device

A `maestro_run` / `maestro_test_all` flow (rn-dev-agent's own L3) takes the device exclusively for its duration — `device_*` and CDP reads issued mid-flow refuse fast with `BUSY_FLOW_ACTIVE`.
```

- [ ] **Step 6: Run the doc-presence test to verify it passes**

Run: `cd scripts/cdp-bridge && node --test test/unit/gh-202-contract-doc-presence.test.js`
Expected: PASS (1/1).

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md \
        docs-site/src/content/docs/architecture.mdx \
        docs-site/src/content/docs/guides/maestro-interop.mdx \
        scripts/cdp-bridge/test/unit/gh-202-contract-doc-presence.test.js
git commit -S -m "docs(#202): formalize the three-layer device-control contract + maestro-mcp handoff (Phase 3)"
```

---

### Task 5: Changeset + full suite + dist freshness

**Files:**
- Create: `.changeset/device-foreign-runner-202-phase3.md`

- [ ] **Step 1: Write the changeset**

```markdown
---
"rn-dev-agent-plugin": patch
---

#202 Phase 3: formalize the three-layer device-control contract (L1 introspection / L2 interaction / L3 flow) in the docs, and add a proactive, informational `FOREIGN_RUNNER_ACTIVE` warning. When `device_snapshot action=open` finds a foreign maestro/WebDriverAgent automation session on the simulator and rn-dev-agent is not itself running a flow, the open result now carries `meta.foreignRunner` + a heads-up that interleaving `device_*` may trigger a re-foreground (CDP reads are unaffected). The reactive recovery for an actual leak shipped earlier in #188; this is the complementary proactive signal.
```

- [ ] **Step 2: Rebuild dist and confirm no drift**

Run: `cd scripts/cdp-bridge && npm run build && git status --porcelain scripts/cdp-bridge/dist`
Expected: only the already-committed dist files; no unexpected drift. If anything is unstaged, `git add` it.

- [ ] **Step 3: Run the full suite**

Run: `cd scripts/cdp-bridge && npm test 2>&1 | grep -E '^ℹ (tests|pass|fail)'`
Expected: `fail 0`, and the count is up by the 10 new tests (6 + 3 + 1).

- [ ] **Step 4: Commit**

```bash
git add .changeset/device-foreign-runner-202-phase3.md
git commit -S -m "chore(#202): changeset for Phase 3 foreign-runner contract + warning"
```

---

## Self-review checklist (run before handing off to execution)

- **Spec coverage:** §0 reconciliation (no recovery rebuild) → respected (no edits to `runner-leak-recovery.ts`). §2 contract → Task 4. §3 docs → Task 4. §4 `detectIosExternalRunner` + the live-`ps` validation + UDID-scoping → Task 0 + Task 1. §5 proactive warning + flow-lease gate + opt-out + timings → Tasks 2 + 3. §8 tests → Tasks 1/2/4 (incl. UDID-scope + idle-server + different-sim cases).
- **Type consistency:** `IosExternalRunnerWarning` (Task 1) is consumed by `foreignRunnerNotice` (Task 2) and the device-session wiring (Task 3). `ForeignRunnerNotice.meta` is passed straight to `warnResult(data, warning, meta)`.
- **No placeholders:** every code step shows complete code.
- **Gate correctness:** the flow-lease gate is checked once (Task 3 computes `flowHeld` and skips the ps-scan when held); `foreignRunnerNotice` re-applies it as the single source of truth for the meta decision (and is unit-tested in isolation).
