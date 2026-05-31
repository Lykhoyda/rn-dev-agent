# Dev Client Picker Dismiss (#136 sub-3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the existing Dev Client "Development servers" picker dismissal as an on-demand MCP tool (`cdp_dismiss_dev_client_picker`) and auto-dismiss it after Android deep links, both routed through one guarded helper.

**Architecture:** A single guarded seam `clearDevClientPickerIfPresent(platform?)` wraps the existing (unchanged) Android `handleDevClientPicker()`; it short-circuits on iOS with an actionable message (so it never respawns the legacy `AgentDeviceRunner`). A thin MCP handler maps the seam's outcome to a `ToolResult`; `device_deeplink` calls the seam best-effort after a successful Android open.

**Tech Stack:** TypeScript (Node ≥22, ESM), `zod` for the MCP schema, `node:test` for unit tests (run against built `dist/`), changesets for versioning.

**Spec:** `docs/superpowers/specs/2026-05-31-devclient-picker-dismiss-sub3-design.md`

**Base:** branch `feat/gh-136-devclient-picker-dismiss` off `origin/main` @ `5c4ca04`. Registered-tool count is **75** here; this adds one → **76**.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `scripts/cdp-bridge/src/tools/dev-client-picker.ts` | Picker logic (unchanged Android core) + **new** guarded helper + MCP handler factory | Modify |
| `scripts/cdp-bridge/src/tools/device-deeplink.ts` | Deep-link tool + **new** exported `annotatePicker` + best-effort dismissal on Android success | Modify |
| `scripts/cdp-bridge/src/index.ts` | Register `cdp_dismiss_dev_client_picker` | Modify |
| `scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js` | Unit tests: helper iOS-guard, handler mapping, `annotatePicker` | Create |
| `docs-site/src/content/docs/dev-client-coverage.md` | Move "No MCP-exposed picker-dismiss tool" Deferred → Fixed | Modify |
| `docs-site/src/content/docs/troubleshooting.mdx`, `skills/rn-testing/SKILL.md` | Replace racy `runFlow when: visible: "DEVELOPMENT SERVERS"` pattern with the new tool | Modify |
| `CLAUDE.md` | Tool count 75 → 76; list tool under device helpers | Modify |
| `.changeset/devclient-picker-dismiss.md` | patch bump for `rn-dev-agent-plugin` + `rn-dev-agent-cdp` | Create |

**Key contracts (defined in Task 1, used everywhere after):**

```typescript
export interface PickerOutcome {
  dismissed: boolean;
  reason: string;
  skipped?: boolean;                       // true only on the iOS guard
  platform?: 'ios' | 'android' | null;
}
// Returns null ONLY when Android + no active device session (so the tool can emit NO_SESSION).
export function clearDevClientPickerIfPresent(
  platform?: 'ios' | 'android',
): Promise<PickerOutcome | null>;
export function createDismissDevClientPickerHandler(): (
  args: { platform?: 'ios' | 'android' },
) => Promise<ToolResult>;
```

---

### Task 1: Guarded helper `clearDevClientPickerIfPresent`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js`

- [ ] **Step 1: Write the failing tests** (create the file)

```javascript
// scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clearDevClientPickerIfPresent,
  _setRunAgentDeviceForTest,
  _setHasSessionForTest,
  _resetRunAgentDeviceForTest,
  _resetHasSessionForTest,
} from '../../dist/tools/dev-client-picker.js';

test('helper: iOS is guarded — skips without calling runAgentDevice', async () => {
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => { calls.push(args); return { content: [{ type: 'text', text: '{}' }] }; });
  const out = await clearDevClientPickerIfPresent('ios');
  assert.equal(calls.length, 0, 'runAgentDevice must never be called on iOS');
  assert.equal(out.skipped, true);
  assert.equal(out.dismissed, false);
  assert.equal(out.platform, 'ios');
  assert.match(out.reason, /manually/i);
  _resetRunAgentDeviceForTest();
});

test('helper: Android with no session returns null', async () => {
  _setHasSessionForTest(false);
  const out = await clearDevClientPickerIfPresent('android');
  assert.equal(out, null);
  _resetHasSessionForTest();
});

test('helper: Android delegates to handleDevClientPicker (auto-advance → dismissed)', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && args[1] === 'Development servers') {
      findCount += 1;
      // 1st find = detected; 2nd find (dismissPicker re-probe) = gone → auto-advanced
      return findCount >= 2
        ? { content: [{ type: 'text', text: 'not found' }], isError: true }
        : { content: [{ type: 'text', text: '{}' }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  });
  const out = await clearDevClientPickerIfPresent('android');
  assert.ok(out);
  assert.equal(out.dismissed, true);
  assert.equal(out.platform, 'android');
  _resetRunAgentDeviceForTest();
  _resetHasSessionForTest();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dismiss-picker-tool.test.js`
