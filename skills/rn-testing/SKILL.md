---
name: rn-testing
description: This skill should be used when the user asks to "write a Maestro test", "create E2E flows", "add testIDs", "run UI tests", "run E2E tests", "verify a feature works", "test my screen", "set up maestro-runner", "mock network requests", "inspect store state", "write test assertions", or needs guidance on test timing rules, flow structure, multi-device testing, network mocking, Zustand inspection, or component tree queries for React Native apps.
---

# rn-testing — Maestro Patterns, Timing Rules, and Test Strategy

How to write and run UI test flows for React Native feature verification.
Covers test runner selection, timing rules, testID conventions, multi-device
testing, network mocking, and store inspection setup.

---

## Test Runner: maestro-runner (Preferred)

maestro-runner is a Go-based drop-in replacement for Maestro. Same YAML flow
syntax, 3-4x faster, no JVM required.

| Metric | Maestro (Java) | maestro-runner (Go) |
|--------|---------------|---------------------|
| Binary size | ~300MB (with JVM) | 21MB single binary |
| Startup time | 2-4s (JVM cold start) | <100ms |
| Memory | ~400MB | ~30MB |
| Flow execution | Baseline | 2-3x faster |
| Install | `brew install maestro` + Java | Single binary download |

```bash
# Auto-detect runner (prefer maestro-runner)
if command -v maestro-runner &>/dev/null; then
  RUNNER="maestro-runner"
elif command -v maestro &>/dev/null; then
  RUNNER="maestro"
else
  echo "Install: brew install maestro OR download maestro-runner"
  exit 1
fi

# Execute flow (identical YAML syntax either way)
$RUNNER test flows/my-flow.yaml
```

---

## Verification Fidelity — No Silent Shortcuts (#61)

**Verification means simulating a real user. State injection that produces a matching screen is NOT verification.**

The following count as **shortcuts** that invalidate verification unless the user explicitly sanctions them:

1. **Deep-linking past the entry point** of the flow being verified (e.g. deep-linking to `success-details/<existingId>` instead of walking the create flow).
2. **Forcing route params a real user can't set** (e.g. `isNewPolicy=true`, `fromSuccess=true`, `mode=edit` injected via URL).
3. **Writing to MMKV / AsyncStorage / SecureStore** to reset cooldowns, permissions, "has-seen" flags, or session state.
4. **Dispatching Redux / Zustand actions directly** rather than through UI (`cdp_dispatch` from outside a real user gesture).
5. **Calling native-module APIs** to skip platform dialogs (e.g. faking permission grants, dismissing system prompts via JS).

These tools work equally well from inside a real flow and as state injection — the plugin can't tell the difference. **The agent is the safeguard.**

### Why this matters

A regression in steps 1–4 of a real user flow (e.g. a mutation not firing, a navigation prop wired wrong) is **invisible** to a verification that deep-links past those steps. Screenshots look identical. The verification claims "passed" while the actual feature is broken.

### Rule

If a real user cannot reach the screen you're verifying via UI alone (no terminal commands, no URL bar, no dev menu), and you are about to use any of the shortcuts above, **STOP and either**:

- **(preferred)** walk the actual user flow through the UI, or
- **state the shortcut explicitly** ("I'm deep-linking past the create flow because X") **and ask the user whether the verification is still valid for their use case**.

Do not silently take the cheaper path. The user reviewing your output cannot tell from screenshots whether the flow was real.

### When shortcuts are legitimate

