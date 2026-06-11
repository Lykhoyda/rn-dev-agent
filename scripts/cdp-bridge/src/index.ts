import './env-setup.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CDPClient } from './cdp-client.js';
import { okResult, failResult, warnResult, withConnection } from './utils.js';
import { annotateMutationAbsence } from './verification/mutation-absence.js';
import { loadVerificationConfig, getCachedProjectRoot } from './verification/config.js';
import { logger } from './logger.js';
import { createStatusHandler } from './tools/status.js';
import { createEvaluateHandler } from './tools/evaluate.js';
import { createReloadHandler } from './tools/reload.js';
import { createComponentTreeHandler } from './tools/component-tree.js';
import { createNavigationStateHandler, readLiveRoute } from './tools/navigation-state.js';
import { createErrorLogHandler } from './tools/error-log.js';
import { createNativeErrorsHandler } from './tools/native-errors.js';
import { createNetworkLogHandler } from './tools/network-log.js';
import { createWaitForNetworkHandler } from './tools/wait-for-network.js';
import { createNetworkBodyHandler } from './tools/network-body.js';
import { createHeapUsageHandler, createCpuProfileHandler } from './tools/profiling.js';
import { createObjectInspectHandler } from './tools/object-inspect.js';
import { createExceptionBreakpointHandler } from './tools/exception-breakpoint.js';
import { createConsoleLogHandler } from './tools/console-log.js';
import { createStoreStateHandler } from './tools/store-state.js';
import { createDiagnosticRenderersHandler } from './tools/diagnostic-renderers.js';
import {
  createExpectReduxHandler,
  createExpectRouteHandler,
  createExpectVisibleByTestIDHandler,
  createExpectTextHandler,
} from './tools/macro-asserts.js';
import { createRepairActionHandler } from './tools/repair-action.js';
import { createSaveAsActionHandler } from './tools/save-as-action.js';
import { createRunActionHandler } from './tools/run-action.js';
import { createDispatchHandler } from './tools/dispatch.js';
import { createMmkvHandler } from './tools/mmkv.js';
import { createDevSettingsHandler } from './tools/dev-settings.js';
import { createInteractHandler } from './tools/interact.js';
import { createCollectLogsHandler } from './tools/collect-logs.js';
import { createDeviceListHandler, createDeviceScreenshotHandler } from './tools/device-list.js';
import { createDeviceSnapshotHandler } from './tools/device-session.js';
import { releaseDeviceLockForSession } from './tools/device-session.js';
import {
  createDeviceFindHandler,
  createDevicePressHandler,
  createDeviceFillHandler,
  createDeviceSwipeHandler,
  createDeviceScrollHandler,
  createDeviceScrollIntoViewHandler,
  createDeviceLongPressHandler,
  createDevicePinchHandler,
  createDeviceBackHandler,
  createDeviceFocusNextHandler,
} from './tools/device-interact.js';
import { createDevicePermissionHandler } from './tools/device-permission.js';
import { createDeviceResetStateHandler } from './tools/device-reset-state.js';
import { createDeviceDeeplinkHandler } from './tools/device-deeplink.js';
import { createDismissDevClientPickerHandler } from './tools/dev-client-picker.js';
import { createDeviceRecordHandler } from './tools/device-record.js';
import {
  createDeviceAcceptSystemDialogHandler,
  createDeviceDismissSystemDialogHandler,
} from './tools/device-system-dialog.js';
import {
  createDevicePickValueHandler,
  createDevicePickDateHandler,
} from './tools/device-picker.js';
import { createNavGraphHandler } from './tools/nav-graph.js';
import { createDeviceBatchHandler } from './tools/device-batch.js';
import { handleAutoLogin } from './tools/auto-login.js';
import { createProofStepHandler } from './tools/proof-step.js';
import { createConnectHandler, createDisconnectHandler, createTargetsHandler } from './tools/connection.js';
import { createRestartHandler } from './tools/restart.js';
import { buildGracefulShutdown } from './lifecycle/graceful-shutdown.js';
import { Lockfile, formatLockConflictMessage } from './lifecycle/lockfile.js';
import { startParentDeathWatch } from './lifecycle/parent-watch.js';
import { arbiterWrap } from './lifecycle/device-arbiter.js';
import { createMaestroRunHandler } from './tools/maestro-run.js';
import { createMaestroGenerateHandler } from './tools/maestro-generate.js';
import { createMaestroTestAllHandler } from './tools/maestro-test-all.js';
import {
  createRecordTestStartHandler,
  createRecordTestStopHandler,
  createRecordTestGenerateHandler,
  createRecordTestAnnotateHandler,
  createRecordTestSaveHandler,
  createRecordTestLoadHandler,
  createRecordTestListHandler,
} from './tools/test-recorder.js';
import { createCrossPlatformVerifyHandler } from './tools/cross-platform-verify.js';
import { createOpenDevToolsHandler } from './tools/open-devtools.js';
import { createMetroEventsHandler } from './tools/metro-events.js';
import { stopFastRunner } from './runners/rn-fast-runner-client.js';
import { ensureSingleRunner } from './runners/ensure-single-runner.js';
import { instrumentTool, setToolObserver } from './observability/instrumentation.js';
import { recorder } from './observability/recorder.js';
import { observeHandler, observeSchema } from './tools/observe.js';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
const pkgVersion = (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;

// M3 / Phase 90: single-instance lock. Must run BEFORE telemetry prune / CDPClient creation
// so two racing MCPs don't corrupt telemetry files or fight for the CDP slot. --no-lock
// opt-out exists for CI parallelism and benchmark harnesses; documented in the conflict
// message. Release is registered on process.exit so ALL exit paths (graceful, uncaught,
// signal) clean up the lock.
// GH #182: module-scoped so the parent-death watch can touch() it (heartbeat) and
// release() it on orphan-exit. null when --no-lock (touch/release become no-ops).
let lockfile: Lockfile | null = null;
const noLock = process.argv.includes('--no-lock');
if (!noLock) {
  lockfile = new Lockfile({ version: pkgVersion });
  const lockResult = lockfile.acquire();
  if (lockResult.status === 'conflict') {
    process.stderr.write(formatLockConflictMessage(lockResult) + '\n');
    process.exit(11);
  }
  process.on('exit', () => lockfile?.release());
}
process.on('exit', () => { try { releaseDeviceLockForSession(); } catch { /* never fail exit */ } });

// GH#202 Phase 1: at boot the simulator UDID is unknown, so only the
// files-only pass runs — remove orphaned ~/.agent-device/daemon.{json,lock}
// when their daemon PID is dead. Never touches a live process at startup.
// Default-on; opt out with RN_DEVICE_KILL_LEGACY=0.
if (process.env.RN_DEVICE_KILL_LEGACY !== '0') {
  void ensureSingleRunner()
    .then((r) => {
      if (r.removedFiles.length) {
        logger.info('rn-device', `ensureSingleRunner(boot): removed ${r.removedFiles.join(', ')}`);
      }
    })
    .catch(() => { /* non-fatal */ });
}

let client = new CDPClient();

const getClient = (): CDPClient => client;
const setClient = (c: CDPClient): void => { client = c; };
const createClient = (port: number): CDPClient => new CDPClient(port);

const server = new McpServer({
  name: 'rn-dev-agent-cdp-bridge',
  version: pkgVersion,
});

setToolObserver((o) => recorder.record(o));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function trackedTool(name: string, desc: string, schema: any, handler: any): void {
  const wrapped = instrumentTool(name, arbiterWrap(
    name,
    handler as (...args: unknown[]) => Promise<import('./utils.js').ToolResult>,
  ) as (...args: unknown[]) => Promise<unknown>);
  server.tool(name, desc, schema, wrapped as typeof handler);
}

trackedTool(
  'cdp_status',
  'Get full environment status. Auto-connects if not connected. Returns Metro status, CDP connection, app info, capabilities, active errors, and RedBox/paused state. Call this FIRST before any testing.',
  {
    metroPort: z.number().optional().describe('Override Metro port (default: auto-detect 8081/8082/19000/19006)'),
    platform: z.string().optional().describe('Filter target by platform (e.g. "ios", "android") to avoid connecting to the wrong device in multi-simulator setups'),
    resetArbiter: z.boolean().optional().describe('Clear a wedged in-memory device arbiter (a leaked plane lease refusing all flows). Escape hatch — cdp_status is unarbitrated so it always runs.'),
  },
  createStatusHandler(getClient, setClient, createClient),
);

trackedTool(
  'observe',
  "Start/stop the read-only observability web UI (watch the agent's live tool-call timeline, device screenshot, and app state). action: start|stop|status.",
  observeSchema,
  observeHandler,
);

trackedTool(
  'cdp_diagnostic_renderers',
  'Diagnostic helper for "fiber root invisibility" bug reports (issue #126 follow-up). Enumerates every registered React renderer and its root count via __REACT_DEVTOOLS_GLOBAL_HOOK__. Returns hook keys, renderer Map keys, per-renderer-id root summaries (top fiber type + first child + testID), and notes when renderers are registered but unscanned. Use this when cdp_component_tree returns empty for a component you know is mounted (modals, portals, sub-apps), or when bug-reporting fiber-walk failures.',
  {
    maxRendererId: z.number().int().min(1).max(100).optional().describe('How many renderer IDs to scan. Default 20 (matches IIFE MAX_RENDERER_IDS).'),
  },
  createDiagnosticRenderersHandler(getClient),
);

trackedTool(
  'cdp_connect',
  'Explicitly connect to a Hermes debug target. Use when you need to target a specific platform, port, or bundle, or reconnect after a manual disconnect. When multiple Hermes targets exist (common after app restarts on Expo Dev Client — zombie `host.exp.Exponent` pages linger alongside fresh app pages), pass `targetId` (exact id from cdp_targets) or `bundleId` (e.g. "com.myapp") to disambiguate. Use force=true to always reconnect regardless of current state.',
  {
    metroPort: z.number().optional().describe('Metro port to connect to (default: auto-detect 8081/8082/19000/19006)'),
    platform: z.string().optional().describe('Filter target by platform (e.g. "ios", "android"). If already connected to a different platform, forces reconnection to the correct target.'),
    targetId: z.string().optional().describe('Exact Hermes target id (from cdp_targets). Highest-precedence filter — picks one target precisely. Use when multiple targets share a platform and bundleId is ambiguous.'),
    bundleId: z.string().optional().describe('App bundle id to match against target.description (e.g. "com.myapp.dev"). Filters out zombie Expo Go host pages when the real app target is present. B111/D635.'),
    force: z.boolean().optional().default(false).describe('Force disconnect and reconnect even if already connected. Use to switch targets or recover from stale connections.'),
  },
  createConnectHandler(getClient, setClient, createClient),
);

trackedTool(
  'cdp_disconnect',
  'Cleanly disconnect from the current Hermes target. Closes WebSocket, stops auto-reconnect, and clears all state. A fresh connection can be established afterward via cdp_connect or cdp_status.',
  {},
  createDisconnectHandler(getClient, setClient, createClient),
);

trackedTool(
  'cdp_targets',
  'List available Hermes debug targets without connecting. Shows all valid targets from Metro with their IDs, titles, and VM type. Highlights which target is currently connected (if any). Use to inspect what is available before calling cdp_connect.',
  {
    metroPort: z.number().optional().describe('Metro port to scan (default: auto-detect)'),
  },
  createTargetsHandler(getClient),
);

trackedTool(
  'cdp_evaluate',
  'CAUTION: Executes arbitrary JavaScript directly in the Hermes runtime with no sandboxing. Use only when no specific tool covers the need. Has a 5-second timeout. The Hermes dev runtime has NO Node `require()` — Metro bundles modules internally and only the live React tree is reachable. Use cdp_mmkv for storage R/W, cdp_dispatch for Redux/Zustand state changes, cdp_component_tree / cdp_store_state for introspection. Reach for raw evaluate only when no targeted tool fits.',
  {
    expression: z.string().describe('JavaScript expression to evaluate'),
    awaitPromise: z.boolean().default(false).describe('Wait for promise resolution'),
  },
  createEvaluateHandler(getClient),
);

trackedTool(
  'cdp_reload',
  'Trigger a full reload of the app. Auto-reconnects to the new Hermes target (waits up to 30s with 5 soft retries; on failure, falls back once to a 10s force-recreate that mirrors `cdp_connect force=true`). After Dev Client rebuilds, the app may need a manual restart (xcrun simctl terminate + launch) if both paths fail. When the force fallback recovers, `meta.recovered_via` is "force_reconnect" and `meta.proxy_was_active` indicates whether DevTools was attached (re-run cdp_open_devtools to re-attach).',
  {
    full: z.boolean().default(true).describe('Always performs a full reload via DevSettings.reload()'),
  },
  createReloadHandler(getClient, setClient, createClient),
);

trackedTool(
  'cdp_component_tree',
  'Get React component tree. Returns components with props, state, testIDs. Use filter to scope to a specific subtree — NEVER request full tree unless necessary (saves tokens). Detects RedBox and warns.',
  {
    filter: z.string().optional().describe('Case-insensitive substring match against component name, testID/nativeID, or accessibilityLabel (e.g. "CartBadge", "product-list", "Continue")'),
    depth: z.number().int().min(1).max(12).default(4).describe('Max depth (default 4, max 12)'),
  },
  createComponentTreeHandler(getClient),
);

trackedTool(
  'cdp_navigation_state',
  'Get current navigation state: active route, params, stack history, nested navigators, active tab. Works with React Navigation and Expo Router.',
  {},
  createNavigationStateHandler(getClient),
);

trackedTool(
  'cdp_nav_graph',
  'Navigation graph tool. PRIMARY: action="go" — navigates to any screen in ONE call (auto-scans if stale, plans path, executes via __NAV_REF__, verifies arrival, records outcome, returns heal advice on failure). Other actions for manual control: scan, read, navigate (plan only), record, staleness, playbook, heal.',
  {
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
  },
  createNavGraphHandler(getClient),
);

trackedTool(
  'cdp_error_log',
  'Get unhandled JS errors and promise rejections. Hooked into ErrorUtils and Hermes rejection tracker. If empty but app crashed, the error is NATIVE — call cdp_native_errors to check native logs.',
  {
    clear: z.boolean().default(false).describe('Clear all captured errors instead of reading them'),
  },
  createErrorLogHandler(getClient),
);

trackedTool(
  'cdp_native_errors',
  'Read native-level error logs for when JS-layer tools come up empty. iOS spawns `xcrun simctl log show`, Android uses `adb logcat -d`. Catches errors that fire BEFORE __RN_AGENT injects (missing native module, bundle load failure, native crash). Returns filtered + deduped error/fatal entries. Platform defaults to the CDP-connected target.',
  {
    platform: z.enum(['ios', 'android']).optional().describe('Target platform. Defaults to the currently-connected CDP target platform.'),
    sinceSeconds: z.number().int().min(5).max(3600).optional().describe('How far back to look (default 60s, max 3600)'),
    limit: z.number().int().min(1).max(100).optional().describe('Max entries to return (default 10, max 100)'),
  },
  createNativeErrorsHandler(getClient),
);

trackedTool(
  'cdp_network_log',
  'Get recent network requests. Shows method, URL, status, duration. On RN 0.83+ uses CDP Network domain. On older versions uses injected fetch/XHR hooks (auto-detected). Buffers are per-device, keyed by Metro port + target id — switching simulators no longer bleeds stale traffic. Pass `device: "all"` to merge across every device seen this session. Filters AND-combine: `filter` (URL substring), `method` (HTTP verb), `since` (ISO timestamp). When more entries match than `limit` allows, response includes `truncated:true` + `total_matches`.',
  {
    limit: z.number().int().min(1).max(100).default(20).describe('Max entries to return (default 20, max 100)'),
    filter: z.string().optional().describe('Filter by URL substring (e.g. "/api/cart")'),
    method: z.union([z.string(), z.array(z.string())]).optional().describe('Filter by HTTP method, case-insensitive (e.g. "POST" or ["POST","PUT"]). AND-combined with `filter`. Use to isolate mutations from follow-up GETs.'),
    since: z.string().optional().describe('ISO timestamp — drop entries with timestamp < since before applying limit. Use to pin a checkpoint before an action and ask for everything since.'),
    clear: z.boolean().default(false).describe('Clear network buffer instead of reading'),
    device: z.string().optional().describe('Scope: a specific device key OR the literal "all" for a chronologically-merged view across every device. Defaults to the active device.'),
  },
  createNetworkLogHandler(getClient),
);

trackedTool(
  'cdp_network_body',
  'Get the actual response body for a network request by its requestId. Use cdp_network_log first to find request IDs. In CDP mode (RN 0.83+) bodies are fetched on-demand; on RN < 0.83 hook mode a small recent-response cache is used. Pass `device` to look up requestId in a specific device buffer; defaults to the active device.',
  {
    requestId: z.string().describe('Request ID from cdp_network_log output'),
    maxLength: z.number().int().min(100).max(100000).default(10000).optional()
      .describe('Max body length to return (default 10000 chars). Truncated if longer.'),
    device: z.string().optional().describe('Device key to scope the lookup ("all" to search every device buffer). Defaults to the active device.'),
  },
  createNetworkBodyHandler(getClient),
);

trackedTool(
  'cdp_wait_for_network',
  'Block until a network request matching url_pattern (URL substring) and optional method completes (response received), or timeout_ms elapses. Two-phase: scans the existing buffer first (retroactive match), then polls every poll_interval_ms until deadline. Returns {matched:true, mutation, network_log_since} on success or {matched:false, timeout_ms, candidates_seen} (capped at 10) on timeout — never errors on timeout; agents should check `data.matched`. Use after triggering an action that fires a request to deterministically confirm it landed without buffer-churn races. Pin `since` to a timestamp captured BEFORE the trigger (Date.now() ISO) to also catch mutations that land in the MCP transport window. On RN < 0.83 (hook network mode) new-entry detection granularity is ~500ms — sub-500ms poll_interval_ms buys nothing there.',
  {
    url_pattern: z.string().describe('URL substring to match (e.g. "/api/cart/add", "checkout"). Same matching semantics as cdp_network_log filter.'),
    method: z.union([z.string(), z.array(z.string())]).optional().describe('HTTP method filter, case-insensitive (e.g. "POST" or ["POST","PUT"]). Omit to match any method.'),
    timeout_ms: z.number().int().min(100).max(60000).default(5000).optional().describe('Max wait in ms (default 5000, range 100-60000)'),
    poll_interval_ms: z.number().int().min(50).max(500).default(100).optional().describe('Buffer poll cadence in ms (default 100, range 50-500)'),
    since: z.string().optional().describe('ISO timestamp checkpoint — ignore entries older than this. Defaults to the moment the tool is called. Capture `new Date().toISOString()` before the trigger action to avoid missing the mutation in the transport window.'),
    device: z.string().optional().describe('Device key OR "all". Defaults to the active device.'),
  },
  createWaitForNetworkHandler(getClient),
);

trackedTool(
  'cdp_heap_usage',
  'Get current JS heap memory usage. Single fast CDP call — useful before/after operations to detect memory leaks. Returns used/total in bytes and MB.',
  {},
  createHeapUsageHandler(getClient),
);

trackedTool(
  'cdp_cpu_profile',
  'Record a CPU profile for a specified duration. Returns the top hot functions sorted by hit count. Requires Profiler domain (check cdp_status domains.profiler).',
  {
    durationMs: z.number().int().min(500).max(30000).default(3000).optional()
      .describe('Profile duration in ms (default 3000, max 30000)'),
  },
  createCpuProfileHandler(getClient),
);

trackedTool(
  'cdp_object_inspect',
  'Inspect a JS object by expression without flattening to JSON. Uses Runtime.getProperties for lazy, handle-based inspection. Good for large objects, cyclic refs, class instances.',
  {
    expression: z.string().describe('JS expression to evaluate and inspect (e.g. "globalThis.__REDUX_STORE__")'),
    depth: z.number().int().min(0).max(3).default(1).optional().describe('Property inspection depth (default 1, max 3)'),
    maxProperties: z.number().int().min(1).max(100).default(20).optional().describe('Max properties per level (default 20)'),
  },
  createObjectInspectHandler(getClient),
);

trackedTool(
  'cdp_exception_breakpoint',
  'Set the debugger to pause on exceptions. With durationMs: records exceptions for that period then auto-disables. Without durationMs: toggles the breakpoint state (call with state="none" to disable).',
  {
    state: z.enum(['none', 'uncaught', 'all']).default('uncaught').describe('Exception pause mode: none (off), uncaught (default), all'),
    durationMs: z.number().int().min(1000).max(30000).optional()
      .describe('Auto-capture duration in ms. If set, records exceptions then disables.'),
  },
  createExceptionBreakpointHandler(getClient),
);

trackedTool(
  'cdp_console_log',
  'Get recent console output. Buffered in ring buffer so logs from between agent calls are preserved.',
  {
    level: z.enum(['all', 'log', 'warn', 'error', 'info', 'debug']).default('all').describe('Filter by log level'),
    limit: z.number().int().min(1).max(200).default(50).describe('Max entries to return (default 50, max 200)'),
    clear: z.boolean().default(false).describe('Clear console buffer instead of reading'),
  },
  createConsoleLogHandler(getClient),
);

trackedTool(
  'cdp_store_state',
  'Read app store state (Redux, Zustand, Jotai, React Query). Use path to query specific slice (e.g. "cart.items", "auth.user.name"). Use storeType to target a specific store when multiple exist. Redux auto-detected via fiber Provider. Zustand requires: if (__DEV__) global.__ZUSTAND_STORES__ = { store }. Jotai requires: if (__DEV__) { global.__JOTAI_STORE__ = store; global.__JOTAI_ATOMS__ = { name: atom } }',
  {
    path: z.string().optional().describe('Dot-path into store state (e.g. "cart.items")'),
    storeType: z.enum(['redux', 'zustand', 'jotai', 'react-query']).optional().describe('Target a specific store type. Useful when app has both Redux and React Query.'),
  },
  createStoreStateHandler(getClient),
);

trackedTool(
  'cdp_navigate',
  'Navigate to any screen by name, including nested stack screens that __NAV_REF__.navigate() cannot reach. Builds a nested dispatch action by walking the navigation state tree. Works across tabs, stacks, and modals.',
  {
    screen: z.string().describe('Screen name to navigate to (e.g. "AllTasks", "Dashboard", "ProfileEditModal")'),
    params: z.record(z.unknown()).optional().describe('Screen params (e.g. { id: "1" })'),
  },
  withConnection(getClient, async (args: { screen: string; params?: Record<string, unknown> }, client) => {
    const paramsArg = args.params ? JSON.stringify(args.params) : 'undefined';
    const expression = `__RN_AGENT.navigateTo(${JSON.stringify(args.screen)}, ${paramsArg})`;
    const result = await client.evaluate(expression);
    if (result.error) return failResult(`Navigate error: ${result.error}`);
    if (typeof result.value !== 'string') return failResult('Unexpected response');
    let parsed: unknown;
    try { parsed = JSON.parse(result.value); } catch { return okResult({ raw: result.value }); }
    if (parsed !== null && typeof parsed === 'object' && '__agent_error' in (parsed as Record<string, unknown>)) {
      return failResult(String((parsed as Record<string, unknown>).__agent_error));
    }
    // GH #91: surface verification_warning when the requested screen matches
    // the success-shape regex AND the 5s rolling window has no qualifying
    // mutation. Uses args.screen as the signal — the user asked to navigate
    // there, so even if the actual landing route differs we capture intent.
    const cfg = loadVerificationConfig(getCachedProjectRoot());
    return annotateMutationAbsence(okResult(parsed), {
      client,
      screenName: args.screen,
      source: 'cdp_navigate',
      successShapes: cfg.successShapes,
      mutationMethods: cfg.mutationMethods,
    });
  }),
);

trackedTool(
  'cdp_component_state',
  'Inspect a specific component\'s full hook state by testID. Returns props, all hook values (useState, useRef, useForm, etc.), and auto-detects react-hook-form control objects. Use when cdp_store_state misses non-Redux state (forms, local state, atoms).',
  {
    testID: z.string().describe('testID of the target component'),
  },
  withConnection(getClient, async (args: { testID: string }, client) => {
    const result = await client.evaluate(`__RN_AGENT.getComponentState(${JSON.stringify(args.testID)})`);
    if (result.error) return failResult(`Component state error: ${result.error}`);
    if (typeof result.value !== 'string') return failResult('Unexpected response');
    let parsed: unknown;
    try { parsed = JSON.parse(result.value); } catch { return okResult({ raw: result.value }); }
    if (parsed !== null && typeof parsed === 'object' && '__agent_error' in (parsed as Record<string, unknown>)) {
      return failResult(String((parsed as Record<string, unknown>).__agent_error));
    }
    return okResult(parsed);
  }),
);

trackedTool(
  'cdp_set_shared_value',
  'Set a Reanimated SharedValue on a component found by testID. Walks the React fiber tree to find the component, locates the named prop (a SharedValue object), and sets .value. Useful for driving Reanimated animations in proof captures when gesture/scroll synthesis is unavailable.',
  {
    testID: z.string().describe('testID of the component that receives the SharedValue as a prop'),
    prop: z.string().describe('Prop name containing the SharedValue (e.g. "scrollY", "progress")'),
    value: z.number().describe('Numeric value to set on the SharedValue'),
  },
  withConnection(getClient, async (args: { testID: string; prop: string; value: number }, client) => {
    const expression = `(function() {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || typeof hook.getFiberRoots !== 'function') return JSON.stringify({ __agent_error: 'No React DevTools hook' });
      var allRoots = [];
      for (var i = 1; i <= 5; i++) {
        var r = hook.getFiberRoots(i);
        if (r && r.size) { var it = r.values(); var v; while (!(v = it.next()).done) allRoots.push(v.value); }
      }
      if (!allRoots.length) return JSON.stringify({ __agent_error: 'No fiber roots' });
      var found = null;
      function walk(fiber, depth) {
        if (!fiber || depth > 300 || found) return;
        var props = fiber.memoizedProps;
        if (props && props.testID === ${JSON.stringify(args.testID)}) {
          var sv = props[${JSON.stringify(args.prop)}];
          if (sv && typeof sv === 'object' && 'value' in sv) { found = fiber; return; }
          var fc = fiber;
          for (var up = 0; up < 5 && fc; up++) {
            var p2 = fc.memoizedProps;
            if (p2 && p2[${JSON.stringify(args.prop)}] && typeof p2[${JSON.stringify(args.prop)}] === 'object' && 'value' in p2[${JSON.stringify(args.prop)}]) {
              found = fc; return;
            }
            fc = fc.return;
          }
        }
        if (fiber.child) walk(fiber.child, depth + 1);
        if (fiber.sibling) walk(fiber.sibling, depth);
      }
      for (var ri = 0; ri < allRoots.length; ri++) walk(allRoots[ri].current, 0);
      if (!found) return JSON.stringify({ __agent_error: 'No component with testID=' + ${JSON.stringify(args.testID)} + ' has a SharedValue prop named ' + ${JSON.stringify(args.prop)} });
      var sv = found.memoizedProps[${JSON.stringify(args.prop)}];
      if (!sv) {
        var fc2 = found;
        for (var up2 = 0; up2 < 5 && fc2; up2++) {
          if (fc2.memoizedProps && fc2.memoizedProps[${JSON.stringify(args.prop)}]) { sv = fc2.memoizedProps[${JSON.stringify(args.prop)}]; break; }
          fc2 = fc2.return;
        }
      }
      if (!sv || typeof sv !== 'object' || !('value' in sv)) return JSON.stringify({ __agent_error: 'SharedValue prop found but not accessible on the resolved fiber' });
      sv.value = ${args.value};
      var observed = sv.value;
      var drift = observed !== ${args.value};
      return JSON.stringify({ ok: true, testID: ${JSON.stringify(args.testID)}, prop: ${JSON.stringify(args.prop)}, written: ${args.value}, observed: observed, drift: drift });
    })()`;
    const result = await client.evaluate(expression);
    if (result.error) return failResult(`SharedValue error: ${result.error}`);
    if (typeof result.value !== 'string') return failResult('Unexpected response');
    let parsed: unknown;
    try { parsed = JSON.parse(result.value); } catch { return okResult({ raw: result.value }); }
    if (parsed !== null && typeof parsed === 'object' && '__agent_error' in (parsed as Record<string, unknown>)) {
      return failResult(String((parsed as Record<string, unknown>).__agent_error));
    }
    return okResult(parsed);
  }),
);

trackedTool(
  'cdp_dispatch',
  'Dispatch a Redux action and optionally read state afterward — all in a single synchronous JS execution. Use for atomic dispatch+verify operations (e.g. dispatch "tasks/softDelete" then read "tasks.pendingDelete"). NOTE: Best used for state verification, not UI interaction testing — React components may not re-render immediately after CDP-dispatched actions. For UI testing, use device_press/device_find to trigger the action through the UI instead.',
  {
    action: z.string().describe('Redux action type (e.g. "tasks/softDelete", "cart/addItem")'),
    payload: z.any().optional().describe('Action payload. WARNING: JSON-RPC between LLM and MCP does not preserve the distinction between string "42" and number 42 — the LLM\'s JSON encoder may serialize either way. For type-critical payloads (e.g. a string that happens to be numeric), use payloadJson instead.'),
    payloadJson: z.string().optional().describe('Stringified JSON payload with guaranteed type preservation. Takes precedence over `payload` when provided. Example: payloadJson=\'"42"\' dispatches the STRING "42"; payloadJson=\'42\' dispatches the NUMBER 42; payloadJson=\'{"id":"42","qty":5}\' dispatches an object.'),
    readPath: z.string().optional().describe('Dot-path to read from store after dispatch (e.g. "tasks.pendingDelete")'),
  },
  createDispatchHandler(getClient),
);

trackedTool(
  'cdp_mmkv',
  'Read/write the app\'s MMKV storage from Hermes. Closes the iteration-loop gap where tests had to xcrun simctl uninstall + reinstall to clear cooldowns/timestamps/feature flags. Requires react-native-mmkv v3+ (Nitro-based) — older versions exposed via TurboModule are not reachable. Returns __agent_error if MMKV / NitroModulesProxy is unavailable in the runtime. Actions: get|set|delete|has|keys|clear. Use sparingly: writing to MMKV bypasses the real user flow, so only use during test setup/teardown, not as a substitute for UI interaction (see "Verification Fidelity" rule).',
  {
    action: z.enum(['get', 'set', 'delete', 'has', 'keys', 'clear']).describe('MMKV action: get/set/delete/has by key, keys (list all), clear (wipe instance)'),
    key: z.string().optional().describe('Required for get/set/delete/has actions'),
    value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Required for set action. Combine with `type` to disambiguate (default: string)'),
    type: z.enum(['string', 'number', 'boolean']).optional().describe('Value type for get/set (default: string)'),
    instanceId: z.string().optional().describe('MMKV instance id (default: "mmkv.default")'),
  },
  createMmkvHandler(getClient),
);

trackedTool(
  'cdp_dev_settings',
  'Control React Native dev settings programmatically (no visual dev menu needed). dismissRedBox clears LogBox overlays and RedBox errors via a 4-tier fallback chain. disableDevMenu suppresses shake-to-show dev menu (use before proof recordings). For reload with auto-reconnect, use cdp_reload instead.',
  {
    action: z.enum(['reload', 'toggleInspector', 'togglePerfMonitor', 'dismissRedBox', 'disableDevMenu'])
      .describe('Dev menu action to execute'),
  },
  createDevSettingsHandler(getClient),
);

trackedTool(
  'cdp_interact',
  'Interact with React components by testID (preferred) or accessibilityLabel — press buttons, long-press, type text, scroll, or set a React Hook Form field value directly. Calls JS handlers directly (not native touch). testID matches strictly; accessibilityLabel matches in tiers (exact → trim/case-insensitive → substring) and returns an ambiguity error when >1 component matches. Prefer testID for unambiguous targeting. For native gestures (swipe, drag), use device_swipe/device_press instead. setFieldValue (GH #126 Gap A): explicit fallback when typeText fails because the field routes through a Controller — pass name + value, walks UP to the nearest FormProvider and calls its setValue. Use only when typeText returns "no handler". Portal-root coverage (GH #126 Gap B): if your app uses react-native-actions-sheet, @gorhom/bottom-sheet, or any Modal-based portal whose fiber root is not in React DevTools\' getFiberRoots() registry, set `globalThis.__RN_AGENT_EXTRA_ROOTS__ = () => [sheetRef.current, ...]` in your __DEV__ block — testID resolution will then reach inside those subtrees. See CLAUDE.md template for the canonical snippet.',
  {
    action: z.enum(['press', 'longPress', 'typeText', 'scroll', 'setFieldValue']).describe('press: calls onPress. longPress: calls onLongPress. typeText: calls onChangeText. scroll: calls scrollTo or onScroll. setFieldValue: walks UP to nearest React Hook Form FormProvider and calls setValue(name, value, {shouldValidate, shouldDirty}).'),
    testID: z.string().optional().describe('testID prop of the target component (strict match — preferred). For setFieldValue, this is the testID anchor inside the form\'s subtree from which to walk up.'),
    accessibilityLabel: z.string().optional().describe('accessibilityLabel prop (used if testID not provided). Tiered match: exact → normalized (trim+lowercase) → substring. Returns Ambiguous error if >1 component matches.'),
    text: z.string().optional().describe('Required for typeText: the text to enter'),
    scrollX: z.number().optional().describe('For scroll: horizontal offset in pixels (default 0)'),
    scrollY: z.number().optional().describe('For scroll: vertical offset in pixels (default 300)'),
    animated: z.boolean().default(true).describe('For scroll: whether to animate'),
    name: z.string().optional().describe('Required for setFieldValue: the React Hook Form field name (same string you passed to useController({name}) or <Controller name="...">).'),
    value: z.union([z.string(), z.number(), z.boolean()]).optional().describe('Required for setFieldValue: the value to set. Passed verbatim to setValue; no coercion.'),
    shouldValidate: z.boolean().optional().describe('For setFieldValue: pass-through to setValue\'s options.shouldValidate (default true). Set false to suppress synchronous validation.'),
    shouldDirty: z.boolean().optional().describe('For setFieldValue: pass-through to setValue\'s options.shouldDirty (default true). Set false to keep the field marked pristine.'),
  },
  createInteractHandler(getClient),
);

trackedTool(
  'collect_logs',
  'Collect logs from multiple sources in parallel: JS console (Hermes ring buffer snapshot), native iOS (xcrun simctl log stream), native Android (adb logcat). Results merged and sorted by timestamp. Works without CDP when only native sources requested. Use when debugging crashes that span JS and native layers.',
  {
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
  },
  createCollectLogsHandler(getClient),
);

// --- agent-device tools (native device interaction) ---

trackedTool(
  'device_list',
  'List all available iOS simulators and Android emulators. Returns device name, UDID, platform, and status. Use before device_snapshot action=open to confirm the target device.',
  {},
  createDeviceListHandler(),
);

trackedTool(
  'device_screenshot',
  'Capture a screenshot of the active device screen. Returns the file path. Prefer JPEG for faster capture. When both iOS sim and Android emulator are booted, defaults to the platform of the currently connected CDP target. Output is auto-downscaled to maxWidth (default 800px) via macOS sips to keep LLM context costs predictable; pass maxWidth=0 to disable when full-resolution capture is needed (visual diffing). meta.resize describes what happened. Result may include meta.advisories[] (EPHEMERAL_PATH when saving to /tmp, FULL_RESOLUTION when maxWidth=0) — non-blocking nudges to use docs/proof/<feature>/<NN>-<step>.jpg for deliverables and the default 800px width for everyday captures.',
  {
    path: z.string().optional().describe('Output file path (default: auto-generated in /tmp). Use .jpg extension for JPEG.'),
    format: z.enum(['jpeg', 'png']).optional().describe('Image format (default: auto-detect from path extension, or jpeg)'),
    platform: z.enum(['ios', 'android']).optional().describe('Target device platform. Defaults to the currently-connected CDP target platform.'),
    maxWidth: z.number().int().min(0).optional().describe('Downscale image so width does not exceed this many pixels. 0 disables resize. Default 800 (saves ~46% on iPhone 15/17 Pro screenshots without losing label readability).'),
    quality: z.number().int().min(1).max(100).optional().describe('JPEG compression quality (1-100). Only applied to .jpg/.jpeg files. Default 85.'),
  },
  createDeviceScreenshotHandler(getClient),
);

trackedTool(
  'device_snapshot',
  'Manage device sessions and capture UI snapshots. action=open starts a session (required before other device_ tools). action=snapshot returns the accessibility tree with @ref identifiers for device_press/device_fill. action=close ends the session. Use attachOnly=true on action=open to skip launching the app when it is already running (avoids relaunch-induced bundle races).',
  {
    action: z.enum(['open', 'close', 'snapshot']).default('snapshot').describe('open: start session for an app. snapshot: capture UI tree with element refs. close: end session.'),
    appId: z.string().optional().describe('App bundle ID — required for action=open (e.g. "com.example.app")'),
    platform: z.enum(['ios', 'android']).optional().describe('Target platform — used with action=open to select device'),
    sessionName: z.string().optional().describe('Session name override (default: auto-generated)'),
    attachOnly: z.boolean().optional().describe('action=open only: skip launching the app. Requires the app to be already running. Use when connecting to an already-active dev session to avoid bundle-load races.'),
  },
  createDeviceSnapshotHandler(),
);

trackedTool(
  'device_find',
  'Find a UI element by visible text and optionally interact with it. Use action="click" to tap, omit for find-only. Returns element ref for use with device_press/device_fill. Requires an open session. For overlapping labels (e.g. "Property damaged" vs "Property lost"), pass exact=true for strict match or index=N to pick the Nth candidate directly — both short-circuit AMBIGUOUS_MATCH. If AMBIGUOUS_MATCH still occurs, the result includes a candidates[] array with refs you can pass to device_press.',
  {
    text: z.string().describe('Visible text, accessibility label, or identifier to find'),
    action: z.string().optional().describe('Action to perform: "click" to tap, omit for search-only'),
    exact: z.boolean().optional().describe('Require exact label match (case-sensitive). Skips fuzzy matching entirely.'),
    index: z.number().int().min(0).optional().describe('Pick the Nth candidate (0-based) when multiple elements match. Short-circuits AMBIGUOUS_MATCH.'),
  },
  createDeviceFindHandler(),
);

trackedTool(
  'device_press',
  'Tap a UI element by its @ref from device_snapshot. Supports double-tap, repeated taps, long hold, and post-tap focus settle. Requires an open session.',
  {
    ref: z.string().describe('Element ref from device_snapshot (e.g. "e3" or "@e3")'),
    doubleTap: z.boolean().optional().describe('Use double-tap gesture'),
    count: z.number().int().min(1).max(50).optional().describe('Repeat tap N times (for rapid-fire interactions)'),
    holdMs: z.number().int().min(0).max(10000).optional().describe('Hold duration in ms (for long-press via ref)'),
    waitForFocusMs: z.number().int().min(0).max(5000).optional().describe('Sleep this many ms after tap to let keyboard focus settle — useful in sequential press+fill flows where focus would otherwise not propagate.'),
  },
  createDevicePressHandler(),
);

trackedTool(
  'device_fill',
  'Type text into an input field by its @ref from device_snapshot. Always re-taps the element first so keyboard focus is on the correct field even in sequential fills. On "no focused text input" errors, automatically falls back: Pressable→TextInput resolution (common RN design-system pattern where outer Pressable wraps inner TextInput) → coordinate re-tap + retry → Android adb input / iOS Maestro inputText. Check meta.fallbackUsed in the result to see which strategy succeeded. Requires an open session.',
  {
    ref: z.string().describe('Input field ref from device_snapshot (e.g. "e5" or "@e5")'),
    text: z.string().describe('Text to type into the field'),
    waitForKeyboardMs: z.number().int().min(0).max(5000).optional().describe('Wait between pre-tap and fill probe in ms (default 150). Bump to 500-1000ms when filling Pressable-wrapped TextInputs on slow keyboard animations to give RN native focus dispatch time to land.'),
    testID: z.string().optional().describe('Explicit testID for the JS-first fill path; resolved from the ref\'s cached snapshot identifier when omitted. Pass this when the ref is not a snapshot token.'),
  },
  createDeviceFillHandler(getClient),
);

trackedTool(
  'device_swipe',
  'Swipe on the device screen. Use direction for simple scrolling, or x1/y1/x2/y2 for precise coordinate-based swipes (drag-to-reorder, bottom sheets). Pass exact: true to require fast-runner (precise unclamped duration) — needed for momentum-sensitive UIs like UIDatePicker wheels where the agent-device daemon\'s safe-normalized 60ms cap causes overshoot. Requires an open session.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('Simple directional swipe (delegates to scroll)'),
    x1: z.number().optional().describe('Start X coordinate (use with y1, x2, y2 for precise swipes)'),
    y1: z.number().optional().describe('Start Y coordinate'),
    x2: z.number().optional().describe('End X coordinate'),
    y2: z.number().optional().describe('End Y coordinate'),
    durationMs: z.number().int().min(50).max(10000).optional().describe('Swipe duration in ms (slower = more precise, default ~300). Note: agent-device daemon caps at ~60ms via safe-normalized timing — use exact: true to bypass.'),
    count: z.number().int().min(1).max(50).optional().describe('Repeat swipe N times (incompatible with exact: true)'),
    pattern: z.enum(['one-way', 'ping-pong']).optional().describe('Repeat pattern: one-way (reset to start) or ping-pong (reverse direction). Incompatible with exact: true.'),
    exact: z.boolean().optional().describe('B123: REQUIRE fast-runner (no daemon fallback). Preserves user-supplied durationMs verbatim — needed for slow precise swipes on UIDatePicker wheels and similar momentum-sensitive UIs. Fails with EXACT_REQUIRES_FAST_RUNNER if fast-runner unavailable instead of silently degrading.'),
  },
  createDeviceSwipeHandler(),
);

