export interface CDPMessage {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface HermesTarget {
  id: string;
  title: string;
  vm: string;
  webSocketDebuggerUrl: string;
  description?: string;
  type?: string;
  platform?: 'ios' | 'android';
  /**
   * Metro /json/list includes this field for RN 0.76+. It disambiguates
   * iOS vs Android when the same bundleId is installed on both (B131/D660).
   */
  deviceName?: string;
  /**
   * B116 (D639): set true when the bundleId is installed on BOTH iOS sim AND
   * Android emulator and neither inference source could disambiguate. Callers
   * should pass `targetId` or `bundleId + platform` for exact selection.
   */
  ambiguousPlatform?: boolean;
}

export interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: string;
}

export interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  timestamp: string;
  status?: number;
  duration_ms?: number;
  bodyAvailable?: boolean;
  bodySize?: number;
}

export interface ErrorEntry {
  message: string;
  stack?: string;
  isFatal?: boolean;
  type?: string;
  timestamp: string;
}

export interface LogEntry {
  source: string;
  level: string;
  text: string;
  timestamp: string;
  url?: string;
  lineNumber?: number;
}

export type CDPClientState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface StatusResult {
  metro: {
    running: boolean;
    port: number | null;
    /** M5 (D656): true when the MetroEventsClient has an open WS to Metro's /events endpoint. */
    eventsConnected?: boolean;
    /** M5 (D656): most recent bundle build status + timestamp (null if no events seen yet). */
    lastBuild?: { status: 'started' | 'done' | 'failed'; timestamp: string } | null;
    /** M5 (D656): count of bundle_build_failed events observed since MCP connected. */
    buildErrors?: number;
    /**
     * B129 (D658): reason the events stream is unusable on this Metro, if any.
     * `"expo-cli-incompatible"` means Expo CLI is serving the manifest
     * protocol at /events instead of Metro's reporter stream. When present,
     * `eventsConnected` will be false and no events will ever arrive.
     */
    eventsReason?: 'expo-cli-incompatible' | null;
  };
  cdp: {
    connected: boolean;
    device: string | null;
    pageId: string | null;
    platform: string | null;
    /** B111 (D643): target.description (bundleId from Metro) — surfaces which app the MCP attached to. */
    bundleId: string | null;
  };
  app: {
    platform: string | null;
    dev: boolean | null;
    hermes: boolean | null;
    rnVersion: string | null;
    dimensions: { width: number; height: number } | null;
    hasRedBox: boolean;
    isPaused: boolean;
    errorCount: number;
    /** M10 / Phase 110: RN architecture — 'new' (Fabric), 'old' (classic bridge), 'unknown' (probe failed or non-RN). Optional for older callers. */
    architecture?: 'new' | 'old' | 'unknown';
  };
  capabilities: {
    networkDomain: boolean;
    fiberTree: boolean;
    networkFallback: boolean;
    bridgeDetected: boolean;
    bridgeVersion: number | null;
    /** M1 (D654): true when RN >= 0.85 supports native multi-debugger (DevTools + MCP can coexist without proxy). */
    supportsMultipleDebuggers: boolean;
    /**
     * D1202: explicit __RN_AGENT helpers status. true when the helper bundle
     * is loaded into Hermes; false during the post-launch race window or when
     * the JS world is hung. /doctor and `cdp_status` callers should treat
     * false as "JS-tier tools (cdp_*) won't work — fall back to device_* or
     * cdp_reload."
     */
    helpersInjected: boolean;
  };
  domains: {
    runtime: boolean;
    debugger: boolean;
    network: boolean;
    log: boolean;
    profiler: boolean;
    heapProfiler: boolean;
  };
  reconnect: {
    active: boolean;
    lastAttempt: string | null;
    attemptCount: number;
  };
  /** Spec 2026-06-10-debugger-seat-optout: resolved autoConnect mode and its source. */
  // keep in sync with AutoConnectResolution (project-config.ts)
  autoConnect?: {
    enabled: boolean;
    source: 'env' | 'config' | 'default';
  };
  /** GH#264 Phase 5: supervision facts the supervisor sets via env at each worker spawn. */
  bridge?: {
    supervised: boolean;
    workerRestarts: number;
    lastWorkerExit: string | null;
  };
  /**
   * #210: iOS device-session visibility. `sessionOpen` is whether a device session
   * has been opened; `rnFastRunner` is the XCUITest runner's liveness (only probed
   * when an iOS session is open — `dead` otherwise, never misreported as down when
   * simply never started). `foreignRunner.detected` means a Maestro/WDA flow currently
   * owns the device. iOS-focused; on Android `rnFastRunner` is always `'dead'` (the iOS
   * runner is never used). Always populated by buildStatusResult.
   */
  deviceSession?: {
    sessionOpen: boolean;
    rnFastRunner: 'alive' | 'stale' | 'dead';
    appId?: string;
    deviceId?: string;
    foreignRunner?: { detected: true };
  };
  /**
   * M1b (Phase 100+): multiplexer proxy state. `active: true` means React Native
   * DevTools can coexist with the MCP by connecting to `port` on localhost.
   * `consumerCount` is the number of DevTools/other-debugger instances connected
   * to the proxy (excluding the MCP itself).
   */
  proxy: {
    active: boolean;
    port: number | null;
    url: string | null;
    consumerCount: number;
  };
}

export interface EvaluateResult {
  value?: unknown;
  error?: string;
}

