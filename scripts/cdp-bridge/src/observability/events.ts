export type AgentEventFamily =
  | 'interaction'
  | 'introspection'
  | 'navigation'
  | 'lifecycle'
  | 'testing'
  | 'other';

export interface AgentEvent {
  seq: number;
  ts: number;
  tool: string;
  family: AgentEventFamily;
  args: Record<string, unknown>;
  ok: boolean;
  durationMs?: number;
  error?: { message: string; code?: string };
  ghost?: { attempted: boolean; outcome: string };
  summary: string;
  payload?: unknown;
  truncated?: boolean;
}

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

export function classifyFamily(tool: string): AgentEventFamily {
  if (INTERACTION.has(tool)) return 'interaction';
  if (NAVIGATION.has(tool)) return 'navigation';
  if (INTROSPECTION.has(tool)) return 'introspection';
  if (LIFECYCLE.has(tool)) return 'lifecycle';
  if (TESTING.has(tool)) return 'testing';
  return 'other';
}
