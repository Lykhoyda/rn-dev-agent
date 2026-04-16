export const CDP_TIMEOUT_FAST = 1500;
export const CDP_TIMEOUT_MS = 5000;
export const CDP_TIMEOUT_SLOW = 30000;
const METHOD_TIMEOUTS = new Map([
    ['Runtime.getHeapUsage', CDP_TIMEOUT_FAST],
    ['Log.enable', CDP_TIMEOUT_FAST],
    ['Log.disable', CDP_TIMEOUT_FAST],
    ['HeapProfiler.takeHeapSnapshot', CDP_TIMEOUT_SLOW],
    ['HeapProfiler.startTrackingHeapObjects', CDP_TIMEOUT_SLOW],
    ['Profiler.start', CDP_TIMEOUT_SLOW],
    ['Profiler.stop', CDP_TIMEOUT_SLOW],
    ['Network.getResponseBody', CDP_TIMEOUT_SLOW],
]);
export function timeoutForMethod(method) {
    return METHOD_TIMEOUTS.get(method) ?? CDP_TIMEOUT_MS;
}
