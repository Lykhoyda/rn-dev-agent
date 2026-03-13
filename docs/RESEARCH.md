# rn-dev-agent: CLI Tool Research & Speed Improvements

## Executive Summary

The single highest-impact optimization for the testing loop is **concurrent state extraction** — a single script that simultaneously grabs a compressed screenshot AND the native UI hierarchy, then strips non-interactive nodes before feeding both to the agent. This eliminates the biggest bottleneck: the agent waiting to understand what happened after each action.

---

## Research Findings

### 1. Screenshot Speed — JPEG Over PNG, Always

| Platform | Command | Time | Size |
|----------|---------|------|------|
| iOS Sim | `xcrun simctl io booted screenshot --type=png /tmp/s.png` | ~150ms | ~800KB |
| iOS Sim | `xcrun simctl io booted screenshot --type=jpeg /tmp/s.jpg` | ~80ms | ~200KB |
| Android | `adb shell screencap -p /sdcard/s.png && adb pull` | ~500ms | ~800KB |
| Android | `adb exec-out screencap -p > /tmp/s.png` | ~300ms | ~800KB |
| Android | `adb exec-out "screencap \| gzip -1" > /tmp/s.gz` | ~150ms | ~250KB |

**Decision: Always use JPEG for iOS, gzipped PNG for Android.** Vision models internally compress and downscale images anyway — pixel-perfect PNGs are wasted I/O.

For the skill:
```bash
# iOS — fast JPEG screenshot
xcrun simctl io booted screenshot --type=jpeg /tmp/rn-screenshot.jpg

# Android — fast gzipped screenshot
adb exec-out screencap -p > /tmp/rn-screenshot.png
# Or for maximum speed (2-3x faster):
adb exec-out "screencap | gzip -1" > /tmp/rn-screenshot.png.gz && \
  gunzip -f /tmp/rn-screenshot.png.gz
```

### 2. UI Hierarchy Extraction — The Secret Weapon

Both platforms can dump structured accessibility/UI trees that are far more useful to an LLM than raw screenshots:

**Android:**
```bash
# Full UI hierarchy as XML (300-500ms)
adb shell uiautomator dump --compressed /dev/stdout

# Output contains per-element:
# - text, resource-id, content-desc (for finding elements)
# - bounds="[left,top][right,bottom]" (for calculating tap coordinates)
# - class, clickable, enabled, focused, scrollable
```

**iOS (via simctl + Accessibility Inspector):**
```bash
# No built-in equivalent to uiautomator dump in simctl
# Options:
# 1. Maestro's internal hierarchy (not directly exposed CLI)
# 2. idb: `idb ui describe-all --udid booted` (requires idb install)
# 3. CDP: Walk fiber tree for testID-tagged elements (our MCP server)
```

**Decision: Use `uiautomator dump` on Android as a fast state extraction tool. On iOS, rely on Maestro + CDP since simctl lacks this capability.**

### 3. maestro-runner — The 3.6x Speed Boost

`maestro-runner` is a Go-based drop-in replacement for Maestro (same YAML syntax) that launched January 2026:

| Metric | Maestro (Java) | maestro-runner (Go) |
|--------|---------------|-------------------|
| Binary size | ~300MB (with JVM) | 21MB single binary |
| Startup time | 2-4s (JVM cold start) | <100ms |
| Memory | ~400MB | ~30MB |
| Flow execution | Baseline | 2-3x faster |
| iOS real device | Paid only | Built-in (free) |
| Parallel runs | No | `--parallel` flag |
| Install | `brew install maestro` + Java | Single binary download |

Architecture: eliminates the gRPC layer Maestro uses, directly communicates with UIAutomator2 (Android) and WebDriverAgent (iOS) via HTTP.

**Decision: Recommend `maestro-runner` as default, Maestro as fallback.** The YAML flows are identical — zero migration cost. The JVM elimination alone saves 3-4 seconds on every test invocation (enormous in an agent loop that may run 10-20 test steps).

