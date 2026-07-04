# No-touch iOS Dev-Menu Dismiss Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dismiss the iOS expo-dev-client dev menu over CDP (no touch) so the JS thread never detaches, exposed as a `hideDevMenu` action on `cdp_dev_settings` plus a best-effort auto-dismiss on `cdp_reload`.

**Architecture:** A single focused module `tools/expo-dev-menu.ts` owns a multi-tier resolver for the `ExpoDevMenu` native module and a `hideExpoDevMenu(client)` helper that invokes `ExpoDevMenu.hideMenu()`/`closeMenu()` via `client.evaluate`. Two thin consumers: the `hideDevMenu` action in `dev-settings.ts`, and an iOS-gated `autoDismissDevMenuMeta(client)` called at the tail of `reload.ts`.

**Tech Stack:** TypeScript (ES modules, `.js` import specifiers), compiled to `dist/`; tests are `node:test` + `node:assert/strict` `.test.js` importing compiled `dist/`.

## Global Constraints

- Runtime: Node's built-in `node:test`; run via `npm test` in `scripts/cdp-bridge` (it builds first). No jest/vitest.
- Test files: `.test.js` only, under `scripts/cdp-bridge/test/unit/`, importing from `../../dist/...`. `npm run build` before running tests (the `test` script does this).
- Injected JS must resolve modules defensively — every resolver tier wrapped in `try/catch`; follow the existing `RESOLVE_DEV_SETTINGS` pattern in `dev-settings.ts`.
- Use explicit type imports (`import type { CDPClient }`).
- No unnecessary comments.
- Every commit is signed (1Password `op-ssh-sign`) — must be unlocked. End commit messages with the `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` trailer.
- Tool name `cdp_dev_settings` is unchanged → do **not** regenerate `test/fixtures/tool-registry.json`.
- `client.evaluate(expr)` returns `{ value?: unknown; error?: string }`.
- Result envelopes: `okResult(data)` → `{ok:true,data}`; `warnResult(data,warning,meta?)` → `{ok:true,data,meta:{...meta,warning}}`; `failResult(error,code?,meta?)` → `{ok:false,error,code?}` + `isError:true`.

---

### Task 1: `expo-dev-menu.ts` resolver + hide helper + auto-dismiss meta

**Files:**
- Create: `scripts/cdp-bridge/src/tools/expo-dev-menu.ts`
- Test: `scripts/cdp-bridge/test/unit/gh-335-hide-dev-menu.test.js`

**Interfaces:**
- Produces:
  - `RESOLVE_EXPO_DEV_MENU: string` — injected-JS IIFE returning the `ExpoDevMenu` module or `null`.
  - `HIDE_EXPO_DEV_MENU_EXPRESSION: string` — injected-JS IIFE returning sentinel `ok:hideMenu | ok:closeMenu | no_module | no_method_available | error:<msg>`.
  - `interface HideDevMenuOutcome { dismissed: boolean; method?: 'hideMenu' | 'closeMenu'; reason: string }`.
  - `hideExpoDevMenu(client: CDPClient, opts?: { retries?: number; retryDelayMs?: number }): Promise<HideDevMenuOutcome>` — total (never throws).
  - `autoDismissDevMenuMeta(client: CDPClient): Promise<Record<string, unknown>>` — iOS-gated, best-effort; returns `{ dev_menu_dismissed: true, dev_menu_method }` on dismiss else `{}`.

- [ ] **Step 1: Write the failing test**