trackedTool(
  'device_back',
  'Press the system back button (Android) or perform back navigation gesture (iOS). Requires an open session.',
  {},
  createDeviceBackHandler(),
);

trackedTool(
  'device_longpress',
  'Long press on an element or coordinates. Use for context menus, drag initiation, or hold-to-delete. Requires an open session.',
  {
    ref: z.string().optional().describe('Element ref from device_snapshot (uses press --hold-ms)'),
    x: z.number().optional().describe('X coordinate (use with y for coordinate-based long press)'),
    y: z.number().optional().describe('Y coordinate'),
    durationMs: z.number().int().min(100).max(10000).optional().describe('Hold duration in ms (default 1000)'),
  },
  createDeviceLongPressHandler(),
);

trackedTool(
  'device_scroll',
  'Scroll the screen in a direction. Smoother than device_swipe for list scrolling. Requires an open session.',
  {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.number().min(0).max(1).optional().describe('Scroll amount 0-1 (default ~0.5). 1 = full screen height/width.'),
  },
  createDeviceScrollHandler(),
);

trackedTool(
  'device_scrollintoview',
  'Scroll until a specific element becomes visible. Use for finding elements in long lists without knowing their position. Requires an open session.',
  {
    text: z.string().optional().describe('Visible text to scroll to'),
    ref: z.string().optional().describe('Element ref from device_snapshot to scroll to'),
  },
  createDeviceScrollIntoViewHandler(),
);

