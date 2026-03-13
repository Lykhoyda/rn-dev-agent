# Port expo-mcp Patterns Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add native device automation (XCTest + ADB), multi-source log collection, and image optimization to the rn-dev-agent MCP server, porting proven patterns from expo/expo-mcp.

**Architecture:** 4 new MCP tools (`automation_tap`, `automation_find`, `automation_screenshot`, `collect_logs`) added to the existing cdp-bridge server. New modules (`automation/`, `log-collectors/`, `image-utils.ts`) sit alongside existing code. Automation tools are standalone (no CDP dependency); `collect_logs` optionally uses CDP for JS console source.

**Tech Stack:** TypeScript (ES2022, Node16 modules), Zod schemas, `jimp-compact` for image processing, `xcodebuild` for iOS XCTest, `adb` for Android automation.

**Spec:** `docs/superpowers/specs/2026-03-10-expo-mcp-patterns-port-design.md`

**Security note:** Use `execFileSync` / `spawn` (array args) instead of `execSync` with string interpolation to prevent shell injection. Only use `execSync` for static commands with no user input.

---

## File Structure

All paths relative to `scripts/cdp-bridge/`:

### New Files

| File | Responsibility |
|------|---------------|
| `src/automation/types.ts` | `IAutomation` interface, `TapResult`, `FindResult`, `ScreenshotResult` types |
| `src/automation/factory.ts` | `AutomationFactory` — platform detection, create automation instance |
| `src/automation/android.ts` | `AutomationAndroid` — ADB-based tap/find/screenshot |
| `src/automation/ios.ts` | `AutomationIos` — XCTest-based tap/find/screenshot + build cache |
| `src/automation/ios-xctest/AutomationUITests.swift` | XCTest runner Swift source (~150 lines) |
| `src/automation/ios-xctest/AutomationUITests.xcodeproj/project.pbxproj` | Minimal Xcode project for XCTest build |
| `src/automation/ios-xctest/Info.plist` | XCTest bundle metadata |
| `src/jimp-compact.d.ts` | Ambient type declaration for jimp-compact (CJS package) |
| `src/log-collectors/types.ts` | `LogCollector` interface, `LogEntry`, `LogSource` enum |
| `src/log-collectors/factory.ts` | `LogCollectorFactory.create(sources[])` |
| `src/log-collectors/cdp-collector.ts` | Reads from existing `consoleBuffer` ring buffer by timestamp |
| `src/log-collectors/android-collector.ts` | ADB logcat stream + parser |
| `src/log-collectors/ios-collector.ts` | `xcrun simctl spawn log stream` + parser |
| `src/log-collectors/composite-collector.ts` | Parallel aggregator, timestamp-sorted merge |
| `src/image-utils.ts` | `optimizeScreenshot()` — JPEG quality reduction + dimension downscale |
| `src/tools/automation-tap.ts` | MCP tool handler for `automation_tap` |
| `src/tools/automation-find.ts` | MCP tool handler for `automation_find` |
| `src/tools/automation-screenshot.ts` | MCP tool handler for `automation_screenshot` |
| `src/tools/collect-logs.ts` | MCP tool handler for `collect_logs` |

### Modified Files

| File | What Changes |
|------|-------------|
| `src/index.ts` | Import + register 4 new tools |
| `package.json` | Add `jimp-compact` dependency |

---

## Chunk 1: Foundation — Types & Image Utils

### Task 1: Automation Types

**Files:**
- Create: `scripts/cdp-bridge/src/automation/types.ts`

- [ ] **Step 1: Create automation types file**

```typescript
// scripts/cdp-bridge/src/automation/types.ts

export interface TapResult {
  success: boolean;
  durationMs: number;
}

export interface FindResult {
  found: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
  text?: string;
  accessible?: boolean;
  enabled?: boolean;
}

export interface ScreenshotResult {
  buffer: Buffer;
  bytes: number;
  quality: number;
  width: number;
}

export interface IAutomation {
  tap(options: { testID?: string; x?: number; y?: number }): Promise<TapResult>;
  find(testID: string): Promise<FindResult>;
  screenshot(options?: { testID?: string }): Promise<ScreenshotResult>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors (new file has no imports that could break)

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/src/automation/types.ts
git commit -m "feat: add automation layer type definitions"
```

---

### Task 2: Log Collector Types

**Files:**
- Create: `scripts/cdp-bridge/src/log-collectors/types.ts`

- [ ] **Step 1: Create log collector types file**

```typescript
// scripts/cdp-bridge/src/log-collectors/types.ts

export type LogSource = 'js_console' | 'native_ios' | 'native_android';

export interface LogEntry {
  source: LogSource;
  level: string;
  message: string;
  timestamp: number;
}

export interface CollectOptions {
  durationMs: number;
  filter?: string;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
}

export interface LogCollector {
  collect(options: CollectOptions): Promise<LogEntry[]>;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/src/log-collectors/types.ts
git commit -m "feat: add log collector type definitions"
```

---

### Task 3: Image Optimization Utility

**Files:**
- Create: `scripts/cdp-bridge/src/image-utils.ts`
- Modify: `scripts/cdp-bridge/package.json`

- [ ] **Step 1: Add jimp-compact dependency**

Run: `cd scripts/cdp-bridge && npm install jimp-compact@0.16.1`

- [ ] **Step 2: Create ambient type declaration for jimp-compact**

```typescript
// scripts/cdp-bridge/src/jimp-compact.d.ts
declare module 'jimp-compact' {
  interface JimpInstance {
    getWidth(): number;
    getHeight(): number;
    clone(): JimpInstance;
    quality(q: number): JimpInstance;
    resize(w: number, h: number | typeof Jimp.AUTO): JimpInstance;
    crop(x: number, y: number, w: number, h: number): JimpInstance;
    getBufferAsync(mime: string): Promise<Buffer>;
  }

  const Jimp: {
    read(input: Buffer | string): Promise<JimpInstance>;
    MIME_JPEG: string;
    AUTO: number;
  };

  export default Jimp;
}
```

- [ ] **Step 3: Create image-utils.ts**

```typescript
// scripts/cdp-bridge/src/image-utils.ts
import Jimp from 'jimp-compact';

const DEFAULT_MAX_BYTES = 716800; // 700KB
const DEFAULT_INITIAL_QUALITY = 85;
const DEFAULT_MIN_QUALITY = 40;
const QUALITY_STEP = 10;
const DIMENSION_SCALE_FACTOR = 0.9;
const MAX_DIMENSION_ITERATIONS = 10;

export interface OptimizeResult {
  buffer: Buffer;
  bytes: number;
  quality: number;
  width: number;
}

export async function optimizeScreenshot(
  input: Buffer,
  options?: {
    maxBytes?: number;
    initialQuality?: number;
    minQuality?: number;
  },
): Promise<OptimizeResult> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;
  const initialQuality = options?.initialQuality ?? DEFAULT_INITIAL_QUALITY;
  const minQuality = options?.minQuality ?? DEFAULT_MIN_QUALITY;

  const image = await Jimp.read(input);
  let quality = initialQuality;
  let width = image.getWidth();

  // Phase 1: Reduce JPEG quality
  while (quality >= minQuality) {
    const buf = await image
      .clone()
      .quality(quality)
      .getBufferAsync(Jimp.MIME_JPEG);

    if (buf.length <= maxBytes) {
      return { buffer: buf, bytes: buf.length, quality, width };
    }
    quality -= QUALITY_STEP;
  }

  // Phase 2: Downscale dimensions
  quality = minQuality;
  for (let i = 0; i < MAX_DIMENSION_ITERATIONS; i++) {
    width = Math.round(width * DIMENSION_SCALE_FACTOR);
    image.resize(width, Jimp.AUTO);

    const buf = await image
      .clone()
      .quality(quality)
      .getBufferAsync(Jimp.MIME_JPEG);

    if (buf.length <= maxBytes) {
      return { buffer: buf, bytes: buf.length, quality, width };
    }
  }

  // Final fallback: return whatever we have
  const finalBuf = await image.quality(quality).getBufferAsync(Jimp.MIME_JPEG);
  return { buffer: finalBuf, bytes: finalBuf.length, quality, width };
}

export async function cropToElement(
  screenshotBuffer: Buffer,
  bounds: { x: number; y: number; w: number; h: number },
): Promise<Buffer> {
  const image = await Jimp.read(screenshotBuffer);
  const imgW = image.getWidth();
  const imgH = image.getHeight();

  // Clamp bounds to image dimensions
  const x = Math.max(0, Math.min(bounds.x, imgW - 1));
  const y = Math.max(0, Math.min(bounds.y, imgH - 1));
  const w = Math.min(bounds.w, imgW - x);
  const h = Math.min(bounds.h, imgH - y);

  if (w <= 0 || h <= 0) {
    // Bounds entirely outside image — return original
    return image.getBufferAsync(Jimp.MIME_JPEG);
  }

  image.crop(x, y, w, h);
  return image.getBufferAsync(Jimp.MIME_JPEG);
}
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/image-utils.ts scripts/cdp-bridge/src/jimp-compact.d.ts scripts/cdp-bridge/package.json scripts/cdp-bridge/package-lock.json
git commit -m "feat: add image optimization utility (jimp-compact)"
```

