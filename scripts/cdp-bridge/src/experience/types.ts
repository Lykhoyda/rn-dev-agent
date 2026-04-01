export interface EnvironmentFingerprint {
  rn_version: string | null;
  expo_sdk: string | null;
  engine: 'hermes' | 'jsc' | null;
  architecture: 'fabric' | 'old' | null;
  bridgeless: boolean | null;
  platform: 'ios' | 'android' | null;
  device: string | null;
  metro_port: number;
  key_deps: string[];
}

export interface TelemetryEvent {
  ts: string;
  event_id?: string;
  parent_event_id?: string;
  run: string;
  phase: string;
  event: 'tool_call' | 'failure' | 'fix_retry' | 'recovery' | 'ghost_attempt';
  tool?: string;
  params?: Record<string, unknown>;
  result?: 'PASS' | 'FAIL' | 'ERROR';
  error?: string;
  normalized_error?: string;
  family_id?: string;
  family_confidence?: number;
  recovery?: string;
  recovery_result?: 'PASS' | 'FAIL';
  ghost_attempted?: boolean;
  ghost_outcome?: 'recovered' | 'failed' | 'skipped';
  latency_ms?: number;
  env?: EnvironmentFingerprint;
}

// --- Phase B: Classification ---

export interface FailureFamilyMatch {
  type: 'exact' | 'regex' | 'signal';
  field: string;
  pattern: string;
}

export interface FailureFamily {
  id: string;
  name: string;
  symptoms: string[];
  match?: FailureFamilyMatch[];
  recovery: string[];
  recovery_id?: string;
  ghost_eligible: boolean;
  notes?: string;
}

export interface RecoveryStep {
  kind: 'tool' | 'wait' | 'assert';
  tool?: string;
  args?: Record<string, unknown>;
  ms?: number;
  path?: string;
  equals?: unknown;
}

export interface RecoverySequence {
  id: string;
  name: string;
  trigger: string;
  steps: RecoveryStep[];
  confidence: number;
}

export interface ClassificationResult {
  family_id: string;
  family_name: string;
  confidence: number;
  matched_symptom: string;
  recovery_id?: string;
  ghost_eligible: boolean;
}

// --- Phase B: Retrieval ---

export type HeuristicSource = 'seed' | 'project' | 'user';

export interface ExperienceHeuristic {
  id: string;
  source: HeuristicSource;
  type: 'failure_pattern' | 'recovery_shortcut' | 'platform_quirk' | 'expo_gotcha';
  summary: string;
  env_filter?: Partial<EnvironmentFingerprint>;
  confidence: number;
}

export interface LoadedExperience {
  heuristics: ExperienceHeuristic[];
  families: FailureFamily[];
  recoveries: RecoverySequence[];
  loaded_at: string;
  token_estimate: number;
}

// --- Phase B: Ghost Recovery ---

export interface ToolCallContext {
  depth: number;
  is_recovery: boolean;
  parent_event_id?: string;
  disable_ghost?: boolean;
}

export interface GhostRecoveryResult {
  recovered: boolean;
  family_id: string;
  steps_executed: number;
  latency_ms: number;
  note: string;
  recovered_result?: unknown;
}

// --- Phase C: Compaction + Promotion ---

export interface FailureStats {
  tool: string;
  normalized_error: string;
  family_id?: string;
  total: number;
  passed: number;
  failed: number;
  ghost_recovered: number;
  first_seen: string;
  last_seen: string;
  runs: Set<string>;
}

export interface CandidateHeuristic {
  id: string;
  type: 'failure_pattern' | 'recovery_shortcut';
  tool: string;
  symptom: string;
  normalized_error: string;
  family_id?: string;
  recovery?: string;
  confidence: number;
  seen_count: number;
  success_count: number;
  first_seen: string;
  last_seen: string;
  env?: Partial<EnvironmentFingerprint>;
  auto_promotable: boolean;
}

export interface CompactionResult {
  telemetry_files_scanned: number;
  events_processed: number;
  failure_groups: number;
  candidates_generated: number;
  candidates_auto_promoted: number;
  heuristics_decayed: number;
  heuristics_removed: number;
  experience_tokens: number;
}

export interface PromotionResult {
  promoted_to: 'user' | 'project';
  heuristic_id: string;
  auto: boolean;
  reason: string;
}

export interface ExperienceConfig {
  experience_engine: boolean;
  retention_days: number;
  max_telemetry_mb: number;
  redact_paths: boolean;
  redact_secrets: boolean;
  redact_pii: boolean;
}

export const DEFAULT_CONFIG: ExperienceConfig = {
  experience_engine: true,
  retention_days: 14,
  max_telemetry_mb: 250,
  redact_paths: true,
  redact_secrets: true,
  redact_pii: true,
};