trackedTool(
  'device_pinch',
  'Pinch/zoom gesture on the screen. scale < 1 zooms out, scale > 1 zooms in. iOS simulator only. Requires an open session.',
  {
    scale: z.number().min(0.1).max(10).describe('Pinch scale factor (0.5 = zoom out 50%, 2.0 = zoom in 2x)'),
    x: z.number().optional().describe('Center X coordinate (default: screen center)'),
    y: z.number().optional().describe('Center Y coordinate (default: screen center)'),
  },
  createDevicePinchHandler(),
);

trackedTool(
  'device_permission',
  'Grant, revoke, reset, or query app permissions on simulator/emulator. Uses xcrun simctl privacy (iOS) and adb shell pm/dumpsys (Android). query returns current permission state (Android only — iOS returns "unknown"). Use before testing permission-gated flows to ensure correct starting state.',
  {
    action: z.enum(['grant', 'revoke', 'reset', 'query']).describe('grant: allow. revoke: deny. reset: restore default. query: check current state (Android: granted/denied/not_declared, iOS: unknown).'),
    permission: z.string().describe('Permission key: notifications, camera, microphone, location, location-always, photos, contacts, calendar, reminders, storage, all'),
    appId: z.string().describe('App bundle ID (e.g. "com.example.app")'),
    platform: z.string().optional().describe('Force platform: "ios" or "android". Auto-detected if omitted.'),
  },
  createDevicePermissionHandler(),
);