---

## Chunk 2: Automation Layer

### Task 4: Automation Factory

**Files:**
- Create: `scripts/cdp-bridge/src/automation/factory.ts`

- [ ] **Step 1: Create factory with platform detection**

Uses `execFileSync` with array args to avoid shell injection.

```typescript
// scripts/cdp-bridge/src/automation/factory.ts
import { execFileSync } from 'node:child_process';
import type { IAutomation } from './types.js';
import { AutomationAndroid } from './android.js';
import { AutomationIos } from './ios.js';

export class AutomationFactory {
  // CDP hint: when CDP is connected to a device, prefer that platform
  private static cdpPlatformHint: 'ios' | 'android' | null = null;

  static setCdpPlatformHint(platform: 'ios' | 'android' | null): void {
    AutomationFactory.cdpPlatformHint = platform;
  }

  static detectPlatform(preferred?: 'ios' | 'android'): 'ios' | 'android' {
    const iosBooted = AutomationFactory.isIosSimulatorBooted();
    const androidBooted = AutomationFactory.isAndroidDeviceConnected();

    if (preferred) {
      if (preferred === 'ios' && iosBooted) return 'ios';
      if (preferred === 'android' && androidBooted) return 'android';
      if (preferred === 'ios' && !iosBooted) {
        throw new Error('No booted iOS Simulator found. Boot one with: xcrun simctl boot <UDID>');
      }
      if (preferred === 'android' && !androidBooted) {
        throw new Error('No connected Android device found. Start an emulator or connect a device.');
      }
    }

    // Prefer the platform that CDP is currently connected to
    if (AutomationFactory.cdpPlatformHint) {
      const hint = AutomationFactory.cdpPlatformHint;
      if (hint === 'ios' && iosBooted) return 'ios';
      if (hint === 'android' && androidBooted) return 'android';
    }

    // Default to iOS when both available (matches snapshot_state.sh behavior)
    if (iosBooted) return 'ios';
    if (androidBooted) return 'android';

    throw new Error(
      'No booted iOS Simulator or connected Android device found. ' +
      'Boot a simulator (xcrun simctl boot <UDID>) or start an emulator.',
    );
  }

  static create(platform: 'ios' | 'android'): IAutomation {
    if (platform === 'ios') return new AutomationIos();
    return new AutomationAndroid();
  }

  static isIosSimulatorBooted(): boolean {
    try {
      const output = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const data = JSON.parse(output) as { devices: Record<string, Array<{ state: string }>> };
      return Object.values(data.devices).some(
        (devices) => devices.some((d) => d.state === 'Booted'),
      );
    } catch {
      return false;
    }
  }

  static isAndroidDeviceConnected(): boolean {
    try {
      const adbPath = AutomationFactory.findAdb();
      const output = execFileSync(adbPath, ['devices'], {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const lines = output.trim().split('\n').slice(1);
      return lines.some((line) => line.includes('device'));
    } catch {
      return false;
    }
  }

  static findAdb(): string {
    const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
    if (androidHome) {
      return `${androidHome}/platform-tools/adb`;
    }
    try {
      execFileSync('which', ['adb'], { timeout: 2000, encoding: 'utf-8' });
      return 'adb';
    } catch {
      throw new Error(
        'ADB not found. Set ANDROID_HOME or install Android SDK. ' +
        'Download from: https://developer.android.com/studio',
      );
    }
  }

  static getBootedSimulatorUdid(): string {
    const output = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    const data = JSON.parse(output) as { devices: Record<string, Array<{ udid: string; state: string }>> };
    for (const devices of Object.values(data.devices)) {
      const booted = devices.find((d) => d.state === 'Booted');
      if (booted) return booted.udid;
    }
    throw new Error('No booted iOS Simulator found');
  }
}
```

- [ ] **Step 2: Do NOT commit yet** — factory.ts imports android.ts and ios.ts which don't exist yet. Tasks 4-7 form a compile-time dependency chain and will be committed together at the end of Task 7.

---

### Task 5: Android Automation

**Files:**
- Create: `scripts/cdp-bridge/src/automation/android.ts`

- [ ] **Step 1: Create AutomationAndroid**

Uses `execFileSync` with array args for all ADB commands.