Create `scripts/cdp-bridge/test/unit/gh-335-hide-dev-menu.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hideExpoDevMenu,
  autoDismissDevMenuMeta,
  HIDE_EXPO_DEV_MENU_EXPRESSION,
  RESOLVE_EXPO_DEV_MENU,
} from '../../dist/tools/expo-dev-menu.js';

const fastRetry = { retries: 2, retryDelayMs: 0 };
function clientReturning(...values) {
  let i = 0;
  const calls = { count: 0 };
  const client = {
    evaluate: async () => {
      calls.count += 1;
      const v = values[Math.min(i, values.length - 1)];
      i += 1;
      if (v && typeof v === 'object' && 'throw' in v) throw new Error(v.throw);
      return v;
    },
  };
  return { client, calls };
}

test('hideExpoDevMenu: ok:hideMenu → dismissed via hideMenu', async () => {
  const { client } = clientReturning({ value: 'ok:hideMenu' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, true);
  assert.equal(r.method, 'hideMenu');
});

test('hideExpoDevMenu: ok:closeMenu → dismissed via closeMenu', async () => {
  const { client } = clientReturning({ value: 'ok:closeMenu' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, true);
  assert.equal(r.method, 'closeMenu');
});

test('hideExpoDevMenu: no_module → not dismissed, actionable reason', async () => {
  const { client } = clientReturning({ value: 'no_module' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
  assert.match(r.reason, /expo dev-menu module/i);
});

test('hideExpoDevMenu: no_method_available → not dismissed', async () => {
  const { client } = clientReturning({ value: 'no_method_available' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
});

test('hideExpoDevMenu: error sentinel → not dismissed, surfaces message', async () => {
  const { client } = clientReturning({ value: 'error:boom' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
  assert.match(r.reason, /boom/);
});

test('hideExpoDevMenu: eval {error} → not dismissed, does not throw', async () => {
  const { client } = clientReturning({ error: 'WebSocket closed' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
});

test('hideExpoDevMenu: eval throws → not dismissed, does not throw', async () => {
  const { client } = clientReturning({ throw: 'kaboom' });
  const r = await hideExpoDevMenu(client);
  assert.equal(r.dismissed, false);
  assert.match(r.reason, /kaboom/);
});

test('hideExpoDevMenu: retries fire N+1 evaluations on ok', async () => {
  const { client, calls } = clientReturning({ value: 'ok:hideMenu' });
  await hideExpoDevMenu(client, fastRetry);
  assert.equal(calls.count, 3);
});

test('hideExpoDevMenu: no_module short-circuits retries', async () => {
  const { client, calls } = clientReturning({ value: 'no_module' });
  await hideExpoDevMenu(client, fastRetry);
  assert.equal(calls.count, 1);
});

test('autoDismissDevMenuMeta: iOS + dismissed → meta with method', async () => {
  const client = {
    connectedTarget: { platform: 'ios' },
    evaluate: async () => ({ value: 'ok:hideMenu' }),
  };
  const meta = await autoDismissDevMenuMeta(client);
  assert.equal(meta.dev_menu_dismissed, true);
  assert.equal(meta.dev_menu_method, 'hideMenu');
});

test('autoDismissDevMenuMeta: Android → empty (platform gate)', async () => {
  let evaluated = false;
  const client = {
    connectedTarget: { platform: 'android' },
    evaluate: async () => {
      evaluated = true;
      return { value: 'ok:hideMenu' };
    },
  };
  const meta = await autoDismissDevMenuMeta(client);
  assert.deepEqual(meta, {});
  assert.equal(evaluated, false, 'must not evaluate on Android');
});

test('autoDismissDevMenuMeta: iOS + no_module → empty', async () => {
  const client = {
    connectedTarget: { platform: 'ios' },
    evaluate: async () => ({ value: 'no_module' }),
  };
  assert.deepEqual(await autoDismissDevMenuMeta(client), {});
});

test('autoDismissDevMenuMeta: iOS + eval throws → empty (best-effort)', async () => {
  const client = {
    connectedTarget: { platform: 'ios' },
    evaluate: async () => {
      throw new Error('detached');
    },
  };
  assert.deepEqual(await autoDismissDevMenuMeta(client), {});
});

test('HIDE_EXPO_DEV_MENU_EXPRESSION is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + HIDE_EXPO_DEV_MENU_EXPRESSION));
});

test('RESOLVE_EXPO_DEV_MENU is syntactically valid JS', () => {
  assert.doesNotThrow(() => new Function('return ' + RESOLVE_EXPO_DEV_MENU));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern='hideExpoDevMenu|autoDismissDevMenuMeta|EXPO_DEV_MENU'`
