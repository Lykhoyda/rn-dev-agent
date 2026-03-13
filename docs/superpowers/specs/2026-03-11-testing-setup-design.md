# Design: E2E Testing Setup for rn-dev-agent Plugin

**Date:** 2026-03-11
**Status:** Approved
**Approach:** Standalone Test App + Node.js Test Harness (Approach A)

## Goal

Create a purpose-built React Native test app and automated test harness that validates all 10 MCP tools in the rn-dev-agent plugin work correctly against a real app running on iOS Simulator.

## Constraints

- iOS first, Android later
- Test app lives inside the plugin repo at `test-app/`
- Mirrors production app stack: Expo, React Navigation 6, Redux Toolkit, NativeWind, MSW
- Automated validation via Node.js harness (no test framework dependency)

## Test App Architecture

| Layer | Tech | Why |
|-------|------|-----|
| Framework | Expo (latest stable SDK at time of implementation), matching RN version | Match production app patterns |
| Navigation | React Navigation 6 (native stack + bottom tabs) | Exercises `cdp_navigation_state` |
| State | Redux Toolkit + Redux Persist | Exercises `cdp_store_state` |
| Styling | NativeWind | Match production app |
| Network | MSW 2.x (in-app) | Exercises `cdp_network_log` with deterministic responses |
| Platform | iOS first | Per user preference |

### 8 Screens

Each screen is deliberately simple — just enough UI to exercise specific MCP tools.

| Screen | Tab/Nav | Exercises | testIDs |
|--------|---------|-----------|---------|
| **Home** | Home tab | `cdp_component_tree`, `cdp_status` | `home-welcome`, `home-feature-0/1/2`, `home-feed-btn` |
| **Profile** | Profile tab | `cdp_store_state`, `cdp_evaluate` | `profile-name`, `profile-email`, `profile-avatar`, `profile-update-btn` |
| **Feed** | Home > push | `cdp_network_log` (MSW-backed API calls) | `feed-loading`, `feed-item-0/1/2`, `feed-error`, `feed-retry-btn` |
| **Settings** | Profile > push | `cdp_dev_settings` | `settings-theme-toggle`, `settings-language-toggle` |
| **Notifications** | Notifications tab | `cdp_console_log` (deliberate log/warn/error on mount) | `notif-item-0/1/2`, `notif-mark-read-btn` |
| **Error Lab** | Modal from any tab | `cdp_error_log` (JS errors, unhandled rejections, RedBox) | `error-lab-throw`, `error-lab-rejection`, `error-lab-redbox` |
| **Deep Link Target** | Via `rndatest://deeplink?id=123` | `cdp_navigation_state` (deep link routing + params) | `deeplink-id`, `deeplink-params` |
| **Reload Test** | Settings > push | `cdp_reload` (full reload + reconnect) | `reload-counter`, `reload-btn` |

### Global Test Helpers

The test app exposes global references for harness-driven navigation and store access:

```typescript
// In App.tsx — expose navigation ref for harness
import { createNavigationContainerRef } from '@react-navigation/native';

export const navigationRef = createNavigationContainerRef();

// Exposed globally for cdp_evaluate access
if (__DEV__) {
  globalThis.__NAV_REF__ = navigationRef;
}
```

```typescript
// In store/index.ts — expose Redux store for cdp_store_state
const store = configureStore({ ... });

if (__DEV__) {
  globalThis.__REDUX_STORE__ = store;
}
```

The harness navigates between screens via `cdp_evaluate` calling `__NAV_REF__.navigate('Feed')`.

### Redux Store Shape

```typescript
{
  user: { name: string; email: string; avatar: string; loggedIn: boolean },
  feed: { items: FeedItem[]; loading: boolean; error: string | null },
  notifications: { items: Notification[]; unreadCount: number },
  settings: { theme: 'light' | 'dark'; language: 'en' | 'de' }
}
```

### Screen Details

**Home** — Welcome card, 3 feature cards, "Go to Feed" button. Nested components 3 levels deep to validate `cdp_component_tree` depth parameter.

**Profile** — Reads `user` slice from Redux. "Update Name" button dispatches a Redux action, validating `cdp_store_state` before/after.

