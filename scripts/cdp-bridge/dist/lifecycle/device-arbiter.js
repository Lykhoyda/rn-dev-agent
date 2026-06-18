import { failResult } from "../utils.js";
import { foreignFlowGate, foreignGateUdid, foreignGateEnabled } from "./foreign-flow-gate.js";
/**
 * GH#202 Phase 2a: in-memory serialization of the three device-control planes
 * for ONE bridge process. `flow` (Maestro) is exclusive — it cannot start while
 * any op is in flight, and no op can start while it is held. `introspection`
 * (CDP reads) and `interaction` (device_*) are shared and coexist. Refuse-fast,
 * never queue. MUST stay in-memory: persisting a lease recreates the #202
 * orphaned-lock bug. A leaked op-id would wedge all flows forever, so `reset()`
 * is the escape hatch (exposed via the unarbitrated cdp_status resetArbiter).
 */
export class DeviceSessionArbiter {
    flowLeaseHeldBy = null;
    ops = new Map();
    nextOpId = 1;
    now;
    constructor(now = Date.now) {
        this.now = now;
    }
    tryAcquire(plane, tool) {
        if (plane === "flow") {
            if (this.flowLeaseHeldBy !== null || this.ops.size > 0) {
                return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
            }
            return this.grant(plane, tool, true);
        }
        if (this.flowLeaseHeldBy !== null) {
            return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
        }
        return this.grant(plane, tool, false);
    }
    grant(plane, tool, isFlow) {
        const opId = this.nextOpId++;
        this.ops.set(opId, { plane, tool, startedAtMs: this.now() });
        if (isFlow)
            this.flowLeaseHeldBy = opId;
        return { ok: true, lease: { plane, opId } };
    }
    describeBlocker() {
        const id = this.flowLeaseHeldBy ?? this.oldestOpId();
        if (id === null)
            return null;
        const info = this.ops.get(id);
        return info ? { plane: info.plane, tool: info.tool, opId: id } : null;
    }
    oldestOpId() {
        let oldest = null;
        let oldestAt = Infinity;
        for (const [id, info] of this.ops) {
            if (info.startedAtMs < oldestAt) {
                oldestAt = info.startedAtMs;
                oldest = id;
            }
        }
        return oldest;
    }
    /** GH#186: set when a FLOW lease releases. Our own maestro driver (argv
     * carries the udid) keeps tearing down WDA for seconds after release and
     * matches the foreign detector — taps inside this window must not scan. */
    lastFlowReleasedAt = -Infinity;
    get msSinceFlowReleased() {
        return this.now() - this.lastFlowReleasedAt;
    }
    release(lease) {
        this.ops.delete(lease.opId);
        if (this.flowLeaseHeldBy === lease.opId) {
            this.flowLeaseHeldBy = null;
            this.lastFlowReleasedAt = this.now();
        }
    }
    reset(reason) {
        const clearedOps = this.ops.size;
        const hadFlow = this.flowLeaseHeldBy !== null;
        this.ops.clear();
        this.flowLeaseHeldBy = null;
        return { clearedOps, hadFlow, reason };
    }
    get snapshot() {
        return {
            flowLeaseHeldBy: this.flowLeaseHeldBy,
            activeOps: this.ops.size,
            ops: [...this.ops.entries()].map(([opId, i]) => ({ opId, plane: i.plane, tool: i.tool })),
        };
    }
    /** #210: true while a flow (Maestro) owns the device. Flow-fallback tools consult this to take an OS-level path. */
    get flowActive() {
        return this.flowLeaseHeldBy !== null;
    }
}
export const arbiter = new DeviceSessionArbiter();
// --- Plane classification ---------------------------------------------------
// flow: tools that drive the whole device via Maestro OR relaunch the app —
// exclusive, because either yanks the device out from under everything else.
// (cdp_auto_login runs a Maestro subflow; cdp_reload/restart relaunch the app —
// none may interleave with a running flow.)
const FLOW_TOOLS = new Set([
    "maestro_run",
    "maestro_test_all",
    "cdp_run_action",
    "cdp_auto_login",
    "cdp_reload",
    "cdp_restart",
]);
// interaction: anything that mutates device/app state — gestures AND
// state-mutating CDP calls (navigate/dispatch/set_shared_value/mmkv write).
// These are writes, deliberately NOT "introspection".
const INTERACTION_TOOLS = new Set([
    "device_screenshot",
    "device_snapshot",
    "device_find",
    "device_press",
    "device_fill",
    "device_swipe",
    "device_back",
    "device_longpress",
    "device_scroll",
    "device_scrollintoview",
    "device_pinch",
    "device_permission",
    "device_reset_state",
    "device_deeplink",
    "device_accept_system_dialog",
    "device_dismiss_system_dialog",
    "device_record",
    "device_pick_value",
    "device_pick_date",
    "device_focus_next",
    "device_batch",
    "cdp_interact",
    "cdp_repair_action",
    "cross_platform_verify",
    "proof_step",
    "cdp_navigate",
    "cdp_dispatch",
    "cdp_set_shared_value",
    "cdp_mmkv",
]);
// introspection: genuinely read-only CDP/state queries.
const INTROSPECTION_TOOLS = new Set([
    "cdp_evaluate",
    "cdp_component_tree",
    "cdp_component_state",
    "cdp_diagnostic_renderers",
    "cdp_navigation_state",
    "cdp_nav_graph",
    "cdp_store_state",
    "cdp_network_log",
    "cdp_network_body",
    "cdp_wait_for_network",
    "cdp_console_log",
    "cdp_error_log",
    "cdp_native_errors",
    "cdp_metro_events",
    "cdp_heap_usage",
    "cdp_cpu_profile",
    "cdp_object_inspect",
    "cdp_exception_breakpoint",
    "collect_logs",
    "expect_redux",
    "expect_route",
    "expect_visible_by_testid",
    "expect_text",
]);
// Everything else is UNARBITRATED (planeForTool → null): cdp_status (the health
// check + the reset escape hatch), cdp_connect/disconnect/targets, device_list
// (session-less), cdp_record_test_*, dev settings/devtools. These must work even
// mid-flow — cdp_status especially is what you run WHEN a flow looks stuck. A new
// tool not listed in any Set above defaults here (unarbitrated) — add it to a Set
// if it touches the device.
export function planeForTool(name) {
    if (FLOW_TOOLS.has(name))
        return "flow";
    if (INTERACTION_TOOLS.has(name))
        return "interaction";
    if (INTROSPECTION_TOOLS.has(name))
        return "introspection";
    return null;
}
// #210: interaction tools with a flow-SAFE fallback (OS-level, no XCUITest) that may run
// UNLEASED while a flow owns the device instead of refusing. device_screenshot falls back
// to `xcrun simctl io screenshot` / `adb screencap`, which cannot conflict with a Maestro/WDA
// flow. The handler MUST consult `arbiter.flowActive` and take the raw path when true.
const FLOW_FALLBACK_TOOLS = new Set(["device_screenshot"]);
/** GH#186: WDA teardown after our own flow takes seconds; within this window
 * the detector cannot distinguish our dying driver from a foreign one. */
