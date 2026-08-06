export type AuthorityFacet = 'C' | 'S' | 'I' | 'M' | 'A' | 'B' | 'D' | 'R' | 'P';
export type AuthorityAxis = AuthorityFacet;
export type AuthorityGroup = 'session' | 'target' | 'runtime' | 'automation';

// Groups are bookkeeping only; gates, probes, receipts, and errors use resolved facets.
const groupFacets: Record<AuthorityGroup, readonly AuthorityFacet[]> = {
  session: ['C', 'S'],
  target: ['D', 'I'],
  runtime: ['M', 'B', 'A'],
  automation: ['R'],
};

const facetOrder: readonly AuthorityFacet[] = ['C', 'S', 'I', 'M', 'A', 'B', 'D', 'R', 'P'];

const session: readonly AuthorityGroup[] = ['session'];
const osScoped: readonly AuthorityGroup[] = ['session', 'target'];
const throughRuntime: readonly AuthorityGroup[] = ['session', 'target', 'runtime'];
const allGroups: readonly AuthorityGroup[] = ['session', 'target', 'runtime', 'automation'];

function facetsOf(
  groups: readonly AuthorityGroup[],
  narrowing: { without?: readonly AuthorityFacet[]; overlay?: readonly AuthorityFacet[] } = {},
): readonly AuthorityFacet[] {
  const facets = new Set<AuthorityFacet>(groups.flatMap((group) => [...groupFacets[group]]));
  for (const facet of narrowing.overlay ?? []) facets.add(facet);
  for (const facet of narrowing.without ?? []) facets.delete(facet);
  return facetOrder.filter((facet) => facets.has(facet));
}

export interface AuthorityProfile {
  kind: 'diagnostic' | 'transition' | 'authoritative';
  groups?: readonly AuthorityGroup[];
  axes: readonly AuthorityAxis[];
  postflightAxes?: readonly AuthorityAxis[];
  optionalAxes?: readonly AuthorityAxis[];
  managedOrigin?: boolean;
  managedRunnerPark?: boolean;
  managedInstallReissue?: boolean;
  sessionIdentity?: boolean;
  mutation: boolean;
  liveBundleProbe: boolean;
}

const diagnostic = ['cdp_status', 'cdp_targets', 'device_list'] as const;

const transition = ['rn_session', 'cdp_connect', 'cdp_disconnect'] as const;

const sourceState = [
  'cdp_nav_graph',
  'cdp_record_test_generate',
  'cdp_record_test_list',
  'cdp_record_test_load',
  'cdp_record_test_save',
  'cdp_record_test_save_as_action',
  'maestro_generate',
] as const;

const nativeRead = [
  'cross_platform_verify',
  'device_find',
  'device_screenshot',
  'device_snapshot',
] as const;

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
] as const;

const hybridMutation = ['cdp_auto_login', 'cdp_run_e2e_suite'] as const;
const optionalHybridMutation = ['cdp_run_action'] as const;
const nativeDiagnostic = ['cdp_native_errors'] as const;
const inlineMaestroMutation = new Set<string>([
  'device_accept_system_dialog',
  'device_dismiss_system_dialog',
  'device_fill',
  'device_pick_date',
  'device_pick_value',
]);

const cdpRead = [
  'cdp_component_state',
  'cdp_component_tree',
  'cdp_console_log',
  'cdp_cpu_profile',
  'cdp_diagnostic_renderers',
  'cdp_error_log',
  'cdp_heap_usage',
  'cdp_metro_events',
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
] as const;

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
] as const;

const observe = ['observe'] as const;
const proof = ['proof_capture', 'proof_step'] as const;

const profiles = new Map<string, AuthorityProfile>();

function add(names: readonly string[], profile: AuthorityProfile): void {
  for (const name of names) {
    if (profiles.has(name)) throw new Error(`DUPLICATE_AUTHORITY_PROFILE: ${name}`);
    profiles.set(name, profile);
  }
}

add(diagnostic, {
  kind: 'diagnostic',
  groups: [],
  axes: [],
  mutation: false,
  liveBundleProbe: false,
});
add(transition, {
  kind: 'transition',
  groups: session,
  axes: facetsOf(session),
  mutation: true,
  liveBundleProbe: false,
});
add(sourceState, {
  kind: 'authoritative',
  groups: session,
  axes: facetsOf(session),
  mutation: true,
  liveBundleProbe: false,
});
// Native tools drive the device without a live CDP seat: no B, A stays live.
add(nativeRead, {
  kind: 'authoritative',
  groups: allGroups,
  axes: facetsOf(allGroups, { without: ['B'] }),
  mutation: false,
  liveBundleProbe: false,
});
add(nativeMutation, {
  kind: 'authoritative',
  groups: allGroups,
  axes: facetsOf(allGroups, { without: ['B'] }),
  mutation: true,
  liveBundleProbe: false,
});
// Hybrid runs hold the live CDP seat instead of the native A association probe.
add(hybridMutation, {
  kind: 'authoritative',
  groups: allGroups,
  axes: facetsOf(allGroups, { without: ['A'] }),
  mutation: true,
  liveBundleProbe: true,
});
add(optionalHybridMutation, {
  kind: 'authoritative',
  groups: allGroups,
  axes: facetsOf(allGroups, { without: ['A', 'B'] }),
  optionalAxes: ['B'],
  managedOrigin: true,
  managedRunnerPark: true,
  managedInstallReissue: true,
  mutation: true,
  liveBundleProbe: true,
});
add(nativeDiagnostic, {
  kind: 'authoritative',
  groups: osScoped,
  axes: facetsOf(osScoped),
  mutation: false,
  liveBundleProbe: false,
});
// CDP tools never touch the runner and prove the bundle seat instead of A.
add(cdpRead, {
  kind: 'authoritative',
  groups: throughRuntime,
  axes: facetsOf(throughRuntime, { without: ['A'] }),
  mutation: false,
  liveBundleProbe: true,
});
add(cdpMutation, {
  kind: 'authoritative',
  groups: throughRuntime,
  axes: facetsOf(throughRuntime, { without: ['A'] }),
  mutation: true,
  liveBundleProbe: true,
});
// Observe is a read-only Session child; its mutating web routes keep their own gates.
add(observe, {
  kind: 'authoritative',
  groups: session,
  axes: facetsOf(session),
  mutation: false,
  liveBundleProbe: false,
});
// Strict proof requires all four groups live plus the P overlay on every call.
add(proof, {
  kind: 'authoritative',
  groups: allGroups,
  axes: facetsOf(allGroups, { without: ['A'], overlay: ['P'] }),
  mutation: true,
  liveBundleProbe: true,
});

