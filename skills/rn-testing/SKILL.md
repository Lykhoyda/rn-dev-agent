# React Native Testing

Patterns for testing React Native apps with Maestro/maestro-runner and CDP.

## Test Runner: maestro-runner (Preferred)

maestro-runner is a Go-based drop-in replacement for Maestro — 3x faster, no JVM.

```bash
# Auto-detect runner
if command -v maestro-runner &>/dev/null; then
  RUNNER="maestro-runner"
elif command -v maestro &>/dev/null; then
  RUNNER="maestro"
else
  echo "Install maestro-runner or maestro"
  exit 1
fi

$RUNNER test flows/my-flow.yaml
```

### Why maestro-runner for AI agents:
- No JVM cold start (saves 2-4s per invocation)
- Direct UIAutomator2/WDA drivers (no gRPC)
- `--parallel` flag for simultaneous flows
- 21MB binary vs 300MB+ with JVM

## Maestro Flow Patterns

### Basic Interactions
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
```

### Text Input
```yaml
- tapOn:
    id: "search-input"
- inputText: "running shoes"
- pressKey: enter
- assertVisible: "Search Results"
```

### Scrolling
```yaml
- scrollUntilVisible:
    element:
      id: "checkout-btn"
    direction: DOWN
    timeout: 10000
```

### Waiting
```yaml
- assertVisible:
    text: "Loading..."
    enabled: true
- extendedWaitUntil:
    visible:
      text: "Results"
    timeout: 10000
```

## Timing: Maestro First, CDP Second

After any UI interaction, React needs time to commit updates to the Fiber tree.

**CORRECT sequence:**
1. Maestro tap/input
2. Maestro `assertVisible` (waits for UI to settle)
3. CDP state query (gets NEW state)

**WRONG (race condition):**
```
maestro tapOn "Submit" → immediately cdp_store_state → gets OLD state
```

**RIGHT:**
```
maestro tapOn "Submit" → maestro assertVisible "Success" → cdp_store_state → gets NEW state
```

If no visual indicator exists after the action:
```bash
maestro tapOn "Submit" && sleep 0.7
# Then query CDP
```

## The Fast Test Pattern

For maximum speed, combine Maestro for actions with native hierarchy for state:

```bash
# 1. Run action (fast)
maestro-runner test /tmp/tap-add-to-cart.yaml

# 2. Grab state concurrently (fast)
bash scripts/snapshot_state.sh android /tmp/state

# 3. Read pruned element list (tiny, fast for LLM)
cat /tmp/state/ui_elements.json

# 4. For deeper inspection → use CDP MCP tools
```

## testID Best Practices

Always use `testID` prop for elements the agent needs to find:

```tsx
<TouchableOpacity testID="add-to-cart-btn" onPress={addToCart}>
  <Text>Add to Cart</Text>
</TouchableOpacity>

<View testID="cart-badge">
  <Text>{count}</Text>
</View>
```

Naming convention: `kebab-case`, descriptive of purpose:
- `product-list`, `cart-badge`, `checkout-btn`
- `search-input`, `filter-price-slider`
- `error-message`, `loading-spinner`

## Dev Menu: Avoid the Visual Menu

NEVER open the visual dev menu during automated testing — it blocks Maestro.

Use `cdp_dev_settings` for programmatic control:
- Reload: `cdp_dev_settings action=reload`
- Dismiss RedBox: `cdp_dev_settings action=dismissRedBox`

If visual dev menu appears:
```bash
# Android: press back to dismiss
adb shell input keyevent KEYCODE_BACK
# iOS: tap outside menu area
```

## Multi-Device Testing

```bash
# Check what's running
xcrun simctl list devices booted
adb devices

# Run on specific device
maestro --device booted test flow.yaml        # iOS
maestro --device emulator-5554 test flow.yaml # Android
```

## Zustand Store Inspection

Zustand v4+ uses `useSyncExternalStore`, NOT React Context. Fiber walking cannot detect Zustand stores.

Required setup (1 line, zero production cost):
```typescript
// app/_layout.tsx or App.tsx
if (__DEV__) {
  global.__ZUSTAND_STORES__ = {
    auth: useAuthStore,
    cart: useCartStore,
    settings: useSettingsStore,
  };
}
```

Then query: `cdp_store_state(path="cart.items")`

## Accessibility Testing

After feature verification, check accessibility:
```yaml
- assertVisible:
    id: "submit-btn"
    enabled: true
```

Via adb:
```bash
adb shell uiautomator dump --compressed /dev/stdout | \
  python3 -c "
import xml.etree.ElementTree as ET, sys
tree = ET.parse(sys.stdin)
issues = []
for n in tree.iter('node'):
    if n.get('clickable') == 'true':
        if not n.get('content-desc') and not n.get('text'):
            issues.append(f\"Missing label: {n.get('class')} bounds={n.get('bounds')}\")
for i in issues: print(i)
print(f'Total accessibility issues: {len(issues)}')
"
```

## Network Mocking

For testing features with specific API responses:

```typescript
// In app code (dev only):
if (__DEV__ && global.__RN_AGENT_MOCKS__) {
  const mocks = global.__RN_AGENT_MOCKS__;
  const origFetch = global.fetch;
  global.fetch = (url, opts) => {
    if (mocks[url]) return Promise.resolve(new Response(JSON.stringify(mocks[url])));
    return origFetch(url, opts);
  };
}
```

Inject mocks via CDP:
```
cdp_evaluate: global.__RN_AGENT_MOCKS__ = {
  "https://api.example.com/products": [{ id: 1, name: "Test Product" }]
}
```