trackedTool(
  'device_reset_state',
  'One-shot preflight: revoke/reset permissions, clear MMKV storage keys, force-stop the app, then relaunch + reconnect CDP. Composes device_permission + cdp_mmkv + simctl/adb terminate+launch in one atomic call. Best-effort with per-step status — never silently rolls back. Sequence: permission → storage → terminate → launch → reconnect → helpers (→ optional nav_ready). On iOS, permission state is not queryable post-revoke (simctl limitation) — `ok: true` only means the shell-out exited 0. Returns { summary: {ok, failed, skipped}, steps: [...], reconnected, helpersInjected }.',
  {
    appId: z.string().describe('App bundle ID, e.g. "com.example.app".'),
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Auto-detected from booted devices if omitted.'),
    permissions: z.array(z.union([
      z.string(),
      z.object({ name: z.string(), action: z.enum(['revoke', 'reset']).optional() }),
    ])).optional().describe('Permissions to revoke/reset before relaunch. String shorthand defaults to revoke. Each entry is processed via device_permission.'),
    storageKeys: z.array(z.string()).optional().describe('MMKV keys to delete before terminate (so the app reads cleared values on next launch). Skipped if CDP is not connected.'),
    mmkvInstanceId: z.string().optional().describe('Forwarded to cdp_mmkv. Defaults to mmkv.default.'),
    relaunch: z.boolean().optional().describe('Launch the app after terminate. Default true.'),
    waitForReady: z.boolean().optional().describe('After relaunch, wait for CDP reconnect + helpers injection. Default true. Set false to return immediately and let the caller poll.'),
    waitForNavReady: z.boolean().optional().describe('After helpers, also wait for globalThis.__NAV_REF__ to expose a non-empty navigation state. Default false.'),
  },
  createDeviceResetStateHandler(getClient),
);

