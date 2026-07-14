import { createHash } from 'node:crypto';
import { redact } from '../util/redact.js';
export class StrictProofMonitor {
    now;
    events = [];
    observedResults = [];
    active = false;
    constructor(now = Date.now) {
        this.now = now;
    }
    begin() {
        this.events = [];
        this.observedResults = [];
        this.active = true;
    }
    record(event) {
        if (!this.active || event.tool === 'proof_capture')
            return;
        const ts = this.now();
        this.events.push({
            tool: event.tool,
            ok: event.status === 'PASS',
            ts,
            durationMs: event.latencyMs,
            argsHash: hashProofArgs(event.params),
        });
        this.observedResults.push({
            tool: event.tool,
            ok: event.status === 'PASS',
            ts,
            argsHash: hashProofArgs(event.params),
            resultHash: hashObservedValue(event.result),
            screenshotPath: observedScreenshotPath(event),
            assertionPassed: observedAssertionPassed(event),
        });
    }
    snapshot() {
        return structuredClone(this.events);
    }
    stop() {
        this.active = false;
        return this.snapshot();
    }
    observations() {
        return structuredClone(this.observedResults);
    }
}
function canonicalizeProofValue(value) {
    if (Array.isArray(value))
        return value.map(canonicalizeProofValue);
    if (!value || typeof value !== 'object')
        return value;
    return Object.fromEntries(Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeProofValue(nested)]));
}
export function hashProofArgs(params) {
    return hashProofValue(redact(params));
}
export function hashProofValue(value) {
    return createHash('sha256')
        .update(JSON.stringify(canonicalizeProofValue(value)))
        .digest('hex');
}
export function proofRuntimeAuthorityMarker(input) {
    return hashProofValue(input);
}
function hashObservedValue(value) {
    const bytes = JSON.stringify(value) ?? String(value);
    return createHash('sha256').update(bytes).digest('hex');
}
function resultEnvelopeData(result) {
    if (!result || typeof result !== 'object')
        return null;
    const content = result.content;
    if (!Array.isArray(content))
        return result;
    const text = content[0]?.text;
    if (typeof text !== 'string')
        return result;
    try {
        const envelope = JSON.parse(text);
        return envelope.data ?? envelope;
    }
    catch {
        return result;
    }
}
function stringField(value, fields) {
    if (!value || typeof value !== 'object')
        return null;
    for (const field of fields) {
        const candidate = value[field];
        if (typeof candidate === 'string' && candidate.length > 0)
            return candidate;
    }
    return null;
}
function observedScreenshotPath(event) {
    return stringField(resultEnvelopeData(event.result), ['screenshotPath', 'path', 'output']);
}
function observedAssertionPassed(event) {
    if (event.status !== 'PASS')
        return false;
    const tool = event.tool
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replaceAll('-', '_');
    const data = resultEnvelopeData(event.result);
    if (!data || typeof data !== 'object')
        return !tool.endsWith('proof_step');
    const record = data;
    if (tool.endsWith('proof_step') && record.verified !== true)
        return false;
    if (record.verified === false || record.ok === false)
        return false;
    return !Array.isArray(record.errors) || record.errors.length === 0;
}
const transitions = {
    idle: { begin_rehearsal: 'rehearsing' },
    rehearsing: { finish_rehearsal: 'rehearsed', reject: 'rejected' },
    rehearsed: { arm: 'armed', reject: 'rejected' },
    armed: { start_recording: 'recording', reject: 'rejected' },
    recording: { stop_recording: 'validating', reject: 'rejected' },
    validating: { validate: 'mechanically_accepted', reject: 'rejected' },
    mechanically_accepted: { finalize: 'accepted', reject: 'rejected' },
    accepted: {},
    rejected: { begin_rehearsal: 'rehearsing' },
};
export const traceReasonCodes = [
    'ACTION_REPAIR_DURING_RECORDING',
    'RELOAD_DURING_RECORDING',
    'RESTART_DURING_RECORDING',
    'DEV_CLIENT_DISMISSAL_DURING_RECORDING',
    'STATE_RESET_DURING_RECORDING',
    'OBSERVED_TOOL_FAILED',
    'UNDECLARED_MUTATING_TOOL',
    'UNDECLARED_READ_ONLY_TOOL',
    'STORYBOARD_OPERATION_MISSING',
    'STORYBOARD_ORDER_VIOLATION',
];
const readOnlyTools = new Set([
    'cdp_status',
    'cdp_targets',
    'device_list',
    'cdp_component_tree',
    'cdp_component_state',
    'cdp_diagnostic_renderers',
    'cdp_navigation_state',
    'cdp_nav_graph',
    'cdp_store_state',
    'cdp_network_log',
    'cdp_network_body',
    'cdp_wait_for_network',
    'cdp_console_log',
    'cdp_error_log',
    'cdp_native_errors',
    'cdp_metro_events',
    'cdp_heap_usage',
    'cdp_cpu_profile',
    'cdp_object_inspect',
    'collect_logs',
    'expect_redux',
    'expect_route',
    'expect_visible_by_testid',
    'expect_text',
]);
function normalizeToolName(tool) {
    const bare = tool.startsWith('mcp__') ? (tool.split('__').at(-1) ?? tool) : tool;
    return bare
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replaceAll('-', '_');
}
function isReadOnlyTool(tool) {
    return readOnlyTools.has(tool) || tool.startsWith('expect_');
}
function forbiddenReason(tool) {
    const tokens = tool.split('_');
    if (tokens.includes('action') && tokens.includes('repair')) {
        return 'ACTION_REPAIR_DURING_RECORDING';
    }
    if (tool === 'cdp_reload' || tool === 'reload')
        return 'RELOAD_DURING_RECORDING';
    if (tool === 'cdp_restart' || tool === 'restart')
        return 'RESTART_DURING_RECORDING';
    if (tool === 'cdp_dismiss_dev_client_picker' ||
        tool === 'dismiss_dev_client_picker' ||
        tool === 'dev_client_picker_dismiss') {
        return 'DEV_CLIENT_DISMISSAL_DURING_RECORDING';
    }
    if (tool === 'device_reset_state' || tool === 'cdp_reset_state' || tool === 'reset_state') {
        return 'STATE_RESET_DURING_RECORDING';
    }
    return null;
}
export function transitionProofStage(stage, action) {
    const next = transitions[stage][action];
    if (!next) {
        throw new Error(`INVALID_PROOF_STAGE_TRANSITION:${stage}:${action}`);
    }
    return next;
}
const PROOF_DURATION_VARIANCE_FACTOR = 1.5;
const PROOF_DURATION_GRACE_MS = 10_000;
const PROOF_DURATION_TARGET_MAXIMUM_MS = 120_000;
const PROOF_DURATION_TOLERANCE_MS = 5_000;
export function durationBounds(expectedMs) {
    const targetMaximumMs = Math.min(Math.ceil(expectedMs * PROOF_DURATION_VARIANCE_FACTOR + PROOF_DURATION_GRACE_MS), PROOF_DURATION_TARGET_MAXIMUM_MS);
    return {
        minimumMs: Math.floor(expectedMs * 0.8),
        targetMaximumMs,
        hardMaximumMs: targetMaximumMs + PROOF_DURATION_TOLERANCE_MS,
    };
}
export function validateTrace(allowedTools, observed) {
    const normalizedAllowed = allowedTools.map(normalizeToolName);
    const allowed = new Set(normalizedAllowed);
    const orderedOperations = normalizedAllowed.filter((tool) => !isReadOnlyTool(tool));
    const reasons = [];
    let expectedIndex = 0;
    const reject = (reason) => {
        if (!reasons.includes(reason))
            reasons.push(reason);
    };
    for (const event of observed) {
        const tool = normalizeToolName(event.tool);
        if (!event.ok)
            reject('OBSERVED_TOOL_FAILED');
        const forbidden = forbiddenReason(tool);
        if (forbidden) {
            reject(forbidden);
            continue;
        }
        if (isReadOnlyTool(tool)) {
            if (!allowed.has(tool))
                reject('UNDECLARED_READ_ONLY_TOOL');
            continue;
        }
        if (!allowed.has(tool)) {
            reject('UNDECLARED_MUTATING_TOOL');
            continue;
        }
        if (orderedOperations[expectedIndex] === tool) {
            expectedIndex += 1;
            continue;
        }
        reject('STORYBOARD_ORDER_VIOLATION');
        const laterIndex = orderedOperations.indexOf(tool, expectedIndex + 1);
        if (laterIndex >= 0)
            expectedIndex = laterIndex + 1;
    }
    if (reasons.length === 0 && expectedIndex < orderedOperations.length) {
        reject('STORYBOARD_OPERATION_MISSING');
    }
    return { ok: reasons.length === 0, reasons };
}