**Feed** — On mount fetches `GET /api/feed` via MSW. Shows loading/items/error states. "Trigger Error" button re-fetches with `?error=true`.

**Settings** — Toggle switches for theme and language. Persisted in Redux `settings` slice.

**Notifications** — On mount fires `console.log('notifications loaded')`, `console.warn('stale cache')`, `console.error('notification parse failed')`. Displays 3 hardcoded notifications. "Mark Read" fires `POST /api/notifications/read`.

**Error Lab** — Modal with 3 buttons:
- "Throw Error" — synchronous `throw new Error('test-sync-error')` in event handler
- "Unhandled Rejection" — `Promise.reject(new Error('test-unhandled-rejection'))`
- "Trigger RedBox" — Sets a state flag `crashChild: true` which conditionally renders a `<CrashComponent />` that throws in its render method, producing a React render-phase error (RedBox). After this test, `cdp_reload` is required to recover.

**Deep Link Target** — Reached via `rndatest://deeplink?id=123`. Displays received params. Validates `cdp_navigation_state` shows correct route + params.

**Reload Test** — Mount counter (using `useRef` persisted across fast refresh but reset on full reload) to verify `cdp_reload` triggers a real reload and helpers get re-injected.

## MSW Network Mocking

MSW runs inside the test app using `msw/native`, intercepting `fetch` calls at the JavaScript level.

**Interception order matters for `cdp_network_log`:** MSW 2.x patches `globalThis.fetch`. The plugin's injected fetch hooks (for RN < 0.83) also wrap `globalThis.fetch`. The test app must initialize MSW **before** the CDP bridge connects, so the plugin's hook wraps MSW's patched fetch and observes both the outgoing request and MSW's synthetic response. For RN >= 0.83 where the plugin uses the CDP `Network.enable` domain instead of fetch hooks, MSW-intercepted requests will NOT appear in `cdp_network_log` because they never reach the native networking layer.

**Resolution:** The Feed screen fetches via `fetch('https://api.testapp.local/api/feed')`. On RN >= 0.83, the `cdp_network_log` test suite asserts that the plugin's fetch hook fallback path works by verifying the app has `__RN_AGENT.networkFallback` set. If the CDP Network domain is active instead, the network-log suite skips the MSW-specific assertions and instead validates that the domain is enabled and the buffer structure is correct.

| Endpoint | Response | Purpose |
|----------|----------|---------|
| `GET /api/feed` | 3 feed items (200) | Happy path for network log |
| `GET /api/feed?error=true` | 500 with error body | Error state for Feed screen |
| `GET /api/user/profile` | User object | Seed Redux store on init |
| `POST /api/notifications/read` | 204 | POST request in network log |

## Test Harness

The harness lives at `test-app/harness/` — a plain Node.js script that programmatically validates all 10 MCP tools.

### How It Works

1. Spawns the cdp-bridge MCP server as a child process (same as Claude Code does)
2. Communicates via MCP protocol over stdio using `@modelcontextprotocol/sdk/client`
3. Runs 10 test suites sequentially in a fixed order
4. Each suite has a 15-second timeout to prevent hangs
5. Exits 0 (all pass) or 1 (failures) + prints summary

**Prerequisite:** Test app must already be running on iOS Simulator with Metro serving. The harness does NOT boot the app.

### Execution Order

Suites run in this exact order. Side effects from earlier suites are accounted for:

1. **`cdp_status`** — Establishes connection, verifies app info (platform, `__DEV__`, Hermes). No navigation needed (app starts on Home tab).
2. **`cdp_evaluate`** — `__RN_AGENT.getAppInfo()` returns platform, RN version, Hermes=true. Also verifies `__NAV_REF__` and `__REDUX_STORE__` are accessible.
3. **`cdp_component_tree`** — Filtered query on Home tab for nested components and testIDs.
4. **`cdp_navigation_state`** — Verifies Home tab is active, correct tab index and stack depth. Then navigates to Deep Link Target via `cdp_evaluate('__NAV_REF__.navigate("DeepLink", { id: "123" })')` and asserts route params.
5. **`cdp_store_state`** — `path="user.name"` returns seeded value, `path="feed.items"` returns array. Navigates back to Home first.
6. **`cdp_network_log`** — Navigates to Feed via `cdp_evaluate`, waits 1s for MSW fetch to complete, asserts network entries appear (or validates buffer structure if CDP Network domain is active).
7. **`cdp_console_log`** — Clears buffer, navigates to Notifications tab, waits 1s, asserts `notifications loaded` (info), `stale cache` (warn), and `notification parse failed` (error) entries.
8. **`cdp_error_log`** — Triggers error via `cdp_evaluate('throw new Error("harness-test-error")')`, asserts error appears in buffer.
9. **`cdp_dev_settings`** — `togglePerfMonitor` executes without error.
10. **`cdp_reload`** — **Last** (resets all state). After reload, `cdp_status` shows reconnected, helpers re-injected, `__RN_AGENT.isReady()` returns true.