trackedTool(
  'device_deeplink',
  'Open a deep link or universal URL on the booted simulator/emulator. Cross-platform: wraps xcrun simctl openurl (iOS) and adb shell am start -a VIEW -d (Android). Session-less — no need to call device_snapshot action=open first. Use to enter the app at a specific route when cdp_navigate is unavailable (RN 0.83 Bridgeless mode) or for universal-link testing.',
  {
    url: z.string().describe('URL to open, e.g. "myapp://claims/new" or "https://example.com/page".'),
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Auto-detected from the active session or booted devices if omitted.'),
    packageName: z.string().optional().describe('(Android only) Explicit package/activity, e.g. "com.example/.MainActivity". Usually not needed — intent resolution picks the right app.'),
  },
  createDeviceDeeplinkHandler(),
);

trackedTool(
  'cdp_dismiss_dev_client_picker',
  'Dismiss the Expo Dev Client "Development servers" picker on demand. The picker is a native expo-dev-menu screen that blocks the JS bundle after deep links, restarts, permission changes, or clearState; this taps the configured Metro server entry so CDP/the bundle can proceed. Android only today (requires an open device session — call device_snapshot action="open" first). iOS returns an actionable manual-select message (cross-platform support tracked as a follow-up). Prefer this over a racy Maestro `runFlow when: visible: "DEVELOPMENT SERVERS"` block.',
  {
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Otherwise resolved from the active session or the booted device.'),
  },
  createDismissDevClientPickerHandler(),
);

trackedTool(
  'device_accept_system_dialog',
  'Tap an OS-level system dialog button (outside the app accessibility tree) — e.g. "Open in App?", "Allow notifications", biometric prompts. Runs via Maestro so the tap reaches SpringBoard (iOS) or SystemUI (Android). Tries common accept labels by default (Allow, OK, Open, Continue, Yes). Call immediately after a permission trigger or deep link is expected to surface a system prompt. Session-less.',
  {
    label: z.string().optional().describe('Specific button label to tap. Omit to try common defaults (Allow, OK, Open, Continue, Yes, Accept).'),
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Auto-detected from the active session or booted devices if omitted.'),
    timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Maestro invocation timeout (default 15000ms).'),
  },
  createDeviceAcceptSystemDialogHandler(),
);

trackedTool(
  'device_dismiss_system_dialog',
  'Tap an OS-level system dialog dismiss button — e.g. "Cancel", "Don\u2019t Allow", "Deny", "Not Now". Same mechanism as device_accept_system_dialog but for the negative action. Handles both ASCII and typographic apostrophes in "Don\u2019t Allow". Session-less.',
  {
    label: z.string().optional().describe('Specific button label to tap. Omit to try common defaults (Cancel, Don\u2019t Allow, Deny, No, Not Now).'),
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Auto-detected from the active session or booted devices if omitted.'),
    timeoutMs: z.number().int().min(1000).max(60000).optional().describe('Maestro invocation timeout (default 15000ms).'),
  },
  createDeviceDismissSystemDialogHandler(),
);

trackedTool(
  'device_record',
  'Cross-platform screen recording for proof captures. Wraps xcrun simctl io recordVideo (iOS) and adb shell screenrecord (Android), auto-pulls Android files to the host, converts to MP4 with faststart via ffmpeg. Three actions: action="start" begins a background recording (returns pid + output path + the deviceId actually used); action="stop" finalizes ALL active recordings (returns saved files; pass gif=true to also produce GIFs via ffmpeg); action="status" lists active recordings. Android caps at 180s per recording. iOS may stall on long captures via xcrun simctl. GH #173: when more than one simulator is booted (or more than one Android device connected), start refuses to auto-pick to avoid recording the wrong device — pass deviceId=<UDID|serial> to disambiguate; the response echoes the deviceId actually used so you can verify. Session-less.',
  {
    action: z.enum(['start', 'stop', 'status']).describe('start: begin recording. stop: finalize and save (all active recordings). status: list active recordings.'),
    platform: z.enum(['ios', 'android']).optional().describe('(start only) Force platform. Auto-detected from booted devices if omitted.'),
    outputPath: z.string().optional().describe('(start only) Absolute output path. Defaults to /tmp/rn-dev-agent-proof-<platform>-<timestamp>.mp4.'),
    deviceId: z.string().optional().describe('(start only) Explicit target identifier (iOS UDID or Android serial). Required when more than one device of the same platform is booted/connected — without it, start fails with code=DEVICE_AMBIGUOUS and lists the candidates. Auto-selected when exactly one device is available.'),
    gif: z.boolean().optional().describe('(stop only) When true, also convert each saved recording to GIF via ffmpeg.'),
    gifPath: z.string().optional().describe('(stop only) Override GIF output path. Defaults to the recording path with .gif extension.'),
  },
  createDeviceRecordHandler(),
);