- **Auth pre-flight** (auto-login via deep-link) — bootstrap, not verification surface
- **Permission pre-flight** (granting via `device_permission`) — platform setup, declared upfront
- **Test data seeding** (via app's test-only fixtures) — declared in the test plan
- **Explicit user instruction** ("just deep-link to the details screen and check the layout") — user-sanctioned scope

In all these cases: **declare the shortcut in the test report**, don't bury it.

---

## Optimized Test Loop (Timing Reference)

```
PER STEP — OPTIMIZED (maestro-runner + JPEG):
  1. maestro-runner tap action    →  0.3s
  2. maestro-runner assertVisible →  0.3s
  3. bash: snapshot (concurrent)   →  0.2s  (screenshot + UI dump in parallel)
  4. MCP: cdp_component_tree      →  0.4s
  5. MCP: cdp_store_state         →  0.2s
  Total per step: ~1.4s

PER STEP — BASELINE (Maestro + PNG):
  Total per step: ~3.1s

Improvement: 2.2x faster per step. Over a 10-step test: saves ~17 seconds.
```

---

## Critical Timing Rule: Wait Before CDP

After any UI interaction, React needs time to commit updates to the Fiber tree.

### With agent-device (preferred for live verification)
```
1. device_find text="Submit" action=click  → native tap
2. device_snapshot  → verify UI changed (new elements, @refs)
3. cdp_store_state  → now safe to read React state
```

### With Maestro (for persistent YAML E2E tests)
```
1. Maestro tap/input
2. Maestro assertVisible (wait for UI to settle)
3. CDP state query (now safe to read)
```

WRONG (race condition — gets stale state):
```
1. device_find "Submit" action=click  OR  Maestro tap
2. Immediately: cdp_store_state → returns OLD state
```

If no visual indicator exists after an action, add an explicit delay:
```bash
# After interaction, wait for React to settle
# bash: sleep 0.7
# cdp_store_state
```

After code changes, Fast Refresh triggers automatically. Wait 1-2 seconds
before querying CDP state, or call `cdp_reload` for a full reload.

---

## Maestro Flow Patterns

### Basic Flow Structure

```yaml
appId: com.example.app
---
- launchApp
- assertVisible: "Home"
```

**WARNING**: Never use `clearState: true` with Expo Dev Client builds — it wipes
the stored Metro server URL, causing the Dev Client launcher/picker to appear
instead of your app (EG_DEV_CLIENT_CLEARSTATE). Only use clearState with
Expo Go or bare React Native apps.

### Navigation and Interaction

```yaml
# Deep link navigation (preferred when available)
- openLink: "myapp://cart"

# Tap by testID
- tapOn:
    id: "add-to-cart-btn"

# Tap by visible text
- tapOn: "Add to Cart"

# Type in input
- tapOn:
    id: "search-input"
- inputText: "Nike Air Max"

# Scroll until element visible
- scrollUntilVisible:
    element:
      id: "checkout-btn"
```

### Assertions

```yaml
# Assert element is visible
- assertVisible: "Shopping Cart"

# Assert by testID
- assertVisible:
    id: "cart-badge"

# Assert text content
- assertVisible:
    id: "cart-badge"
    text: "3"

# Assert element is NOT visible
- assertNotVisible:
    id: "error-banner"
```

### Full Feature Test Example

```yaml
appId: com.example.app
---
- launchApp
- assertVisible: "Home"
- tapOn:
    id: "product-shoe-1"
- assertVisible: "Product Detail"
- tapOn:
    id: "add-to-cart-btn"
- assertVisible:
    id: "cart-badge"
    text: "1"
- tapOn:
    id: "cart-tab"
- assertVisible: "Shopping Cart"
- assertVisible: "Air Max 90"
```

### Inline Flow (for agent use during testing)

```bash
cat > /tmp/step.yaml << 'EOF'
appId: com.example.app
---
- tapOn:
    id: "add-to-cart-btn"
- assertVisible:
    id: "cart-badge"
EOF
maestro-runner --platform <ios|android> test /tmp/step.yaml
```

---

## Reusable Action Metadata Schema (M7)

Every reusable Maestro flow MUST declare an M7 metadata header — `# key: value`
comment lines above the body (Maestro ignores them; the inventory and the
`/run-action` pre-flight parse them). The 5 inventory keys:

| Key | Value | Notes |
|---|---|---|
| `id` | kebab-case slug | defaults to filename without `.yaml` |
| `intent` | one-line goal | surfaced verbatim by `/list-learned-actions`; the routing key |
| `tags` | `[a, b, c]` lower-case kebab | feature area (auth, tasks), operation (create, delete), markers (smoke, regression) |
| `mutates` | `true`/`false` | persistent residue? drives the `/run-action` confirmation gate; missing parses as `null` and renders as `?` |
| `status` | `experimental` \| `active` \| `deprecated` | start `experimental`; first clean replay promotes; `deprecated` = never replay |

**Auto-generated flows** from `cdp_record_test_generate` populate these fields
when supplied via `GenerateOpts.id|intent|tags|mutates|status` (see
`tools/test-recorder-generators.ts`). `maestro_generate` and **hand-written
flows** must add the header manually before the flow is considered reusable.

**Verification rule:** before approving a new flow for the artifact-first
inventory, confirm the header carries all 5 keys.

For the full authoring workflow (inventory dedup, selector grounding, the
ASCII flow diagram, optional fields — `params`, `appId`, `produces`,
`expectedRouteSequence` — validation, and replay-to-promote), load the
**creating-actions** skill.

---

## testID Best Practices

```tsx
// Good — stable, semantic testIDs
<TouchableOpacity testID="add-to-cart-btn">
<Text testID="cart-badge">{count}</Text>
<TextInput testID="search-input" />
<View testID={`product-item-${item.id}`}>

// Bad — index-based or text-based (breaks on reorder/copy changes)
<TouchableOpacity testID="button-0">
```

Grep for existing testIDs before writing flows:
```bash
grep -r 'testID=' src/ --include="*.tsx" --include="*.ts"
```

---

## Component Tree Queries — Token Efficiency Rules

1. NEVER call `cdp_component_tree` without a filter. Full tree dumps produce 10K+ tokens.
2. Always scope to the component you are checking:
   ```
   cdp_component_tree(filter="CartBadge", depth=2)
   cdp_component_tree(filter="product-list", depth=3)
   ```
3. Fiber tree presence does NOT mean screen visibility. Use Maestro `assertVisible`
   for screen-level checks, CDP for data-level checks.

---

## Multi-Device Testing

```bash
# ALWAYS pass --platform explicitly (global flag, before the test subcommand)
maestro-runner --platform ios test flow.yaml              # iOS
maestro-runner --platform android test flow.yaml          # Android

# With explicit device ID
maestro-runner --platform ios --device booted test flow.yaml
maestro-runner --platform android --device emulator-5554 test flow.yaml

# Sequential cross-platform
maestro-runner --platform ios test flows/feature.yaml && \
maestro-runner --platform android test flows/feature.yaml
```

## Android-Specific Testing Rules (GH #7)

1. **ALWAYS use maestro-runner on Android** — classic Maestro's gRPC driver
   is unreliable (UNAVAILABLE: io exception). maestro-runner talks directly
   to UIAutomator2 over HTTP, bypassing the fragile gRPC stack entirely.

2. **Text input**: Use `device_fill` for text input on Android. It auto-detects
   long strings (>30 chars) or special characters (`+`, `@`, `#`) and chunks
   the input to prevent ANR crashes. Never use raw `adb shell input text` for
   complex strings.

3. **Emulator boot timing**: Android emulators report "device" to ADB before
   the system is fully booted. Always verify `sys.boot_completed == 1` before
   running tests. The `ensure-android-ready.sh` hook checks this automatically.

4. **Play Protect**: Google Play Protect on emulators can silently block test
   APK installations. Disable it: Settings > Security > Play Protect.

5. **Port 7001 conflicts**: If you must use classic Maestro, clean stale
   forwarding rules first: `adb forward --remove-all`

---

## Auth Pre-flight: Auto-login via Maestro Subflows (GH #10)

Before testing features that require authentication, check if the app is
on a login/auth screen. If so, use the project's own Maestro subflows
instead of unreliable manual coordinate taps.

### Detection

Call `cdp_navigation_state` and check the route name. Auth-related routes
typically match: `Login`, `Welcome`, `SignIn`, `Register`, `Onboarding`,
`Auth`, `Landing`.

**Caution**: An empty navigation state may be a splash screen (loading) or
the Dev Client picker (GH #9), not necessarily auth. Wait 3 seconds and
retry before concluding the app is logged out.

### Discovery

Scan for Maestro subflows in the project:
```bash
ls .maestro/subflows/ .maestro/ 2>/dev/null
```

**Prefer login over registration** (idempotent, no backend junk):
1. `login.yaml`, `sign_in.yaml`, `auth.yaml`
2. `flow_start.yaml` (often includes login)
3. `register_user.yaml` (last resort — creates accounts)

Read the file to confirm it performs authentication.

### Pre-execution checks

1. **`clearState: true`**: If the subflow contains it and this is a Dev
   Client build, copy to `/tmp/` and strip the line before running (GH #8).
2. **Environment variables**: If the flow uses `${EMAIL}`, `${PASSWORD}`,
   etc., check for `.env` or `.maestro/config.yaml`. Ask the user if needed.
3. **`appId`**: Subflows often lack `appId`. Wrap them:
   ```bash
   cat > /tmp/auth-wrapper.yaml << EOF
   appId: <bundle-id>
   ---
   - launchApp
   - runFlow:
       file: $(pwd)/.maestro/subflows/login.yaml
   EOF
   ```

### Execution

```bash
# ALWAYS use maestro-runner (classic Maestro gRPC is unreliable on Android)
maestro-runner --platform <ios|android> test /tmp/auth-wrapper.yaml
```

If maestro-runner is not installed, STOP and tell the user to install it.
Do NOT fall back to classic Maestro.

### Verification

After the subflow completes, verify arrival at the main app:
```
cdp_navigation_state → route should be a main screen (Home, Dashboard, Tabs)
```

### Rules

- **NEVER** fall back to classic Maestro for auth flows (GH #7)
- **NEVER** use `clearState: true` with Dev Client builds (GH #8)
- **ALWAYS** pass `--platform` to maestro-runner
- **Skip** the notification `permissions` config if testing notification
  permission flows (preserve undetermined state)
- If no Maestro subflows found, inform the user and ask them to log in
  manually or create `.maestro/subflows/login.yaml`

---

## Permission Pre-flight for Permission-Gated Flows (GH #11)

Before testing flows that depend on specific permission states (notification
opt-in, camera access, location prompts), verify and set the correct state.

### Query (Android only)

```
device_permission(action="query", permission="notifications", appId="com.example.app")
→ { state: "granted" | "denied" | "not_declared" }
```

Query all permissions at once:
```
device_permission(action="query", permission="all", appId="com.example.app")
→ { granted: ["notifications", "camera"], denied: ["location"] }
```

### Set Required State

| Need | Currently | Action |
|------|-----------|--------|
| Undetermined (fresh prompt) | granted | `action="revoke"` + app restart |
| Undetermined (fresh prompt) | denied | `action="reset"` |
| Granted | denied | `action="grant"` |
| Denied | granted | `action="revoke"` |

### Platform Differences

| Platform | Query | Grant | Revoke | Reset |
|----------|-------|-------|--------|-------|
| Android | `dumpsys` — returns granted/denied | `pm grant` | `pm revoke` | `pm reset-permissions` |
| iOS Sim | **Not supported** (returns "unknown") | `simctl privacy grant` | `simctl privacy revoke` | `simctl privacy reset` |

### iOS Workaround

iOS Simulator cannot query permission state. Options:
1. Use `action="reset"` before testing to ensure ask-again state
2. Erase simulator for fully clean state (nuclear option)
3. Accept the limitation and retry if the flow skips

---

## Dev Menu: Use CDP, Not the Visual Menu

NEVER open the visual dev menu during automated testing — it overlays the
entire screen and blocks Maestro interactions.

Use `cdp_dev_settings` for programmatic control:
- Reload: `cdp_dev_settings action=reload` (or `cdp_reload` for auto-reconnect)
- Dismiss RedBox: `cdp_dev_settings action=dismissRedBox`
- Toggle inspector: `cdp_dev_settings action=toggleInspector`

---

## Network Mocking (for API-dependent features)

Inject mocks via CDP before navigating to the screen under test:
```
cdp_evaluate:
  expression: 'global.__RN_AGENT_MOCKS__ = { "https://api.example.com/products": [{ id: 1, name: "Test" }] }'
```

For the full app-side fetch-patching setup, multiple-URL mocking, and error
simulation, consult **`references/network-mocking-setup.md`**.

---

## Zustand Store Inspection Setup

Zustand v4+ uses `useSyncExternalStore`, NOT React Context. Fiber tree walking
cannot detect Zustand stores. Register store hooks for the MCP tool:

```typescript
// app/_layout.tsx or App.tsx — register the store hooks (not state snapshots)
if (__DEV__) {
  global.__ZUSTAND_STORES__ = {
    auth: useAuthStore,
    cart: useCartStore,
    settings: useSettingsStore,
  };
}
```

`cdp_store_state` calls `.getState()` on each registered hook at query time:
```
cdp_store_state(path="cart.items")     # reads useCartStore.getState().items
cdp_store_state(path="auth")           # reads full useAuthStore.getState()
```

---

## Prerequisites

| Tool | Required | Purpose | Install |
|------|----------|---------|---------|
| agent-device | Recommended | Live device interaction | `npm install -g agent-device` |
| maestro-runner | Recommended | YAML E2E test execution | Single binary download |
| Maestro | Fallback | YAML E2E test execution | `brew install maestro` |
| Xcode + Simulator | iOS | iOS testing | Mac App Store |
| Android SDK + adb | Android | Android testing | developer.android.com |
| Node.js >= 18 | Required | CDP MCP server | nodejs.org |

---

## Common Rationalizations

Agents routinely skip test steps because "it looks right." Don't.

| Excuse | Reality |
|--------|---------|
| "I tested on iOS, Android behaves the same" | False for ~40% of features (Ralph Loop data). Keyboard, permissions, back button, text input quirks, safe-area differ. Run `cross_platform_verify` unless explicitly single-platform. |
| "The component renders, I don't need to check state" | Rendering with wrong state is how most production bugs ship. `cdp_store_state(path="X")` is one call — take it. |
| "A screenshot is enough proof" | Screenshots show pixels, not correctness. If the test is "add to cart increments badge", verify the STORE incremented (`cdp_store_state`) — screenshot alone may show stale render. |
| "Manual testing is faster than writing a Maestro flow" | Manual doesn't persist. Tomorrow's refactor breaks the feature silently. A 15-second Maestro flow saves hours of regression debugging. |
| "I'll skip the `assertVisible` step — CDP is fast enough" | React render is async. `cdp_component_tree` called 50ms after a tap may query the old tree. Always `assertVisible` first, then CDP. |
| "The feature is trivial, no need for a testID" | Every interactive element needs a testID. Without them, E2E tests rely on text matching which breaks on i18n, capitalization, and whitespace changes. |
| "Network mocking is overkill for this test" | Real API calls make tests flaky (rate limits, network, staging drift). Mock at the boundary (MSW or `__RN_AGENT_RESPONSE_BODIES__`). |

## Red Flags — Stop and Reconsider

- About to claim "tested" without having called `cdp_status` first
- Reading ONLY `cdp_component_tree` without also checking store state
- Skipping cross-platform check because "I'm in a rush"
- Writing assertions on pixel positions or exact colors (brittle)
- Adding `sleep 3` to fix flakiness instead of using `assertVisible`
- Testing happy path only — no empty state, no error state, no loading state

## Verification — Before Declaring Tests Complete

- [ ] `cdp_status` returns `ok:true` with `cdp.connected: true`
- [ ] testIDs added to every new interactive element
- [ ] Maestro flow runs green: `maestro_run` on iOS
- [ ] Maestro flow runs green: `maestro_run` on Android (unless explicitly skipped)
- [ ] `cdp_store_state` confirms expected state after interactions
- [ ] `cdp_component_tree` shows the expected rendered tree
- [ ] `cdp_error_log` returns zero errors at the end of the flow
- [ ] Screenshots saved to `docs/proof/<feature>/` for PR evidence
- [ ] Cross-platform parity verified OR documented difference noted