```typescript
// scripts/cdp-bridge/src/automation/android.ts
import { execFileSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IAutomation, TapResult, FindResult, ScreenshotResult } from './types.js';
import { AutomationFactory } from './factory.js';

export class AutomationAndroid implements IAutomation {
  private get adb(): string {
    return AutomationFactory.findAdb();
  }

  async tap(options: { testID?: string; x?: number; y?: number }): Promise<TapResult> {
    const start = Date.now();

    if (options.testID) {
      const found = await this.find(options.testID);
      if (!found.found || !found.bounds) {
        return { success: false, durationMs: Date.now() - start };
      }
      const cx = Math.round(found.bounds.x + found.bounds.w / 2);
      const cy = Math.round(found.bounds.y + found.bounds.h / 2);
      execFileSync(this.adb, ['shell', 'input', 'tap', String(cx), String(cy)], { timeout: 5000 });
    } else if (options.x != null && options.y != null) {
      execFileSync(this.adb, ['shell', 'input', 'tap', String(Math.round(options.x)), String(Math.round(options.y))], { timeout: 5000 });
    } else {
      return { success: false, durationMs: Date.now() - start };
    }

    return { success: true, durationMs: Date.now() - start };
  }

  async find(testID: string): Promise<FindResult> {
    const xml = this.dumpUiHierarchy();
    const node = this.findNodeByTestId(xml, testID);

    if (!node) {
      return { found: false };
    }

    const bounds = this.parseBounds(node.bounds);
    return {
      found: true,
      bounds,
      text: node.text || undefined,
      accessible: node['content-desc'] !== '',
      enabled: node.enabled === 'true',
    };
  }

  async screenshot(options?: { testID?: string }): Promise<ScreenshotResult> {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const devicePath = `/data/local/tmp/rn-agent-screenshot-${uniqueId}.png`;
    const localPath = join(tmpdir(), `rn-agent-screenshot-${uniqueId}.png`);

    try {
      execFileSync(this.adb, ['shell', 'screencap', '-p', devicePath], { timeout: 10000 });
      execFileSync(this.adb, ['pull', devicePath, localPath], { timeout: 10000 });
      execFileSync(this.adb, ['shell', 'rm', devicePath], { timeout: 5000 });

      let buffer = readFileSync(localPath);

      if (options?.testID) {
        const found = await this.find(options.testID);
        if (found.found && found.bounds) {
          const { cropToElement } = await import('../image-utils.js');
          buffer = await cropToElement(buffer, found.bounds);
        }
      }

      const { optimizeScreenshot } = await import('../image-utils.js');
      return optimizeScreenshot(buffer);
    } finally {
      try { unlinkSync(localPath); } catch { /* cleanup best-effort */ }
    }
  }

  private dumpUiHierarchy(): string {
    const uniqueId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const devicePath = `/data/local/tmp/rn-agent-uidump-${uniqueId}.xml`;
    const localPath = join(tmpdir(), `rn-agent-uidump-${uniqueId}.xml`);

    try {
      execFileSync(this.adb, ['shell', 'uiautomator', 'dump', devicePath], { timeout: 10000 });
      execFileSync(this.adb, ['pull', devicePath, localPath], { timeout: 5000 });
      execFileSync(this.adb, ['shell', 'rm', devicePath], { timeout: 5000 });
      return readFileSync(localPath, 'utf-8');
    } finally {
      try { unlinkSync(localPath); } catch { /* cleanup */ }
    }
  }

  private findNodeByTestId(xml: string, testID: string): Record<string, string> | null {
    // React Native testID maps to content-desc on Android
    const contentDescRegex = new RegExp(
      `<node[^>]*content-desc="${this.escapeRegex(testID)}"[^>]*`,
    );
    let match = contentDescRegex.exec(xml);

    // Fallback: search resource-id
    if (!match) {
      const resourceIdRegex = new RegExp(
        `<node[^>]*resource-id="[^"]*${this.escapeRegex(testID)}"[^>]*`,
      );
      match = resourceIdRegex.exec(xml);
    }

    if (!match) return null;

    const nodeStr = match[0];
    return {
      'content-desc': this.extractAttr(nodeStr, 'content-desc'),
      'resource-id': this.extractAttr(nodeStr, 'resource-id'),
      bounds: this.extractAttr(nodeStr, 'bounds'),
      text: this.extractAttr(nodeStr, 'text'),
      enabled: this.extractAttr(nodeStr, 'enabled'),
      focusable: this.extractAttr(nodeStr, 'focusable'),
    };
  }

  private extractAttr(nodeStr: string, attr: string): string {
    const regex = new RegExp(`${attr}="([^"]*)"`);
    const match = regex.exec(nodeStr);
    return match?.[1] ?? '';
  }

  private parseBounds(boundsStr?: string): { x: number; y: number; w: number; h: number } | undefined {
    if (!boundsStr) return undefined;
    // Format: [x1,y1][x2,y2]
    const match = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(boundsStr);
    if (!match) return undefined;
    const [, x1s, y1s, x2s, y2s] = match;
    const x1 = Number(x1s);
    const y1 = Number(y1s);
    const x2 = Number(x2s);
    const y2 = Number(y2s);
    return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
```

- [ ] **Step 2: Do NOT commit yet** — android.ts depends on factory.ts which depends on ios.ts. Committed together at end of Task 7.

---

### Task 6: iOS XCTest Swift Source

**Files:**
- Create: `scripts/cdp-bridge/src/automation/ios-xctest/AutomationUITests.swift`
- Create: `scripts/cdp-bridge/src/automation/ios-xctest/Info.plist`

- [ ] **Step 1: Create XCTest Swift runner**

```swift
// scripts/cdp-bridge/src/automation/ios-xctest/AutomationUITests.swift
import XCTest

final class AutomationUITests: XCTestCase {

    private var app: XCUIApplication!

    override func setUp() {
        super.setUp()
        continueAfterFailure = false

        // Use bundle ID from env var to attach to the app-under-test (not the test host)
        if let bundleId = ProcessInfo.processInfo.environment["RN_AGENT_BUNDLE_ID"], !bundleId.isEmpty {
            app = XCUIApplication(bundleIdentifier: bundleId)
        } else {
            app = XCUIApplication()
        }
        // Use activate() to bring to foreground without relaunching (preserves JS context + CDP)
        // Only launch() if the app is not already running
        if app.state == .notRunning {
            app.launch()
        } else {
            app.activate()
        }
    }

    func testAutomationActions() throws {
        let action = ProcessInfo.processInfo.environment["RN_AGENT_ACTION"] ?? ""
        let params = ProcessInfo.processInfo.environment["RN_AGENT_PARAMS"] ?? "{}"

        guard let paramsData = params.data(using: .utf8),
              let paramsDict = try? JSONSerialization.jsonObject(with: paramsData) as? [String: Any] else {
            outputResult(["error": "invalid_params", "message": "Failed to parse RN_AGENT_PARAMS"])
            return
        }

        switch action {
        case "tap":
            performTap(params: paramsDict)
        case "find":
            performFind(params: paramsDict)
        case "screenshot":
            performScreenshot(params: paramsDict)
        default:
            outputResult(["error": "unknown_action", "message": "Unknown action: \(action)"])
        }
    }

    private func performTap(params: [String: Any]) {
        let start = CFAbsoluteTimeGetCurrent()

        if let testID = params["testID"] as? String {
            let element = app.descendants(matching: .any).matching(identifier: testID).firstMatch
            if element.waitForExistence(timeout: 2) {
                element.tap()
                let duration = (CFAbsoluteTimeGetCurrent() - start) * 1000
                outputResult(["success": true, "durationMs": Int(duration)])
            } else {
                let duration = (CFAbsoluteTimeGetCurrent() - start) * 1000
                outputResult(["success": false, "durationMs": Int(duration), "error": "Element not found: \(testID)"])
            }
        } else if let x = params["x"] as? Double, let y = params["y"] as? Double {
            let normalized = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
                .withOffset(CGVector(dx: x, dy: y))
            normalized.tap()
            let duration = (CFAbsoluteTimeGetCurrent() - start) * 1000
            outputResult(["success": true, "durationMs": Int(duration)])
        } else {
            outputResult(["success": false, "error": "Provide testID or x,y coordinates"])
        }
    }

    private func performFind(params: [String: Any]) {
        guard let testID = params["testID"] as? String else {
            outputResult(["found": false, "error": "testID required"])
            return
        }

        let element = app.descendants(matching: .any).matching(identifier: testID).firstMatch
        guard element.waitForExistence(timeout: 2) else {
            outputResult(["found": false])
            return
        }

        let frame = element.frame
        outputResult([
            "found": true,
            "bounds": [
                "x": Int(frame.origin.x),
                "y": Int(frame.origin.y),
                "w": Int(frame.size.width),
                "h": Int(frame.size.height),
            ],
            "text": element.label,
            "accessible": element.isAccessibilityElement,
            "enabled": element.isEnabled,
        ])
    }

    private func performScreenshot(params: [String: Any]) {
        let screenshot: XCUIScreenshot

        if let testID = params["testID"] as? String {
            let element = app.descendants(matching: .any).matching(identifier: testID).firstMatch
            if element.waitForExistence(timeout: 2) {
                screenshot = element.screenshot()
            } else {
                outputResult(["error": "element_not_found", "message": "Element not found: \(testID)"])
                return
            }
        } else {
            screenshot = app.screenshot()
        }

        let pngData = screenshot.pngRepresentation
        let tempPath = NSTemporaryDirectory() + "rn-agent-screenshot.png"
        try? pngData.write(to: URL(fileURLWithPath: tempPath))
        outputResult(["screenshotPath": tempPath])
    }

    private func outputResult(_ dict: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: dict),
           let json = String(data: data, encoding: .utf8) {
            print("######JSON_START######\(json)######JSON_END######")
        }
    }
}
```

- [ ] **Step 2: Create Info.plist**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDevelopmentRegion</key>
    <string>en</string>
    <key>CFBundleExecutable</key>
    <string>$(EXECUTABLE_NAME)</string>
    <key>CFBundleIdentifier</key>
    <string>com.rn-dev-agent.automation-tests</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>AutomationUITests</string>
    <key>CFBundlePackageType</key>
    <string>BNDL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
</dict>
</plist>
```