trackedTool(
  'device_pick_value',
  'Select a value in a UIPickerView / Android picker wheel by tapping the target row. Works for any picker that exposes row labels via accessibility. If pickerTestId is provided, taps the picker open first. Known limitation: only works when the target value is already visible in the wheel window (scroll-to-visible is not yet implemented).',
  {
    value: z.string().describe('The visible row label to select (e.g. "Claim damages", "Male", "USD")'),
    pickerTestId: z.string().optional().describe('Optional testID of the picker itself — tapped first to ensure the picker is open.'),
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Auto-detected if omitted.'),
    timeoutMs: z.number().int().min(1000).max(120000).optional().describe('Maestro timeout (default 20000ms).'),
  },
  createDevicePickValueHandler(),
);

trackedTool(
  'device_pick_date',
  'Select a date in a UIDatePicker (wheels mode) / Android DatePicker. Parses YYYY-MM-DD or ISO 8601 and taps month name, day, and year in sequence. Known limitation: only wheels mode is supported — iOS 14+ inline calendar mode requires tapping calendar cells via device_find.',
  {
    date: z.string().describe('Target date — YYYY-MM-DD or full ISO 8601. Time component is ignored.'),
    pickerTestId: z.string().optional().describe('Optional testID of the date picker — tapped first to ensure the picker is open.'),
    platform: z.enum(['ios', 'android']).optional().describe('Force platform. Auto-detected if omitted.'),
    timeoutMs: z.number().int().min(1000).max(120000).optional().describe('Maestro timeout (default 20000ms).'),
  },
  createDevicePickDateHandler(),
);

trackedTool(
  'device_focus_next',
  'Move keyboard focus to the next input field by tapping the soft keyboard\'s Next/Return/Done/Go button. Use in multi-field form flows where sequential device_press + device_fill calls leave focus stuck on the first field. Requires an open session and a visible keyboard.',
  {},
  createDeviceFocusNextHandler(),
);

trackedTool(
  'device_batch',
  'Execute a sequence of UI interactions in ONE tool call. Eliminates LLM round-trip overhead. Steps: find/press/fill (testID OR text/ref), scroll/swipe (direction), back, wait (ms), hideKeyboard, snapshot, screenshot. Pass `testID` on find/press/fill for fresh fiber-tree resolution per step (eliminates stale-ref-across-step-transitions failures from cached refs). Fails fast on error unless step has optional=true OR continueOnError is true at the batch level.',
  {
    steps: z.array(z.object({
      action: z.enum(['find', 'press', 'fill', 'swipe', 'scroll', 'back', 'wait', 'hideKeyboard', 'snapshot', 'screenshot']).describe('Step action'),
      text: z.string().optional().describe('(find) Visible text to match. (fill) Text to type into the field.'),
      ref: z.string().optional().describe('(press/fill) Element ref from snapshot (e.g. "e5"). Beware: refs can go stale across step transitions; prefer testID for cross-step actions.'),
      testID: z.string().optional().describe('(find/press/fill) PREFERRED for known testIDs — re-resolves via snapshot at execution time, immune to layout-change drift. Slower per-step than ref (each call snapshots) but eliminates stale-ref failures across step transitions. When set, ignores text/ref.'),
      tap: z.boolean().optional().describe('(find) Tap the found element'),
      direction: z.enum(['up', 'down', 'left', 'right']).optional().describe('(scroll/swipe) Direction'),
      ms: z.number().optional().describe('(wait) Milliseconds to wait'),
      optional: z.boolean().optional().describe('Skip this step on failure instead of aborting'),
      timeoutMs: z.number().optional().describe('Per-step timeout override in ms. Default 15000.'),
    })).describe('Ordered list of UI interaction steps'),
    delayMs: z.number().default(300).describe('Delay between steps in ms (default 300)'),
    screenshotOn: z.enum(['none', 'failure', 'end', 'each']).default('failure').describe('When to capture screenshots'),
    continueOnError: z.boolean().default(false).describe('When true, a failed non-optional step is recorded but the batch continues. Result includes failure_count + failures array. Default false (fail-fast). Use for diagnostic batches where partial results > first-failure abort.'),
  },
  createDeviceBatchHandler(),
);

trackedTool(
  'cdp_auto_login',
  'Pre-flight check: detect if the app is on a login/auth screen and auto-login via Maestro subflows from the project. Scans .maestro/subflows/ for login.yaml, sign_in.yaml, auth.yaml, flow_start.yaml, register_user.yaml. Returns { loggedIn: true/false, reason, flow }. Call before proof capture or feature testing when app may be logged out.',
  {
    appId: z.string().optional().describe('App bundle ID override (auto-detected from app.json if omitted)'),
    platform: z.enum(['ios', 'android']).optional().describe('Platform override (auto-detected from session if omitted)'),
  },
  withConnection(getClient, async (args: { appId?: string; platform?: string }, client) => {
    const result = await handleAutoLogin(client, args);
    if (result === null) return failResult('CDP not connected or helpers not injected');
    if (result.loggedIn) return okResult(result);
    if (result.reason.includes('not on an auth screen')) return okResult(result);
    return warnResult(result, result.reason);
  }),
);

trackedTool(
  'proof_step',
  'Atomic proof capture step: navigate to a screen (optional), wait for settlement, verify an element (optional), and take a screenshot. Combines 3-4 tool calls into one. Use in proof flows to reduce tool-call overhead.',
  {
    screen: z.string().optional().describe('Screen to navigate to (omit to stay on current screen)'),
    params: z.record(z.unknown()).optional().describe('Navigation params (e.g. { id: "1" })'),
    waitMs: z.number().int().min(0).max(10000).default(1500).describe('Settlement wait in ms (default 1500)'),
    verifyText: z.string().optional().describe('Visible text to verify on screen (uses device_find)'),
    verifyTestID: z.string().optional().describe('testID to verify in component tree (uses cdp_component_tree)'),
    screenshotPath: z.string().optional().describe('Output path for screenshot (default: auto-generated)'),
    label: z.string().optional().describe('Label for this proof step (e.g. "After adding item to cart")'),
  },
  createProofStepHandler(getClient),
);

trackedTool(
  'maestro_run',
  'Execute a Maestro flow via maestro-runner. Pass flowPath for an existing .yaml file, or inlineYaml for ephemeral flows. Uses UIAutomator2 on Android and XCTest on iOS. Does NOT require CDP — works even when app is crashed or on native screens.',
  {
    flowPath: z.string().optional().describe('Path to a .yaml flow file to execute'),
    inlineYaml: z.string().optional().describe('Inline YAML flow content (written to /tmp and executed)'),
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detected from session)'),
    appId: z.string().optional().describe('App bundle ID (auto-detected from app.json)'),
    appFile: z.string().optional().describe('iOS only — path to a built .app/.ipa for maestro-runner to reinstall on clearState. Auto-resolved from the flow appId when omitted (GH#201).'),
    timeoutMs: z.number().int().min(5000).max(300000).default(120000).describe('Execution timeout in ms'),
    params: z.record(z.string(), z.string()).optional().describe('GH #116: parameter bindings forwarded as -e KEY=VALUE for ${KEY} placeholders in the flow. Keys must match /^[A-Z_][A-Z0-9_]*$/ (validated in the handler).'),
  },
  createMaestroRunHandler(),
);

trackedTool(
  'maestro_generate',
  'Generate a persistent Maestro YAML flow file from structured steps. Writes to .rn-agent/actions/<name>.yaml in the project root. Use after live verification to create reusable actions.',
  {
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
    outputDir: z.string().optional().describe('Output directory (default: <project>/.rn-agent/actions/). Pass an explicit path for non-default targets.'),
  },
  createMaestroGenerateHandler(),
);

trackedTool(
  'maestro_test_all',
  'Discover and run all Maestro flows in .rn-agent/actions/ as a regression suite. Returns per-flow pass/fail with durations. Use for CI or after refactoring to verify no regressions. Pass flowDir to override the default directory.',
  {
    platform: z.enum(['ios', 'android']).optional().describe('Target platform (auto-detected from session)'),
    flowDir: z.string().optional().describe('Directory to scan for .yaml flows (default: <project>/.rn-agent/actions/)'),
    pattern: z.string().optional().describe('Regex pattern to filter flow files (e.g. "cart|checkout")'),
    timeoutPerFlow: z.number().int().min(5000).max(300000).default(120000).describe('Timeout per flow in ms'),
    stopOnFailure: z.boolean().default(false).describe('Stop after first failure'),
  },
  createMaestroTestAllHandler(),
);

// M6 / Phase 112 (D669): Object.freeze test recorder.
trackedTool(
  'cdp_record_test_start',
  'Start recording UI interactions via Object.freeze interceptor. Captures taps, long-presses, text input, submits, and scroll-derived swipes from the running app — no app changes required. Requires __DEV__=true (release builds pre-freeze props at bundle time). Pair with cdp_record_test_stop and cdp_record_test_generate to produce Maestro YAML or Detox JS.',
  {},
  createRecordTestStartHandler(getClient),
);

trackedTool(
  'cdp_record_test_stop',
  'Stop recording, deduplicate consecutive type/tap bursts, freeze the buffer, and return event count + per-type breakdown. Sets `truncated: true` when the 500-event cap was hit. Recorded events stay in MCP memory for cdp_record_test_generate / cdp_record_test_save until the next start.',
  {},
  createRecordTestStopHandler(getClient),
);

trackedTool(
  'cdp_record_test_generate',
  'Render the stored recording as replayable test code. Formats: maestro (YAML, primary), detox (JS). Appium returns NOT_IMPLEMENTED — file an issue if you need it. Requires a recording in memory (call start/stop or load first). Pass id/intent/tags/mutates/status to emit the M7 metadata header (D1203) into the YAML so the result is a first-class reusable action.',
  {
    format: z.enum(['maestro', 'detox', 'appium']).describe('Output format'),
    testName: z.string().optional().describe('Name shown in describe()/comment header'),
    bundleId: z.string().optional().describe('App bundle ID for the Maestro appId header'),
    id: z.string().optional().describe('M7 action id (stable slug). When set, emitted as `# id: <slug>` header line. Default: filename without `.yaml`.'),
    intent: z.string().optional().describe('M7 one-line goal. When set, emitted as `# intent: <intent>` header line.'),
    tags: z.array(z.string()).optional().describe('M7 filterable tags. When set, emitted as `# tags: [a, b, c]`.'),
    mutates: z.boolean().optional().describe('M7 side-effect flag. When set, emitted as `# mutates: true|false`.'),
    status: z.enum(['experimental', 'active', 'deprecated']).optional().describe('M7 lifecycle status. When set, emitted as `# status: <status>`.'),
  },
  createRecordTestGenerateHandler(),
);

