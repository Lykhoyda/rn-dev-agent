// src/observability/live-device.ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyFamily } from './events.js';
import type { MirrorTargetResolution } from './mirror/target.js';

/**
 * GH #206: does THIS tool call change on-screen state (→ trigger a live
 * /observe refresh)? Derived from events.ts families — all INTERACTION-family
 * tools plus cdp_navigate. Read-only NAVIGATION tools (cdp_navigation_state,
 * cdp_nav_graph) are excluded: reads change nothing.
 *
 * `device_find` is special: it is INTROSPECTION (search) by default, but
 * `device_find({ action: 'click' })` taps the match — a real state change. So
 * the decision is per-CALL (depends on args), which is why callers pass the
 * tool's args (PR #296 review P2).
 */
export function isStateMutating(tool: string, args?: Record<string, unknown>): boolean {
  if (FLOW_MUTATION_TOOLS.has(tool)) return true;
  if (classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate') return true;
  if (tool === 'device_find' && args?.action === 'click') return true;
  return false;
}

const FLOW_MUTATION_TOOLS = new Set([
  'maestro_run',
  'maestro_test_all',
  'cdp_run_action',
  'proof_step',
  'cdp_auto_login',
]);

/**
 * GH #321: tools that NEVER change the on-screen UI, so a valid snapshot cache
 * (used by device_find to skip a redundant ~1,450 ms snapshot) survives them.
 * This is the allowlist for a FAIL-SAFE rule: any tool NOT listed here is treated
 * as a potential mutation and invalidates the cache. A redundant snapshot is
 * cheap; serving a stale snapshot after an unlisted mutation (cdp_dispatch,
 * cdp_reload, maestro_run, cdp_evaluate, cdp_mmkv write, …) would be a
 * wrong-element tap. New tools therefore default to "invalidate" until proven a
 * pure read.
 */
const SNAPSHOT_CACHE_READS = new Set<string>([
  // CDP / native introspection
  'cdp_component_tree',
  'cdp_component_state',
  'cdp_store_state',
  'cdp_network_log',
  'cdp_network_body',
  'cdp_console_log',
  'cdp_error_log',
  'cdp_native_errors',
  'cdp_diagnostic_renderers',
  'cdp_object_inspect',
  'cdp_heap_usage',
  'collect_logs',
  'cdp_metro_events',
  'cdp_wait_for_network',
  // perception (the cache's producer + consumer)
  'device_snapshot',
  'device_screenshot',
  // navigation reads (NOT cdp_navigate, which changes the screen)
  'cdp_navigation_state',
  'cdp_nav_graph',
  // diagnostics / connection
  'cdp_status',
  'cdp_targets',
  'device_list',
  'observe',
  // state assertions (verify-via-state — pure reads)
  'expect_redux',
  'expect_route',
  'expect_visible_by_testid',
  'expect_text',
  'cross_platform_verify',
]);

/**
 * GH #321: should this tool call invalidate the device_find snapshot cache?
 * Fail-safe: invalidate unless the tool is a known read. `device_find` is a read
 * UNLESS it taps (`action: 'click'`), mirroring isStateMutating's per-call rule.
 */
export function toolInvalidatesSnapshotCache(
  tool: string,
  args?: Record<string, unknown>,
): boolean {
  if (tool === 'device_find') return args?.action === 'click';
  if (tool === 'device_snapshot') return args?.action === 'open';
  if (tool === 'rn_session') return args?.action === 'pin_dev_client';
  return !SNAPSHOT_CACHE_READS.has(tool);
}

export function resolveSnapshotInvalidationPlatform(
  tool: string,
  args: Record<string, unknown> | undefined,
  activePlatform: string | undefined,
): 'ios' | 'android' | undefined {
  if (args?.platform === 'ios' || args?.platform === 'android') return args.platform;
  return activePlatform === 'ios' || activePlatform === 'android' ? activePlatform : undefined;
}

// Story 05 (#386): the exclusion is ONLY for single-action tools that leave a
// VALID current-screen baseline (lastSnapshotHash) for the next tap —
// invalidating after them would erase it and defeat tap-sequence change
// detection. Exactly two kinds qualify: retry-eligible tap verbs (their settle
// refreshes the hash to the post-tap screen and does NOT invalidate), and
// device_find (snapshot, or click routed through a tap). Everything else must
// invalidate:
//   - swipe/scroll take the iOS fastSwipe path that returns BEFORE any settle
//     (baseline left stale) — the exact hazard this hook exists for;
//   - pinch/back/fill/scrollintoview do settle, but as non-retry-eligible
//     verbs their settle exits hierarchyChanged===undefined → already
//     invalidates, so the hook's invalidation is a harmless no-op;
//   - device_batch runs steps under a per-step Promise.race timeout whose
//     native action can keep mutating the screen AFTER the batch returns
//     (device-batch.ts documents this), so it cannot guarantee a valid
//     baseline — invalidate and let the next tap fail-open.
export const BASELINE_SELF_MANAGED_TOOLS = new Set<string>([
  'device_press',
  'device_longpress',
  'device_find',
]);

/**
 * Story 05 (#386): should this tool call invalidate the tap-retry baseline
 * hash? True for tools that mutate the screen through a path OTHER than the
 * runNative dispatch choke point (cdp_interact, cdp_navigate, device_deeplink,
 * maestro_run, cdp_reload, …) — those never touch the baseline on their own,
 * so a stale baseline would compare a later tap against the wrong screen.
 * Reuses toolInvalidatesSnapshotCache so pure reads are excluded for free.
 */
export function toolInvalidatesRetryBaseline(
  tool: string,
  args?: Record<string, unknown>,
): boolean {
  return toolInvalidatesSnapshotCache(tool, args) && !BASELINE_SELF_MANAGED_TOOLS.has(tool);
}

/**
 * Registration-time gate: could this tool EVER trigger a live capture (for
 * some args)? Used to decide whether to install the per-call wrapper at all.
 * Tools that can only mutate for certain args (device_find) must still be
 * wrapped so the per-call `isStateMutating(tool, args)` check can run.
 */
export function mayTriggerLiveCapture(tool: string): boolean {
  return (
    FLOW_MUTATION_TOOLS.has(tool) ||
    classifyFamily(tool) === 'interaction' ||
    tool === 'cdp_navigate' ||
    tool === 'device_find'
  );
}

/**
 * GH #636 (B266): the Device pane has exactly one owner of "which device am I
 * showing" — the mirror target resolver. The live per-tool frame used to
 * resolve its own platform from the agent-device session and the live CDP
 * target; a flow that parks the runner and leaves CDP stale erased both and the
 * capture silently produced nothing, even though the authority-proven device
 * binding was intact and the simctl/adb capture needs neither.
 */
export type LiveCaptureOutcome =
  | { ok: true; pushed: 'frame' }
  | {
      ok: true;
      pushed: 'skipped';
      reason: 'no-observers' | 'flow-active' | 'coalesced' | 'mirror-active';
    }
  | { ok: false; code: string; reason: string };

export interface LiveCaptureDeps {
  hasObservers: () => boolean;
  isFlowActive: () => boolean;
  resolveTarget: () => Promise<MirrorTargetResolution>;
  captureScreenshot: (
    platform: 'ios' | 'android',
    path: string,
    deviceId: string,
  ) => Promise<{ ok: true; path: string } | { ok: false }>;
  readRoute: () => Promise<string | null>;
  readShotFile: (path: string) => { buf: Buffer; contentType: string } | null;
  pushLive: (frame: { shot?: { buf: Buffer; contentType: string }; route?: string }) => void;
  tmpPath: () => string;
  /** GH #206 + mirror spec: while the MJPEG mirror is streaming, the per-tool
   * screenshot is redundant — the browser already sees live pixels. */
  isMirrorActive?: () => boolean;
  /** Truthful reporting seam: an unprovable frame is announced, never faked. */
  reportBlocked?: (outcome: { code: string; reason: string }) => void;
}

let inFlight = false;
let pending = false;

/** Test-only: reset the single-flight latches between cases. */
export function _resetLiveCaptureForTest(): void {
  inFlight = false;
  pending = false;
}

export async function maybeCaptureLiveFrame(deps: LiveCaptureDeps): Promise<LiveCaptureOutcome> {
  try {
    if (!deps.hasObservers()) return { ok: true, pushed: 'skipped', reason: 'no-observers' };
    if (deps.isFlowActive()) return { ok: true, pushed: 'skipped', reason: 'flow-active' };
    if (inFlight) {
      pending = true;
      return { ok: true, pushed: 'skipped', reason: 'coalesced' };
    }
    inFlight = true;
  } catch {
    return { ok: true, pushed: 'skipped', reason: 'no-observers' };
  }
  let outcome: LiveCaptureOutcome;
  try {
    outcome = await runCapture(deps);
  } finally {
    inFlight = false;
    if (pending) {
      pending = false;
      void maybeCaptureLiveFrame(deps);
    }
  }
  if (!outcome.ok) {
    try {
      deps.reportBlocked?.({ code: outcome.code, reason: outcome.reason });
    } catch {
      /* reporting is best-effort; it must never mask the capture outcome */
    }
  }
  return outcome;
}

async function runCapture(deps: LiveCaptureDeps): Promise<LiveCaptureOutcome> {
  const mirrorActive = deps.isMirrorActive?.() === true;
  if (mirrorActive) {
    try {
      const route = await deps.readRoute();
      if (route) {
        deps.pushLive({ route });
        return { ok: true, pushed: 'frame' };
      }
    } catch {
      return { ok: true, pushed: 'skipped', reason: 'mirror-active' };
    }
    return { ok: true, pushed: 'skipped', reason: 'mirror-active' };
  }

  let resolution: MirrorTargetResolution;
  try {
    resolution = await deps.resolveTarget();
  } catch (error) {
    return {
      ok: false,
      code: 'LIVE_TARGET_UNRESOLVED',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!resolution.ok) {
    return {
      ok: false,
      code: resolution.code ?? 'LIVE_TARGET_UNRESOLVED',
      reason: resolution.reason,
    };
  }
  const { platform, deviceId } = resolution.target;
  const frame: { shot?: { buf: Buffer; contentType: string }; route?: string } = {};
  let captureDetail = `the supported ${platform === 'ios' ? 'simctl' : 'adb'} capture produced no frame`;
  try {
    const shot = await deps.captureScreenshot(platform, deps.tmpPath(), deviceId);
    if (shot.ok) {
      const bytes = deps.readShotFile(shot.path);
      if (bytes) frame.shot = bytes;
      else captureDetail = 'the captured file could not be read back';
    }
  } catch (error) {
    captureDetail = error instanceof Error ? error.message : String(error);
  }
  try {
    const route = await deps.readRoute();
    if (route) frame.route = route;
  } catch {
    /* route best-effort — CDP is stale by design right after a flow */
  }
  if (frame.shot || frame.route) {
    deps.pushLive(frame);
    return { ok: true, pushed: 'frame' };
  }
  return { ok: false, code: 'LIVE_FRAME_UNAVAILABLE', reason: captureDetail };
}

interface BuildLiveDepsInput {
  recorder: { hasSubscribers: () => boolean; pushLive: LiveCaptureDeps['pushLive'] };
  isFlowActive: () => boolean;
  /** The Device pane's single target owner — the same resolver the mirror uses. */
  resolveTarget: () => Promise<MirrorTargetResolution>;
  getClient: () => { isConnected: boolean };
  captureScreenshot: LiveCaptureDeps['captureScreenshot'];
  readRoute: (client: unknown) => Promise<string | null>;
  readShotFile: LiveCaptureDeps['readShotFile'];
  isMirrorActive?: () => boolean;
  reportBlocked?: LiveCaptureDeps['reportBlocked'];
}

export function buildLiveDeps(input: BuildLiveDepsInput): LiveCaptureDeps {
  return {
    hasObservers: () => input.recorder.hasSubscribers(),
    isFlowActive: () => input.isFlowActive(),
    resolveTarget: () => input.resolveTarget(),
    captureScreenshot: input.captureScreenshot,
    readRoute: async () => {
      const c = input.getClient();
      if (!c.isConnected) return null;
      return input.readRoute(c);
    },
    readShotFile: input.readShotFile,
    // Arrow-wrap, NOT a bare method reference: `input.recorder.pushLive`
    // detaches `this`, so the real Recorder.pushLive throws "this.subs is not
    // iterable" when invoked as deps.pushLive(...). The live device gate caught
    // this — the unit fakes used standalone arrows and missed it.
    pushLive: (frame) => input.recorder.pushLive(frame),
    tmpPath: () => join(tmpdir(), `rn-observe-live-${process.pid}.jpg`),
    isMirrorActive: input.isMirrorActive,
    reportBlocked: input.reportBlocked,
  };
}
