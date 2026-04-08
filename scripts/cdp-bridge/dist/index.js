import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CDPClient } from './cdp-client.js';
import { okResult, failResult, warnResult, withConnection } from './utils.js';
import { createStatusHandler } from './tools/status.js';
import { createEvaluateHandler } from './tools/evaluate.js';
import { createReloadHandler } from './tools/reload.js';
import { createComponentTreeHandler } from './tools/component-tree.js';
import { createNavigationStateHandler } from './tools/navigation-state.js';
import { createErrorLogHandler } from './tools/error-log.js';
import { createNetworkLogHandler } from './tools/network-log.js';
import { createConsoleLogHandler } from './tools/console-log.js';
import { createStoreStateHandler } from './tools/store-state.js';
import { createDispatchHandler } from './tools/dispatch.js';
import { createDevSettingsHandler } from './tools/dev-settings.js';
import { createInteractHandler } from './tools/interact.js';
import { createCollectLogsHandler } from './tools/collect-logs.js';
import { createDeviceListHandler, createDeviceScreenshotHandler } from './tools/device-list.js';
import { createDeviceSnapshotHandler } from './tools/device-session.js';
import { createDeviceFindHandler, createDevicePressHandler, createDeviceFillHandler, createDeviceSwipeHandler, createDeviceScrollHandler, createDeviceScrollIntoViewHandler, createDeviceLongPressHandler, createDevicePinchHandler, createDeviceBackHandler, } from './tools/device-interact.js';
import { createDevicePermissionHandler } from './tools/device-permission.js';
import { createNavGraphHandler } from './tools/nav-graph.js';
import { createDeviceBatchHandler } from './tools/device-batch.js';
import { handleAutoLogin } from './tools/auto-login.js';
import { createProofStepHandler } from './tools/proof-step.js';
import { createConnectHandler, createDisconnectHandler, createTargetsHandler } from './tools/connection.js';
import { createMaestroRunHandler } from './tools/maestro-run.js';
import { createMaestroGenerateHandler } from './tools/maestro-generate.js';
import { createMaestroTestAllHandler } from './tools/maestro-test-all.js';
import { stopFastRunner } from './fast-runner-session.js';
import { instrumentTool, pruneOldTelemetry } from './experience/index.js';
pruneOldTelemetry();
let client = new CDPClient();
const getClient = () => client;
const setClient = (c) => { client = c; };
const createClient = (port) => new CDPClient(port);
const server = new McpServer({
    name: 'rn-dev-agent-cdp',
    version: '0.8.0',
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trackedTool(name, desc, schema, handler) {
    const wrapped = instrumentTool(name, handler);
    server.tool(name, desc, schema, wrapped);
}
trackedTool('cdp_status', 'Get full environment status. Auto-connects if not connected. Returns Metro status, CDP connection, app info, capabilities, active errors, and RedBox/paused state. Call this FIRST before any testing.', {
    metroPort: z.number().optional().describe('Override Metro port (default: auto-detect 8081/8082/19000/19006)'),
    platform: z.string().optional().describe('Filter target by platform (e.g. "ios", "android") to avoid connecting to the wrong device in multi-simulator setups'),
}, createStatusHandler(getClient, setClient, createClient));
trackedTool('cdp_connect', 'Explicitly connect to a Hermes debug target. Use when you need to target a specific platform or port, or reconnect after a manual disconnect. If already connected, returns current connection info without reconnecting.', {
    metroPort: z.number().optional().describe('Metro port to connect to (default: auto-detect 8081/8082/19000/19006)'),
    platform: z.string().optional().describe('Filter target by platform (e.g. "ios", "android")'),
}, createConnectHandler(getClient, setClient, createClient));
trackedTool('cdp_disconnect', 'Cleanly disconnect from the current Hermes target. Closes WebSocket, stops auto-reconnect, and clears all state. A fresh connection can be established afterward via cdp_connect or cdp_status.', {}, createDisconnectHandler(getClient, setClient, createClient));
trackedTool('cdp_targets', 'List available Hermes debug targets without connecting. Shows all valid targets from Metro with their IDs, titles, and VM type. Highlights which target is currently connected (if any). Use to inspect what is available before calling cdp_connect.', {
    metroPort: z.number().optional().describe('Metro port to scan (default: auto-detect)'),
}, createTargetsHandler(getClient));
trackedTool('cdp_evaluate', 'CAUTION: Executes arbitrary JavaScript directly in the Hermes runtime with no sandboxing. Use only when no specific tool covers the need. Has a 5-second timeout. Prefer cdp_component_tree, cdp_store_state, and other targeted tools over raw evaluate.', {
    expression: z.string().describe('JavaScript expression to evaluate'),
    awaitPromise: z.boolean().default(false).describe('Wait for promise resolution'),
}, createEvaluateHandler(getClient));
trackedTool('cdp_reload', 'Trigger a full reload of the app. Auto-reconnects to the new Hermes target (waits up to 15s). Returns when app is ready for queries again.', {
    full: z.boolean().default(true).describe('Always performs a full reload via DevSettings.reload()'),
}, createReloadHandler(getClient));
trackedTool('cdp_component_tree', 'Get React component tree. Returns components with props, state, testIDs. Use filter to scope to a specific subtree — NEVER request full tree unless necessary (saves tokens). Detects RedBox and warns.', {
    filter: z.string().optional().describe('Component name or testID to scope query (e.g. "CartBadge", "product-list")'),
    depth: z.number().int().min(1).max(12).default(4).describe('Max depth (default 4, max 12)'),
}, createComponentTreeHandler(getClient));
trackedTool('cdp_navigation_state', 'Get current navigation state: active route, params, stack history, nested navigators, active tab. Works with React Navigation and Expo Router.', {}, createNavigationStateHandler(getClient));
trackedTool('cdp_nav_graph', 'Navigation graph tool. PRIMARY: action="go" — navigates to any screen in ONE call (auto-scans if stale, plans path, executes via __NAV_REF__, verifies arrival, records outcome, returns heal advice on failure). Other actions for manual control: scan, read, navigate (plan only), record, staleness, playbook, heal.', {
    action: z.enum(['go', 'scan', 'read', 'navigate', 'record', 'staleness', 'playbook', 'heal']).describe('go = navigate in one call (recommended). scan/read/navigate/record/staleness/playbook/heal for manual control'),
    navigator_id: z.string().optional().describe('(read) Filter to navigator subtree by id'),
    screen: z.string().optional().describe('(read/navigate/record/heal) Target screen name'),
    from: z.string().optional().describe('(navigate) Current screen. Omit to use active screen'),
    force: z.boolean().default(false).describe('(scan) Force re-scan'),
    method: z.enum(['programmatic', 'deep_link', 'ui_interaction']).optional().describe('(record/heal) Navigation method'),
    success: z.boolean().optional().describe('(record) Whether navigation succeeded'),
    latency_ms: z.number().optional().describe('(record) Navigation time in ms'),
    platform: z.enum(['ios', 'android']).optional().describe('(go/playbook/heal) Platform for playbook tips and heal advice'),
    params: z.record(z.unknown()).optional().describe('(go) Screen params to pass (e.g. { id: "1" })'),
}, createNavGraphHandler(getClient));
trackedTool('cdp_error_log', 'Get unhandled JS errors and promise rejections. Hooked into ErrorUtils and Hermes rejection tracker. If empty but app crashed, the error is NATIVE — use bash logcat/simctl log instead.', {
    clear: z.boolean().default(false).describe('Clear all captured errors instead of reading them'),
}, createErrorLogHandler(getClient));
trackedTool('cdp_network_log', 'Get recent network requests. Shows method, URL, status, duration. On RN 0.83+ uses CDP Network domain. On older versions uses injected fetch/XHR hooks (auto-detected).', {
    limit: z.number().int().min(1).max(100).default(20).describe('Max entries to return (default 20, max 100)'),
    filter: z.string().optional().describe('Filter by URL substring (e.g. "/api/cart")'),
    clear: z.boolean().default(false).describe('Clear network buffer instead of reading'),
}, createNetworkLogHandler(getClient));
trackedTool('cdp_console_log', 'Get recent console output. Buffered in ring buffer so logs from between agent calls are preserved.', {
    level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).default('all').describe('Filter by log level'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return (default 50, max 200)'),
    clear: z.boolean().default(false).describe('Clear console buffer instead of reading'),
}, createConsoleLogHandler(getClient));
trackedTool('cdp_store_state', 'Read app store state (Redux, Zustand, React Query). Use path to query specific slice (e.g. "cart.items", "auth.user.name"). Use storeType to target a specific store when multiple exist. Redux auto-detected via fiber Provider. Zustand requires: if (__DEV__) global.__ZUSTAND_STORES__ = { store }', {
    path: z.string().optional().describe('Dot-path into store state (e.g. "cart.items")'),
    storeType: z.enum(['redux', 'zustand', 'react-query']).optional().describe('Target a specific store type. Useful when app has both Redux and React Query.'),
}, createStoreStateHandler(getClient));
trackedTool('cdp_navigate', 'Navigate to any screen by name, including nested stack screens that __NAV_REF__.navigate() cannot reach. Builds a nested dispatch action by walking the navigation state tree. Works across tabs, stacks, and modals.', {
    screen: z.string().describe('Screen name to navigate to (e.g. "AllTasks", "Dashboard", "ProfileEditModal")'),
    params: z.record(z.unknown()).optional().describe('Screen params (e.g. { id: "1" })'),
}, withConnection(getClient, async (args, client) => {
    const paramsArg = args.params ? JSON.stringify(args.params) : 'undefined';
    const expression = `__RN_AGENT.navigateTo(${JSON.stringify(args.screen)}, ${paramsArg})`;
    const result = await client.evaluate(expression);
    if (result.error)
        return failResult(`Navigate error: ${result.error}`);
    if (typeof result.value !== 'string')
        return failResult('Unexpected response');
    let parsed;
    try {
        parsed = JSON.parse(result.value);
    }
    catch {
        return okResult({ raw: result.value });
    }
    if (parsed !== null && typeof parsed === 'object' && '__agent_error' in parsed) {
        return failResult(String(parsed.__agent_error));
    }
    return okResult(parsed);
}));
trackedTool('cdp_component_state', 'Inspect a specific component\'s full hook state by testID. Returns props, all hook values (useState, useRef, useForm, etc.), and auto-detects react-hook-form control objects. Use when cdp_store_state misses non-Redux state (forms, local state, atoms).', {
    testID: z.string().describe('testID of the target component'),
}, withConnection(getClient, async (args, client) => {
    const result = await client.evaluate(`__RN_AGENT.getComponentState(${JSON.stringify(args.testID)})`);
    if (result.error)
        return failResult(`Component state error: ${result.error}`);
    if (typeof result.value !== 'string')
        return failResult('Unexpected response');
    let parsed;
    try {
        parsed = JSON.parse(result.value);
    }
    catch {
        return okResult({ raw: result.value });
    }
    if (parsed !== null && typeof parsed === 'object' && '__agent_error' in parsed) {
        return failResult(String(parsed.__agent_error));
    }
    return okResult(parsed);
}));
trackedTool('cdp_dispatch', 'Dispatch a Redux action and optionally read state afterward — all in a single synchronous JS execution. Use for atomic dispatch+verify operations (e.g. dispatch "tasks/softDelete" then read "tasks.pendingDelete"). Avoids MCP round-trip timing issues.', {
    action: z.string().describe('Redux action type (e.g. "tasks/softDelete", "cart/addItem")'),
    payload: z.any().optional().describe('Action payload'),
    readPath: z.string().optional().describe('Dot-path to read from store after dispatch (e.g. "tasks.pendingDelete")'),
}, createDispatchHandler(getClient));
trackedTool('cdp_dev_settings', 'Control React Native dev settings programmatically (no visual dev menu needed). dismissRedBox clears LogBox overlays and RedBox errors via a 4-tier fallback chain. disableDevMenu suppresses shake-to-show dev menu (use before proof recordings). For reload with auto-reconnect, use cdp_reload instead.', {
    action: z.enum(['reload', 'toggleInspector', 'togglePerfMonitor', 'dismissRedBox', 'disableDevMenu'])
        .describe('Dev menu action to execute'),
}, createDevSettingsHandler(getClient));
trackedTool('cdp_interact', 'Interact with React components by testID — press buttons, long-press, type text, scroll. Calls JS handlers directly (not native touch). Reliable for all React-level interactions including elements inside gesture handlers. For native gestures (swipe, drag), use device_swipe/device_press instead.', {
    action: z.enum(['press', 'longPress', 'typeText', 'scroll']).describe('press: calls onPress. longPress: calls onLongPress. typeText: calls onChangeText. scroll: calls scrollTo or onScroll.'),
    testID: z.string().optional().describe('testID prop of the target component'),
    accessibilityLabel: z.string().optional().describe('accessibilityLabel prop (used if testID not provided)'),
    text: z.string().optional().describe('Required for typeText: the text to enter'),
    scrollX: z.number().optional().describe('For scroll: horizontal offset in pixels (default 0)'),
    scrollY: z.number().optional().describe('For scroll: vertical offset in pixels (default 300)'),
    animated: z.boolean().default(true).describe('For scroll: whether to animate'),
}, createInteractHandler(getClient));
trackedTool('collect_logs', 'Collect logs from multiple sources in parallel: JS console (Hermes ring buffer snapshot), native iOS (xcrun simctl log stream), native Android (adb logcat). Results merged and sorted by timestamp. Works without CDP when only native sources requested. Use when debugging crashes that span JS and native layers.', {
    sources: z.array(z.enum(['js_console', 'native_ios', 'native_android']))
        .default(['js_console'])
        .describe('Log sources to collect from (default: js_console only)'),
    durationMs: z.number().int().min(0).max(10000).default(2000)
        .describe('How long to stream native logs in ms (default 2000). JS console is a snapshot — durationMs only applies to native sources.'),
    limit: z.number().int().min(1).max(500).default(100)
        .describe('Max entries to return (default 100, max 500). Returns most recent entries when truncated.'),
    filter: z.string().optional()
        .describe('Substring filter applied to log text after collection'),
    logLevel: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).default('all')
        .describe('Filter by log level (default: all)'),
}, createCollectLogsHandler(getClient));
// --- agent-device tools (native device interaction) ---
trackedTool('device_list', 'List all available iOS simulators and Android emulators. Returns device name, UDID, platform, and status. Use before device_snapshot action=open to confirm the target device.', {}, createDeviceListHandler());
trackedTool('device_screenshot', 'Capture a screenshot of the active device screen. Returns image data or file path. Prefer JPEG for faster capture.', {
    path: z.string().optional().describe('Output file path (default: auto-generated in /tmp). Use .jpg extension for JPEG.'),
    format: z.enum(['jpeg', 'png']).optional().describe('Image format (default: auto-detect from path extension, or jpeg)'),
}, createDeviceScreenshotHandler());
trackedTool('device_snapshot', 'Manage device sessions and capture UI snapshots. action=open starts a session (required before other device_ tools). action=snapshot returns the accessibility tree with @ref identifiers for device_press/device_fill. action=close ends the session.', {
    action: z.enum(['open', 'close', 'snapshot']).default('snapshot').describe('open: start session for an app. snapshot: capture UI tree with element refs. close: end session.'),
    appId: z.string().optional().describe('App bundle ID — required for action=open (e.g. "com.example.app")'),
    platform: z.enum(['ios', 'android']).optional().describe('Target platform — used with action=open to select device'),
    sessionName: z.string().optional().describe('Session name override (default: auto-generated)'),
}, createDeviceSnapshotHandler());
trackedTool('device_find', 'Find a UI element by visible text and optionally interact with it. Use action="click" to tap, omit for find-only. Returns element ref for use with device_press/device_fill. Requires an open session (call device_snapshot action=open first).', {
    text: z.string().describe('Visible text, accessibility label, or identifier to find'),
    action: z.string().optional().describe('Action to perform: "click" to tap, omit for search-only'),
}, createDeviceFindHandler());
trackedTool('device_press', 'Tap a UI element by its @ref from device_snapshot. Supports double-tap, repeated taps, and long hold. Requires an open session.', {
    ref: z.string().describe('Element ref from device_snapshot (e.g. "e3" or "@e3")'),
    doubleTap: z.boolean().optional().describe('Use double-tap gesture'),
    count: z.number().int().min(1).max(50).optional().describe('Repeat tap N times (for rapid-fire interactions)'),
    holdMs: z.number().int().min(0).max(10000).optional().describe('Hold duration in ms (for long-press via ref)'),
}, createDevicePressHandler());
trackedTool('device_fill', 'Type text into an input field by its @ref from device_snapshot. Clears existing text first. Requires an open session.', {
    ref: z.string().describe('Input field ref from device_snapshot (e.g. "e5" or "@e5")'),
    text: z.string().describe('Text to type into the field'),
}, createDeviceFillHandler());
trackedTool('device_swipe', 'Swipe on the device screen. Use direction for simple scrolling, or x1/y1/x2/y2 for precise coordinate-based swipes (drag-to-reorder, bottom sheets). Requires an open session.', {
    direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Simple directional swipe (delegates to scroll)'),
    x1: z.number().optional().describe('Start X coordinate (use with y1, x2, y2 for precise swipes)'),
    y1: z.number().optional().describe('Start Y coordinate'),
    x2: z.number().optional().describe('End X coordinate'),
    y2: z.number().optional().describe('End Y coordinate'),
    durationMs: z.number().int().min(50).max(10000).optional().describe('Swipe duration in ms (slower = more precise, default ~300)'),
    count: z.number().int().min(1).max(50).optional().describe('Repeat swipe N times'),
    pattern: z.enum(['one-way', 'ping-pong']).optional().describe('Repeat pattern: one-way (reset to start) or ping-pong (reverse direction)'),
}, createDeviceSwipeHandler());
trackedTool('device_back', 'Press the system back button (Android) or perform back navigation gesture (iOS). Requires an open session.', {}, createDeviceBackHandler());
trackedTool('device_longpress', 'Long press on an element or coordinates. Use for context menus, drag initiation, or hold-to-delete. Requires an open session.', {
    ref: z.string().optional().describe('Element ref from device_snapshot (uses press --hold-ms)'),
    x: z.number().optional().describe('X coordinate (use with y for coordinate-based long press)'),
    y: z.number().optional().describe('Y coordinate'),
    durationMs: z.number().int().min(100).max(10000).optional().describe('Hold duration in ms (default 1000)'),
}, createDeviceLongPressHandler());
trackedTool('device_scroll', 'Scroll the screen in a direction. Smoother than device_swipe for list scrolling. Requires an open session.', {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.number().min(0).max(1).optional().describe('Scroll amount 0-1 (default ~0.5). 1 = full screen height/width.'),
}, createDeviceScrollHandler());
trackedTool('device_scrollintoview', 'Scroll until a specific element becomes visible. Use for finding elements in long lists without knowing their position. Requires an open session.', {
    text: z.string().optional().describe('Visible text to scroll to'),
    ref: z.string().optional().describe('Element ref from device_snapshot to scroll to'),
}, createDeviceScrollIntoViewHandler());
trackedTool('device_pinch', 'Pinch/zoom gesture on the screen. scale < 1 zooms out, scale > 1 zooms in. iOS simulator only. Requires an open session.', {
    scale: z.number().min(0.1).max(10).describe('Pinch scale factor (0.5 = zoom out 50%, 2.0 = zoom in 2x)'),
    x: z.number().optional().describe('Center X coordinate (default: screen center)'),
    y: z.number().optional().describe('Center Y coordinate (default: screen center)'),
}, createDevicePinchHandler());
trackedTool('device_permission', 'Grant, revoke, reset, or query app permissions on simulator/emulator. Uses xcrun simctl privacy (iOS) and adb shell pm/dumpsys (Android). query returns current permission state (Android only — iOS returns "unknown"). Use before testing permission-gated flows to ensure correct starting state.', {
    action: z.enum(['grant', 'revoke', 'reset', 'query']).describe('grant: allow. revoke: deny. reset: restore default. query: check current state (Android: granted/denied/not_declared, iOS: unknown).'),
    permission: z.string().describe('Permission key: notifications, camera, microphone, location, location-always, photos, contacts, calendar, reminders, storage, all'),
    appId: z.string().describe('App bundle ID (e.g. "com.example.app")'),
    platform: z.string().optional().describe('Force platform: "ios" or "android". Auto-detected if omitted.'),
}, createDevicePermissionHandler());
trackedTool('device_batch', 'Execute a sequence of UI interactions in ONE tool call. Eliminates LLM round-trip overhead. Steps: find (text + optional tap), fill (ref + text), scroll/swipe (direction), back, wait (ms), hideKeyboard, snapshot, screenshot. Fails fast on error unless step has optional=true.', {
    steps: z.array(z.object({
        action: z.enum(['find', 'press', 'fill', 'swipe', 'scroll', 'back', 'wait', 'hideKeyboard', 'snapshot', 'screenshot']).describe('Step action'),
        text: z.string().optional().describe('(find/fill) Text to find or type'),
        ref: z.string().optional().describe('(press/fill) Element ref from snapshot (e.g. "e5")'),
        tap: z.boolean().optional().describe('(find) Tap the found element'),
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('(scroll/swipe) Direction'),
        ms: z.number().optional().describe('(wait) Milliseconds to wait'),
        optional: z.boolean().optional().describe('Skip this step on failure instead of aborting'),
    })).describe('Ordered list of UI interaction steps'),
    delayMs: z.number().default(300).describe('Delay between steps in ms (default 300)'),
    screenshotOn: z.enum(['none', 'failure', 'end', 'each']).default('failure').describe('When to capture screenshots'),
}, createDeviceBatchHandler());
trackedTool('cdp_auto_login', 'Pre-flight check: detect if the app is on a login/auth screen and auto-login via Maestro subflows from the project. Scans .maestro/subflows/ for login.yaml, sign_in.yaml, auth.yaml, flow_start.yaml, register_user.yaml. Returns { loggedIn: true/false, reason, flow }. Call before proof capture or feature testing when app may be logged out.', {
    appId: z.string().optional().describe('App bundle ID override (auto-detected from app.json if omitted)'),
    platform: z.enum(['ios', 'android']).optional().describe('Platform override (auto-detected from session if omitted)'),
}, withConnection(getClient, async (args, client) => {
    const result = await handleAutoLogin(client, args);
    if (result === null)
        return failResult('CDP not connected or helpers not injected');
    if (result.loggedIn)
        return okResult(result);
    if (result.reason.includes('not on an auth screen'))
        return okResult(result);
    return warnResult(result, result.reason);
}));
trackedTool('proof_step', 'Atomic proof capture step: navigate to a screen (optional), wait for settlement, verify an element (optional), and take a screenshot. Combines 3-4 tool calls into one. Use in Phase 8 proof flows to reduce tool-call overhead.', {
    screen: z.string().optional().describe('Screen to navigate to (omit to stay on current screen)'),
    params: z.record(z.unknown()).optional().describe('Navigation params (e.g. { id: "1" })'),
    waitMs: z.number().int().min(0).max(10000).default(1500).describe('Settlement wait in ms (default 1500)'),
    verifyText: z.string().optional().describe('Visible text to verify on screen (uses device_find)'),
    verifyTestID: z.string().optional().describe('testID to verify in component tree (uses cdp_component_tree)'),
    screenshotPath: z.string().optional().describe('Output path for screenshot (default: auto-generated)'),
    label: z.string().optional().describe('Label for this proof step (e.g. "After adding item to cart")'),
}, createProofStepHandler(getClient));
trackedTool('maestro_run', 'Execute a Maestro flow via maestro-runner. Pass flowPath for an existing .yaml file, or inlineYaml for ephemeral flows. Uses UIAutomator2 on Android and XCTest on iOS. Does NOT require CDP — works even when app is crashed or on native screens.', {
    flowPath: z.string().optional().describe('Path to a .yaml flow file to execute'),
    inlineYaml: z.string().optional().describe('Inline YAML flow content (written to /tmp and executed)'),
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detected from session)'),
    appId: z.string().optional().describe('App bundle ID (auto-detected from app.json)'),
    timeoutMs: z.number().int().min(5000).max(300000).default(120000).describe('Execution timeout in ms'),
}, createMaestroRunHandler());
trackedTool('maestro_generate', 'Generate a persistent Maestro YAML flow file from structured steps. Writes to .maestro/flows/<name>.yaml in the project root. Use after Phase 5.5 verification to create regression tests.', {
    name: z.string().describe('Flow name (e.g. "add-to-cart", "profile-edit"). Becomes filename.'),
    steps: z.array(z.object({
        action: z.enum(['tap', 'fill', 'assert', 'scroll', 'navigate', 'back', 'wait', 'swipe', 'launch']).describe('Step action'),
        testID: z.string().optional().describe('Target element testID'),
        text: z.string().optional().describe('Visible text to find/assert'),
        input: z.string().optional().describe('Text to input (for fill action)'),
        direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Swipe direction'),
        url: z.string().optional().describe('Deep link URL (for navigate action)'),
        waitMs: z.number().optional().describe('Wait duration in ms (for wait action)'),
    })).describe('Ordered list of Maestro steps'),
    appId: z.string().optional().describe('App bundle ID to include in YAML header'),
    outputDir: z.string().optional().describe('Output directory (default: <project>/.maestro/flows/)'),
}, createMaestroGenerateHandler());
trackedTool('maestro_test_all', 'Discover and run all Maestro flows in .maestro/flows/ as a regression suite. Returns per-flow pass/fail with durations. Use for CI or after refactoring to verify no regressions.', {
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detected from session)'),
    flowDir: z.string().optional().describe('Directory to scan for .yaml flows (default: <project>/.maestro/flows/)'),
    pattern: z.string().optional().describe('Regex pattern to filter flow files (e.g. "cart|checkout")'),
    timeoutPerFlow: z.number().int().min(5000).max(300000).default(120000).describe('Timeout per flow in ms'),
    stopOnFailure: z.boolean().default(false).describe('Stop after first failure'),
}, createMaestroTestAllHandler());
process.on('uncaughtException', (err) => {
    console.error('MCP server uncaught exception:', err.message);
    stopFastRunner();
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error('MCP server unhandled rejection (non-fatal):', msg);
});
process.on('SIGTERM', () => {
    stopFastRunner();
    process.exit(0);
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
main().catch((err) => {
    console.error('MCP server fatal error:', err);
    stopFastRunner();
    process.exit(1);
});
