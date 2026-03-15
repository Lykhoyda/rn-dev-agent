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
- launchApp:
    clearState: true
- assertVisible: "Home"
```

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
- launchApp:
    clearState: true
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
maestro-runner test /tmp/step.yaml
```

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
# Run Maestro on specific device
maestro-runner --device booted test flow.yaml        # iOS
maestro-runner --device emulator-5554 test flow.yaml  # Android

# Sequential cross-platform
maestro-runner test --device booted flows/feature.yaml && \
maestro-runner test --device emulator-5554 flows/feature.yaml
```

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
