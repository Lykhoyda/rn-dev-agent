import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
export const RUNNER_DIAGNOSTICS_MAX_EVENTS = 200;
const storage = new AsyncLocalStorage();
const TERMINAL_EVENT_TYPES = new Set([
    'typed-failure',
    'cleanup',
    'tool-outcome',
]);
export function retainRunnerDiagnosticEvents(events, maximum) {
    if (maximum <= 0)
        return [];
    const retained = [...events];
    while (retained.length > maximum) {
        const counts = new Map();
        for (const event of retained)
            counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
        let removeAt = retained.findIndex((event) => !TERMINAL_EVENT_TYPES.has(event.type) && (counts.get(event.type) ?? 0) > 1);
        if (removeAt < 0) {
            removeAt = retained.findIndex((event) => !TERMINAL_EVENT_TYPES.has(event.type));
        }
        if (removeAt < 0) {
            removeAt = retained.findIndex((event) => (counts.get(event.type) ?? 0) > 1);
        }
        retained.splice(removeAt < 0 ? 0 : removeAt, 1);
    }
    return retained;
}
export function withRunnerDiagnosticsContext(tool, params, work) {
    if (storage.getStore())
        return work();
    return storage.run({
        rootTool: tool,
        rootParams: params,
        events: [],
        truncated: false,
        startedAt: performance.now(),
        nextSequence: 0,
    }, work);
}
export function recordRunnerDiagnostic(type, detail = {}) {
    const state = storage.getStore();
    if (!state)
        return;
    const event = {
        sequence: ++state.nextSequence,
        monotonicMs: Math.max(0, Math.round((performance.now() - state.startedAt) * 1000) / 1000),
        timestamp: new Date().toISOString(),
        type,
        detail,
    };
    const retained = retainRunnerDiagnosticEvents([...state.events, event], RUNNER_DIAGNOSTICS_MAX_EVENTS);
    if (retained.length < state.events.length + 1) {
        state.truncated = true;
    }
    state.events = retained;
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