export function authorityProfileFor(
  tool: string,
  args: Record<string, unknown> = {},
): AuthorityProfile {
  if (tool === 'device_find' && args.action === 'click') {
    return profiles.get('device_press')!;
  }
  if (tool === 'device_deeplink') {
    // OS-launch path: Runtime narrows to the managed Metro facet only.
    return {
      kind: 'authoritative',
      groups: throughRuntime,
      axes: facetsOf(throughRuntime, { without: ['A', 'B'] }),
      managedOrigin: true,
      mutation: true,
      liveBundleProbe: false,
    };
  }
  if (tool === 'device_permission') {
    return {
      kind: 'authoritative',
      groups: osScoped,
      axes: facetsOf(osScoped),
      mutation: args.action !== 'query',
      liveBundleProbe: false,
    };
  }
  if (tool === 'device_record') {
    const cleanup = args.action === 'stop' || args.action === 'status';
    return {
      kind: 'authoritative',
      groups: osScoped,
      axes: cleanup ? facetsOf(osScoped, { without: ['I'] }) : facetsOf(osScoped),
      sessionIdentity: true,
      mutation: args.action !== 'status',
      liveBundleProbe: false,
    };
  }
  if (tool === 'proof_capture' && args.action === 'discard') {
    // Lighter teardown: discard must succeed after Runtime or install loss.
    return {
      kind: 'authoritative',
      groups: osScoped,
      axes: facetsOf(osScoped, { without: ['I'], overlay: ['P'] }),
      postflightAxes: facetsOf(osScoped, { without: ['I'] }),
      mutation: true,
      liveBundleProbe: false,
    };
  }
  if (tool === 'device_reset_state') {
    const storageMutation = Array.isArray(args.storageKeys) && args.storageKeys.length > 0;
    return {
      kind: 'authoritative',
      groups: allGroups,
      axes: storageMutation
        ? facetsOf(allGroups, { without: ['A'] })
        : facetsOf(allGroups, { without: ['A', 'B'] }),
      postflightAxes: facetsOf(allGroups, { without: ['A', 'B'] }),
      managedOrigin: true,
      mutation: true,
      liveBundleProbe: storageMutation,
    };
  }
  if (tool === 'cdp_lock_e2e_test' || tool === 'cdp_run_e2e_suite') {
    const profile = profiles.get(tool)!;
    return {
      ...profile,
      axes: profile.axes.filter((facet) => facet !== 'A'),
      managedOrigin: true,
      managedRunnerPark: true,
    };
  }
  if (tool === 'maestro_run' || tool === 'maestro_test_all') {
    return {
      kind: 'authoritative',
      groups: allGroups,
      axes: facetsOf(allGroups, { without: ['A', 'B'] }),
      postflightAxes: facetsOf(throughRuntime, { without: ['A', 'B'] }),
      managedOrigin: true,
      managedRunnerPark: true,
      managedInstallReissue: true,
      mutation: true,
      liveBundleProbe: false,
    };
  }
  if (tool === 'cdp_restart' && args.hardReset === true && args.platform === 'ios') {
    return {
      kind: 'transition',
      groups: allGroups,
      axes: facetsOf(allGroups, { without: ['A'] }),
      mutation: true,
      liveBundleProbe: true,
    };
  }
  if (tool === 'cdp_nav_graph' && (args.action === 'scan' || args.action === 'go')) {
    return profiles.get('cdp_interact')!;
  }
  const profile = profiles.get(tool);
  if (!profile) throw new Error(`UNPROFILED_AUTHORITY_TOOL: ${tool}`);
  // These tools remain ordinary interactions until their conditional Maestro
  // fallback dispatches. Installing the lazy park callback here does not stop
  // the runner and does not alter the non-flow teardown-grace invariant.
  return inlineMaestroMutation.has(tool) ? { ...profile, managedRunnerPark: true } : profile;
}

export function assertAuthorityProfilesExhaustive(toolNames: readonly string[]): void {
  const expected = new Set(toolNames);
  const missing = toolNames.filter((name) => !profiles.has(name));
  const stale = [...profiles.keys()].filter((name) => !expected.has(name));
  if (missing.length || stale.length) {
    throw new Error(
      `UNPROFILED_AUTHORITY_TOOL: missing=${missing.join(',') || 'none'} stale=${stale.join(',') || 'none'}`,
    );
  }
}