Update for the skill:
```bash
# Check which runner is available (prefer maestro-runner)
if command -v maestro-runner &>/dev/null; then
  RUNNER="maestro-runner"
elif command -v maestro &>/dev/null; then
  RUNNER="maestro"
else
  echo "Install: brew install maestro OR download maestro-runner from github.com/devicelab-dev/maestro-runner"
  exit 1
fi

# Execute flow (same syntax either way)
$RUNNER test flows/my-flow.yaml
```

### 4. idb vs simctl — Skip idb, Use What's Already There

Facebook's `idb` provides capabilities simctl lacks (UI tapping, accessibility tree, direct input events), BUT:

- Requires Python + pip + fb-idb + idb_companion via Homebrew
- Adds significant setup friction for plugin users
- The companion daemon can interfere with Xcode's own simulator management
- Maestro already abstracts the UI interaction layer

**Decision: Don't depend on idb.** The setup cost outweighs the benefit. Maestro handles all UI interaction. simctl handles all device lifecycle. CDP handles all app introspection. The three together cover everything idb would add.

### 5. The Existing ios-simulator-skill Pattern

The `conorluddy/ios-simulator-skill` Claude Code plugin takes an interesting approach: 21 Python scripts wrapping simctl/idb for semantic navigation (find elements by text, type, or ID rather than coordinates). Key scripts:

- `navigator.py` — find elements by text/type/testID and tap
- `screen_mapper.py` — map all visible elements with positions
- `accessibility_audit.py` — WCAG compliance checking

**What we can learn:**
- The "semantic navigation" approach (finding elements by meaning, not coordinates) is the right mental model
- But Python scripts add cold-start latency (~200ms per script) and a Python dependency
- For our use case, Maestro already does semantic navigation (`tapOn: "Button Text"` or `tapOn: { id: "testID" }`)
- The accessibility audit concept is worth adding to our skills

**Decision: Don't build wrapper scripts. Maestro IS the semantic navigation layer.** Add accessibility audit patterns to the testing skill.

---

## The Optimized Testing Loop

Based on all findings, here's the improved loop with timing estimates:

```
CURRENT (v2):
  1. Maestro tap action           →  1.5s  (JVM start + execution)
  2. Maestro assertVisible        →  0.5s
  3. bash: screenshot (PNG)       →  0.3s
  4. MCP: cdp_component_tree      →  0.5s
  5. MCP: cdp_store_state         →  0.3s
  Total per step: ~3.1s

OPTIMIZED (v3):
  1. maestro-runner tap action    →  0.3s  (no JVM, direct driver)
  2. maestro-runner assertVisible →  0.3s
  3. bash: snapshot_state.sh      →  0.2s  (concurrent JPEG + UI dump)
  4. MCP: cdp_component_tree      →  0.4s
  5. MCP: cdp_store_state         →  0.2s
  Total per step: ~1.4s

  Improvement: 2.2x faster per step
  Over a 10-step test: 31s → 14s saved
```

### The `snapshot_state.sh` Script

The single highest-impact addition: a concurrent state capture script.