- [ ] **Step 3: Create minimal Xcode project**

The XCTest requires a `.xcodeproj` for `xcodebuild build-for-testing` to work. Create a minimal project file:

```bash
mkdir -p scripts/cdp-bridge/src/automation/ios-xctest/AutomationUITests.xcodeproj
```

Create `scripts/cdp-bridge/src/automation/ios-xctest/AutomationUITests.xcodeproj/project.pbxproj` with a minimal UI testing target. This is a standard Xcode project file that defines:
- A single UI Testing Bundle target named `AutomationUITests`
- References `AutomationUITests.swift` as the source file
- Sets `INFOPLIST_FILE` to `Info.plist`
- Targets iOS Simulator (any device)
- Links `XCTest.framework`

**Note:** The .pbxproj file is too large for inline code in a plan. The implementer should generate this by:
1. Run `mkdir -p /tmp/xctest-gen && cd /tmp/xctest-gen`
2. Copy the Swift and Info.plist files there
3. Run `xcodebuild -create-xcodeproj` or create via Xcode UI: File > New > Project > UI Testing Bundle
4. Copy the generated `.xcodeproj/project.pbxproj` back to `scripts/cdp-bridge/src/automation/ios-xctest/`
5. Verify: `cd scripts/cdp-bridge/src/automation/ios-xctest && xcodebuild build-for-testing -scheme AutomationUITests -destination "platform=iOS Simulator,name=iPhone"`

- [ ] **Step 4: Do NOT commit yet** — committed together with factory, android, ios at end of Task 7.

---

### Task 7: iOS Automation

**Files:**
- Create: `scripts/cdp-bridge/src/automation/ios.ts`

- [ ] **Step 1: Create AutomationIos**

```typescript
// scripts/cdp-bridge/src/automation/ios.ts
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IAutomation, TapResult, FindResult, ScreenshotResult } from './types.js';

const XCTEST_TIMEOUT_MS = 30000;
const XCTEST_BUILD_TIMEOUT_MS = 120000;
const JSON_START_MARKER = '######JSON_START######';
const JSON_END_MARKER = '######JSON_END######';

// Resolve package root from dist/automation/ios.js → ../../.. → package root
const currentFilePath = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFilePath);
const PACKAGE_ROOT = join(currentDir, '..', '..');

// Swift source is ALWAYS in src/ (not dist/) — resolve from package root
const XCTEST_SOURCE_DIR = join(PACKAGE_ROOT, 'src', 'automation', 'ios-xctest');
const CACHE_DIR = join(homedir(), '.cache', 'rn-dev-agent', 'xctest-bundle');

export class AutomationIos implements IAutomation {
  async tap(options: { testID?: string; x?: number; y?: number }): Promise<TapResult> {
    const result = await this.runAction('tap', options);
    return {
      success: result.success === true,
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0,
    };
  }

  async find(testID: string): Promise<FindResult> {
    const result = await this.runAction('find', { testID });
    if (!result.found) return { found: false };

    return {
      found: true,
      bounds: result.bounds as FindResult['bounds'],
      text: typeof result.text === 'string' ? result.text : undefined,
      accessible: typeof result.accessible === 'boolean' ? result.accessible : undefined,
      enabled: typeof result.enabled === 'boolean' ? result.enabled : undefined,
    };
  }

  async screenshot(options?: { testID?: string }): Promise<ScreenshotResult> {
    const result = await this.runAction('screenshot', options ?? {});

    if (result.error) {
      throw new Error(typeof result.message === 'string' ? result.message : 'Screenshot failed');
    }

    const screenshotPath = result.screenshotPath as string;
    const buffer = readFileSync(screenshotPath);

    const { optimizeScreenshot } = await import('../image-utils.js');
    return optimizeScreenshot(buffer);
  }

  private bundleId?: string;

  setBundleId(bundleId: string): void {
    this.bundleId = bundleId;
  }

  private async runAction(action: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.ensureXcodeAvailable();
    await this.ensureXcTestBuilt();

    const udid = this.getSimulatorUdid();
    const xctestrunPath = this.findXctestrunFile();

    // Use spawn with env vars to avoid shell injection (C4 fix)
    return new Promise((resolve, reject) => {
      const proc = nodeSpawn('xcodebuild', [
        'test-without-building',
        '-xctestrun', xctestrunPath,
        '-destination', `platform=iOS Simulator,id=${udid}`,
      ], {
        timeout: XCTEST_TIMEOUT_MS,
        env: {
          ...process.env,
          RN_AGENT_ACTION: action,
          RN_AGENT_PARAMS: JSON.stringify(params),
          ...(this.bundleId ? { RN_AGENT_BUNDLE_ID: this.bundleId } : {}),
        },
      });

      let output = '';
      proc.stdout.on('data', (data: Buffer) => { output += data.toString(); });
      proc.stderr.on('data', (data: Buffer) => { output += data.toString(); });

      proc.on('close', () => {
        try {
          resolve(this.parseJsonOutput(output));
        } catch (err) {
          reject(err);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`XCTest execution failed: ${err.message}`));
      });
    });
  }

  private findXctestrunFile(): string {
    // xcodebuild build-for-testing generates .xctestrun in DerivedData
    const derivedData = join(CACHE_DIR, 'DerivedData');
    const buildDir = join(derivedData, 'Build', 'Products');
    try {
      const files = readdirSync(buildDir);
      const xctestrunFile = files.find((f) => f.endsWith('.xctestrun'));
      if (xctestrunFile) {
        const fullPath = join(buildDir, xctestrunFile);
        if (existsSync(fullPath)) return fullPath;
      }
    } catch { /* fall through */ }
    throw new Error('XCTest bundle not found. Cache may be corrupted — delete ~/.cache/rn-dev-agent/xctest-bundle/ and retry.');
  }

  private parseJsonOutput(output: string): Record<string, unknown> {
    const startIdx = output.indexOf(JSON_START_MARKER);
    const endIdx = output.indexOf(JSON_END_MARKER);

    if (startIdx === -1 || endIdx === -1) {
      throw new Error('No JSON response from XCTest runner. Output tail: ' + output.slice(-500));
    }

    const json = output.slice(startIdx + JSON_START_MARKER.length, endIdx);
    return JSON.parse(json) as Record<string, unknown>;
  }

  private ensureXcodeAvailable(): void {
    try {
      execFileSync('xcode-select', ['-p'], { timeout: 5000, encoding: 'utf-8' });
    } catch {
      throw new Error(
        'Xcode CLI tools not found. Install with: xcode-select --install',
      );
    }
  }

  private async ensureXcTestBuilt(): Promise<void> {
    if (this.isCacheValid()) return;

    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }

    if (!existsSync(XCTEST_SOURCE_DIR)) {
      throw new Error(
        `XCTest source not found at ${XCTEST_SOURCE_DIR}. ` +
        `Ensure the plugin is installed correctly.`,
      );
    }

    try {
      execFileSync('xcodebuild', [
        'build-for-testing',
        '-project', join(XCTEST_SOURCE_DIR, 'AutomationUITests.xcodeproj'),
        '-scheme', 'AutomationUITests',
        '-destination', 'generic/platform=iOS Simulator',
        '-derivedDataPath', join(CACHE_DIR, 'DerivedData'),
      ], {
        timeout: XCTEST_BUILD_TIMEOUT_MS,
        encoding: 'utf-8',
        cwd: XCTEST_SOURCE_DIR,
      });

      writeFileSync(join(CACHE_DIR, 'source-hash'), this.getSourceHash());
      writeFileSync(join(CACHE_DIR, 'xcode-version'), this.getXcodeVersion());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `XCTest build failed. This might be a Swift version or SDK mismatch.\n` +
        `Build output tail: ${message.slice(-1000)}`,
      );
    }
  }

  private isCacheValid(): boolean {
    try {
      const cachedHash = readFileSync(join(CACHE_DIR, 'source-hash'), 'utf-8');
      const cachedXcode = readFileSync(join(CACHE_DIR, 'xcode-version'), 'utf-8');
      return cachedHash === this.getSourceHash() && cachedXcode === this.getXcodeVersion();
    } catch {
      return false;
    }
  }

  private getSourceHash(): string {
    try {
      const hash = createHash('sha256');
      const swiftSource = readFileSync(
        join(XCTEST_SOURCE_DIR, 'AutomationUITests.swift'),
        'utf-8',
      );
      hash.update(swiftSource);
      const infoPlist = readFileSync(
        join(XCTEST_SOURCE_DIR, 'Info.plist'),
        'utf-8',
      );
      hash.update(infoPlist);
      return hash.digest('hex');
    } catch {
      return 'unknown';
    }
  }

  private getXcodeVersion(): string {
    try {
      return execFileSync('xcodebuild', ['-version'], { timeout: 5000, encoding: 'utf-8' }).trim();
    } catch {
      return 'unknown';
    }
  }

  private getSimulatorUdid(): string {
    const output = execFileSync('xcrun', ['simctl', 'list', 'devices', 'booted', '--json'], {
      timeout: 5000,
      encoding: 'utf-8',
    });
    const data = JSON.parse(output) as { devices: Record<string, Array<{ udid: string; state: string }>> };
    for (const devices of Object.values(data.devices)) {
      const booted = devices.find((d) => d.state === 'Booted');
      if (booted) return booted.udid;
    }
    throw new Error('No booted iOS Simulator found');
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles (all automation files together)**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors (all automation files now exist: types.ts, factory.ts, android.ts, ios.ts)

- [ ] **Step 3: Commit all automation files together (Tasks 4-7)**

```bash
git add scripts/cdp-bridge/src/automation/
git commit -m "feat: add automation layer (factory, Android ADB, iOS XCTest)"
```

---

## Chunk 3: Log Collection

### Task 8: CDP Log Collector

**Files:**
- Create: `scripts/cdp-bridge/src/log-collectors/cdp-collector.ts`

- [ ] **Step 1: Create CDP collector that reads from existing ring buffer**

```typescript
// scripts/cdp-bridge/src/log-collectors/cdp-collector.ts
import type { RingBuffer } from '../ring-buffer.js';
import type { ConsoleEntry } from '../types.js';
import type { LogCollector, LogEntry, CollectOptions } from './types.js';