trackedTool(
  'cdp_record_test_annotate',
  'Push a human-readable note into the live event stream — appears as a comment in generated tests. Useful for marking flow checkpoints ("reached checkout", "error appeared"). Only valid during an active recording.',
  {
    note: z.string().min(1).describe('Annotation text'),
  },
  createRecordTestAnnotateHandler(getClient),
);

trackedTool(
  'cdp_record_test_save',
  'Persist current recording events to <projectRoot>/.rn-agent/recordings/<filename>.json. Filename is sanitized (only [a-zA-Z0-9_-] kept). Use cdp_record_test_load to restore later for re-generation in a different format.',
  {
    filename: z.string().min(1).describe('Recording name (without .json — sanitized)'),
  },
  createRecordTestSaveHandler(getClient),
);

trackedTool(
  'cdp_record_test_load',
  'Restore a previously-saved recording from <projectRoot>/.rn-agent/recordings/. Replaces any in-memory events. After loading, call cdp_record_test_generate to render in any format.',
  {
    filename: z.string().min(1).describe('Recording name (without .json)'),
  },
  createRecordTestLoadHandler(getClient),
);

trackedTool(
  'cdp_record_test_list',
  'List saved recordings under <projectRoot>/.rn-agent/recordings/. Returns the directory path and an array of recording names (without .json extension), sorted alphabetically.',
  {},
  createRecordTestListHandler(getClient),
);

trackedTool(
  'cdp_restart',
  'In-process soft state reset. Disconnects the current CDP client, creates a fresh instance, and reconnects. Clears console/network/error ring buffers, background poll, reconnect state, and helpers-injected flag. Does NOT reload the MCP server binary — to load new dist/ after npm run build, fully quit and relaunch Claude Code. Pass hardReset=true to also kill the fast-runner xcodebuild rig and terminate+relaunch the target app via simctl — recovers from the "JS thread paused / app backgrounded" wedge (B154 shape) without requiring a manual /reload-plugins. Useful for recovering from stuck connection state (target drift, stale helpers after many reloads) without losing the CC session.',
  {
    metroPort: z.number().optional().describe('Override Metro port for reconnection (default: keep current)'),
    platform: z.string().optional().describe('Platform filter for reconnection (e.g. "ios", "android")'),
    hardReset: z.boolean().optional().describe('Also kill fast-runner + simctl terminate+launch the connected bundle before reconnecting. iOS only for now. Use when the JS thread is paused (B154 shape).'),
    bundleId: z.string().optional().describe('Manual bundleId override for hardReset (e.g. "com.example.app"). Use when the previous restart left the connectedTarget null and the module-cached bundleId is also missing.'),
  },
  createRestartHandler(getClient, setClient, createClient),
);

trackedTool(
  'cross_platform_verify',
  'Compare UI elements across iOS and Android. Reads cached accessibility snapshots from both platforms (populated by device_snapshot) and checks which elements are present on each. Workflow: test on iOS → device_snapshot → switch to Android → device_snapshot → cross_platform_verify. Supports auto-discovery of testIDs from source via scanDir. Returns a per-element comparison table with PASS/FAIL verdict.',
  {
    elements: z.array(z.string()).optional().describe('List of testIDs or labels to check on both platforms. Optional if scanDir is provided.'),
    scanDir: z.string().optional().describe('Directory to scan for testID="..." props in .tsx/.jsx/.ts/.js files. Auto-discovers elements. Merges with elements[] if both provided.'),
    matchBy: z.enum(['testID', 'label', 'any']).default('any').describe('Match strategy: testID (exact identifier match), label (substring in accessibility label), any (try both)'),
  },
  createCrossPlatformVerifyHandler(),
);

trackedTool(
  'cdp_open_devtools',
  'Report the React Native DevTools frontend URL for the live app + start a multiplexer proxy so DevTools can coexist with the MCP session on RN < 0.85 (RN >= 0.85 uses native multi-debugger). The proxy auto-resumes across reconnects. Returns { devtoolsUrl, inspectorWsUrl, hermesWsUrl, mode: "native" | "proxy-active", proxyPort, supportsMultipleDebuggers, rnVersion, guidance }.',
  {},
  createOpenDevToolsHandler(getClient),
);

trackedTool(
  'cdp_metro_events',
  'Read Metro reporter events (bundle_build_started, bundle_build_done, bundle_build_failed, reloads) captured since the MCP connected. The MetroEventsClient attaches a second WebSocket alongside CDP, giving push-based visibility into bundler state — watch for build errors without having to read console.error. Returns { eventsConnected, lastBuild, buildErrors, events, count }. Pass `clearErrors: true` to reset the build-error counter.',
  {
    limit: z.number().int().min(1).max(100).default(20).describe('Max entries to return (default 20, max 100)'),
    type: z.string().optional().describe('Filter by event type (e.g. "bundle_build_failed")'),
    clearErrors: z.boolean().default(false).describe('Reset the build-error counter without reading events'),
  },
  createMetroEventsHandler(getClient),
);

// D1206 Tier 2 Sprint B / Phase 126 — Macro-Asserts.
// State-assertive primitives that wrap CDP introspection with assertion
// semantics. The differentiated capability over Maestro Cloud / KaneAI /
// BrowserStack — visual-only test runners cannot read Redux state or
// navigation params mid-flow.

trackedTool(
  'expect_redux',
  'Assert against Redux/Zustand store state at a path. Returns ok when the assertion matches; failResult with code=ASSERTION_FAILED when it does not. Operators (compose with AND): equals (deep), exists (default if no other op), notExists, length (array/string), contains (array), gt/lt/gte/lte (numbers). Pass timeoutMs to retry until match — useful when the store updates asynchronously after a tap. Differentiated capability over Maestro: Maestro asserts pixels; this asserts internal state.',
  {
    path: z.string().describe('Dot-path into the store, e.g. "cart.items" or "auth.user.id". Required.'),
    storeType: z.string().optional().describe('Restrict to a specific store ("redux" | "zustand" | a Zustand store name). Default: auto-detect.'),
    equals: z.unknown().optional().describe('Deep-equal against this value.'),
    exists: z.boolean().optional().describe('When true, value must be defined and non-null. When false, value must be undefined or null. Implicit default if no other operator is supplied.'),
    notExists: z.boolean().optional().describe('Inverse of exists.'),
    length: z.number().int().optional().describe('Asserts (Array | string).length === this number.'),
    contains: z.unknown().optional().describe('Asserts an array contains this element (deep-equal).'),
    gt: z.number().optional().describe('Asserts actual > this number.'),
    lt: z.number().optional().describe('Asserts actual < this number.'),
    gte: z.number().optional().describe('Asserts actual >= this number.'),
    lte: z.number().optional().describe('Asserts actual <= this number.'),
    timeoutMs: z.number().int().min(0).optional().describe('Polling timeout in ms (default 0 = no retry). Useful for async state updates.'),
  },
  createExpectReduxHandler(getClient),
);

trackedTool(
  'expect_route',
  'Assert against the navigation state — current route name, current route params, or a route\'s presence in the stack. Returns ok when the assertion matches; failResult with code=ASSERTION_FAILED otherwise. Differentiated capability over Maestro: Maestro doesn\'t know what route you\'re on, only what\'s rendered. Pass timeoutMs to retry through navigation animations.',
  {
    name: z.string().optional().describe('Asserts the current top-of-stack route name === this.'),
    paramsEquals: z.unknown().optional().describe('Asserts deep-equal against the current route params object.'),
    inStack: z.string().optional().describe('Asserts a route with this name exists somewhere in the stack (not necessarily current).'),
    timeoutMs: z.number().int().min(0).optional().describe('Polling timeout in ms (default 0). Use 1000-2000 to wait through navigation animations.'),
  },
  createExpectRouteHandler(getClient),
);

trackedTool(
  'expect_visible_by_testid',
  'Assert that an element with a given testID is (or is not) currently rendered in the device accessibility tree. Snapshot-based — re-resolves on each retry. Pass exists=false to assert NOT visible. Pass timeoutMs to wait through animations / late mounts. Convenience wrapper over device_snapshot + manual scan.',
  {
    testID: z.string().describe('The testID to look for in the accessibility tree.'),
    exists: z.boolean().optional().describe('Default true (assert visible). Pass false to assert NOT visible.'),
    timeoutMs: z.number().int().min(0).optional().describe('Polling timeout in ms (default 0). Use 1000-3000 for late-mounted elements.'),
  },
  createExpectVisibleByTestIDHandler(),
);

trackedTool(
  'expect_text',
  'Assert that visible text is (or is not) currently rendered in the device accessibility tree. Default substring match; pass exact=true for full-string match. Pass exists=false to assert NOT visible. Convenience wrapper over device_snapshot + label scan; equivalent to Maestro\'s assertVisible: "..." but callable mid-batch and during interactive walks without leaving the LLM context.',
  {
    text: z.string().describe('The visible text to look for.'),
    exact: z.boolean().optional().describe('Default false (substring match). Pass true to require exact label equality.'),
    exists: z.boolean().optional().describe('Default true (assert visible). Pass false to assert NOT visible.'),
    timeoutMs: z.number().int().min(0).optional().describe('Polling timeout in ms (default 0).'),
  },
  createExpectTextHandler(),
);

// D1206 Tier 2 Sprint D-2 / Phase 130 — L2→L3 auto-emission. After an
// interactive walk completes, this turns the recorder buffer into a
// first-class L3 reusable action: emits Maestro YAML with full M7
// metadata header at <project>/.rn-agent/actions/<id>.yaml AND
// initialises the sidecar runtime state. Closes the L2→L3 loop.

