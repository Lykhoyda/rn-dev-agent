// src/observability/live-device.ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyFamily } from './events.js';
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
export function isStateMutating(tool, args) {
    if (classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate')
        return true;
    if (tool === 'device_find' && args?.action === 'click')
        return true;
    return false;
}
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
const SNAPSHOT_CACHE_READS = new Set([
    // CDP / native introspection
    'cdp_component_tree', 'cdp_component_state', 'cdp_store_state', 'cdp_network_log',
    'cdp_network_body', 'cdp_console_log', 'cdp_error_log', 'cdp_native_errors',
    'cdp_diagnostic_renderers', 'cdp_object_inspect', 'cdp_heap_usage', 'collect_logs',
    'cdp_metro_events', 'cdp_wait_for_network',
    // perception (the cache's producer + consumer)
    'device_snapshot', 'device_screenshot',
    // navigation reads (NOT cdp_navigate, which changes the screen)
    'cdp_navigation_state', 'cdp_nav_graph',
    // diagnostics / connection
    'cdp_status', 'cdp_targets', 'device_list', 'observe',
    // state assertions (verify-via-state — pure reads)
    'expect_redux', 'expect_route', 'expect_visible_by_testid', 'expect_text',
    'cross_platform_verify',
]);
/**
 * GH #321: should this tool call invalidate the device_find snapshot cache?
 * Fail-safe: invalidate unless the tool is a known read. `device_find` is a read
 * UNLESS it taps (`action: 'click'`), mirroring isStateMutating's per-call rule.
 */
export function toolInvalidatesSnapshotCache(tool, args) {
    if (tool === 'device_find')
        return args?.action === 'click';
    return !SNAPSHOT_CACHE_READS.has(tool);
}
/**
 * Registration-time gate: could this tool EVER trigger a live capture (for
 * some args)? Used to decide whether to install the per-call wrapper at all.
 * Tools that can only mutate for certain args (device_find) must still be
 * wrapped so the per-call `isStateMutating(tool, args)` check can run.
 */
export function mayTriggerLiveCapture(tool) {
    return classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate' || tool === 'device_find';
}
let inFlight = false;
let pending = false;
/** Test-only: reset the single-flight latches between cases. */
export function _resetLiveCaptureForTest() { inFlight = false; pending = false; }
export async function maybeCaptureLiveFrame(deps) {
    try {
        if (!deps.hasObservers() || deps.isFlowActive())
            return;
        if (inFlight) {
            pending = true;
            return;
        }
        inFlight = true;
    }
    catch {
        return;
    }
    try {
        await runCapture(deps);
    }
    finally {
        inFlight = false;
        if (pending) {
            pending = false;
            void maybeCaptureLiveFrame(deps);
        }
    }
}
async function runCapture(deps) {
    const platform = deps.getPlatform();
    if (!platform)
        return;
    const frame = {};
    try {
        const shot = await deps.captureScreenshot(platform, deps.tmpPath());
        if (shot.ok) {
            const bytes = deps.readShotFile(shot.path);
            if (bytes)
                frame.shot = bytes;
        }
    }
    catch { /* screenshot best-effort */ }
    try {
        const route = await deps.readRoute();
        if (route)
            frame.route = route;
    }
    catch { /* route best-effort */ }
    if (frame.shot || frame.route)
        deps.pushLive(frame);
}
function asDevicePlatform(p) {
    return p === 'ios' || p === 'android' ? p : null;
}
export function buildLiveDeps(input) {
    return {
        hasObservers: () => input.recorder.hasSubscribers(),
        isFlowActive: () => input.isFlowActive(),
        getPlatform: () => {
            const fromSession = asDevicePlatform(input.getActiveSession()?.platform);
            if (fromSession)
                return fromSession;
            return asDevicePlatform(input.getClient().connectedTarget?.platform);
        },
        captureScreenshot: input.captureScreenshot,
        readRoute: async () => {
            const c = input.getClient();
            if (!c.isConnected)
                return null;
            return input.readRoute(c);
        },
        readShotFile: input.readShotFile,
        // Arrow-wrap, NOT a bare method reference: `input.recorder.pushLive`
        // detaches `this`, so the real Recorder.pushLive throws "this.subs is not
        // iterable" when invoked as deps.pushLive(...). The live device gate caught
        // this — the unit fakes used standalone arrows and missed it.
        pushLive: (frame) => input.recorder.pushLive(frame),
        tmpPath: () => join(tmpdir(), `rn-observe-live-${process.pid}.jpg`),
    };
}
