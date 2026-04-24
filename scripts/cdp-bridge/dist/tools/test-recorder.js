// M6 / Phase 112 (D669): cdp_record_test_* tool family.
//
// Seven tools that wrap the Object.freeze interceptor in test-recorder-helpers
// and produce replayable test code via test-recorder-generators. State is
// module-level (storedEvents) — MCP is single-client-per-process so we don't
// need per-session isolation.
import { okResult, failResult, withConnection } from '../utils.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEV_CHECK_JS, START_RECORDING_JS, STOP_RECORDING_JS, buildAnnotationJs, } from '../cdp/test-recorder-helpers.js';
import { generateMaestro, generateDetox, } from './test-recorder-generators.js';
// --- Module state ---
// Shared across the 7 tool handlers — reset on start, written on stop, read by
// generate / save. Test-only setters exposed at the bottom of this file for
// hermetic integration tests.
let storedEvents = null;
let recordingTruncated = false;
// B136: route captured at record_start — used by the generator to emit a
// `# startRoute: <name>` preamble so replay users know where the recorded
// flow assumes the app is. Null when the recorder couldn't resolve a route
// (no __NAV_REF__ yet, or app is on its default/landing route).
let recordingStartRoute = null;
// B144: bundleId captured at record_start time — used by save/load/list to
// resolve the project root to the app the recording was made against, rather
// than whichever RN project happens to sort first in the sibling scan.
let recordingBundleId = null;
// --- Pure helpers (easy to unit-test) ---
// Collapse consecutive duplicates: same-testID type bursts keep the latest
// value; identical-testID taps within 100ms collapse to one. Mirrors
// metro-mcp's deduplicateEvents but with explicit type guards.
export function deduplicateEvents(events) {
    const out = [];
    for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (ev.type === 'type') {
            const next = events[i + 1];
            if (next?.type === 'type' &&
                next.testID === ev.testID) {
                continue;
            }
        }
        if (ev.type === 'tap') {
            const last = out[out.length - 1];
            if (last?.type === 'tap' &&
                last.testID === ev.testID &&
                ev.t - last.t < 100) {
                continue;
            }
        }
        out.push(ev);
    }
    return out;
}
export function sanitizeFilename(name) {
    return name.replace(/\.json$/i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
}
export function getRecordingsDir(rootResolver = findProjectRoot) {
    const root = rootResolver();
    if (!root)
        return null;
    return join(root, '.rn-agent', 'recordings');
}
// B144: resolver factory that threads a bundleId into findProjectRoot so
// save/load/list land in the correct project when the plugin CWD has
// multiple sibling RN projects.
//
// Codex review 2026-04-24 (conf ≥80) caught that a single resolver for all
// three operations leaks stale state: after start → stop → save against app
// A, a later load/list in the same session against app B would still prefer
// the captured bundleId (A). Fix: split semantics by operation mode.
//
//   - mode='save'       captured bundleId wins; fall back to live client.
//                       A save finalizes a recording against the app it was
//                       made from, even if the user has since reconnected
//                       elsewhere (the recording's identity is bound to
//                       capture time, not dispatch time).
//   - mode='load-list'  live client bundleId wins; fall back to captured.
//                       Load/list reflect "what's the current app's
//                       recording dir?" When the user has reconnected to a
//                       different app, we want its recordings, not the
//                       last-captured one's.
export function _makeRecordingRootResolverForTest(getClient, mode = 'save') {
    return makeRecordingRootResolver(getClient, mode);
}
function makeRecordingRootResolver(getClient, mode = 'save') {
    return () => {
        const liveBundleId = getClient?.().connectedTarget?.description ?? null;
        const bundleId = mode === 'save'
            ? (recordingBundleId ?? liveBundleId)
            : (liveBundleId ?? recordingBundleId);
        if (bundleId)
            return findProjectRoot({ bundleId });
        return findProjectRoot();
    };
}
export function typeCounts(events) {
    const counts = {};
    for (const ev of events)
        counts[ev.type] = (counts[ev.type] ?? 0) + 1;
    return counts;
}
async function probeDev(client) {
    const r = (await client.evaluate(DEV_CHECK_JS));
    return r.value === true;
}
const DEV_REQUIRED_MSG = 'Recording requires __DEV__=true — release builds pre-freeze props at bundle time and cannot be intercepted';
export function createRecordTestStartHandler(getClient) {
    return withConnection(getClient, async (_args, client) => {
        if (!(await probeDev(client))) {
            return failResult(DEV_REQUIRED_MSG, 'DEV_MODE_REQUIRED');
        }
        const result = (await client.evaluate(START_RECORDING_JS));
        if (result.error) {
            return failResult(`Failed to start recording: ${result.error}`, 'EVAL_FAILED');
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from START_RECORDING_JS — expected JSON string', 'BAD_RESPONSE');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Invalid JSON from start: ${String(result.value).slice(0, 200)}`, 'BAD_RESPONSE');
        }
        if (!parsed.ok) {
            return failResult(parsed.error ?? 'start failed', 'START_FAILED');
        }
        storedEvents = null;
        recordingTruncated = false;
        recordingStartRoute = parsed.activeRoute ?? null;
        // B144: capture the connected bundleId so save/load/list resolve the
        // project root for this specific app, not whichever sibling happens to
        // sort first alphabetically.
        recordingBundleId = client.connectedTarget?.description ?? null;
        return okResult({
            started: true,
            alreadyRunning: !!parsed.alreadyRunning,
            activeRoute: parsed.activeRoute ?? null,
        });
    });
}
export function createRecordTestStopHandler(getClient) {
    return withConnection(getClient, async (_args, client) => {
        const result = (await client.evaluate(STOP_RECORDING_JS));
        if (result.error) {
            return failResult(`Failed to stop recording: ${result.error}`, 'EVAL_FAILED');
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from STOP_RECORDING_JS — expected JSON string', 'BAD_RESPONSE');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Invalid JSON from stop: ${String(result.value).slice(0, 200)}`, 'BAD_RESPONSE');
        }
        const raw = Array.isArray(parsed.events) ? parsed.events : [];
        storedEvents = deduplicateEvents(raw);
        recordingTruncated = !!parsed.truncated;
        return okResult({
            stopped: true,
            eventCount: storedEvents.length,
            truncated: recordingTruncated,
            typeCounts: typeCounts(storedEvents),
        });
    });
}
export function createRecordTestGenerateHandler() {
    return async (args) => {
        if (!storedEvents || storedEvents.length === 0) {
            return failResult('No recorded events — call cdp_record_test_start, interact, then cdp_record_test_stop first', 'NO_EVENTS');
        }
        if (args.format === 'appium') {
            return failResult('Appium generator not implemented in M6 — file a GitHub issue if needed', 'NOT_IMPLEMENTED');
        }
        const opts = {
            testName: args.testName,
            bundleId: args.bundleId,
            startRoute: recordingStartRoute ?? undefined,
        };
        const text = args.format === 'maestro'
            ? generateMaestro(storedEvents, opts)
            : generateDetox(storedEvents, opts);
        return okResult({ format: args.format, eventCount: storedEvents.length, text, startRoute: recordingStartRoute });
    };
}
export function createRecordTestAnnotateHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (!(await probeDev(client))) {
            return failResult(DEV_REQUIRED_MSG, 'DEV_MODE_REQUIRED');
        }
        const result = (await client.evaluate(buildAnnotationJs(args.note)));
        if (result.error) {
            return failResult(`Failed to annotate: ${result.error}`, 'EVAL_FAILED');
        }
        if (typeof result.value !== 'string') {
            return failResult('Unexpected response from annotate — expected JSON string', 'BAD_RESPONSE');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.value);
        }
        catch {
            return failResult(`Invalid JSON from annotate: ${String(result.value).slice(0, 200)}`, 'BAD_RESPONSE');
        }
        if (!parsed.ok) {
            return failResult(parsed.error ?? 'Annotation failed', 'NOT_RECORDING');
        }
        return okResult({ annotated: true });
    });
}
export function createRecordTestSaveHandler(getClient) {
    return async (args) => {
        if (!storedEvents) {
            return failResult('No events to save — stop a recording first', 'NO_EVENTS');
        }
        const dir = getRecordingsDir(makeRecordingRootResolver(getClient, 'save'));
        if (!dir) {
            return failResult('Could not resolve project root (no package.json ancestor). Set RN_PROJECT_ROOT env var.', 'NO_PROJECT_ROOT');
        }
        await mkdir(dir, { recursive: true });
        const safe = sanitizeFilename(args.filename);
        if (!safe) {
            return failResult('Filename is empty after sanitization', 'BAD_FILENAME');
        }
        const filePath = join(dir, `${safe}.json`);
        const payload = { savedAt: new Date().toISOString(), events: storedEvents };
        await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
        return okResult({
            saved: true,
            path: filePath,
            eventCount: storedEvents.length,
            truncated: recordingTruncated,
        });
    };
}
export function createRecordTestLoadHandler(getClient) {
    return async (args) => {
        const dir = getRecordingsDir(makeRecordingRootResolver(getClient, 'load-list'));
        if (!dir) {
            return failResult('Could not resolve project root', 'NO_PROJECT_ROOT');
        }
        const safe = sanitizeFilename(args.filename);
        if (!safe) {
            return failResult('Filename is empty after sanitization', 'BAD_FILENAME');
        }
        const filePath = join(dir, `${safe}.json`);
        let raw;
        try {
            raw = await readFile(filePath, 'utf8');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return failResult(`Could not load ${filePath}: ${msg}`, 'LOAD_FAILED');
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            return failResult(`Recording file is not valid JSON: ${filePath}`, 'BAD_RECORDING');
        }
        storedEvents = Array.isArray(parsed.events) ? parsed.events : [];
        recordingTruncated = false;
        return okResult({
            loaded: true,
            path: filePath,
            savedAt: parsed.savedAt ?? null,
            eventCount: storedEvents.length,
            typeCounts: typeCounts(storedEvents),
        });
    };
}
export function createRecordTestListHandler(getClient) {
    return async () => {
        const dir = getRecordingsDir(makeRecordingRootResolver(getClient, 'load-list'));
        if (!dir) {
            return failResult('Could not resolve project root', 'NO_PROJECT_ROOT');
        }
        let files;
        try {
            files = await readdir(dir);
        }
        catch {
            return okResult({ dir, files: [] });
        }
        const recordings = files
            .filter((f) => f.endsWith('.json'))
            .map((f) => f.replace(/\.json$/, ''))
            .sort();
        return okResult({ dir, files: recordings });
    };
}
// --- Test-only DI hooks (named with leading underscore by convention) ---
export function _setStoredEvents(events, truncated = false) {
    storedEvents = events;
    recordingTruncated = truncated;
}
export function _getStoredEvents() {
    return storedEvents;
}
export function _resetState() {
    storedEvents = null;
    recordingTruncated = false;
    recordingStartRoute = null;
    recordingBundleId = null;
}
export function _setRecordingStartRoute(route) {
    recordingStartRoute = route;
}
// B144: test-only setter for module state. Production code captures this at
// record_test_start time from the CDP client's connectedTarget.description.
export function _setRecordingBundleId(bundleId) {
    recordingBundleId = bundleId;
}
export function _getRecordingBundleId() {
    return recordingBundleId;
}