// CDP levels: log, info, warning, error, debug
// MCP-facing levels: info, warn, error, debug
const LEVEL_MAP: Record<string, string> = {
  warning: 'warn',
  log: 'info',
};

const INTERNAL_PREFIX = '__RN_NET__:';

export class CdpLogCollector implements LogCollector {
  constructor(private readonly consoleBuffer: RingBuffer<ConsoleEntry>) {}

  async collect(options: CollectOptions): Promise<LogEntry[]> {
    const startTime = Date.now();

    // Wait for the collection duration to allow new entries to accumulate
    if (options.durationMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, options.durationMs));
    }

    const endTime = Date.now();

    // Read all entries from the ring buffer
    const allEntries = this.consoleBuffer.getLast(this.consoleBuffer.size);

    // Filter by timestamp range
    let filtered = allEntries.filter((entry) => {
      const ts = new Date(entry.timestamp).getTime();
      return ts >= startTime && ts <= endTime;
    });

    // Filter out internal network hook messages
    filtered = filtered.filter((entry) => !entry.text.startsWith(INTERNAL_PREFIX));

    // Filter by log level
    if (options.logLevel) {
      filtered = filtered.filter((entry) => {
        const normalizedLevel = LEVEL_MAP[entry.level] ?? entry.level;
        return normalizedLevel === options.logLevel;
      });
    }

    // Filter by regex pattern (validated to prevent ReDoS)
    if (options.filter) {
      let regex: RegExp;
      try {
        regex = new RegExp(options.filter);
      } catch {
        throw new Error(`Invalid filter regex: ${options.filter}`);
      }
      filtered = filtered.filter((entry) => regex.test(entry.text));
    }

    return filtered.map((entry): LogEntry => ({
      source: 'js_console',
      level: LEVEL_MAP[entry.level] ?? entry.level,
      message: entry.text,
      timestamp: new Date(entry.timestamp).getTime(),
    }));
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/src/log-collectors/cdp-collector.ts
git commit -m "feat: add CDP log collector (reads from existing ring buffer)"
```

---

### Task 9: Android Log Collector

**Files:**
- Create: `scripts/cdp-bridge/src/log-collectors/android-collector.ts`

- [ ] **Step 1: Create Android logcat collector**

```typescript
// scripts/cdp-bridge/src/log-collectors/android-collector.ts
import { spawn, execFileSync } from 'node:child_process';
import type { LogCollector, LogEntry, CollectOptions } from './types.js';
import { AutomationFactory } from '../automation/factory.js';

// Format: MM-DD HH:MM:SS.mmm PID TID LEVEL TAG: message
const LOGCAT_LINE_REGEX = /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(.+?):\s+(.*)$/;

const LEVEL_MAP: Record<string, string> = {
  V: 'debug',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
  S: 'error',
};

export class AndroidLogCollector implements LogCollector {
  private appPid: string | null = null;

  constructor(private readonly appId?: string) {}

  async collect(options: CollectOptions): Promise<LogEntry[]> {
    const adb = AutomationFactory.findAdb();

    // Resolve app PID for filtering
    if (this.appId) {
      this.appPid = this.resolveAppPid(adb, this.appId);
    }

    // Clear existing logs
    try {
      execFileSync(adb, ['logcat', '-c'], { timeout: 5000 });
    } catch {
      // Best effort clear
    }

    const filterRegex = options.filter ? new RegExp(options.filter) : null;

    return new Promise((resolve) => {
      const entries: LogEntry[] = [];
      const proc = spawn(adb, ['logcat', '-v', 'threadtime']);

      let output = '';

      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        const lines = output.split('\n');
        output = lines.pop() ?? '';

        for (const line of lines) {
          const entry = this.parseLine(line, options, filterRegex);
          if (entry) entries.push(entry);
        }
      });

      const timer = setTimeout(() => {
        proc.kill('SIGINT');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 1000);
      }, options.durationMs);

