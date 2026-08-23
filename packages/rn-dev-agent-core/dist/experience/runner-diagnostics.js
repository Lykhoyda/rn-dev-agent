import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
export const RUNNER_DIAGNOSTICS_MAX_EVENTS = 200;
const storage = new AsyncLocalStorage();
export function withRunnerDiagnosticsContext(tool, params, work) {
    if (storage.getStore())
        return work();
    return storage.run({
        rootTool: tool,
        rootParams: params,
        events: [],
        truncated: false,
        startedAt: performance.now(),
    }, work);
}
export function recordRunnerDiagnostic(type, detail = {}) {
    const state = storage.getStore();
    if (!state)
        return;
    if (state.events.length >= RUNNER_DIAGNOSTICS_MAX_EVENTS) {
        state.truncated = true;
        return;
    }
    state.events.push({
        sequence: state.events.length + 1,
        monotonicMs: Math.max(0, Math.round((performance.now() - state.startedAt) * 1000) / 1000),
        timestamp: new Date().toISOString(),
        type,
        detail,
    });
}
export function currentRunnerDiagnosticsPlatform() {
    const value = storage.getStore()?.rootParams.platform;
    return typeof value === 'string' ? value : null;
}
export function snapshotRunnerDiagnostics() {
    const state = storage.getStore();
    if (!state || state.events.length === 0)
        return undefined;
    return {
        rootTool: state.rootTool,
        rootParams: { ...state.rootParams },
        events: state.events.map((event) => ({ ...event, detail: { ...event.detail } })),
        truncated: state.truncated,
    };
}