Expected: FAIL — `Cannot find module '../../dist/tools/expo-dev-menu.js'` (module not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `scripts/cdp-bridge/src/tools/expo-dev-menu.ts`:

```ts
import type { CDPClient } from '../cdp-client.js';

export const RESOLVE_EXPO_DEV_MENU = `(function () {
  try { var e = globalThis.expo; if (e && e.modules && e.modules.ExpoDevMenu) return e.modules.ExpoDevMenu; } catch (e0) {}
  try { var nm = require("react-native").NativeModules; if (nm) { if (nm.ExpoDevMenu) return nm.ExpoDevMenu; if (nm.DevMenu) return nm.DevMenu; } } catch (e1) {}
  try { if (typeof __turboModuleProxy === "function") { var t = __turboModuleProxy("ExpoDevMenu"); if (t) return t; } } catch (e2) {}
  try { if (typeof globalThis.nativeModuleProxy !== "undefined") { var p = globalThis.nativeModuleProxy.ExpoDevMenu; if (p) return p; } } catch (e3) {}
  return null;
})()`;

export const HIDE_EXPO_DEV_MENU_EXPRESSION = `(function () {
  var m = ${RESOLVE_EXPO_DEV_MENU};
  if (!m) return "no_module";
  try {
    if (typeof m.hideMenu === "function") { m.hideMenu(); return "ok:hideMenu"; }
    if (typeof m.closeMenu === "function") { m.closeMenu(); return "ok:closeMenu"; }
  } catch (e) { return "error:" + (e && e.message ? e.message : String(e)); }
  return "no_method_available";
})()`;

export interface HideDevMenuOutcome {
  dismissed: boolean;
  method?: 'hideMenu' | 'closeMenu';
  reason: string;
}

function parseSentinel(value: unknown): HideDevMenuOutcome {
  const s = typeof value === 'string' ? value : '';
  if (s === 'ok:hideMenu') return { dismissed: true, method: 'hideMenu', reason: 'Dev menu hidden via hideMenu().' };
  if (s === 'ok:closeMenu') return { dismissed: true, method: 'closeMenu', reason: 'Dev menu hidden via closeMenu().' };
  if (s === 'no_module') return { dismissed: false, reason: 'No expo dev-menu module found — is this an expo-dev-client build?' };
  if (s === 'no_method_available') return { dismissed: false, reason: 'ExpoDevMenu resolved but exposes no hideMenu/closeMenu.' };
  if (s.startsWith('error:')) return { dismissed: false, reason: `ExpoDevMenu hide threw: ${s.slice(6)}` };
  return { dismissed: false, reason: `Unexpected dev-menu hide result: ${s || '(empty)'}` };
}

export async function hideExpoDevMenu(
  client: CDPClient,
  opts: { retries?: number; retryDelayMs?: number } = {},
): Promise<HideDevMenuOutcome> {
  const retries = Math.max(0, opts.retries ?? 0);
  const retryDelayMs = opts.retryDelayMs ?? 500;
  let outcome: HideDevMenuOutcome = { dismissed: false, reason: 'Dev menu hide not attempted.' };

  for (let attempt = 0; attempt <= retries; attempt++) {
    let value: unknown;
    try {
      const result = await client.evaluate(HIDE_EXPO_DEV_MENU_EXPRESSION);
      if (result.error) {
        outcome = { dismissed: false, reason: `Dev menu hide eval failed: ${result.error}` };
      } else {
        value = result.value;
      }
    } catch (err) {
      outcome = {
        dismissed: false,
        reason: `Dev menu hide eval threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (value === 'no_module') return parseSentinel(value);
    if (value !== undefined) outcome = parseSentinel(value);

    if (attempt < retries) {
      await new Promise((r) => setTimeout(r, retryDelayMs));
    }
  }

  return outcome;
}