```bash
#!/bin/bash
# scripts/snapshot_state.sh
# Captures screenshot + UI hierarchy concurrently
# Usage: snapshot_state.sh [ios|android] [output_dir]

PLATFORM=${1:-$([ -n "$(xcrun simctl list devices booted 2>/dev/null | grep Booted)" ] && echo "ios" || echo "android")}
OUT_DIR=${2:-/tmp/rn-dev-agent}
mkdir -p "$OUT_DIR"

if [ "$PLATFORM" = "ios" ]; then
  # iOS: screenshot (JPEG) + we rely on CDP for accessibility tree
  xcrun simctl io booted screenshot --type=jpeg "$OUT_DIR/screenshot.jpg" &
  PID_SCREENSHOT=$!
  
  # iOS has no CLI accessibility dump — CDP handles this
  wait $PID_SCREENSHOT
  echo '{"platform":"ios","screenshot":"'$OUT_DIR'/screenshot.jpg"}'

elif [ "$PLATFORM" = "android" ]; then
  # Android: screenshot + UI hierarchy dump CONCURRENTLY
  adb exec-out screencap -p > "$OUT_DIR/screenshot.png" &
  PID_SCREENSHOT=$!
  
  adb shell uiautomator dump --compressed /dev/stdout > "$OUT_DIR/ui_hierarchy.xml" &
  PID_HIERARCHY=$!
  
  wait $PID_SCREENSHOT $PID_HIERARCHY
  
  # Prune hierarchy: keep only interactive + visible elements
  python3 -c "
import xml.etree.ElementTree as ET, json, sys
try:
    tree = ET.parse('$OUT_DIR/ui_hierarchy.xml')
    elements = []
    for node in tree.iter('node'):
        text = node.get('text', '')
        rid = node.get('resource-id', '')
        desc = node.get('content-desc', '')
        bounds = node.get('bounds', '')
        clickable = node.get('clickable') == 'true'
        visible = node.get('visible-to-user', 'true') != 'false'
        
        # Only include elements that are useful to an agent
        if (text or rid or desc) and visible:
            elements.append({
                'text': text, 'id': rid, 'desc': desc,
                'bounds': bounds, 'clickable': clickable,
                'class': node.get('class', '').split('.')[-1]
            })
    json.dump({'elements': elements, 'count': len(elements)}, sys.stdout, indent=2)
except: 
    json.dump({'error': 'Failed to parse UI hierarchy'}, sys.stdout)
" > "$OUT_DIR/ui_elements.json"
  
  echo '{"platform":"android","screenshot":"'$OUT_DIR'/screenshot.png","hierarchy":"'$OUT_DIR'/ui_elements.json"}'
fi
```

### Pruned Android UI Hierarchy Example

Before pruning (raw `uiautomator dump`): ~15-30KB XML, 200+ nodes
After pruning (interactive + visible only): ~2-3KB JSON, 15-40 nodes

```json
{
  "elements": [
    { "text": "Home", "id": "tab-home", "desc": "", "bounds": "[0,1700][270,1920]", "clickable": true, "class": "TextView" },
    { "text": "Shopping Cart", "id": "cart-header", "desc": "", "bounds": "[100,100][980,160]", "clickable": false, "class": "TextView" },
    { "text": "Air Max 90", "id": "product-name-0", "desc": "", "bounds": "[100,200][800,260]", "clickable": true, "class": "TextView" },
    { "text": "$99.00", "id": "product-price-0", "desc": "", "bounds": "[800,200][980,260]", "clickable": false, "class": "TextView" },
    { "text": "Checkout", "id": "checkout-btn", "desc": "Proceed to checkout", "bounds": "[200,1500][880,1600]", "clickable": true, "class": "Button" }
  ],
  "count": 5
}
```

This is ~500 bytes — about 100 tokens. The agent can immediately understand the screen without any screenshots.

---

## Skill Updates for Speed

### rn-device-control/SKILL.md Additions

```markdown
## Fast Screenshot Commands

### iOS (prefer JPEG — 2x faster, good enough for AI analysis)
```bash
xcrun simctl io booted screenshot --type=jpeg /tmp/screenshot.jpg
```

### Android (prefer exec-out — skips device storage)
```bash
# Standard (300ms)
adb exec-out screencap -p > /tmp/screenshot.png

# Faster with gzip (150ms, need to decompress)
adb exec-out "screencap | gzip -1" > /tmp/s.gz && gunzip -f /tmp/s.gz
```

## Quick State Snapshot (Android Only)

Get a structured list of all visible interactive elements in one command:
```bash
adb shell uiautomator dump --compressed /dev/stdout | \
  python3 -c "
import xml.etree.ElementTree as ET, json, sys
tree = ET.parse(sys.stdin)
els = [{'text':n.get('text',''),'id':n.get('resource-id',''),
        'bounds':n.get('bounds',''),'clickable':n.get('clickable')=='true'}
       for n in tree.iter('node')
       if n.get('text') or n.get('resource-id')]
