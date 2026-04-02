export type NavigatorKind = 'stack' | 'tab' | 'drawer' | 'native-stack' | 'unknown';

export type NavLibrary = 'expo-router' | 'react-navigation' | 'unknown';

export interface NavScreen {
  name: string;
  path?: string;
  params_template?: string;
  is_active: boolean;
  initial?: boolean;
  is_modal?: boolean;
  reliability_score: number;
  visit_count: number;
  last_seen?: string;
  avg_load_ms?: number;
  action_records?: NavActionRecord[];
}

export interface NavNavigator {
  id: string;
  kind: NavigatorKind;
  screens: NavScreen[];
  active_screen: string | null;
  parent_screen?: string;
  is_visited: boolean;
  source: 'runtime' | 'linking' | 'both';
}

export interface NavGraphMeta {
  schema_version: 1;
  project_slug: string;
  nav_library: NavLibrary;
  rn_version: string | null;
  expo_sdk: string | null;
  created_at: string;
  last_scanned_at: string;
  scanned_at_commit?: string;
  scan_count: number;
  containers_found: number;
  coverage: number;
}

export interface NavGraph {
  meta: NavGraphMeta;
  navigators: NavNavigator[];
  all_screens: string[];
}

export interface RawRoute {
  name: string;
  path?: string;
  params_schema?: string[];
  is_initial?: boolean;
  is_active?: boolean;
  is_modal?: boolean;
  is_visited: boolean;
}

export interface RawNavigator {
  id: string;
  kind: NavigatorKind;
  parent_screen: string | null;
  routes: RawRoute[];
  active_route_name?: string | null;
  initial_route_name?: string;
  is_visited: boolean;
  source: 'runtime' | 'linking' | 'both';
}

export interface RawNavTopology {
  library: NavLibrary;
  rn_version: string | null;
  expo_sdk: string | null;
  navigators: RawNavigator[];
  containers_found: number;
  error?: string;
}

// --- Phase B: Navigation Planning ---

export type NavMethod = 'programmatic' | 'deep_link' | 'ui_interaction';

export interface NavigationStep {
  action: 'switch_tab' | 'push' | 'navigate' | 'open_drawer' | 'go_back' | 'deep_link';
  target_screen: string;
  navigator_id: string;
  navigator_kind: NavigatorKind;
  method: NavMethod;
  deep_link_path?: string;
  params?: Record<string, unknown>;
  note?: string;
}

export interface NavigationPlan {
  from: string | null;
  to: string;
  steps: NavigationStep[];
  total_steps: number;
  estimated_reliability: number;
  prerequisites: NavigationPrerequisite[];
  preferred_method: NavMethod;
  deep_link_available: boolean;
  deep_link_path?: string;
}

export interface NavigationPrerequisite {
  type: 'auth' | 'permission' | 'state';
  description: string;
  check_tool?: string;
  check_args?: Record<string, unknown>;
}

// --- Phase C: Runtime Learning ---

export interface NavActionRecord {
  method: NavMethod;
  success: boolean;
  latency_ms: number;
  recorded_at: string;
}

export interface StrikeEntry {
  screen: string;
  method: NavMethod;
  consecutive_failures: number;
  last_failure_at: string;
  cooled_until?: string;
}

export interface NavRecordInput {
  screen: string;
  method: NavMethod;
  success: boolean;
  latency_ms?: number;
}

export interface NavRecordResult {
  screen: string;
  method: NavMethod;
  success: boolean;
  new_reliability_score: number;
  new_visit_count: number;
  strike_status?: {
    consecutive_failures: number;
    cooled_down: boolean;
    cooled_until?: string;
  };
}

// --- Phase D: Self-Healing + Polish ---

export interface StalenessCheck {
  stale: boolean;
  reason?: string;
  scanned_at_commit?: string;
  current_commit?: string;
  nav_files_changed: string[];
  recommendation: 'ok' | 'rescan_recommended' | 'rescan_required';
}

export interface PlaybookEntry {
  context: string;
  platform: 'ios' | 'android' | 'both';
  use: string;
  avoid?: string;
  reason: string;
}

export interface SelfHealResult {
  original_failure: string;
  recovery_attempted: boolean;
  recovery_method?: string;
  recovered: boolean;
  note: string;
}

export interface NavGraphScanResult {
  graph: NavGraph;
  file_path: string | null;
  navigators_found: number;
  routes_found: number;
  new_routes: string[];
  removed_routes: string[];
  is_first_scan: boolean;
  coverage: number;
}
