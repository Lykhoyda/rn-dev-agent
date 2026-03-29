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
  run: string;
  phase: string;
  event: 'tool_call' | 'failure' | 'fix_retry' | 'recovery';
  tool?: string;
  params?: Record<string, unknown>;
  result?: 'PASS' | 'FAIL' | 'ERROR';
  error?: string;
  recovery?: string;
  recovery_result?: 'PASS' | 'FAIL';
  latency_ms?: number;
  env?: EnvironmentFingerprint;
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