### Output Format

```
[PASS] cdp_status — connected, app info valid (120ms)
[PASS] cdp_evaluate — getAppInfo returns expected shape (45ms)
[PASS] cdp_component_tree — HomeScreen found with 5 testIDs (85ms)
[PASS] cdp_navigation_state — Home tab active, deep link params verified (350ms)
[PASS] cdp_store_state — user.name and feed.items match (60ms)
[PASS] cdp_network_log — 3 feed entries captured (1200ms)
[PASS] cdp_console_log — 3 log levels captured (1150ms)
[FAIL] cdp_error_log — expected error entry, got empty buffer
[PASS] cdp_dev_settings — togglePerfMonitor ok (30ms)
[SKIP] cdp_reload — skipped (depends on error_log passing)
...
10 suites: 8 passed, 1 failed, 1 skipped (3.1s)
```

## Project Structure

```
test-app/
  app.json                    # Expo config (bundleId: com.rndevagent.testapp)
  package.json
  tsconfig.json
  babel.config.js             # NativeWind + Expo preset
  tailwind.config.js
  metro.config.js
  src/
    App.tsx                   # Providers (Redux, Navigation, MSW init), global refs
    screens/
      HomeScreen.tsx
      ProfileScreen.tsx
      FeedScreen.tsx
      SettingsScreen.tsx
      NotificationsScreen.tsx
      ErrorLabModal.tsx
      DeepLinkScreen.tsx
      ReloadTestScreen.tsx
    navigation/
      RootNavigator.tsx       # Stack + Tab setup, deep link config
      types.ts                # Navigation type params
    store/
      index.ts                # configureStore + persistor + global exposure
      slices/
        userSlice.ts
        feedSlice.ts
        notificationsSlice.ts
        settingsSlice.ts
    mocks/
      handlers.ts             # MSW request handlers
      server.ts               # MSW setup (native) — initialized BEFORE CDP connects
  harness/
    package.json              # Separate deps (@modelcontextprotocol/sdk)
    tsconfig.json             # ES2022, Node16 modules (matches cdp-bridge)
    run.ts                    # Entry point — spawns MCP server, runs suites in order
    lib/
      mcp-client.ts           # MCP client wrapper (spawn + call + close)
      assertions.ts           # Simple assert helpers (assertEqual, assertContains, assertShape)
    suites/
      status.ts
      evaluate.ts
      component-tree.ts
      navigation.ts
      store-state.ts
      network-log.ts
      console-log.ts
      error-log.ts
      dev-settings.ts
      reload.ts
```

## Dependencies

### Test App

- `expo` (latest stable SDK at time of implementation), matching `react-native` and `react` versions
- `@react-navigation/native`, `@react-navigation/native-stack`, `@react-navigation/bottom-tabs`
- `@reduxjs/toolkit`, `react-redux`, `redux-persist`, `@react-native-async-storage/async-storage`
- `nativewind`, `tailwindcss`
- `msw` ~2.x

### Harness

- `@modelcontextprotocol/sdk` ^1.12.0 (uses `@modelcontextprotocol/sdk/client` imports)
- `typescript` ^5.4

## Run Workflow

```bash
# 1. Install dependencies
cd test-app && npm install
cd harness && npm install

# 2. Build harness
cd test-app/harness && npx tsc

# 3. Boot simulator + start app (terminal 1)
cd test-app && npx expo run:ios

# 4. Run harness (terminal 2)
cd test-app/harness && node dist/run.js
```