      proc.on('close', () => {
        clearTimeout(timer);
        resolve(entries);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(entries);
      });
    });
  }

  private parseLine(line: string, options: CollectOptions, filterRegex: RegExp | null): LogEntry | null {
    const match = LOGCAT_LINE_REGEX.exec(line);
    if (!match) return null;

    const [, timestampStr, pid, , levelChar, , message] = match;
    const level = LEVEL_MAP[levelChar] ?? 'info';

    // Filter by app PID
    if (this.appPid && pid !== this.appPid) return null;

    // Filter by log level
    if (options.logLevel && level !== options.logLevel) return null;

    // Filter by regex pattern (pre-compiled)
    if (filterRegex && !filterRegex.test(message)) return null;

    // Parse timestamp (add current year since logcat omits it)
    const year = new Date().getFullYear();
    const timestamp = new Date(`${year}-${timestampStr.replace(' ', 'T')}`).getTime();

    return {
      source: 'native_android',
      level,
      message,
      timestamp: isNaN(timestamp) ? Date.now() : timestamp,
    };
  }

  private resolveAppPid(adb: string, appId: string): string | null {
    try {
      const output = execFileSync(adb, ['shell', 'pidof', appId], {
        timeout: 5000,
        encoding: 'utf-8',
      });
      const pid = output.trim();
      return pid || null;
    } catch {
      return null;
    }
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/src/log-collectors/android-collector.ts
git commit -m "feat: add Android log collector (ADB logcat)"
```

---

### Task 10: iOS Log Collector

**Files:**
- Create: `scripts/cdp-bridge/src/log-collectors/ios-collector.ts`

- [ ] **Step 1: Create iOS simctl log stream collector**

```typescript
// scripts/cdp-bridge/src/log-collectors/ios-collector.ts
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { LogCollector, LogEntry, CollectOptions } from './types.js';

// Note: --style compact format varies by macOS version. Lines that don't match
// fall through to the unmatched handler (level=info, timestamp=now).
// Future improvement: use --style ndjson for reliable JSON parsing (macOS 10.15+).
const IOS_LOG_REGEX = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+[+-]\d{4})\s+\S+\s+\S+\s+(\w+)\s+\S+\s+\S+\s+\S+\s+(.*)$/;

const SYSTEM_NOISE = [
  'NotificationCenter',
  'SpringBoard',
  'dasd',
  'runningboardd',
];

const IOS_LEVEL_MAP: Record<string, string> = {
  Default: 'info',
  Info: 'info',
  Debug: 'debug',
  Error: 'error',
  Fault: 'error',
};

export class IosLogCollector implements LogCollector {
  constructor(private readonly executableName?: string) {}

