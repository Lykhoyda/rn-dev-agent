import { redact } from '../util/redact.js';
const CLIP_LIMIT = 16000;
const INTERACTION = new Set([
    'device_press',
    'device_fill',
    'device_swipe',
    'device_scroll',
    'device_longpress',
    'device_pinch',
    'device_back',
    'device_batch',
    'device_scrollintoview',
    'cdp_interact',
    'device_focus_next',
    'device_pick_date',
    'device_pick_value',
    'device_deeplink',
]);
const NAVIGATION = new Set(['cdp_navigation_state', 'cdp_nav_graph', 'cdp_navigate']);
const INTROSPECTION = new Set([
    'cdp_component_tree',
    'cdp_component_state',
    'cdp_store_state',
    'device_snapshot',
    'device_screenshot',
    'cdp_network_log',
    'cdp_network_body',
    'cdp_console_log',
    'cdp_error_log',
    'cdp_native_errors',
    'cdp_diagnostic_renderers',
    'cdp_object_inspect',
    'cdp_heap_usage',
    'collect_logs',
]);
const LIFECYCLE = new Set([
    'cdp_status',
    'cdp_connect',
    'cdp_disconnect',
    'cdp_targets',
    'cdp_reload',
    'cdp_restart',
    'cdp_dev_settings',
    'cdp_open_devtools',
    'device_list',
    'observe',
]);
const TESTING = new Set([
    'maestro_run',
    'maestro_generate',
    'maestro_test_all',
    'cdp_run_action',
    'cdp_repair_action',
    'proof_step',
    'cross_platform_verify',
    'cdp_auto_login',
    'expect_redux',
    'expect_route',
    'expect_visible_by_testid',
    'expect_text',
]);
export function classifyFamily(tool) {
    if (INTERACTION.has(tool))
        return 'interaction';
    if (NAVIGATION.has(tool))
        return 'navigation';
    if (INTROSPECTION.has(tool))
        return 'introspection';
    if (LIFECYCLE.has(tool))
        return 'lifecycle';
    if (TESTING.has(tool))
        return 'testing';
    return 'other';
}
export function clipThenRedact(args, payload) {
    let redactedArgs;
    try {
        redactedArgs = redact(args ?? {});
    }
    catch {
        redactedArgs = { redacted: true };
    }
    if (payload === null || payload === undefined) {
        return { args: redactedArgs };
    }
    try {
        let json;
        try {
            json = JSON.stringify(payload);
        }
        catch {
            return { args: redactedArgs, payload: { redacted: true } };
        }
        let clipped = payload;
        let truncated = false;
        if (typeof json === 'string' && json.length > CLIP_LIMIT) {
            clipped = { _clipped: json.slice(0, CLIP_LIMIT) };
            truncated = true;
        }
        const redactedPayload = redact({ v: clipped }).v;
        return truncated
            ? { args: redactedArgs, payload: redactedPayload, truncated: true }
            : { args: redactedArgs, payload: redactedPayload };
    }
    catch {
        return { args: redactedArgs, payload: { redacted: true } };
    }
}
export function unwrapResult(result) {
    if (!result || typeof result !== 'object')
        return undefined;
    const env = result;
    const text = env.content?.[0]?.text;
    if (typeof text !== 'string')
        return undefined;
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
export function summarize(tool, _family, args, ok) {
    const target = args.testID ?? args.ref ?? args.text ?? args.screen ?? args.path ?? '';
    const head = target ? `${tool} ${String(target).slice(0, 60)}` : tool;
    return ok ? head : `${head} ✗`;
}
export function mapObservation(seq, o) {
    const family = classifyFamily(o.tool);
    const ok = o.status === 'PASS';
    const unwrapped = unwrapResult(o.result);
    const payloadSource = ok ? (unwrapped ? unwrapped.data : o.result) : undefined;
    const { args, payload, truncated } = clipThenRedact(o.params ?? {}, payloadSource);
    const summary = summarize(o.tool, family, args, ok);
    const event = {
        seq,
        ts: Date.now(),
        tool: o.tool,
        family,
        args,
        ok,
        durationMs: o.latencyMs,
        summary,
    };
    if (payload !== undefined)
        event.payload = payload;
    if (truncated)
        event.truncated = true;
    if (!ok && o.error) {
        const raw = String(o.error).slice(0, 500);
        let message;
        try {
            message = String(redact({ m: raw }).m);
        }
        catch {
            message = '[REDACTED:error]';
        }
        event.error = { message };
    }
    if (o.ghost?.attempted)
        event.ghost = o.ghost;
    return event;
}