export type ToolErrorCode =
  | 'STALE_TARGET'
  | 'HELPERS_STALE'
  | 'RECONNECT_TIMEOUT'
  | 'APP_DETACHED'              // GH #208 (RC2/RC3): Metro up but 0 Hermes targets (app detached)
  | 'APP_NOT_INSTALLED'         // GH #262: relaunch failed and get_app_container confirms the bundle is missing
  | 'NOT_CONNECTED'
  | 'HELPERS_NOT_INJECTED'
  // M6 / Phase 112 (D669): cdp_record_test_* tool family.
  | 'DEV_MODE_REQUIRED'
  | 'EVAL_FAILED'
  | 'BAD_RESPONSE'
  | 'START_FAILED'
  | 'NO_EVENTS'
  | 'NOT_IMPLEMENTED'
  | 'NOT_RECORDING'
  | 'NO_PROJECT_ROOT'
  | 'BAD_FILENAME'
  | 'LOAD_FAILED'
  | 'BAD_RECORDING'
  // GH #60 Feature-c (D687): device_reset_state composite tool.
  | 'DEVICE_RESET_INVALID_ARGS'
  | 'DEVICE_RESET_STATE_PARTIAL'
  | 'DEVICE_RESET_RECONNECT_FAILED'
  | 'CDP_NOT_CONNECTED'
  // CDP tool review batch 2026-04-29.
  | 'CDP_TARGET_APP_MISMATCH'   // CDP-003
  | 'INVALID_PLATFORM'          // CDP-014
  | 'PROFILER_UNAVAILABLE'      // CDP-007
  | 'NATIVE_LOG_UNAVAILABLE'    // CDP-016
  // D1206 Tier 2 Sprint A/B post-review batch 2026-04-30.
  | 'TESTID_NOT_FOUND'          // device_batch testID-keyed step / expect_visible_by_testid
  | 'ASSERTION_FAILED'          // expect_redux / expect_route / expect_text / expect_visible_by_testid
  | 'SNAPSHOT_FAILED'           // agent-device snapshot returned ok:false (distinct from "not present")
  | 'RN_FAST_RUNNER_DOWN'       // #210: iOS rn-fast-runner not running and could not be auto-spawned (not prebuilt / no device)
  | 'RN_ANDROID_RUNNER_DOWN'    // #243: rn-android-runner not reachable (cold-start race / can't bind port)
  | 'SCREENSHOT_FAILED'         // rn-android-runner screenshot response missing pngBase64 payload
  | 'PATH_NOT_FOUND'            // expect_redux when getStoreState surfaces __agent_error
  | 'STORE_TRUNCATED'           // expect_redux when store payload exceeded safeStringify cap
  // Phase 134.2: appId / packageName validation at adb shell boundary.
  | 'INVALID_APPID'             // device_permission
  | 'DEVICE_RESET_INVALID_APPID' // device_reset_state
  | 'INVALID_PACKAGE_NAME'      // device_deeplink
  | 'INVALID_BUNDLE_ID'         // GH #262 codex-pair: cdp_restart explicit bundleId arg failed strict validation
  // GH #105 / B153: cdp_repair_action's snapshot landed on Agent Device Runner.
  | 'RUNNER_LEAK'
  // GH #105 / iOS-MVP §3.1: runIOS press/fill with a @ref no longer in the
  // ref-map (snapshot is stale / UI re-rendered). Caller must device_snapshot
  // to refresh refs, then retry.
  | 'STALE_REF'
  // Audit B5: cross_platform_verify verdict FAIL (elements differ across
  // platforms) — distinct from the partial-coverage missing-snapshot warning.
  | 'CROSS_PLATFORM_MISMATCH'
  // GH #184: cdp_status aborted fast because the Dev Client picker was blocking
  // the bundle (React unreachable on a non-Hermes target within the budget).
  | 'PICKER_BLOCKING'
  // GH #186: cdp_run_action replay hit structural route-drift (live route off
  // the action's expectedRouteSequence) — distinct from a stale selector.
  | 'ROUTE_DRIFT'
  // GH #136: cdp_dismiss_dev_client_picker called with no active device session.
  | 'DEV_CLIENT_PICKER_NO_SESSION'
  // GH #202 Phase 2a: DeviceSessionArbiter refused an op because an exclusive
  // Maestro flow is in flight (or the requesting op is a flow and another op is
  // active). Refuse-fast, never queue.
  | 'BUSY_FLOW_ACTIVE'
  // GH#186 Phase 6: a FOREIGN Maestro/XCUITest session holds the flow plane
  // (UDID-scoped detection). L2/L3 refuse fast; L1 reads stay free.
  | 'BUSY_FOREIGN_FLOW'
  // GH #191: native fill + retype + maestro all failed to produce the expected value.
  | 'TEXT_ENTRY_UNVERIFIED';

export interface ResultEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: ToolErrorCode;
  truncated?: boolean;
  meta?: Record<string, unknown>;
}

export interface SessionState {
  name: string;
  platform?: string;
  deviceId?: string;
  openedAt: string;
  /**
   * B35: bundleId saved at session-open time. Used by runner-leak-recovery to
   * close+reopen the session when the agent-device daemon misroutes commands
   * to AgentDeviceRunner instead of the target app on iOS.
   */
  appId?: string;
}

export interface FastRunnerState {
  port: number;
  pid: number;
  deviceId: string;
  bundleId: string;
  startedAt: string;
}
