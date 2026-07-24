const diagnostic = ['cdp_status', 'cdp_targets', 'device_list'];
const transition = ['rn_session', 'cdp_connect', 'cdp_disconnect'];
const sourceState = [
    'cdp_nav_graph',
    'cdp_record_test_generate',
    'cdp_record_test_list',
    'cdp_record_test_load',
    'cdp_record_test_save',
    'cdp_record_test_save_as_action',
    'maestro_generate',
];
const nativeRead = [
    'cross_platform_verify',
    'device_find',
    'device_screenshot',
    'device_snapshot',
];
const nativeMutation = [
    'cdp_lock_e2e_test',
    'cdp_repair_action',
    'device_accept_system_dialog',
    'device_back',
    'device_batch',
    'device_deeplink',
    'device_dismiss_system_dialog',
    'device_fill',
    'device_focus_next',
    'device_longpress',
    'device_permission',
    'device_pick_date',
    'device_pick_value',
    'device_pinch',
    'device_press',
    'device_record',
    'device_reset_state',
    'device_scroll',
    'device_scrollintoview',
    'device_swipe',
    'maestro_run',
    'maestro_test_all',
];
const hybridMutation = ['cdp_auto_login', 'cdp_run_e2e_suite'];
const optionalHybridMutation = ['cdp_run_action'];
const cdpRead = [
    'cdp_component_state',
    'cdp_component_tree',
    'cdp_console_log',
    'cdp_cpu_profile',
    'cdp_diagnostic_renderers',
    'cdp_error_log',
    'cdp_heap_usage',
    'cdp_metro_events',
    'cdp_native_errors',
    'cdp_navigation_state',
    'cdp_network_body',
    'cdp_network_log',
    'cdp_object_inspect',
    'cdp_open_devtools',
    'cdp_store_state',
    'cdp_wait_for_network',
    'collect_logs',
    'expect_redux',
    'expect_route',
    'expect_text',
    'expect_visible_by_testid',
];
const cdpMutation = [
    'cdp_dev_settings',
    'cdp_dismiss_dev_client_picker',
    'cdp_dispatch',
    'cdp_evaluate',
    'cdp_exception_breakpoint',
    'cdp_interact',
    'cdp_mmkv',
    'cdp_navigate',
    'cdp_record_test_annotate',
    'cdp_record_test_start',
    'cdp_record_test_stop',
    'cdp_reload',
    'cdp_restart',
    'cdp_set_shared_value',
];
const observe = ['observe'];
const proof = ['proof_capture', 'proof_step'];
const profiles = new Map();
function add(names, profile) {
    for (const name of names) {
        if (profiles.has(name))
            throw new Error(`DUPLICATE_AUTHORITY_PROFILE: ${name}`);
        profiles.set(name, profile);
    }
}
add(diagnostic, {
    kind: 'diagnostic',
    axes: [],
    mutation: false,
    liveBundleProbe: false,
});
add(transition, {
    kind: 'transition',
    axes: ['C', 'S'],
    mutation: true,
    liveBundleProbe: false,
});
add(sourceState, {
    kind: 'authoritative',
    axes: ['C', 'S'],
    mutation: true,
    liveBundleProbe: false,
});
add(nativeRead, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'D', 'R'],
    mutation: false,
    liveBundleProbe: false,
});
add(nativeMutation, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'D', 'R'],
    mutation: true,
    liveBundleProbe: false,
});
add(hybridMutation, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'B', 'D', 'R'],
    mutation: true,
    liveBundleProbe: true,
});
add(optionalHybridMutation, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'D', 'R'],
    optionalAxes: ['B'],
    mutation: true,
    liveBundleProbe: true,
});
add(cdpRead, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'B', 'D'],
    mutation: false,
    liveBundleProbe: true,
});
add(cdpMutation, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'B', 'D'],
    mutation: true,
    liveBundleProbe: true,
});
add(observe, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'B', 'D', 'O'],
    mutation: false,
    liveBundleProbe: true,
});
add(proof, {
    kind: 'authoritative',
    axes: ['C', 'S', 'I', 'M', 'B', 'D', 'R', 'P'],
    mutation: true,
    liveBundleProbe: true,
});
export function authorityProfileFor(tool, args = {}) {
    if (tool === 'cdp_nav_graph' && (args.action === 'scan' || args.action === 'go')) {
        return profiles.get('cdp_interact');
    }
    const profile = profiles.get(tool);
    if (!profile)
        throw new Error(`UNPROFILED_AUTHORITY_TOOL: ${tool}`);
    return profile;
}
export function assertAuthorityProfilesExhaustive(toolNames) {
    const expected = new Set(toolNames);
    const missing = toolNames.filter((name) => !profiles.has(name));
    const stale = [...profiles.keys()].filter((name) => !expected.has(name));
    if (missing.length || stale.length) {
        throw new Error(`UNPROFILED_AUTHORITY_TOOL: missing=${missing.join(',') || 'none'} stale=${stale.join(',') || 'none'}`);
    }
}