Expected: FAIL — `clearDevClientPickerIfPresent` is not exported (TypeScript build error or import error).

- [ ] **Step 3: Implement the helper**

In `scripts/cdp-bridge/src/tools/dev-client-picker.ts`, add to the imports at the top:

```typescript
import { runAgentDevice as _runAgentDeviceImpl, hasActiveSession, getActiveSession } from '../agent-device-wrapper.js';
import { detectPlatform } from './platform-utils.js';
```

(The first line replaces the existing `import { runAgentDevice as _runAgentDeviceImpl, hasActiveSession } from '../agent-device-wrapper.js';` — only `getActiveSession` is added.)

Add near the other exported types/functions (e.g. just below `PickerResult`):

```typescript
export interface PickerOutcome {
  dismissed: boolean;
  reason: string;
  skipped?: boolean;
  platform?: 'ios' | 'android' | null;
}

/**
 * GH #136 sub-3: the single guarded seam every on-demand/auto consumer routes
 * through. iOS is short-circuited with an actionable message — we must NOT call
 * handleDevClientPicker() there because its agent-device `find` path respawns
 * the legacy AgentDeviceRunner (D1219). Returns null ONLY for Android + no
 * device session, so the MCP tool can surface a NO_SESSION error.
 */
export async function clearDevClientPickerIfPresent(
  platform?: 'ios' | 'android',
): Promise<PickerOutcome | null> {
  const resolved = platform ?? getActiveSession()?.platform ?? (await detectPlatform());
  if (resolved === 'ios') {
    return {
      dismissed: false,
      skipped: true,
      platform: 'ios',
      reason: 'iOS Dev Client picker auto-dismiss is not supported yet — select the Metro server manually on the simulator.',
    };
  }
  if (resolved !== 'android') {
    return { dismissed: false, platform: resolved ?? null, reason: 'No iOS/Android device detected.' };
  }
  const res = await handleDevClientPicker();
  if (res === null) return null;
  return { ...res, platform: 'android' };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dismiss-picker-tool.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js
git commit -m "$(cat <<'EOF'
feat(#136): add guarded clearDevClientPickerIfPresent seam (sub-3)

Wraps the unchanged Android handleDevClientPicker(); iOS short-circuits
with an actionable message and never touches the legacy agent-device path.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: MCP handler `createDismissDevClientPickerHandler`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-client-picker.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```javascript
import { createDismissDevClientPickerHandler } from '../../dist/tools/dev-client-picker.js';

const handle = createDismissDevClientPickerHandler();
const parse = (r) => JSON.parse(r.content[0].text);

test('handler: no session → DEV_CLIENT_PICKER_NO_SESSION', async () => {
  _setHasSessionForTest(false);
  const r = await handle({ platform: 'android' });
  assert.equal(r.isError, true);
  assert.equal(parse(r).code, 'DEV_CLIENT_PICKER_NO_SESSION');
  _resetHasSessionForTest();
});

test('handler: iOS → warn, dismissed:false, never calls runAgentDevice', async () => {
  const calls = [];
  _setRunAgentDeviceForTest(async (args) => { calls.push(args); return { content: [{ type: 'text', text: '{}' }] }; });
  const r = await handle({ platform: 'ios' });
  assert.equal(r.isError, undefined);
  const p = parse(r);
  assert.equal(p.dismissed, false);
  assert.equal(p.platform, 'ios');
  assert.match(p.warning, /manually/i);
  assert.equal(calls.length, 0);
  _resetRunAgentDeviceForTest();
});