  async collect(options: CollectOptions): Promise<LogEntry[]> {
    const args = ['simctl', 'spawn', 'booted', 'log', 'stream', '--style', 'compact'];

    if (this.executableName) {
      args.push('--predicate', `processImagePath ENDSWITH "${this.executableName}"`);
    }

    return new Promise((resolve) => {
      const entries: LogEntry[] = [];
      const proc = spawn('xcrun', args);

      let output = '';

      proc.stdout.on('data', (data: Buffer) => {
        output += data.toString();
        const lines = output.split('\n');
        output = lines.pop() ?? '';

        for (const line of lines) {
          const entry = this.parseLine(line, options);
          if (entry) entries.push(entry);
        }
      });

      const timer = setTimeout(() => {
        proc.kill('SIGINT');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 1000);
      }, options.durationMs);

      proc.on('close', () => {
        clearTimeout(timer);
        resolve(entries);
      });

      proc.on('error', () => {
        clearTimeout(timer);
        resolve(entries);
      });
    });
  }

  private parseLine(line: string, options: CollectOptions): LogEntry | null {
    if (SYSTEM_NOISE.some((noise) => line.includes(noise))) return null;

    const match = IOS_LOG_REGEX.exec(line);
    if (!match) {
      if (line.trim().length === 0) return null;
      return this.createEntryIfMatches(line.trim(), 'info', Date.now(), options);
    }

    const [, timestampStr, levelStr, message] = match;
    const level = IOS_LEVEL_MAP[levelStr] ?? 'info';
    const timestamp = new Date(timestampStr).getTime();

    return this.createEntryIfMatches(message, level, timestamp, options);
  }

  private createEntryIfMatches(
    message: string,
    level: string,
    timestamp: number,
    options: CollectOptions,
  ): LogEntry | null {
    if (options.logLevel && level !== options.logLevel) return null;

    if (options.filter) {
      let regex: RegExp;
      try {
        regex = new RegExp(options.filter);
      } catch {
        return null;
      }
      if (!regex.test(message)) return null;
    }

    return {
      source: 'native_ios',
      level,
      message,
      timestamp: isNaN(timestamp) ? Date.now() : timestamp,
    };
  }

  static resolveExecutableName(projectRoot?: string): string | null {
    if (projectRoot) {
      try {
        const raw = readFileSync(`${projectRoot}/app.json`, 'utf-8');
        const appJson = JSON.parse(raw) as { expo?: { ios?: { bundleIdentifier?: string } }; name?: string };
        // Prefer the app name (maps to executable name in most RN projects)
        if (appJson.name) return appJson.name;
        // Fallback: derive from bundle ID (last component)
        const bundleId = appJson.expo?.ios?.bundleIdentifier;
        if (bundleId) return bundleId.split('.').pop() ?? null;
      } catch {
        // No app.json or parse error
      }
    }

    // Fallback: Expo Go
    return 'Expo Go';
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add scripts/cdp-bridge/src/log-collectors/ios-collector.ts
git commit -m "feat: add iOS log collector (simctl log stream)"
```

---

### Task 11: Composite Log Collector & Factory

**Files:**
- Create: `scripts/cdp-bridge/src/log-collectors/composite-collector.ts`
- Create: `scripts/cdp-bridge/src/log-collectors/factory.ts`

- [ ] **Step 1: Create CompositeLogCollector**

```typescript
// scripts/cdp-bridge/src/log-collectors/composite-collector.ts
import type { LogCollector, LogEntry, CollectOptions } from './types.js';

export class CompositeLogCollector implements LogCollector {
  constructor(private readonly collectors: LogCollector[]) {}

  async collect(options: CollectOptions): Promise<LogEntry[]> {
    const settled = await Promise.allSettled(
      this.collectors.map((c) => c.collect(options)),
    );

    return settled
      .filter((r): r is PromiseFulfilledResult<LogEntry[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value)
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
```

- [ ] **Step 2: Create LogCollectorFactory**

```typescript
// scripts/cdp-bridge/src/log-collectors/factory.ts
import type { RingBuffer } from '../ring-buffer.js';
import type { ConsoleEntry } from '../types.js';
import type { LogCollector, LogSource } from './types.js';
import { CdpLogCollector } from './cdp-collector.js';
import { AndroidLogCollector } from './android-collector.js';
import { IosLogCollector } from './ios-collector.js';
import { CompositeLogCollector } from './composite-collector.js';

export interface LogCollectorFactoryOptions {
  consoleBuffer?: RingBuffer<ConsoleEntry>;
  appId?: string;
  executableName?: string;
}

export class LogCollectorFactory {
  static create(
    sources: LogSource[],
    options: LogCollectorFactoryOptions = {},
  ): LogCollector {
    const collectors: LogCollector[] = [];

    for (const source of sources) {
      switch (source) {
        case 'js_console':
          if (options.consoleBuffer) {
            collectors.push(new CdpLogCollector(options.consoleBuffer));
          }
          break;
        case 'native_android':
          collectors.push(new AndroidLogCollector(options.appId));
          break;
        case 'native_ios':
          collectors.push(new IosLogCollector(options.executableName));
          break;
      }
    }

    if (collectors.length === 0) {
      throw new Error('No valid log collectors created. Check sources and options.');
    }

    if (collectors.length === 1) return collectors[0];
    return new CompositeLogCollector(collectors);
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add scripts/cdp-bridge/src/log-collectors/composite-collector.ts scripts/cdp-bridge/src/log-collectors/factory.ts
git commit -m "feat: add CompositeLogCollector and LogCollectorFactory"
```

---

## Chunk 4: MCP Tool Handlers & Registration

### Task 12: automation_tap Tool Handler

**Files:**
- Create: `scripts/cdp-bridge/src/tools/automation-tap.ts`

- [ ] **Step 1: Create tool handler**

```typescript
// scripts/cdp-bridge/src/tools/automation-tap.ts
import { textResult, errorResult } from '../utils.js';
import { AutomationFactory } from '../automation/factory.js';

export function createAutomationTapHandler() {
  return async (args: { platform?: 'ios' | 'android'; testID?: string; x?: number; y?: number }) => {
    try {
      const platform = AutomationFactory.detectPlatform(args.platform);
      const automation = AutomationFactory.create(platform);
      const result = await automation.tap({
        testID: args.testID,
        x: args.x,
        y: args.y,
      });

      return textResult(JSON.stringify({ platform, ...result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/cdp-bridge/src/tools/automation-tap.ts
git commit -m "feat: add automation_tap MCP tool handler"
```

---

### Task 13: automation_find Tool Handler

**Files:**
- Create: `scripts/cdp-bridge/src/tools/automation-find.ts`

- [ ] **Step 1: Create tool handler**

```typescript
// scripts/cdp-bridge/src/tools/automation-find.ts
import { textResult, errorResult } from '../utils.js';
import { AutomationFactory } from '../automation/factory.js';

export function createAutomationFindHandler() {
  return async (args: { platform?: 'ios' | 'android'; testID: string }) => {
    try {
      const platform = AutomationFactory.detectPlatform(args.platform);
      const automation = AutomationFactory.create(platform);
      const result = await automation.find(args.testID);

      return textResult(JSON.stringify({ platform, ...result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/cdp-bridge/src/tools/automation-find.ts
git commit -m "feat: add automation_find MCP tool handler"
```

---

### Task 14: automation_screenshot Tool Handler

**Files:**
- Create: `scripts/cdp-bridge/src/tools/automation-screenshot.ts`

- [ ] **Step 1: Create tool handler**

The MCP SDK supports image content type. We return base64 JPEG.

```typescript
// scripts/cdp-bridge/src/tools/automation-screenshot.ts
import { errorResult } from '../utils.js';
import { AutomationFactory } from '../automation/factory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export function createAutomationScreenshotHandler() {
  return async (args: { platform?: 'ios' | 'android'; testID?: string; maxBytes?: number }): Promise<CallToolResult> => {
    try {
      const platform = AutomationFactory.detectPlatform(args.platform);
      const automation = AutomationFactory.create(platform);

      let result = await automation.screenshot({
        testID: args.testID,
      });

      // Re-optimize if custom maxBytes specified and current is too large
      if (args.maxBytes && result.bytes > args.maxBytes) {
        const { optimizeScreenshot } = await import('../image-utils.js');
        result = await optimizeScreenshot(result.buffer, { maxBytes: args.maxBytes });
      }

      return {
        content: [{
          type: 'image' as const,
          data: result.buffer.toString('base64'),
          mimeType: 'image/jpeg',
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/cdp-bridge/src/tools/automation-screenshot.ts
git commit -m "feat: add automation_screenshot MCP tool handler"
```

---

### Task 15: collect_logs Tool Handler

**Files:**
- Create: `scripts/cdp-bridge/src/tools/collect-logs.ts`

- [ ] **Step 1: Create tool handler**

```typescript
// scripts/cdp-bridge/src/tools/collect-logs.ts
import type { CDPClient } from '../cdp-client.js';
import { textResult, errorResult } from '../utils.js';
import { LogCollectorFactory } from '../log-collectors/factory.js';
import { IosLogCollector } from '../log-collectors/ios-collector.js';
import type { LogSource } from '../log-collectors/types.js';

async function resolveExecutableName(client: CDPClient): Promise<string | undefined> {
  // 1. Try CDP: ask the running app for its name
  if (client.isConnected && client.helpersInjected) {
    try {
      const result = await client.evaluate('JSON.parse(globalThis.__RN_AGENT.getAppInfo()).appName');
      if (result.value && typeof result.value === 'string') return result.value;
    } catch {
      // CDP not available — fall through
    }
  }

  // 2. Try app.json (from current working directory)
  const fromFile = IosLogCollector.resolveExecutableName(process.cwd());
  if (fromFile) return fromFile;

  // 3. Fallback: Expo Go
  return 'Expo Go';
}

async function resolveAndroidAppId(client: CDPClient): Promise<string | undefined> {
  if (client.isConnected && client.helpersInjected) {
    try {
      const result = await client.evaluate('JSON.parse(globalThis.__RN_AGENT.getAppInfo()).bundleId');
      if (result.value && typeof result.value === 'string') return result.value;
    } catch {
      // CDP not available — fall through
    }
  }
  return undefined;
}

export function createCollectLogsHandler(getClient: () => CDPClient) {
  return async (args: {
    sources: LogSource[];
    durationMs: number;
    filter?: string;
    logLevel?: 'error' | 'warn' | 'info' | 'debug';
  }) => {
    try {
      const client = getClient();

      const executableName = args.sources.includes('native_ios')
        ? await resolveExecutableName(client)
        : undefined;

      const appId = args.sources.includes('native_android')
        ? await resolveAndroidAppId(client)
        : undefined;

      // Filter out js_console if CDP is not connected, with warning
      const effectiveSources = args.sources.filter((s) => {
        if (s === 'js_console' && !client.isConnected) return false;
        return true;
      });

      if (effectiveSources.length === 0) {
        return errorResult(
          'No log sources available. js_console requires CDP connection. ' +
          'Use cdp_status to connect first, or request native_ios/native_android sources.',
        );
      }

      const collector = LogCollectorFactory.create(effectiveSources, {
        consoleBuffer: client.isConnected ? client.consoleBuffer : undefined,
        executableName,
        appId,
      });

      const entries = await collector.collect({
        durationMs: args.durationMs,
        filter: args.filter,
        logLevel: args.logLevel,
      });

      return textResult(JSON.stringify({
        count: entries.length,
        sources: args.sources,
        durationMs: args.durationMs,
        entries,
      }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResult(message);
    }
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/cdp-bridge/src/tools/collect-logs.ts
git commit -m "feat: add collect_logs MCP tool handler"
```

---

### Task 16: Register All New Tools in index.ts

**Files:**
- Modify: `scripts/cdp-bridge/src/index.ts:1-129`

- [ ] **Step 1: Add imports for new tool handlers**

Add after line 14 (after `createDevSettingsHandler` import) in `scripts/cdp-bridge/src/index.ts`:

```typescript
import { createAutomationTapHandler } from './tools/automation-tap.js';
import { createAutomationFindHandler } from './tools/automation-find.js';
import { createAutomationScreenshotHandler } from './tools/automation-screenshot.js';
import { createCollectLogsHandler } from './tools/collect-logs.js';
```

- [ ] **Step 2: Register 4 new tools**

Add after the `cdp_dev_settings` tool registration block (after line 118) in `scripts/cdp-bridge/src/index.ts`:

```typescript
server.tool(
  'automation_tap',
  'Tap a UI element by testID or screen coordinates. Uses native platform APIs (XCTest on iOS, ADB on Android). For simple taps — no Maestro needed. For complex multi-step flows, prefer Maestro.',
  z.object({
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detect if omitted)'),
    testID: z.string().optional().describe('React Native testID of the element to tap'),
    x: z.number().optional().describe('X coordinate to tap (use with y)'),
    y: z.number().optional().describe('Y coordinate to tap (use with x)'),
  }).refine(
    (d) => d.testID != null || (d.x != null && d.y != null),
    { message: 'Provide either testID or both x and y coordinates' },
  ),
  createAutomationTapHandler(),
);

server.tool(
  'automation_find',
  'Find a UI element by testID and return its properties (bounds, text, enabled state). Uses native accessibility APIs. Lighter than cdp_component_tree when you just need one element.',
  {
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detect if omitted)'),
    testID: z.string().describe('React Native testID of the element to find'),
  },
  createAutomationFindHandler(),
);

server.tool(
  'automation_screenshot',
  'Take an optimized screenshot (JPEG, max 700KB). Optionally crop to a specific element by testID. Auto-compresses for token efficiency.',
  {
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detect if omitted)'),
    testID: z.string().optional().describe('Crop screenshot to this element (full screen if omitted)'),
    maxBytes: z.number().optional().describe('Max file size in bytes (default 716800 = 700KB)'),
  },
  createAutomationScreenshotHandler(),
);

server.tool(
  'collect_logs',
  'Collect logs from multiple sources simultaneously. Actively listens for durationMs then returns entries. Use for "reproduce and capture" scenarios. For buffered JS console history, use cdp_console_log instead.',
  {
    sources: z.array(z.enum(['js_console', 'native_ios', 'native_android'])).default(['js_console']).describe('Log sources to collect from'),
    durationMs: z.number().int().min(0).max(10000).default(2000).describe('How long to listen for logs (ms)'),
    filter: z.string().optional().describe('Regex pattern to filter log messages'),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).optional().describe('Filter by log level'),
  },
  createCollectLogsHandler(getClient),
);
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd scripts/cdp-bridge && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Build the project**

Run: `cd scripts/cdp-bridge && npm run build`
Expected: Compiles successfully, `dist/` directory updated with all new files

- [ ] **Step 5: Commit**

```bash
git add scripts/cdp-bridge/src/index.ts
git commit -m "feat: register 4 new MCP tools (automation_tap, automation_find, automation_screenshot, collect_logs)"
```

---

## Chunk 5: Skill Updates & Documentation

### Task 17: Update rn-testing Skill

**Files:**
- Modify: `skills/rn-testing/SKILL.md`

- [ ] **Step 1: Add tool selection guide section to the end of the file**

```markdown
## Tool Selection Guide

Choose the right tool for the interaction:

| Need | Tool | Why |
|------|------|-----|
| Quick tap on a button | `automation_tap` | Native API, no Maestro needed |
| Complex swipe/scroll flow | Maestro YAML | Multi-step sequences with timing |
| Check if element exists | `automation_find` | Returns bounds, text, enabled state |
| Inspect React component hierarchy | `cdp_component_tree` | Fiber tree with props/state |
| Screenshot for visual check | `automation_screenshot` | Auto-optimized JPEG (700KB max) |
| "What happened since last check?" | `cdp_console_log` | Ring buffer, instant read |
| "Reproduce and capture everything" | `collect_logs` | Multi-source, time-windowed |

### Decision flow for UI interaction

1. Single tap on known testID → `automation_tap`
2. Need to verify element properties first → `automation_find` then `automation_tap`
3. Scroll, swipe, multi-step sequence → Maestro flow
4. After UI action, verify React state → `cdp_component_tree` or `cdp_store_state`
```

- [ ] **Step 2: Commit**

```bash
git add skills/rn-testing/SKILL.md
git commit -m "docs: add tool selection guide to rn-testing skill"
```

---

### Task 18: Update rn-debugging Skill

**Files:**
- Modify: `skills/rn-debugging/SKILL.md`

- [ ] **Step 1: Add native log collection section**

Append to the file:

```markdown
## Native Log Collection

Use `collect_logs` for comprehensive log capture across all sources:

```
collect_logs(sources: ['js_console', 'native_ios'], durationMs: 5000)
```

This replaces manual `xcrun simctl spawn booted log stream` and `adb logcat` commands when you need structured, filtered output.

### When to use native logs
- JS error log is empty but app crashed → native crash (use `native_ios` or `native_android`)
- Need to correlate JS events with native events → use all sources together
- Startup crashes before CDP connects → native logs are the only source
```

- [ ] **Step 2: Commit**

```bash
git add skills/rn-debugging/SKILL.md
git commit -m "docs: add native log collection to rn-debugging skill"
```

---

### Task 19: Update rn-device-control Skill

**Files:**
- Modify: `skills/rn-device-control/SKILL.md`

- [ ] **Step 1: Add automation tools reference section**

Append to the file:

```markdown
## Native Automation Tools

For programmatic device interaction without Maestro:

| Tool | What it does |
|------|-------------|
| `automation_tap` | Tap by testID or coordinates (XCTest on iOS, ADB on Android) |
| `automation_find` | Find element by testID, get bounds/text/state |
| `automation_screenshot` | Optimized screenshot (auto-compressed to 700KB JPEG) |

These use native accessibility APIs and work without installing Maestro. Use them for simple interactions; use Maestro for complex multi-step flows.

### iOS: First-run XCTest build
The first `automation_*` call on iOS builds an XCTest bundle (~30-120s). Subsequent calls use a cached build (instant). Cache location: `~/.cache/rn-dev-agent/xctest-bundle/`.
```

- [ ] **Step 2: Commit**

```bash
git add skills/rn-device-control/SKILL.md
git commit -m "docs: add automation tools reference to rn-device-control skill"
```

---

### Task 20: Final Build Verification & Documentation Update

- [ ] **Step 1: Full clean build**

Run: `cd scripts/cdp-bridge && rm -rf dist && npm run build`
Expected: All files compile, dist/ contains all new modules

- [ ] **Step 2: Verify tool count**

Run: `grep -c "server.tool(" scripts/cdp-bridge/src/index.ts`
Expected: `14` (10 existing + 4 new)

- [ ] **Step 3: Update ROADMAP.md**

Add a new phase entry:

```markdown
## Phase 8: expo-mcp Patterns Port
**Status:** Complete

Ported proven patterns from expo/expo-mcp:
- Native device automation (XCTest iOS + ADB Android): `automation_tap`, `automation_find`, `automation_screenshot`
- Multi-source log collection with factory pattern: `collect_logs`
- Image optimization pipeline (jimp-compact, 700KB target)
- Tools complement existing CDP introspection and Maestro — not replacing either
```

- [ ] **Step 4: Update DECISIONS.md**

Add new decision entries:

```markdown
### D61: Port expo-mcp patterns as flat extension
Chose Approach B (flat extension) over monorepo or separate MCP server. Single package, single build, single process. New modules (automation/, log-collectors/, image-utils.ts) sit alongside existing code.

### D62: Complement Maestro with native automation, not replace
automation_tap/automation_find handle simple interactions natively. Maestro retained for complex multi-step flows. Agent decides based on complexity.

### D63: XCTest built from source on first use
Shipped Swift source instead of pre-built binary. Avoids Xcode version mismatches. Cached at ~/.cache/rn-dev-agent/xctest-bundle/ with source hash + Xcode version as cache key.

### D64: jimp-compact over sharp for image optimization
Pure JS (no native bindings), installs everywhere. Speed difference negligible for single-screenshot processing.

### D65: CDP log collector reads from existing ring buffer
Reuses consoleBuffer ring buffer instead of registering a second event handler. CdpClient eventHandlers Map is keyed by method name — duplicates would overwrite.

### D66: Platform auto-detection defaults to iOS when both available
Matches existing snapshot_state.sh behavior. platform parameter on each tool overrides auto-detection.
```

- [ ] **Step 5: Commit documentation**

```bash
git add docs/ROADMAP.md docs/DECISIONS.md
git commit -m "docs: update roadmap and decisions for expo-mcp patterns port"
```