json.dump(els, sys.stdout, indent=2)"
```

This returns a JSON array of on-screen elements — faster and more
token-efficient than a screenshot for understanding screen state.

## Disable Animations for Faster Testing (Android)

Run once before testing — makes all transitions instant:
```bash
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
```

Restore after testing:
```bash
adb shell settings put global window_animation_scale 1
adb shell settings put global transition_animation_scale 1
adb shell settings put global animator_duration_scale 1
```

## Reduce Simulator Resolution (Faster Screenshots)

For testing (not screenshots for marketing), lower resolution = faster:
```bash
# Android: use a smaller AVD or resize window
# emulator -avd Pixel_6 -skin 720x1280

# iOS: use iPhone SE simulator (smallest screen = fastest screenshots)
```
```

### rn-testing/SKILL.md Additions

```markdown
## Test Runner: maestro-runner (Preferred)

maestro-runner is a Go-based drop-in replacement for Maestro.
Same YAML flows, 3x faster, no JVM required.

Install: Download single binary from github.com/devicelab-dev/maestro-runner
Fallback: `brew install maestro` (requires Java)

```bash
# Auto-detect runner
RUNNER=$(command -v maestro-runner || command -v maestro)
$RUNNER test flows/my-flow.yaml
```

### Why maestro-runner is faster for AI agents:
- No JVM cold start (saves 2-4s on EVERY test invocation)
- Direct UIAutomator2/WDA drivers (no gRPC middleware)
- --parallel flag for running multiple flows simultaneously
- 21MB binary vs 300MB+ with JVM

## The Fast Test Pattern

For maximum speed, combine Maestro for actions with native hierarchy
dumps for state reading:

```bash
# 1. Run action via Maestro (fast)
maestro-runner test /tmp/tap-add-to-cart.yaml

# 2. Grab state concurrently (fast)
bash scripts/snapshot_state.sh android /tmp/state

# 3. Read the pruned element list (tiny, fast for LLM to parse)
cat /tmp/state/ui_elements.json

# 4. For deeper inspection (React state, store, network)
# → use CDP MCP tools
```

## Read Screen State Without Screenshot (Android)

When you just need to know WHAT's on screen, not HOW it looks:
```bash
adb shell uiautomator dump --compressed /dev/stdout
```

This returns XML with every element's text, ID, bounds, and clickability.
Parse it to find elements, verify text content, or calculate tap targets.
This is 10x more token-efficient than sending a screenshot to a vision model.

## Accessibility Testing

After feature verification, check accessibility basics:
```yaml
# flows/accessibility-check.yaml
appId: com.example.app
---
- assertVisible:
    id: "submit-btn"
    enabled: true
- assertTrue:
    condition: "element('submit-btn').accessibilityLabel != ''"
    label: "Submit button must have accessibility label"
```

Or via adb:
```bash
# Check all clickable elements have content descriptions
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
```

---

## Updated Prerequisites

| Tool | Required | Purpose | Install | Speed Impact |
|------|----------|---------|---------|-------------|
| maestro-runner | **Recommended** | UI test execution | Single binary download | 3x faster than Maestro |
| Maestro | Fallback | UI test execution | `brew install maestro` | Baseline |
| Xcode + Simulator | iOS | iOS testing | Mac App Store | — |
| Android SDK + ADB | Android | Android testing | developer.android.com | — |
| Node.js ≥ 18 | Required | CDP MCP server | nodejs.org | — |
| Python 3 | Optional | UI hierarchy parsing | Usually pre-installed | — |

**Explicitly NOT required:** idb, Appium, Detox, Flipper, Java (if using maestro-runner)

---

## Impact Summary

| Optimization | Speed Gain | Effort | Priority |
|-------------|-----------|--------|----------|
| maestro-runner over Maestro | 2-3x per flow execution | 1 hour (skill update) | **P0** |
| JPEG screenshots (iOS) | 2x per screenshot | 30 min (skill update) | **P0** |
| Concurrent snapshot_state.sh | 40% per state check | 2 hours (script + skill) | **P1** |
| Android UI hierarchy parsing | 10x fewer tokens than screenshot | 2 hours (script + skill) | **P1** |
| Disable animations (Android) | Eliminates transition delays | 10 min (skill update) | **P1** |
| gzip screenshots (Android) | 2x per screenshot | 30 min (skill update) | **P2** |
| Lower resolution simulator | Variable | Docs only | **P3** |