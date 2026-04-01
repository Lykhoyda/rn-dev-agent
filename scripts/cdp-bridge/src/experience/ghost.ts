import type {
  ToolCallContext,
  GhostRecoveryResult,
  ClassificationResult,
  RecoveryStep,
} from './types.js';
import { classifyError } from './classify.js';
import { getFailureFamilies, getRecoverySequence } from './retrieve.js';
import { logGhostAttempt } from './telemetry.js';

/**
 * Ghost Recovery — "Ghost in the Machine" pattern.
 *
 * Automatically tries known recovery sequences for transport-level failures
 * (e.g., stale CDP target) BEFORE returning the error to the agent.
 *
 * Design constraints (per Gemini + Codex review):
 * - Max depth = 1 (no recursive ghost recovery)
 * - Only FF_STALE_CDP initially (narrow whitelist)
 * - Per-family cooldown within session (prevent rapid-fire retries)
 * - Preserves original failure in telemetry even on recovery
 * - Appends system note to recovered results for agent transparency
 * - Does NOT ghost FF_FAST_REFRESH_STALE or FF_METRO_CACHE (workflow-level)
 * - Does NOT duplicate withConnection() auto-reconnect (only fires on
 *   classified failures that withConnection didn't catch)
 */

// Phase B whitelist — only transport-level, idempotent recoveries
const GHOST_WHITELIST = new Set(['FF_STALE_CDP']);

// Cooldown: don't ghost the same family more than once per 30s
const familyCooldowns = new Map<string, number>();
const COOLDOWN_MS = 30_000;

// Time budget for ghost recovery attempt
const GHOST_TIMEOUT_MS = 15_000;

export interface GhostContext {
  toolName: string;
  error: string;
  context: ToolCallContext;
  retryTool: (disableGhost: boolean) => Promise<unknown>;
}

function isOnCooldown(familyId: string): boolean {
  const last = familyCooldowns.get(familyId);
  if (!last) return false;
  return Date.now() - last < COOLDOWN_MS;
}

/**
 * Attempt ghost recovery for a failed tool call.
 *
 * Returns null if ghost is not applicable (wrong family, cooldown, depth > 0).
 * Returns GhostRecoveryResult if attempted (regardless of success/failure).
 */