trackedTool(
  'cdp_record_test_save_as_action',
  'Promote the in-memory recording (started via cdp_record_test_start) into a first-class L3 reusable action. Writes Maestro YAML with full M7 metadata header (id, intent, tags, mutates, status, produces) to <project>/.rn-agent/actions/<id>.yaml and initialises the sidecar runtime state. Status defaults to "experimental" — first clean /run-action replay auto-promotes to "active". Refuses if the id already exists unless overwrite=true. Distinct from cdp_record_test_save (which writes JSON to .rn-agent/recordings/) — that is for raw event archival; this is for shipping the recording as a replayable action. The optional `produces` field (D1209) records state postconditions — what state the action establishes when it runs cleanly — so downstream tasks can use it as a deterministic prologue.',
  {
    id: z.string().describe('Stable slug; becomes the filename and the M7 id field. Lower-case kebab-case (a-z, 0-9, hyphen).'),
    intent: z.string().describe('One-line goal — surfaced verbatim by /list-learned-actions. Required.'),
    tags: z.array(z.string()).optional().describe('Lower-case kebab-case keywords for filtering (e.g. ["tasks", "create", "regression"]).'),
    mutates: z.boolean().optional().describe('Does this flow leave persistent residue (created rows, toggled settings)? Required for /run-action safety pre-flight to know whether to confirm before replay.'),
    status: z.enum(['experimental', 'active', 'deprecated']).optional().describe('M7 lifecycle status. Default: experimental (auto-promotes on first clean replay).'),
    bundleId: z.string().optional().describe('App bundle ID for the Maestro appId header. Strongly recommended — /run-action uses it to refuse cross-app replays.'),
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    overwrite: z.boolean().optional().describe('If an action with this id already exists, replace it. Default false (refuse with hint).'),
    testName: z.string().optional().describe('Optional one-line description shown as a comment above the M7 header. Falls back to intent.'),
    produces: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('D1209 — state postconditions this action establishes when it runs cleanly. Flat map of primitive values for hybrid composition (e.g. { authenticated: true, route: "home" }). Optional. Values containing commas or newlines are not supported; use multiple keys instead.'),
  },
  createSaveAsActionHandler(),
);

// D1206 Tier 2 Sprint D / Phase 129 — L3→L2 self-repair. When a Maestro
// flow fails with "element not found", this tool patches the YAML in place
// using fuzzy matching against the current device snapshot. Drives the
// "self-recoverable on UI changes" L3 promise in D1206.

trackedTool(
  'cdp_repair_action',
  'Self-repair an L3 reusable action whose Maestro replay failed with SELECTOR_NOT_FOUND. Loads the action from .rn-agent/actions/<actionId>.yaml, snapshots the live device, fuzzy-matches the failed testID against current testIDs (Levenshtein-based), and patches the YAML in place. Guardrails: refuses if a human edited the YAML since the agent last wrote (mtime check), refuses if the rolling-24h repair budget is exhausted (3 attempts/24h). On success, bumps revision, demotes status to "experimental" until the next clean replay re-validates, and appends a RepairRecord to the sidecar. Pass dryRun=true to preview the diff without writing.',
  {
    actionId: z.string().describe('Action id matching <projectRoot>/.rn-agent/actions/<actionId>.yaml.'),
    failedSelector: z.string().describe('The testID that the prior maestro_run reported as missing. Parse it from stderr like "Element with id \'X\' not found" → X.'),
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    threshold: z.number().min(0).max(1).optional().describe('Fuzzy-match similarity threshold (0..1). Default 0.6. Lower if the screen has many similar testIDs and Levenshtein on the original is too strict.'),
    dryRun: z.boolean().optional().describe('Don\'t write changes — return the diff that WOULD be applied. Useful for previewing repairs before committing.'),
    agentReasoning: z.string().optional().describe('Free-form one-liner the agent records in the RepairRecord. Helps audit "why did this repair happen". Max ~200 chars recommended.'),
  },
  createRepairActionHandler(),
);

// Issue #104 — auto-repair-aware action replay. Wraps maestro_run with
// stderr classification + cdp_repair_action retry on SELECTOR_NOT_FOUND.
trackedTool(
  'cdp_run_action',
  'Replay a learned action by id with end-to-end auto-repair. Loads the action from .rn-agent/actions/<actionId>.yaml, runs the Maestro flow, and on a SELECTOR_NOT_FOUND failure automatically invokes cdp_repair_action and retries once. Appends a RunRecord to the sidecar with full auto-repair telemetry (passed/failed/refused/skipped + diff). The repair attempt counts toward cdp_repair_action\'s 24h budget. Pass autoRepair=false to opt out of auto-repair (returns the raw maestro_run failure verbatim). forceReload defaults true: any human edit to the YAML since the agent\'s last write is acknowledged as the new baseline so downstream repair does not abort with STALE_TARGET (the right default for active composition). Pass forceReload=false for the strict "respect offline human edits" behavior. The orchestrated home for the L3 self-healing loop — prefer this over invoking maestro_run + cdp_repair_action manually for any flow you intend to re-run on schedule.',
  {
    actionId: z.string().describe('Action id matching <projectRoot>/.rn-agent/actions/<actionId>.yaml.'),
    projectRoot: z.string().optional().describe('Override project root (default: process.cwd()).'),
    platform: z.enum(['ios', 'android']).optional().describe('Force a specific platform; otherwise auto-detected from the active device session.'),
    autoRepair: z.boolean().optional().describe('Auto-repair on SELECTOR_NOT_FOUND failures. Default true. Pass false to disable (e.g. when investigating a failure manually).'),
    timeoutMs: z.number().optional().describe('Maestro execution timeout per attempt (ms). Default 120_000.'),
    trigger: z.enum(['agent', 'ci', 'human']).optional().describe('RunRecord trigger annotation. Default "agent". CI calls should pass "ci".'),
    forceReload: z.boolean().optional().describe('GH #173: when true (default), acknowledge any human edit to the YAML as the new baseline before running so downstream repair does not abort with STALE_TARGET. Pass false for the strict Phase 129 "respect external edits" behavior (useful for CI replays of fixed baselines).'),
    params: z.record(z.string(), z.string()).optional().describe('Parameter bindings for the action\'s ${VAR} placeholders, forwarded to maestro as -e KEY=VALUE on the first attempt AND the post-repair retry (GH #116). Keys must match /^[A-Z_][A-Z0-9_]*$/ (validated in maestro_run).'),
  },
  // GH #186: supply a CDP-backed live-route reader so the route-drift guard is
  // actually active. Without this the handler defaulted getLiveRoute to a no-op
  // and the drift branch could never fire, silently routing screen-change
  // failures into fuzzy selector repair.
  createRunActionHandler({ getLiveRoute: () => readLiveRoute(getClient()) }),
);

// B76/D644: unified process-lifecycle shutdown. All termination signals + stdin.end
// funnel into this graceful path so the 5s background-poll setInterval in
// reconnection.ts (the zombie cause) is cleared on every exit.
const shutdown = buildGracefulShutdown({ getClient, stopFastRunnerFn: stopFastRunner });

process.on('uncaughtException', (err: Error) => {
  logger.error('MCP', `Uncaught exception: ${err.message}`);
  void shutdown(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn('MCP', `Unhandled rejection (non-fatal): ${msg}`);
});

process.on('SIGTERM', () => { logger.info('MCP', 'SIGTERM'); void shutdown(0); });
process.on('SIGINT',  () => { logger.info('MCP', 'SIGINT');  void shutdown(0); });
process.on('SIGHUP',  () => { logger.info('MCP', 'SIGHUP');  void shutdown(0); });
// SIGUSR2: hot-reload intent — exit 1 signals a supervisor to respawn. Today CC
// doesn't auto-respawn MCP subprocesses (B76 notes) so this is the clean-exit path
// for future supervisor wiring. Developers should use cdp_restart for in-session reset.
// NOTE: we deliberately avoid SIGUSR1 here because Node reserves it for the built-in
// inspector — running the MCP under `node --inspect` would both start the debugger
// AND trigger our shutdown. SIGUSR2 is collision-free.
process.on('SIGUSR2', () => { logger.info('MCP', 'SIGUSR2 — hot-reload intent'); void shutdown(1); });

// stdin.end is the primary zombie-prevention path: CC closes the stdio pipe on quit
// without sending SIGTERM, and the 5s bgPoll interval would keep the event loop alive
// forever. Explicitly shut down on stdin EOF. The listener itself is registered early
// (passive — doesn't flip stdin into flowing mode); StdioServerTransport flips the
// stream inside transport.start() when server.connect() runs, so 'end' fires reliably.
process.stdin.on('end', () => { logger.info('MCP', 'stdin closed — host disconnected'); void shutdown(0); });

// GH #182: belt-and-suspenders host-death detection + lock heartbeat. stdin-EOF +
// signals can silently fail to fire when CC dies abnormally (SIGKILL/crash/window
// close on macOS) without closing the child's stdin — leaving a LIVE orphan that
// holds the single-instance lock for up to 24h (the PID-alive reclaim can't catch a
// live process). Poll getppid(): on orphan (PPID changed from startup → parent died
// + reparented) self-exit + release. On a live parent, refresh the lock heartbeat —
// and if touch() reports we were usurped (a contender reclaimed our slot while the
// laptop slept, then we woke), self-terminate so we don't run as a second bridge on
// the same device. Unref'd timer — never keeps a should-be-dead process alive.
const stopParentWatch = startParentDeathWatch({
  onOrphaned: () => { logger.info('MCP', 'parent host gone (PPID changed) — exiting'); void shutdown(0); },
  onHeartbeat: () => {
    try {
      if (lockfile && !lockfile.touch()) {
        logger.info('MCP', 'single-instance lock was reclaimed by another bridge — exiting');
        void shutdown(0);
      }
    } catch { /* best-effort heartbeat */ }
  },
});
process.on('exit', () => stopParentWatch());

async function main() {
  logger.info('MCP', `Starting rn-dev-agent-cdp v0.9.1 (log level: ${logger.level})`);
  if (logger.logFilePath) {
    logger.info('MCP', `Log file: ${logger.logFilePath}`);
  }
  logger.debug('MCP', `CWD: ${process.cwd()}, CLAUDE_USER_CWD: ${process.env.CLAUDE_USER_CWD ?? 'not set'}`);
  logger.debug('MCP', `Node: ${process.version}, ANDROID_HOME: ${process.env.ANDROID_HOME ?? 'not set'}`);

  const transport = new StdioServerTransport();
  logger.info('MCP', 'StdioServerTransport created, connecting...');
  await server.connect(transport);
  logger.info('MCP', 'MCP server connected and ready');
}

main().catch((err) => {
  logger.error('MCP', `Fatal error: ${err instanceof Error ? err.message : err}`);
  if (logger.logFilePath) {
    console.error(`CDP bridge log: ${logger.logFilePath}`);
  }
  stopFastRunner();
  process.exit(1);
});
