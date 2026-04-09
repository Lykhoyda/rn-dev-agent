export { redact } from './redact.js';
export { captureFingerprint } from './fingerprint.js';
export { logToolCall, logFailure, logGhostAttempt, pruneOldTelemetry, instrumentTool } from './telemetry.js';
export type { ToolHandler } from './telemetry.js';
export { normalizeError, classifyError } from './classify.js';
export { loadExperience, getFailureFamilies, getRecoverySequence, clearExperienceCache } from './retrieve.js';
export { attemptGhostRecovery, appendGhostNote } from './ghost.js';
export { scanTelemetry, groupFailures, generateCandidates, computeDecay } from './compact.js';
export { runCompactionCycle, autoCompactIfNeeded } from './promote.js';
export { exportExperience, importExperience, getExperienceHealth } from './sharing.js';
export type { ExperienceHealth } from './sharing.js';
export type {
  TelemetryEvent,
  EnvironmentFingerprint,
  ExperienceConfig,
  FailureFamily,
  RecoverySequence,
  ClassificationResult,
  ExperienceHeuristic,
  LoadedExperience,
  ToolCallContext,
  GhostRecoveryResult,
  FailureStats,
  CandidateHeuristic,
  CompactionResult,
  PromotionResult,
} from './types.js';
export { DEFAULT_CONFIG } from './types.js';
