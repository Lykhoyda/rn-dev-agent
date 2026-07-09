# Design: No-touch iOS dev-menu dismiss (GH #335)

- **Issue:** [#335](https://github.com/Lykhoyda/rn-dev-agent/issues/335) — *bug: iOS bridgeless dev menu auto-opens + JS thread detaches on interaction, blocking remount-without-reload workflows*
- **Labels:** `bug`, `kano:must-be`, `effort:m`, `priority:next`
- **Date:** 2026-07-05
- **Status:** Approved (scope confirmed with maintainer)

## Problem

On iOS bridgeless (RN 0.83 New Arch, Expo 55, iOS 26 simulator) the expo-dev-client
**dev menu** (a bottom sheet — distinct from the server-selection *picker*) auto-opens
on every app boot / `cdp_reload`, rendering Home behind it. The **only** way to clear
it today is a coordinate tap/swipe through rn-fast-runner (iOS has no hardware-key
input path). That touch frequently pauses the JS thread / detaches the Hermes target:
`cdp_status` reports `APP_DETACHED` (0 targets) and `Runtime.evaluate` times out. The
only recovery is a cold `simctl terminate && launch`, which **wipes the in-memory JS
store** — breaking live-verification flows that need injected RTK Query / Redux state
to survive.

## Root cause & key insight

The detach is **touch-triggered, not boot-triggered**. Immediately after `cdp_reload`
the menu is visible but Hermes is still attached — the pause only happens when the
sheet is physically swiped/tapped. Therefore a dismiss that runs **over CDP**
(`client.evaluate`) instead of touch never triggers the detach, and the JS store is
preserved.

Ground truth from `expo-dev-menu` (`packages/expo-dev-menu/src/DevMenu.ts`, SDK 55):
the native module **`ExpoDevMenu`** exposes JS-callable `openMenu()`, `hideMenu()`,
and `closeMenu()`. So a no-touch dismiss is directly reachable. RN core `DevSettings`
(what `cdp_dev_settings` uses today) **cannot** close the expo bottom sheet — its
`disableDevMenu` only suppresses shake-to-show for RN's *core* menu.

## Scope (confirmed with maintainer)

- **In:** No-touch dismiss primitive (injected-JS `ExpoDevMenu.hideMenu()`), exposed as
  a new `hideDevMenu` action on the existing `cdp_dev_settings` tool, **plus** a
  best-effort auto-dismiss wired into `cdp_reload`.
- **Out (deferred to a follow-up issue):** the "remount-without-reload" store-preserving
  primitive. Once dismiss is no-touch and store-preserving, the motivation for it (recover
  from the detach without wiping state) largely evaporates, and it is a much larger,
  more fragile build (forcing a React subtree remount from injected JS via React-Refresh
  internals). Tracked separately, linked from #335.
- **Not exposing `openDevMenu`** in this change (YAGNI — trivial to add later on the same
  resolver if a "test a registered dev-menu item" use case appears).

## Design

### New unit — `scripts/cdp-bridge/src/tools/expo-dev-menu.ts`

A single focused module owns resolving + hiding the expo dev menu. It is consumed by
both the on-demand action and the reload auto-dismiss, so it is the one source of truth
and the one place to unit-test. Exports:

- **`RESOLVE_EXPO_DEV_MENU`** — injected-JS multi-tier resolver string (mirrors
  `RESOLVE_DEV_SETTINGS` in `dev-settings.ts`). Tries in order:
  1. `globalThis.expo.modules.ExpoDevMenu` — SDK 50+ Expo modules registry (primary path)
  2. `require('react-native').NativeModules.ExpoDevMenu` / `.DevMenu` — legacy
  3. `__turboModuleProxy('ExpoDevMenu')`
  4. `globalThis.nativeModuleProxy.ExpoDevMenu`

  Returns `null` if none resolve. Each tier is wrapped in `try/catch` so a throwing
  proxy can't abort the chain.

- **`HIDE_EXPO_DEV_MENU_EXPRESSION`** — resolves the module, then calls `hideMenu()`
  (preferred) or `closeMenu()` (fallback). Return-value contract (sentinel string):
  | Sentinel | Meaning |
  |---|---|
  | `ok:hideMenu` | dismissed via `hideMenu()` |
  | `ok:closeMenu` | dismissed via `closeMenu()` |
  | `no_module` | `ExpoDevMenu` not resolvable (not an expo-dev-client build) |
  | `no_method_available` | module resolved but exposes neither method |
  | `error:<msg>` | the hide call threw |

  ```js
  (function () {
    var m = <RESOLVE_EXPO_DEV_MENU>;
    if (!m) return "no_module";
    try {
      if (typeof m.hideMenu === "function") { m.hideMenu(); return "ok:hideMenu"; }
      if (typeof m.closeMenu === "function") { m.closeMenu(); return "ok:closeMenu"; }
    } catch (e) { return "error:" + (e && e.message ? e.message : String(e)); }
    return "no_method_available";
  })()
  ```

- **`hideExpoDevMenu(client, { retries = 0 } = {})`** →
  `Promise<{ dismissed: boolean; method?: 'hideMenu' | 'closeMenu'; reason: string }>`.
  Runs the expression via `client.evaluate`, parses the sentinel. When `retries > 0`
  **and the module resolved**, re-fires the hide up to `retries` more times with a short
  (~500ms) delay — this beats the "menu re-presents a beat after boot" race without
  wasting time on non-expo apps. `no_module` short-circuits (never retries). A CDP eval
  error (`{error}`) maps to `{ dismissed: false, reason }` — the helper never throws for
  a normal eval failure, so callers stay simple. Test seam: the helper takes `client`,
  so tests inject a fake `{ evaluate }` (existing pattern in `tool-handlers-cdp2.test.js`).

### On-demand action — extend `cdp_dev_settings`

- `dev-settings.ts`: add `'hideDevMenu'` to the `DevAction` union. Special-case it at the
  top of the handler (before the generic `ACTION_EXPRESSIONS` path) to call
  `hideExpoDevMenu(client)`:
  - `dismissed` → `okResult({ action, executed: true, method })`
  - otherwise → `warnResult({ action, executed: false }, reason)` with an actionable
    message (e.g. `no_module` → "no expo dev-menu module found — is this an
    expo-dev-client build?").
- `index.ts` (≈ line 938): add `'hideDevMenu'` to the `action` z.enum and extend the tool
  description to mention it. **The tool name `cdp_dev_settings` is unchanged**, so the
  golden `test/fixtures/tool-registry.json` does not change and no registry regeneration
  is required.

### Auto-dismiss on `cdp_reload`

In `reload.ts`, after the reconnect + helper-injection succeeds and immediately before
`sessionReloadCount++` (≈ line 227), add a **best-effort, iOS-gated** dismiss:

```ts
let devMenuMeta: Record<string, unknown> = {};
if (client.connectedTarget?.platform === 'ios') {
  try {
    const r = await hideExpoDevMenu(client, { retries: 1 }); // up to 2 hides over ~0.6s
    if (r.dismissed) devMenuMeta = { dev_menu_dismissed: true, dev_menu_method: r.method };
  } catch {
    // best-effort — never fail a reload because the dev-menu hide failed
  }
}
```

`devMenuMeta` is merged into the final `okResult` meta (alongside any `forceMeta`).
Rationale for the gates:
- **Non-fatal:** wrapped in `try/catch`; a hide failure never changes the reload outcome.
- **iOS-only:** the problem is iOS bridgeless; gating avoids any behavior change on
  Android (where the picker path already governs boot and the dev menu behaves
  differently). The on-demand action stays platform-agnostic (the user invokes it
  explicitly).
- **No-op when absent:** `no_module` on a non-expo app is a silent no-op.

Net effect: after `cdp_reload` the agent lands on Home with the menu already gone and
Hermes still attached — directly killing the reported "auto-opens every boot" pain.

## Data flow

```
cdp_dev_settings { action: "hideDevMenu" }
  └─ createDevSettingsHandler → hideExpoDevMenu(client)
       └─ client.evaluate(HIDE_EXPO_DEV_MENU_EXPRESSION)  // over Hermes, no touch
            └─ ExpoDevMenu.hideMenu()  →  sentinel  →  ok/warn result

cdp_reload
  └─ reload handler: DevSettings.reload() → reconnect → inject helpers
       └─ (iOS) hideExpoDevMenu(client, {retries:1})  [best-effort]
            └─ meta.dev_menu_dismissed
```

## Error handling

- Module not present / non-expo build → `no_module` → warn (on-demand) or silent no-op
  (auto). Never an error.
- Hide call throws in-app → `error:<msg>` → `warnResult` surfaced to the user; reload
  unaffected.
- CDP eval fails (WS closed mid-call) → `{ dismissed:false }`; auto path swallows it,
  on-demand path warns.
- The injected expression is validated at test time with `new Function('return ' + expr)`
  to catch syntax typos in CI without a device.

## Testing (`test/unit/gh-335-hide-dev-menu.test.js`)

Node's `node:test`, `.test.js`, importing compiled `dist/`. Mirrors the fake-`evaluate`
seam from `tool-handlers-cdp2.test.js` and the reload harness from
`reload-force-retry.test.js`.

1. `hideExpoDevMenu`: each sentinel → correct `{dismissed, method, reason}`.
2. `retries`: `ok:*` fires `retries + 1` evaluations; `no_module` fires exactly one.
3. CDP eval error (`{error}`) → `{dismissed:false}`, no throw.
4. `cdp_dev_settings` `hideDevMenu` action via `createDevSettingsHandler(() => client)`:
   dismiss → ok (with `method`); `no_module`/`no_method_available` → warn.
5. Syntax guard: `new Function('return ' + HIDE_EXPO_DEV_MENU_EXPRESSION)` does not throw.
6. Reload auto-dismiss: (a) a throwing `hideExpoDevMenu` still yields `reloaded:true`;
   (b) skipped on Android (platform gate); (c) `dev_menu_dismissed` appears in meta on
   iOS success.

## On-device verification (maintainer, iOS dev-client)

1. `cdp_reload` → confirm Home is visible with **no** dev-menu sheet, and `cdp_status`
   stays attached (no `APP_DETACHED`).
2. Manually open the dev menu (shake / `m`), then `cdp_dev_settings action:hideDevMenu`
   → sheet dismisses, `cdp_status` still attached, injected store state intact.

## Docs, changeset, follow-up

- Changeset `.changeset/gh-335-ios-dev-menu-dismiss.md` — `rn-dev-agent-cdp`: patch,
  `rn-dev-agent-plugin`: patch.
- `docs-site/src/content/docs/dev-client-coverage.md` — remove the iOS "not supported
  yet" gap note; document `hideDevMenu` + auto-dismiss.
- Append findings to the workspace `ROADMAP.md` / `DECISIONS.md`; open or
  update GitHub Issues for bugs (no backend → postman N/A).
- File a follow-up issue for the deferred remount-without-reload primitive, linking #335.

## Files touched

| File | Change |
|---|---|
| `scripts/cdp-bridge/src/tools/expo-dev-menu.ts` | **new** — resolver + expression + `hideExpoDevMenu` |
| `scripts/cdp-bridge/src/tools/dev-settings.ts` | add `hideDevMenu` action |
| `scripts/cdp-bridge/src/index.ts` | extend `cdp_dev_settings` action enum + description |
| `scripts/cdp-bridge/src/tools/reload.ts` | best-effort iOS auto-dismiss after reconnect |
| `scripts/cdp-bridge/test/unit/gh-335-hide-dev-menu.test.js` | **new** — unit coverage |
| `.changeset/gh-335-ios-dev-menu-dismiss.md` | **new** — changeset |
| `docs-site/src/content/docs/dev-client-coverage.md` | update iOS coverage |