test('handler: Android dismissed → ok dismissed:true with timings', async () => {
  _setHasSessionForTest(true);
  let findCount = 0;
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && args[1] === 'Development servers') {
      findCount += 1;
      return findCount >= 2
        ? { content: [{ type: 'text', text: 'gone' }], isError: true }
        : { content: [{ type: 'text', text: '{}' }] };
    }
    return { content: [{ type: 'text', text: '{}' }] };
  });
  const r = await handle({ platform: 'android' });
  const p = parse(r);
  assert.equal(p.dismissed, true);
  assert.ok(p.meta && typeof p.meta.timings_ms.total === 'number');
  _resetRunAgentDeviceForTest();
  _resetHasSessionForTest();
});

test('handler: Android picker not detected → ok dismissed:false (no warning)', async () => {
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async () => ({ content: [{ type: 'text', text: 'not found' }], isError: true }));
  const r = await handle({ platform: 'android' });
  assert.equal(r.isError, undefined);
  const p = parse(r);
  assert.equal(p.dismissed, false);
  assert.equal(p.warning, undefined);
  _resetRunAgentDeviceForTest();
  _resetHasSessionForTest();
});

test('handler: Android detected but no entry → warn dismissed:false', async () => {
  _setHasSessionForTest(true);
  _setRunAgentDeviceForTest(async (args) => {
    if (args[0] === 'find' && args[1] === 'Development servers') return { content: [{ type: 'text', text: '{}' }] };
    if (args[0] === 'snapshot') return { content: [{ type: 'text', text: 'Development servers\nEnter URL manually' }] };
    return { content: [{ type: 'text', text: '{}' }] };
  });
  const r = await handle({ platform: 'android' });
  const p = parse(r);
  assert.equal(p.dismissed, false);
  assert.match(p.warning, /could not find|manually/i);
  _resetRunAgentDeviceForTest();
  _resetHasSessionForTest();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dismiss-picker-tool.test.js`
Expected: FAIL — `createDismissDevClientPickerHandler` is not exported.

- [ ] **Step 3: Implement the handler**

In `scripts/cdp-bridge/src/tools/dev-client-picker.ts`, ensure these are imported from utils (add a line near the top):

```typescript
import { okResult, failResult, warnResult } from '../utils.js';
```

(The file already imports `type { ToolResult }` from `../utils.js`; keep that and add the value imports above.)

Append at the end of the file:

```typescript
export function createDismissDevClientPickerHandler(): (
  args: { platform?: 'ios' | 'android' },
) => Promise<ToolResult> {
  return async (args) => {
    const t0 = Date.now();
    const outcome = await clearDevClientPickerIfPresent(args.platform);
    const meta = { timings_ms: { total: Date.now() - t0 } };

    if (outcome === null) {
      return failResult(
        'No device session open. Call device_snapshot action="open" first.',
        'DEV_CLIENT_PICKER_NO_SESSION',
        { meta },
      );
    }
    if (outcome.skipped) {
      return warnResult({ dismissed: false, platform: outcome.platform }, outcome.reason, { meta });
    }
    if (outcome.dismissed) {
      return okResult({ dismissed: true, reason: outcome.reason, platform: outcome.platform }, { meta });
    }
    if (outcome.reason.toLowerCase().includes('could not find')) {
      return warnResult({ dismissed: false, platform: outcome.platform }, outcome.reason, { meta });
    }
    return okResult({ dismissed: false, reason: outcome.reason, platform: outcome.platform }, { meta });
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dismiss-picker-tool.test.js`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-client-picker.ts scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js
git commit -m "$(cat <<'EOF'
feat(#136): map picker outcome to ToolResult in dismiss handler (sub-3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Register the `cdp_dismiss_dev_client_picker` MCP tool

**Files:**
- Modify: `scripts/cdp-bridge/src/index.ts`

- [ ] **Step 1: Add the import**

Add near the other tool-handler imports (next to line 59 `import { createDeviceDeeplinkHandler } from './tools/device-deeplink.js';`):

```typescript
import { createDismissDevClientPickerHandler } from './tools/dev-client-picker.js';
```

- [ ] **Step 2: Register the tool**

Add a `trackedTool(...)` block immediately after the `device_deeplink` registration block (which ends around `createDeviceDeeplinkHandler(),\n);`):

```typescript
trackedTool(
  'cdp_dismiss_dev_client_picker',
  'Dismiss the Expo Dev Client "Development servers" picker on demand. The picker is a native expo-dev-menu screen that blocks the JS bundle after deep links, restarts, permission changes, or clearState; this taps the configured Metro server entry so CDP/the bundle can proceed. Android only today (requires an open device session — call device_snapshot action="open" first). iOS returns an actionable manual-select message (cross-platform support tracked as a follow-up). Prefer this over a racy Maestro `runFlow when: visible: "DEVELOPMENT SERVERS"` block.',
  {
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Otherwise resolved from the active session or the booted device.'),
  },
  createDismissDevClientPickerHandler(),
);
```

- [ ] **Step 3: Build + verify registration**

Run: `cd scripts/cdp-bridge && npm run build && grep -c "^trackedTool(" src/index.ts && node -e "import('./dist/index.js').then(()=>console.log('import-ok')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: `76` printed for the count, then `import-ok` (the server module loads without throwing).

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp-bridge/src/index.ts
git commit -m "$(cat <<'EOF'
feat(#136): register cdp_dismiss_dev_client_picker MCP tool (sub-3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Best-effort dismissal after Android deep links

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/device-deeplink.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js`

- [ ] **Step 1: Write the failing tests** (append to the test file)

```javascript
import { annotatePicker } from '../../dist/tools/device-deeplink.js';

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

test('annotatePicker: null outcome → pickerChecked:false', () => {
  const r = annotatePicker(ok({ opened: true }), null);
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.meta.pickerChecked, false);
});

test('annotatePicker: dismissed outcome → pickerDismissed:true', () => {
  const r = annotatePicker(ok({ opened: true }), { dismissed: true, reason: 'tapped', platform: 'android' });
  const p = JSON.parse(r.content[0].text);
  assert.equal(p.meta.pickerChecked, true);
  assert.equal(p.meta.pickerDismissed, true);
});

test('annotatePicker: error result passes through untouched', () => {
  const err = { content: [{ type: 'text', text: '{"error":"x"}' }], isError: true };
  const r = annotatePicker(err, { dismissed: true, reason: 't' });
  assert.equal(r, err);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dismiss-picker-tool.test.js`
Expected: FAIL — `annotatePicker` is not exported from `device-deeplink.js`.

- [ ] **Step 3: Implement the wiring**

In `scripts/cdp-bridge/src/tools/device-deeplink.ts`, add to the imports:

```typescript
import { clearDevClientPickerIfPresent, type PickerOutcome } from './dev-client-picker.js';
```

Add this exported helper above `createDeviceDeeplinkHandler` (mirrors `annotateDeepLinkDepth`'s parse-merge-restringify pattern):

```typescript
/**
 * GH #136 sub-3: annotate a deeplink result with best-effort picker outcome.
 * `null` outcome means no session was open, so the picker was not checked.
 * Never mutates an error result.
 */
export function annotatePicker(result: ToolResult, outcome: PickerOutcome | null): ToolResult {
  if (result.isError) return result;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(result.content[0].text) as Record<string, unknown>;
  } catch {
    return result;
  }
  const existingMeta = (payload.meta && typeof payload.meta === 'object') ? payload.meta as Record<string, unknown> : {};
  payload.meta = outcome === null
    ? { ...existingMeta, pickerChecked: false }
    : { ...existingMeta, pickerChecked: true, pickerDismissed: outcome.dismissed };
  result.content[0].text = JSON.stringify(payload, null, 2);
  return result;
}
```

Then change the final two lines of `createDeviceDeeplinkHandler`'s returned function. Replace:

```typescript
    const result = platform === 'ios'
      ? await openIosDeeplink(args.url)
      : await openAndroidDeeplink(args.url, args.packageName);
    // GH #61 B.1: warn on suspicious-looking deep links (3+ segments OR
    // success-state suffix). Stateless heuristic; no overhead on short URLs.
    return annotateDeepLinkDepth(result, { url: args.url });
```

with:

```typescript
    const result = platform === 'ios'
      ? await openIosDeeplink(args.url)
      : await openAndroidDeeplink(args.url, args.packageName);
    // GH #61 B.1: warn on suspicious-looking deep links (3+ segments OR
    // success-state suffix). Stateless heuristic; no overhead on short URLs.
    const annotated = annotateDeepLinkDepth(result, { url: args.url });
    // GH #136 sub-3: the picker can appear after a deep link. Best-effort
    // dismiss on Android (no-op when no session is open); never fail the deeplink.
    if (platform === 'android' && !annotated.isError) {
      const outcome = await clearDevClientPickerIfPresent('android').catch(() => null);
      return annotatePicker(annotated, outcome);
    }
    return annotated;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd scripts/cdp-bridge && npm run build && node --test test/unit/gh-136-dismiss-picker-tool.test.js`
Expected: PASS (11 tests total).

- [ ] **Step 5: Run the full unit suite (no regressions)**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — existing suite count + 11, no failures.

- [ ] **Step 6: Commit**

```bash
git add scripts/cdp-bridge/src/tools/device-deeplink.ts scripts/cdp-bridge/test/unit/gh-136-dismiss-picker-tool.test.js
git commit -m "$(cat <<'EOF'
feat(#136): best-effort Dev Client picker dismiss after Android deep links (sub-3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Documentation

**Files:**
- Modify: `docs-site/src/content/docs/dev-client-coverage.md`
- Modify: `docs-site/src/content/docs/troubleshooting.mdx`
- Modify: `skills/rn-testing/SKILL.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Coverage doc — move the item to Fixed**

In `docs-site/src/content/docs/dev-client-coverage.md`, under **## What's broken**, delete the bullet beginning "**No MCP-exposed picker-dismiss tool.**". Under **## Fixed in this PR**, replace `_None._` (or append) with:

```markdown
- **`cdp_dismiss_dev_client_picker` (Android) — on-demand picker dismissal.** New MCP tool wrapping `handleDevClientPicker()` through the guarded `clearDevClientPickerIfPresent()` seam (`tools/dev-client-picker.ts`). `device_deeplink` now best-effort dismisses on Android success. iOS is guarded with an actionable manual-select message (never invokes the legacy `agent-device find` path). Cross-platform iOS re-path remains deferred (see Deferred).
```

- [ ] **Step 2: Replace the racy Maestro pattern**

In `docs-site/src/content/docs/troubleshooting.mdx` and `skills/rn-testing/SKILL.md`, find the block that documents dismissing the picker with a `runFlow when: visible: "DEVELOPMENT SERVERS"` / `tapOn` snippet. Replace the recommendation with:

```markdown
On Android, call `cdp_dismiss_dev_client_picker` after a launch/deep link instead of a Maestro `runFlow when: visible` block — it taps the configured Metro server deterministically and avoids the picker auto-advance race. (iOS: select the Metro server manually for now.)
```

Run first to locate the exact lines: `grep -n "DEVELOPMENT SERVERS" docs-site/src/content/docs/troubleshooting.mdx skills/rn-testing/SKILL.md`

- [ ] **Step 3: CLAUDE.md tool count + listing**

In `CLAUDE.md`: change `**75 tools** exposed via MCP (re-audited 2026-05-29; ...)` to `**76 tools** exposed via MCP (re-audited 2026-05-31; ...)`. In the device-helpers list ("Plus device helpers filed alongside CDP in code: ..."), add `cdp_dismiss_dev_client_picker` to the enumeration.

- [ ] **Step 4: Build docs site sanity (optional but preferred)**

Run: `cd docs-site && npm run build` (if the toolchain is installed)
Expected: build succeeds. If the docs toolchain is not installed locally, skip and rely on `deploy-docs` CI.

- [ ] **Step 5: Commit**

```bash
git add docs-site/src/content/docs/dev-client-coverage.md docs-site/src/content/docs/troubleshooting.mdx skills/rn-testing/SKILL.md CLAUDE.md
git commit -m "$(cat <<'EOF'
docs(#136): document cdp_dismiss_dev_client_picker; bump tool count 75→76 (sub-3)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Changeset + version bump

**Files:**
- Create: `.changeset/devclient-picker-dismiss.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/devclient-picker-dismiss.md`:

```markdown
---
"rn-dev-agent-plugin": patch
"rn-dev-agent-cdp": patch
---

Add `cdp_dismiss_dev_client_picker` MCP tool (Android) and best-effort Dev
Client picker dismissal after Android deep links (#136 sub-3). Routed through a
single guarded `clearDevClientPickerIfPresent()` helper; iOS returns an
actionable manual-select message instead of touching the legacy agent-device
path. Cross-platform iOS support tracked as a follow-up.
```

- [ ] **Step 2: Verify the changeset gate is satisfied**

Run: `bash scripts/sync-versions.sh && bash scripts/require-changeset.sh`
Expected: `versions in sync: 0.44.45` and the require-changeset check passes (a changeset now exists for the shippable `src/` change). If `require-changeset.sh` needs a base ref, run `BASE_REF=origin/main bash scripts/require-changeset.sh`.

- [ ] **Step 3: Commit**

```bash
git add .changeset/devclient-picker-dismiss.md
git commit -m "$(cat <<'EOF'
chore(#136): add changeset (patch) for dev-client picker dismiss tool

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: (At merge time, not now) consume changesets to bump the installable version**

> Performed when merging to `main`, not during feature work — it rewrites versions + CHANGELOG and consumes ALL pending changesets (including the two already pending: `ios-runner-self-build-and-gate-agent-device.md`, `observability-ui.md`).

Run (from repo root): `npm run version-packages`
Expected: `rn-dev-agent-plugin` 0.44.45 → 0.44.46 (or higher if pending minors apply), `rn-dev-agent-cdp` 0.38.40 → 0.38.41; `plugin.json` + `marketplace.json` mirrored; CHANGELOG updated. Then `bash scripts/sync-versions.sh` prints "versions in sync".

---

### Task 7: Workspace logging + final verification

**Files:**
- Modify: `../rn-dev-agent-workspace/docs/DECISIONS.md`, `../rn-dev-agent-workspace/docs/ROADMAP.md` (per global rules; append-only)

- [ ] **Step 1: Full suite + build green**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS, no failures.

- [ ] **Step 2: Log the decision + roadmap note** (append-only — never edit existing entries)

Append to `../rn-dev-agent-workspace/docs/DECISIONS.md` a dated entry: the iOS-guard decision (why we do NOT call the Android handler on iOS), the Android-as-is choice, and the `clearDevClientPickerIfPresent` single-seam rationale. Append a dated narrative to `../rn-dev-agent-workspace/docs/ROADMAP.md` covering #136 sub-3 completion and the named follow-ups (iOS re-path, session-less dismissal, cdp_restart picker step, tutorial modal, CI DC-Task 9).

- [ ] **Step 3: Run the consultant agent** (per global rule "after implement, run consultant agent to evaluate the solution") on the diff; address any high-confidence findings, re-run `npm test`.

- [ ] **Step 4: Commit any logging/consultant fixups**

```bash
git add -A
git commit -m "$(cat <<'EOF'
chore(#136): log sub-3 decision + roadmap; consultant pass

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review

**1. Spec coverage**
- Shared guarded helper → Task 1. ✓
- MCP tool + result mapping table → Task 2 (rows: no-session→fail, iOS→warn, dismissed→ok, not-detected→ok, no-entry→warn). ✓
- Tool registration / count 75→76 → Task 3 + Task 5. ✓
- `device_deeplink` Android best-effort + session-less no-op → Task 4 (`annotatePicker` null→pickerChecked:false). ✓
- Tests incl. "iOS never calls runAgentDevice" → Tasks 1 & 2. ✓
- Docs (coverage Deferred→Fixed, Maestro pattern, CLAUDE.md) → Task 5. ✓
- Version/changeset + the pending-changeset note → Task 6. ✓
- Workspace logging + consultant → Task 7. ✓
- Out-of-scope items are listed, not implemented. ✓

**2. Placeholder scan:** Step 2 of Task 5 references a `grep` to locate the exact lines because the snippet wording varies per file; the replacement text is given verbatim, so this is a locate-then-replace, not a TODO. No other placeholders.

**3. Type consistency:** `PickerOutcome` (fields `dismissed`, `reason`, `skipped?`, `platform?`) and `clearDevClientPickerIfPresent(platform?) → Promise<PickerOutcome | null>` are defined in Task 1 and consumed identically in Tasks 2 and 4. `createDismissDevClientPickerHandler()` matches the no-dep factory pattern used by `createDeviceDeeplinkHandler()`. `annotatePicker(result, outcome)` is defined and tested in Task 4. Result helpers used per their real signatures: `okResult(data, {meta})`, `failResult(msg, code, {meta})`, `warnResult(data, warning, {meta})`.