export async function autoDismissDevMenuMeta(client: CDPClient): Promise<Record<string, unknown>> {
  try {
    if (client.connectedTarget?.platform !== 'ios') return {};
    const dm = await hideExpoDevMenu(client, { retries: 1 });
    return dm.dismissed ? { dev_menu_dismissed: true, dev_menu_method: dm.method } : {};
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern='hideExpoDevMenu|autoDismissDevMenuMeta|EXPO_DEV_MENU'`
Expected: PASS (15 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/expo-dev-menu.ts scripts/cdp-bridge/test/unit/gh-335-hide-dev-menu.test.js
git commit -m "feat(335): ExpoDevMenu resolver + no-touch hide helper

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `hideDevMenu` action on `cdp_dev_settings`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/dev-settings.ts`
- Modify: `scripts/cdp-bridge/src/index.ts:934-939`
- Test: `scripts/cdp-bridge/test/unit/gh-335-hide-dev-menu.test.js` (append)

**Interfaces:**
- Consumes: `hideExpoDevMenu` from Task 1; `createDevSettingsHandler(getClient)` existing.
- Produces: `cdp_dev_settings { action: "hideDevMenu" }` → ok `{action,executed:true,method}` on dismiss, warn `{action,executed:false}` otherwise.

- [ ] **Step 1: Write the failing test** (append to `gh-335-hide-dev-menu.test.js`)

```js
import { createDevSettingsHandler } from '../../dist/tools/dev-settings.js';

function envelope(r) {
  return JSON.parse(r.content[0].text);
}

test('dev_settings hideDevMenu: dismissed → ok with method', async () => {
  const client = { evaluate: async () => ({ value: 'ok:hideMenu' }) };
  const handler = createDevSettingsHandler(() => client);
  const r = await handler({ action: 'hideDevMenu' });
  const body = envelope(r);
  assert.equal(r.isError, undefined);
  assert.equal(body.ok, true);
  assert.equal(body.data.executed, true);
  assert.equal(body.data.method, 'hideMenu');
});

test('dev_settings hideDevMenu: no_module → warn, not executed', async () => {
  const client = { evaluate: async () => ({ value: 'no_module' }) };
  const handler = createDevSettingsHandler(() => client);
  const r = await handler({ action: 'hideDevMenu' });
  const body = envelope(r);
  assert.equal(r.isError, undefined);
  assert.equal(body.data.executed, false);
  assert.match(body.meta.warning, /expo dev-menu module/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern='dev_settings hideDevMenu'`
Expected: FAIL — handler treats `hideDevMenu` as unknown / `ACTION_EXPRESSIONS['hideDevMenu']` is `undefined`, so `body.data.method` is absent.

- [ ] **Step 3: Write minimal implementation**

Edit `scripts/cdp-bridge/src/tools/dev-settings.ts`:

Add import at top (after existing imports):
```ts
import { hideExpoDevMenu } from './expo-dev-menu.js';
```

Change the `DevAction` union (line 4-9) to add `hideDevMenu`:
```ts
type DevAction =
  | 'reload'
  | 'toggleInspector'
  | 'togglePerfMonitor'
  | 'dismissRedBox'
  | 'disableDevMenu'
  | 'hideDevMenu';
```

Change `ACTION_EXPRESSIONS`'s type (line 19) so `hideDevMenu` is not a required key:
```ts
const ACTION_EXPRESSIONS: Record<Exclude<DevAction, 'hideDevMenu'>, string> = {
```

Add the special-case at the very top of the handler body (immediately inside the `withConnection` callback, before `const expression = ...`):
```ts
export function createDevSettingsHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { action: DevAction }, client) => {
    if (args.action === 'hideDevMenu') {
      const outcome = await hideExpoDevMenu(client);
      if (outcome.dismissed) {
        return okResult({ action: args.action, executed: true, method: outcome.method });
      }
      return warnResult({ action: args.action, executed: false }, outcome.reason);
    }

    const expression = ACTION_EXPRESSIONS[args.action];
    // ...existing body unchanged...
```

Edit `scripts/cdp-bridge/src/index.ts` (lines 934-939): add `hideDevMenu` to the enum and extend the description:
```ts
  'cdp_dev_settings',
  'Control React Native dev settings programmatically (no visual dev menu needed). dismissRedBox clears LogBox overlays and RedBox errors via a 4-tier fallback chain. disableDevMenu suppresses shake-to-show dev menu (use before proof recordings). hideDevMenu dismisses the iOS expo-dev-client dev menu bottom sheet over CDP (no touch, keeps Hermes attached and the JS store intact). For reload with auto-reconnect, use cdp_reload instead.',
  {
    action: z
      .enum(['reload', 'toggleInspector', 'togglePerfMonitor', 'dismissRedBox', 'disableDevMenu', 'hideDevMenu'])
      .describe('Dev menu action to execute'),
  },
  createDevSettingsHandler(getClient),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern='dev_settings'`
Expected: PASS (new hideDevMenu tests + existing dev_settings tests all green).

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/tools/dev-settings.ts scripts/cdp-bridge/src/index.ts scripts/cdp-bridge/test/unit/gh-335-hide-dev-menu.test.js
git commit -m "feat(335): hideDevMenu action on cdp_dev_settings

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: auto-dismiss on `cdp_reload`

**Files:**
- Modify: `scripts/cdp-bridge/src/tools/reload.ts` (import + final return block ≈ line 227-231)

**Interfaces:**
- Consumes: `autoDismissDevMenuMeta` from Task 1 (already fully unit-tested).
- Produces: `cdp_reload` success meta now includes `dev_menu_dismissed`/`dev_menu_method` on iOS when a menu was hidden.

> Note: the testable decision logic lives entirely in `autoDismissDevMenuMeta` (covered in Task 1). This task is thin wiring; its gate is the build + the existing `reload-force-retry.test.js` suite staying green.

- [ ] **Step 1: Implement the wiring**

Edit `scripts/cdp-bridge/src/tools/reload.ts`:

Add import (after line 2):
```ts
import { autoDismissDevMenuMeta } from './expo-dev-menu.js';
```

Replace the final block (currently lines 227-231):
```ts
    sessionReloadCount++;
    return okResult(
      { reloaded: true, type: 'full', reconnected: true },
      Object.keys(forceMeta).length > 0 ? { meta: forceMeta } : undefined,
    );
```
with:
```ts
    const devMenuMeta = await autoDismissDevMenuMeta(client);
    const mergedMeta = { ...forceMeta, ...devMenuMeta };

    sessionReloadCount++;
    return okResult(
      { reloaded: true, type: 'full', reconnected: true },
      Object.keys(mergedMeta).length > 0 ? { meta: mergedMeta } : undefined,
    );
```

- [ ] **Step 2: Build + run the reload suite to verify no regression**

Run: `cd scripts/cdp-bridge && npm test -- --test-name-pattern='forceReconnect|captureClientState'`
Expected: PASS (existing reload tests unaffected; build succeeds with the new import).

- [ ] **Step 3: Run the full suite**

Run: `cd scripts/cdp-bridge && npm test`
Expected: PASS — entire suite green (prior baseline + new gh-335 tests).

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp-bridge/src/tools/reload.ts
git commit -m "feat(335): auto-dismiss iOS dev menu after cdp_reload reconnect

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: changeset + docs

**Files:**
- Create: `.changeset/gh-335-ios-dev-menu-dismiss.md`
- Modify: `docs-site/src/content/docs/dev-client-coverage.md`

- [ ] **Step 1: Write the changeset**

Create `.changeset/gh-335-ios-dev-menu-dismiss.md`:
```md
---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`cdp_dev_settings` gains a `hideDevMenu` action that dismisses the iOS
expo-dev-client dev menu bottom sheet over CDP via `ExpoDevMenu.hideMenu()`
(#335). Because it runs through `client.evaluate` instead of a coordinate
tap/swipe, it never triggers the touch-induced Hermes detach the issue
describes — the JS thread stays attached and the in-memory store survives.
`cdp_reload` now also best-effort auto-dismisses the menu on iOS after
reconnect, so the agent lands on the app instead of behind the sheet.
```

- [ ] **Step 2: Update the coverage doc**

In `docs-site/src/content/docs/dev-client-coverage.md`, find the section noting the iOS dev-menu / "not supported yet" gap and replace it with a note that `cdp_dev_settings action:hideDevMenu` dismisses the iOS dev menu over CDP and `cdp_reload` auto-dismisses it. (Read the file first; match its existing table/prose style. If there is a Markdown table row marking iOS dev-menu dismiss as unsupported, flip it to supported and reference the `hideDevMenu` action.)

- [ ] **Step 3: Verify changeset name passes the validator**

Run: `bash scripts/validate-changeset-names.sh` (or `npm run` equivalent if defined)
Expected: PASS — `gh-335-ios-dev-menu-dismiss.md` matches the required naming convention.

- [ ] **Step 4: Commit**

```bash
git add .changeset/gh-335-ios-dev-menu-dismiss.md docs-site/src/content/docs/dev-client-coverage.md
git commit -m "docs(335): changeset + iOS dev-menu coverage update

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Ship (post-implementation, outside task loop)

1. `cd scripts/cdp-bridge && npm test` — full suite green.
2. Repo-root lint + format: `npm run lint` / `npm run format:check` (or `oxlint` / `oxfmt` per repo config); fix any flags.
3. Append findings to `ROADMAP.md`, bug entry to `BUGS.md`, decision (defer remount primitive; dismiss-over-CDP approach) to `DECISIONS.md`.
4. Push branch `feat/335-ios-dev-menu-dismiss`, open PR referencing #335.
5. File a follow-up issue: "remount-without-reload primitive that preserves the JS store" (deferred from #335), link back to #335.
6. On-device verification checklist for the maintainer (from the spec): `cdp_reload` → menu auto-gone, `cdp_status` stays attached; manual menu open → `cdp_dev_settings action:hideDevMenu` dismisses with store intact.

## Self-Review

- **Spec coverage:** resolver + hide helper (Task 1) ✓; on-demand `hideDevMenu` action (Task 2) ✓; auto-dismiss on reload (Task 3) ✓; changeset + docs (Task 4) ✓; ROADMAP/BUGS/DECISIONS + follow-up issue (Ship) ✓; deferred remount primitive noted (Ship #5) ✓. All spec "Files touched" rows map to a task.
- **Placeholders:** none — all code is complete; the one prose direction (Task 4 Step 2) is a deliberate "match the existing doc" instruction because the target file's exact wording must be read first.
- **Type consistency:** `hideExpoDevMenu`, `autoDismissDevMenuMeta`, `HideDevMenuOutcome`, `HIDE_EXPO_DEV_MENU_EXPRESSION`, `RESOLVE_EXPO_DEV_MENU` names identical across Tasks 1-3 and the tests. Sentinel vocabulary (`ok:hideMenu|ok:closeMenu|no_module|no_method_available|error:`) consistent between the expression and `parseSentinel`.