const FOREIGN_GRACE_MS = 10_000;
function foreignRefusal(name, warning, scanMs) {
    return failResult(`Refusing ${name}: a FOREIGN Maestro/XCUITest session is driving this simulator ` +
        `(${warning.processLines[0] ?? "detected via ps"}). L1 introspection stays safe — use ` +
        `cdp_component_tree / cdp_store_state / cdp_navigation_state for reads, and device_screenshot ` +
        `for pixels (simctl fallback). Retry taps/flows after the foreign run completes. ` +
        `Opt out of this guard with RN_IOS_FOREIGN_GUARD=0.`, "BUSY_FOREIGN_FLOW", { foreignRunner: warning, conflict: true, timings_ms: { foreignScan: scanMs } });
}
/**
 * Wrap an MCP handler so it acquires its plane before running and releases
 * after (in a `finally`, so a throwing handler still frees its lease). A refused
 * acquire returns a ToolResult (never throws). Unarbitrated tools (planeForTool
 * → null) are returned unwrapped. Only EXTERNAL MCP calls pass through here;
 * composite tools (cdp_run_action, proof_step, device_batch) call underlying
 * handler FUNCTIONS, not the wrapped MCP tools, so a flow tool's internal
 * device/CDP work never re-enters this wrapper — one external call = one lease.
 */
export function arbiterWrap(name, handler, inst = arbiter, foreign = {}) {
    const plane = planeForTool(name);
    if (plane === null)
        return handler;
    const gate = foreign.gate ?? foreignFlowGate;
    const getUdid = foreign.getUdid ?? foreignGateUdid;
    const enabled = foreign.enabled ?? foreignGateEnabled;
    return async (...args) => {
        // GH#186 Phase 6: a foreign Maestro session is an external flow-plane
        // holder. Checked for interaction/flow planes only (L1 reads never
        // conflict — the three-layer contract), only with an iOS session (an
        // unscoped scan false-positives on idle maestro-mcp), only when no
        // LOCAL flow lease exists (a detected driver is then our own L3 run —
        // the plain BUSY_FLOW_ACTIVE refusal below already covers contenders),
        // and not within the teardown grace of our own just-released flow (the
        // dying driver still matches the detector; a fresh scan can't tell).
        if (plane !== "introspection" &&
            !inst.flowActive &&
            inst.msSinceFlowReleased >= FOREIGN_GRACE_MS &&
            enabled()) {
            const udid = getUdid();
            if (udid !== null) {
                const check = await gate.check(udid);
                if (check.active && check.warning) {
                    if (FLOW_FALLBACK_TOOLS.has(name)) {
                        // Same OS-level fallback contract as a local flow: pixels stay
                        // available via simctl (the handler routes by gate.lastActive).
                        return await handler(...args);
                    }
                    return foreignRefusal(name, check.warning, check.scanMs);
                }
            }
        }
        const res = inst.tryAcquire(plane, name);
        if (!res.ok) {
            if (FLOW_FALLBACK_TOOLS.has(name) && inst.flowActive) {
                // #210: a flow owns the device, but this tool has an OS-level fallback. Run it
                // WITHOUT a lease — it must not touch XCUITest while the flow holds the device
                // (the handler routes to simctl/adb via arbiter.flowActive). The flowActive guard
                // keeps the unleased path scoped to flow-blocks only (defensive: an interaction
                // tool only fails tryAcquire on a flow today, but this survives arbiter changes).
                return await handler(...args);
            }
            const who = res.holder ? `${res.holder.tool} (${res.holder.plane})` : "a Maestro flow";
            return failResult(`Refusing ${name}: blocked by ${who} on this device — reads and taps can't interleave ` +
                `with a running Maestro flow. Retry after it completes; if it appears stuck, ` +
                `run cdp_status({ resetArbiter: true }).`, res.code, { holder: res.holder, conflict: true });
        }
        try {
            return await handler(...args);
        }
        finally {
            inst.release(res.lease);
        }
    };
}