export async function attemptGhostRecovery(
  ghost: GhostContext,
): Promise<GhostRecoveryResult | null> {
  // Guard: no recursive ghost
  if (ghost.context.depth > 0 || ghost.context.disable_ghost) return null;

  // Guard: check RN_AGENT_NO_GHOST env (for plugin debugging)
  if (process.env.RN_AGENT_NO_GHOST === '1') return null;

  const families = getFailureFamilies();
  const classification = classifyError(ghost.error, ghost.toolName, families);
  if (!classification) return null;

  // Guard: must be ghost-eligible and on whitelist
  if (!classification.ghost_eligible) return null;
  if (!GHOST_WHITELIST.has(classification.family_id)) return null;

  // Guard: confidence threshold (per Gemini review)
  if (classification.confidence < 0.5) return null;

  // Guard: cooldown
  if (isOnCooldown(classification.family_id)) return null;

  // Mark cooldown
  familyCooldowns.set(classification.family_id, Date.now());

  const start = Date.now();
  const eventId = `ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    // Execute recovery with timeout (catch late rejections per Gemini review)
    const recovered = await Promise.race([
      executeRecovery(classification, ghost).catch(() => false as const),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), GHOST_TIMEOUT_MS)),
    ]);

    const latency = Date.now() - start;
    const didRecover = recovered !== false && recovered !== null;
    const result: GhostRecoveryResult = {
      recovered: didRecover,
      family_id: classification.family_id,
      steps_executed: didRecover && typeof recovered === 'object' ? (recovered as RecoveryOutcome).steps : 0,
      latency_ms: latency,
      note: didRecover
        ? `Auto-recovered from ${classification.family_name} (${classification.family_id}). Original error: ${ghost.error.slice(0, 100)}`
        : `Ghost recovery failed for ${classification.family_id}. Original error preserved.`,
      recovered_result: didRecover && typeof recovered === 'object' ? (recovered as RecoveryOutcome).result : undefined,
    };

    logGhostAttempt(
      ghost.toolName,
      classification.family_id,
      classification.confidence,
      result.recovered ? 'recovered' : 'failed',
      latency,
      eventId,
      ghost.error,
    );

    return result;
  } catch (err) {
    const latency = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);

    logGhostAttempt(
      ghost.toolName,
      classification.family_id,
      classification.confidence,
      'failed',
      latency,
      eventId,
      ghost.error,
    );

    return {
      recovered: false,
      family_id: classification.family_id,
      steps_executed: 0,
      latency_ms: latency,
      note: `Ghost recovery threw: ${msg.slice(0, 100)}`,
    };
  }
}

interface RecoveryOutcome {
  steps: number;
  result: unknown;
}

/**
 * Execute recovery steps for a classified failure.
 * Returns RecoveryOutcome with the successful retry result, or false on failure.
 */
async function executeRecovery(
  classification: ClassificationResult,
  ghost: GhostContext,
): Promise<RecoveryOutcome | false> {
  // For FF_STALE_CDP, the recovery is simple: retry the tool call
  // with ghost disabled. The existing withConnection() in utils.ts
  // handles the actual CDP reconnection. Ghost's role here is to
  // classify the failure and decide whether a retry is worthwhile,
  // preventing the agent from seeing transient transport errors.
  if (classification.family_id === 'FF_STALE_CDP') {
    try {
      // Wait briefly for any in-flight reconnection to settle
      await new Promise(r => setTimeout(r, 2000));

      // Retry the original tool with ghost disabled
      const result = await ghost.retryTool(true);

      // Check if retry succeeded
      if (result && typeof result === 'object') {
        const envelope = result as Record<string, unknown>;
        if (envelope.isError) return false;
        return { steps: 1, result };
      }
      return { steps: 1, result };
    } catch {
      return false;
    }
  }

  // For other families (future expansion), execute recovery-playbook steps
  if (classification.recovery_id) {
    const sequence = getRecoverySequence(classification.recovery_id);
    if (!sequence) return false;

    let stepsExecuted = 0;
    for (const step of sequence.steps) {
      const ok = await executeStep(step);
      if (!ok) return false;
      stepsExecuted++;
    }

    try {
      const result = await ghost.retryTool(true);
      if (result && typeof result === 'object') {
        const envelope = result as Record<string, unknown>;
        if (envelope.isError) return false;
      }
      return { steps: stepsExecuted + 1, result };
    } catch {
      return false;
    }
  }

  return false;
}

async function executeStep(step: RecoveryStep): Promise<boolean> {
  if (step.kind === 'wait') {
    await new Promise(r => setTimeout(r, step.ms ?? 1000));
    return true;
  }

  // 'tool' and 'assert' steps are not directly executable from here
  // (we don't have access to MCP tool handlers). For Phase B, only
  // FF_STALE_CDP uses the retry-based recovery above. Future phases
  // can wire up an internal tool executor for playbook-driven recovery.
  return true;
}

/**
 * Append a ghost recovery note to an MCP tool result.
 * Per Gemini review: agent should know a recovery happened.
 */
export function appendGhostNote(
  result: unknown,
  ghostResult: GhostRecoveryResult,
): unknown {
  if (!result || typeof result !== 'object') return result;

  const envelope = result as Record<string, unknown>;
  const content = envelope.content;
  if (!Array.isArray(content) || content.length === 0) return result;

  const first = content[0] as Record<string, unknown> | undefined;
  if (!first?.text || typeof first.text !== 'string') return result;

  try {
    const parsed = JSON.parse(first.text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return result;
    (parsed as Record<string, unknown>).meta = {
      ...((parsed as Record<string, unknown>).meta as Record<string, unknown> ?? {}),
      ghost_recovery: {
        family_id: ghostResult.family_id,
        latency_ms: ghostResult.latency_ms,
        note: ghostResult.note,
      },
    };
    return {
      ...envelope,
      content: [{ type: 'text', text: JSON.stringify(parsed) }],
    };
  } catch {
    return result;
  }
}
