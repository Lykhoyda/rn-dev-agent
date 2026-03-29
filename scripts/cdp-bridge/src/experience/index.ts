export { redact } from './redact.js';
export { captureFingerprint } from './fingerprint.js';
export { logToolCall, logFailure, pruneOldTelemetry, instrumentTool } from './telemetry.js';
export type { ToolHandler } from './telemetry.js';
export type { TelemetryEvent, EnvironmentFingerprint, ExperienceConfig } from './types.js';
export { DEFAULT_CONFIG } from './types.js';
