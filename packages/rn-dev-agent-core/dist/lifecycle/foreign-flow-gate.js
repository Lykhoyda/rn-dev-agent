import { detectIosExternalRunner } from '../runners/external-runner-detect.js';
/**
 * GH#186 / #202 Phase 6: TTL-cached wrapper over detectIosExternalRunner so
 * the per-call arbiter check costs one `ps` scan per window, not per tool
 * call. Fail-open by contract: a detector error reads as "no foreign flow" —
 * the gate must never block a session on infra trouble. `lastActive` is a
 * sync mirror for handlers that route by it (device_screenshot's simctl
 * fallback), same pattern as arbiter.flowActive.
 */
export class ForeignFlowGate {
    detect;
    ttlMs;
    now;
    cachedAt = -Infinity;
    cachedUdid = null;
    cached = null;
    inFlight = null;
    inFlightUdid = null;
    _lastActive = false;
    constructor(deps = {}) {
        this.detect = deps.detect ?? ((udid) => detectIosExternalRunner(undefined, udid));
        this.ttlMs = deps.ttlMs ?? 5_000;
        this.now = deps.now ?? Date.now;
    }
    get lastActive() {
        return this._lastActive;
    }
    async check(udid) {
        const t = this.now();
        if (this.cachedUdid === udid && t - this.cachedAt < this.ttlMs) {
            return { active: this.cached !== null, warning: this.cached, fromCache: true, scanMs: 0 };
        }
        if (this.inFlight && this.inFlightUdid === udid)
            return this.inFlight;
        this.inFlightUdid = udid;
        const scan = (async () => {
            const started = this.now();
            let warning = null;
            try {
                warning = await this.detect(udid);
            }
            catch {
                warning = null;
            }
            this.cached = warning;
            this.cachedUdid = udid;
            this.cachedAt = this.now();
            this._lastActive = warning !== null;
            return { active: warning !== null, warning, fromCache: false, scanMs: this.now() - started };
        })();
        this.inFlight = scan;
        try {
            return await scan;
        }
        finally {
            if (this.inFlight === scan) {
                this.inFlight = null;
                this.inFlightUdid = null;
            }
        }
    }
}
export const foreignFlowGate = new ForeignFlowGate();
/** udid provider, registered from index.ts — a direct getActiveSession import
 * here would create a device-session ↔ arbiter module cycle. Returns the
 * active iOS session's udid, or null when there is no iOS session (the gate
 * is iOS-only; unscoped detection false-positives on idle maestro-mcp). */
let udidProvider = () => null;
export function setForeignGateUdidProvider(fn) {
    udidProvider = fn;
}
export function foreignGateUdid() {
    return udidProvider();
}
/** The knob gates an active refusal, not just a log line — so it carries an
 * honest name. `RN_IOS_FOREIGN_GUARD` is authoritative; the Phase 3
 * `RN_IOS_FOREIGN_WARN` stays as a deprecated alias so existing opt-outs
 * keep working (documented as ALSO disabling the refusal). */
export function foreignGateEnabled(env = process.env) {
    if (env.RN_IOS_FOREIGN_GUARD !== undefined)
        return env.RN_IOS_FOREIGN_GUARD !== '0';
    return env.RN_IOS_FOREIGN_WARN !== '0';
}
