# Design: Port expo-mcp Patterns into rn-dev-agent

**Date:** 2026-03-10
**Status:** Approved
**Approach:** Flat Extension (Approach B) — add new modules alongside existing code

## Goal

Port the best patterns from [expo/expo-mcp](https://github.com/expo/expo-mcp) into our plugin:
- Native device automation (XCTest for iOS, ADB for Android)
- Multi-source log collection with factory pattern
- Screenshot image optimization pipeline
- Direct tap/find tools complementing Maestro (not replacing it)

## New MCP Tools (4)

| Tool | Purpose | Parameters |
|------|---------|------------|
| `automation_tap` | Tap by testID or coordinates | `platform?`, `testID?`, `x?`, `y?` |
| `automation_find` | Find element, return bounds/text/state | `platform?`, `testID` |
| `automation_screenshot` | Optimized screenshot (700KB target) | `platform?`, `testID?`, `maxBytes?` |
| `collect_logs` | Multi-source log collection | `sources[]`, `durationMs`, `filter?`, `logLevel?` |

Existing 10 CDP tools remain unchanged. Agent chooses based on need:
- Quick tap → `automation_tap`; complex flow → Maestro
- Check element exists → `automation_find`; inspect React hierarchy → `cdp_component_tree`
- Visual check → `automation_screenshot`
- "What just happened?" → `cdp_console_log`; "Reproduce and capture" → `collect_logs`

## Architecture

### Automation Layer

```
scripts/cdp-bridge/src/automation/
  types.ts              # IAutomation interface + result types
  factory.ts            # AutomationFactory.create(platform), detectPlatform()
  android.ts            # AutomationAndroid (ADB-based)
  ios.ts                # AutomationIos (XCTest-based)
  ios-xctest/
    AutomationUITests.swift   # XCTest runner
    Info.plist
```

#### IAutomation Interface

```typescript
interface IAutomation {
  tap(options: { testID?: string; x?: number; y?: number }): Promise<TapResult>;
  find(testID: string): Promise<FindResult>;
  screenshot(options?: { testID?: string }): Promise<ScreenshotResult>;
}

interface TapResult { success: boolean; durationMs: number }
interface FindResult { found: boolean; bounds?: { x: number; y: number; w: number; h: number }; text?: string; accessible?: boolean; enabled?: boolean }
interface ScreenshotResult { buffer: Buffer; bytes: number; quality: number; width: number }
```

#### Android Implementation

- `tap` → find element via UIAutomator dump then `adb shell input tap <center>`, or direct coordinates
- `find` → `adb shell uiautomator dump` → parse XML → match by `content-desc` (RN testID maps here) OR `resource-id` as fallback
- `screenshot` → `adb shell screencap` → pull → optimize

#### iOS Implementation

- All operations go through XCTest runner
- Communication: action + params passed as env vars to `xcodebuild test`
- Response: JSON between `######JSON_START######` / `######JSON_END######` markers
- XCTest Swift code uses `XCUIApplication(bundleIdentifier:)` with bundle ID from `RN_AGENT_BUNDLE_ID` env var to attach to the correct app-under-test (not the test host)
- If `RN_AGENT_BUNDLE_ID` is not set, falls back to `XCUIApplication()` (launches test host)

#### Platform Detection

```typescript
AutomationFactory.detectPlatform(preferredPlatform?: 'ios' | 'android'): 'ios' | 'android'
// 1. If preferredPlatform provided and that device is booted, use it
// 2. If CDP is connected, prefer the platform hint from CDP connection
// 3. Check booted iOS simulator (xcrun simctl list)
// 4. Check connected Android device (adb devices)
// 5. If both booted and no preference/hint, default to iOS (matches snapshot_state.sh)
// 6. Throw with descriptive error if neither is booted
```

The `platform` parameter on each tool flows through to `detectPlatform()`. When omitted, auto-detection prefers the CDP-connected platform, then iOS if both are available. `AutomationFactory.setCdpPlatformHint()` is called when the CDP client connects to set this preference.

#### XCTest Build Pipeline

- Swift source in `automation/ios-xctest/`
- Built on first use: `xcodebuild build-for-testing` targeting iOS Simulator
- Expected first-build time: 30-120 seconds (subsequent runs use cache, instant)
- Cached at `~/.cache/rn-dev-agent/xctest-bundle/`
- Cache key: SHA256 of all source files (Swift + Info.plist) + Xcode version (includes iOS SDK version)
- Subsequent runs use cached bundle (instant)

**Failure handling:**
- Xcode not installed → `automation_*` tools return structured error: `{ error: "xcode_not_found", message: "Xcode CLI tools required for iOS automation. Install with: xcode-select --install" }`. MCP server does NOT crash — iOS tools degrade gracefully, Android tools still work.
- Build failure (Swift version mismatch, missing SDK) → error surfaced in tool response with full `xcodebuild` stderr. Agent can retry or fall back to Maestro.
- XCTest invocation timeout: 30 seconds per call (covers build-if-needed + test execution).

#### Android Prerequisite Handling

- ADB not found → `automation_*` tools return structured error: `{ error: "adb_not_found", message: "ADB not found. Set ANDROID_HOME or install Android SDK." }`. iOS tools still work.
- No device connected → descriptive error listing available devices.

### Log Collection System

```
scripts/cdp-bridge/src/log-collectors/
  types.ts                # LogEntry, LogCollector interface
  factory.ts              # LogCollectorFactory.create(sources[])
  cdp-collector.ts        # JS console via existing CdpClient
  android-collector.ts    # ADB logcat parser
  ios-collector.ts        # xcrun simctl log stream
  composite-collector.ts  # Parallel aggregator
```

#### LogCollector Interface

```typescript
interface LogCollector {
  collect(options: {
    durationMs: number;
    filter?: string;
    logLevel?: 'error' | 'warn' | 'info' | 'debug';
  }): Promise<LogEntry[]>;
}

interface LogEntry {
  source: 'js_console' | 'native_ios' | 'native_android';
  level: string;
  message: string;
  timestamp: number;
}
```

#### Difference from existing `cdp_console_log`

| | `cdp_console_log` | `collect_logs` |
|---|---|---|
| Sources | JS console only (ring buffer) | JS + native iOS + native Android |
| Timing | Reads already-buffered entries | Actively listens for `durationMs` |
| Use case | "What happened since last check?" | "Reproduce this, capture everything" |

#### CDP Collector
Reuses existing `CdpClient` — no new WebSocket. Reads from the existing `consoleBuffer` ring buffer, filtering entries by timestamp range (capture start → capture start + durationMs). This avoids registering a second event handler (CdpClient's `eventHandlers` Map is keyed by method name, so duplicates would overwrite). The ring buffer continues accumulating as normal; the collector just snapshots entries within the time window.

#### Android Collector
- Clears then streams: `adb logcat -c && adb logcat -v threadtime`
- Parses: `MM-DD HH:MM:SS.mmm PID TID LEVEL TAG: message`
- Resolves app PID to filter app-specific logs
- ADB discovery: `$ANDROID_HOME/platform-tools/adb` fallback chain

#### iOS Collector
- `xcrun simctl spawn booted log stream --predicate 'processImagePath ENDSWITH "<executable>"'`
- `processImagePath` requires the **executable name** (the binary name inside the .app bundle), not the bundle identifier. Resolution chain:
  1. CDP connected → `cdp_evaluate('__RN_AGENT.getAppInfo()')` → extract executable name from the app info (falls through if CDP unavailable)
  2. Read from `app.json` / `app.config.js` → `expo.ios.bundleIdentifier` → derive executable name (last component of bundle ID, e.g. `com.example.MyApp` → `MyApp`)
  3. Fallback: `Expo Go` executable name
- Streams for duration, kills process after
- Filters known system noise (notification center, SpringBoard)

#### Composite Collector

```typescript
class CompositeLogCollector implements LogCollector {
  async collect(options) {
    const settled = await Promise.allSettled(
      this.collectors.map(c => c.collect(options))
    );
    return settled
      .filter((r): r is PromiseFulfilledResult<LogEntry[]> => r.status === 'fulfilled')
      .flatMap(r => r.value)
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
```

### Image Optimization

```
scripts/cdp-bridge/src/image-utils.ts
```

```typescript
async function optimizeScreenshot(buffer: Buffer, options?: {
  maxBytes?: number;       // Default 700KB (716800)
  initialQuality?: number; // Default 85
  minQuality?: number;     // Default 40
}): Promise<{ buffer: Buffer; bytes: number; quality: number; width: number }>
```

Two-phase compression:
1. **Reduce JPEG quality:** 85 → step down by 10 → floor at 40
2. **Downscale dimensions:** reduce by 10% per iteration, max 10 iterations

Dependency: `jimp-compact` (0.16.1) — pure JS, no native bindings. Chosen over `sharp` (native libvips bindings, complex install on some systems) because we process one screenshot at a time and don't need the speed. Total iteration cap across both phases: 15 max (5 quality steps + 10 dimension steps).

## New Tool Schemas

### `automation_tap`

```typescript
z.object({
  platform: z.enum(['ios', 'android']).optional(),
  testID: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
}).refine(
  (d) => d.testID != null || (d.x != null && d.y != null),
  { message: 'Provide either testID or both x and y coordinates' }
)
```

### `automation_find`

```typescript
{
  platform: z.enum(['ios', 'android']).optional(),
  testID: z.string(),
}
// Returns: { found, bounds, text, accessible, enabled }
```

### `automation_screenshot`

```typescript
{
  platform: z.enum(['ios', 'android']).optional(),
  testID: z.string().optional(),  // Element-specific if provided (find bounds → crop)
  maxBytes: z.number().optional(), // Default 716800 (700KB)
}
```

**Return format:** MCP `image` content type with base64-encoded JPEG. Always JPEG regardless of platform (Android screencap PNG is converted). If element `testID` is provided, bounds are found via `automation_find`, then screenshot is cropped to those bounds (with bounds clamped to image dimensions) before optimization.

### `collect_logs`

```typescript
{
  sources: z.array(z.enum(['js_console', 'native_ios', 'native_android'])).default(['js_console']),
  durationMs: z.number().min(0).max(10000).default(2000),
  filter: z.string().optional(),
  logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional(),
}
```

## File Changes

### New Files

All paths relative to `scripts/cdp-bridge/`:

| File | Purpose |
|------|---------|
| `src/automation/types.ts` | IAutomation interface + result types |
| `src/automation/factory.ts` | Platform detection + factory |
| `src/automation/android.ts` | ADB automation |
| `src/automation/ios.ts` | XCTest automation |
| `src/automation/ios-xctest/AutomationUITests.swift` | XCTest runner |
| `src/automation/ios-xctest/Info.plist` | Test bundle metadata |
| `src/log-collectors/types.ts` | LogEntry, LogCollector interface |
| `src/log-collectors/factory.ts` | LogCollectorFactory |
| `src/log-collectors/cdp-collector.ts` | CDP log collector (reads from existing ring buffer) |
| `src/log-collectors/android-collector.ts` | Logcat parser |
| `src/log-collectors/ios-collector.ts` | simctl log stream |
| `src/log-collectors/composite-collector.ts` | Aggregator |
| `src/image-utils.ts` | optimizeScreenshot() |
| `src/tools/automation-tap.ts` | MCP tool handler (standalone, no CdpClient) |
| `src/tools/automation-find.ts` | MCP tool handler (standalone, no CdpClient) |
| `src/tools/automation-screenshot.ts` | MCP tool handler (standalone, no CdpClient) |
| `src/tools/collect-logs.ts` | MCP tool handler (needs CdpClient for js_console source, standalone for native sources) |

### Modified Files

All paths relative to `scripts/cdp-bridge/` unless noted:

| File | Change |
|------|--------|
| `src/index.ts` | Register 4 new tools. `automation_*` tools registered without `withConnection`. `collect_logs` receives CdpClient reference but uses it only when `js_console` is in sources. |
| `package.json` | Add `jimp-compact` dependency |
| `skills/rn-testing/SKILL.md` | Add tool selection guide (when to use automation vs Maestro vs CDP) |
| `skills/rn-debugging/SKILL.md` | Add native log collection instructions, reference `collect_logs` |
| `skills/rn-device-control/SKILL.md` | Reference new automation tools alongside existing simctl/adb commands |

### Untouched

`cdp-client.ts`, `injected-helpers.ts`, `ring-buffer.ts` (read by cdp-collector but not modified), `types.ts`, `utils.ts`, all 11 existing tool handlers.

### Prerequisites

New tools require platform-specific tooling (graceful degradation when missing):
- **iOS:** Xcode CLI tools (`xcode-select --install`) — needed for XCTest build + simctl
- **Android:** Android SDK with `adb` in `$ANDROID_HOME/platform-tools/`
- **Both:** Node.js >= 18 (existing requirement)

## Target Resolution

Multiple tools need the same target information (platform, bundle ID, executable name, app ID). Rather than resolving these independently in each tool handler, the `AutomationFactory` provides a `cdpPlatformHint` that can be set once when CDP connects. Tool handlers resolve `executableName` and `appId` on demand (via CDP evaluation or app.json fallback), with results naturally cached at the call-site level.

**Future enhancement:** If target resolution becomes more complex (e.g., multi-device support), extract a `TargetContext` object that all tools share. For now, the per-tool resolution is sufficient.

## New Dependency

```json
{ "jimp-compact": "0.16.1" }
```

## Cache

```
~/.cache/rn-dev-agent/
  xctest-bundle/        # Built XCTest binary + DerivedData
  source-hash           # SHA256 of all source files (Swift + Info.plist)
  xcode-version         # Xcode version (includes SDK version)
```
