// Issue #104 — `cdp_run_action` MCP tool. Replays a learned action's
// Maestro flow, parses failures, optionally auto-repairs on
// SELECTOR_NOT_FOUND, and persists a RunRecord with auto-repair
// telemetry to the action's sidecar.
//
// Composition:
//   1. loadAction(projectRoot, actionId) — fail fast if missing.
//   2. createMaestroRunHandler() — first attempt (delegates to the
//      existing `maestro_run` tool, single source of truth for the
//      maestro-runner / Maestro CLI dispatch tiering).
//   3. On failure: parseMaestroFailure → if SELECTOR_NOT_FOUND and
//      autoRepair !== false, invoke createRepairActionHandler. On
//      successful patch, replay maestro once more.
//   4. appendRunRecord (with embedded autoRepair outcome) +
//      saveAction (atomic pair-write) — single source of truth for
//      MTTR analytics.
//
// Behavioural contract:
//   - autoRepair defaults to true. Pass `autoRepair: false` to opt out.
//   - Only SELECTOR_NOT_FOUND-shaped failures trigger repair in phase 1.
//     TIMEOUT and ASSERTION_FAILED are surfaced verbatim (issue #104
//     defers other failure shapes to follow-up).
//   - The repair attempt counts toward `cdp_repair_action`'s 24h budget;
//     an exhausted budget surfaces as `autoRepair.outcome === 'refused'`
//     with `refusedReason: 'BUDGET_EXHAUSTED'`.
//   - One repair attempt + one retry per run. Multi-attempt repair is
//     intentionally NOT in scope for phase 1 (each repair attempt is a
//     30s+ device snapshot; cascading retries would be slow and could
//     mask underlying screen churn).

import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { ToolErrorCode } from '../types.js';
import { loadAction, saveAction } from '../domain/action-store.js';
import {
  type RunRecord,
  type AutoRepairOutcome,
  type AutoRepairRefusedReason,
  type ActionFailureCode,
  appendRunRecord,
} from '../domain/reusable-action.js';
import {
  parseMaestroFailure,
  isAutoRepairable,
  type MaestroFailure,
} from '../domain/maestro-error-parser.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { createRepairActionHandler } from './repair-action.js';

/**
 * Map a parsed Maestro failure kind to an `ActionFailureCode` (for
 * RunRecord telemetry) and a `ToolErrorCode` (for the failResult
 * envelope). The two enums overlap but are NOT identical — RunRecord
 * captures action-domain semantics, ToolErrorCode is the agent-facing
 * error contract.
 */
function classifyFailure(failure: MaestroFailure): {
  actionCode: ActionFailureCode;
  toolCode: ToolErrorCode | undefined;
} {
  switch (failure.kind) {
    case 'SELECTOR_NOT_FOUND':
      return { actionCode: 'SELECTOR_NOT_FOUND', toolCode: 'TESTID_NOT_FOUND' };
    case 'TIMEOUT':
      return { actionCode: 'TIMEOUT', toolCode: undefined };
    case 'ASSERTION_FAILED':
      return { actionCode: 'STATE_MISMATCH', toolCode: 'ASSERTION_FAILED' };
    case 'UNKNOWN':
    default:
      return { actionCode: 'UNKNOWN', toolCode: undefined };
  }
}

export interface RunActionArgs {
  /** Action id matching `<projectRoot>/.rn-agent/actions/<actionId>.yaml`. */
  actionId: string;
  /**
   * Override the project root. Default: process.cwd(). Useful for tests
   * and for projects where cdp-bridge isn't invoked from the project dir.
   */
  projectRoot?: string;
  /** Force a specific platform; otherwise auto-detected. */
  platform?: 'ios' | 'android';
  /**
   * Auto-repair on SELECTOR_NOT_FOUND failures. Default true. Pass
   * `false` for explicit opt-out (e.g. `--no-auto-repair` from the
   * slash command).
   */
  autoRepair?: boolean;
  /** Maestro execution timeout in ms. Default 120s. */
  timeoutMs?: number;
  /**
   * RunRecord trigger annotation. Default 'agent'. CI calls should pass
   * 'ci'; human-driven invocations 'human'.
   */
  trigger?: 'agent' | 'ci' | 'human';
}

interface MaestroEnvelope {
  ok?: boolean;
  data?: { passed?: boolean; output?: string; flowFile?: string; platform?: string };
  error?: string;
  meta?: Record<string, unknown>;
}

function parseEnvelope(toolResult: ToolResult): MaestroEnvelope {
  try {
    return JSON.parse(toolResult.content?.[0]?.text ?? '{}') as MaestroEnvelope;
  } catch {
    return { ok: false, error: 'Unparseable maestro_run envelope' };
  }
}

/** Map repair-action's failResult code → an AutoRepairRefusedReason. */
function mapRefusedReason(repairCode: string | undefined, repairError: string): AutoRepairRefusedReason {
  if (repairCode === 'SNAPSHOT_FAILED') return 'SNAPSHOT_FAILED';
  if (repairCode === 'TESTID_NOT_FOUND') return 'NO_MATCH';
  if (repairCode === 'STALE_TARGET') {
    // STALE_TARGET covers two sub-cases: external edit and budget
    // exhausted. Disambiguate by error-text matching since the handler
    // doesn't expose the sub-reason structurally yet.
    if (/repair budget/i.test(repairError)) return 'BUDGET_EXHAUSTED';
    return 'EXTERNAL_EDIT';
  }
  // Everything else (BAD_FILENAME, NO_PROJECT_ROOT) shouldn't reach
  // here on a well-formed call, but classify defensively.
  return 'NO_MATCH';
}

/**
 * Optional dependency injection for testability. Production callers
 * pass nothing and get the real handlers; tests pass stubs that return
 * pre-shaped envelopes so the orchestration logic can be exercised
 * without booting a device or running Maestro.
 */
export interface RunActionDeps {
  maestroRun?: ReturnType<typeof createMaestroRunHandler>;
  repairAction?: ReturnType<typeof createRepairActionHandler>;
}

export function createRunActionHandler(deps: RunActionDeps = {}) {
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
  const repairAction = deps.repairAction ?? createRepairActionHandler();
  return async (args: RunActionArgs): Promise<ToolResult> => {
    if (!args.actionId || typeof args.actionId !== 'string') {
      return failResult('cdp_run_action requires actionId', 'BAD_FILENAME');
    }

    const projectRoot = args.projectRoot ?? process.cwd();
    const action = loadAction(projectRoot, args.actionId);
    if (!action) {
      return failResult(
        `cdp_run_action: action "${args.actionId}" not found at ${projectRoot}/.rn-agent/actions/${args.actionId}.yaml`,
        'NO_PROJECT_ROOT',
        { hint: 'Verify with /list-learned-actions, or pass projectRoot if cdp-bridge is invoked outside the project dir.' },
      );
    }

    const autoRepairEnabled = args.autoRepair !== false;
    const trigger: 'agent' | 'ci' | 'human' = args.trigger ?? 'agent';
    const timeoutMs = args.timeoutMs ?? 120_000;
    const t0 = Date.now();

    // ─── First attempt ─────────────────────────────────────────────────
    const firstResult = await maestroRun({
      flowPath: action.filePath,
      platform: args.platform,
      timeoutMs,
    });
    const firstEnv = parseEnvelope(firstResult);
    const firstPassed = firstEnv.ok === true && firstEnv.data?.passed === true;
    const firstOutput = firstEnv.data?.output ?? firstEnv.error ?? '';

    if (firstPassed) {
      // Happy path — append RunRecord with no auto-repair, write sidecar.
      await persistRun(action, projectRoot, {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
        status: 'pass',
        trigger,
      });
      return okResult({
        passed: true,
        actionId: args.actionId,
        autoRepair: { attempted: false, outcome: 'skipped' as const, refusedReason: undefined },
        durationMs: Date.now() - t0,
        flowFile: action.filePath,
        firstAttemptOutput: firstOutput.slice(0, 500),
      });
    }

    // ─── First attempt failed — classify ───────────────────────────────
    const failure = parseMaestroFailure(firstOutput);

    // Skip repair if disabled or if the failure isn't a repair shape.
    if (!autoRepairEnabled || !isAutoRepairable(failure)) {
      const autoRepair: AutoRepairOutcome = {
        attempted: false,
        outcome: autoRepairEnabled ? 'skipped' : 'refused',
        refusedReason: autoRepairEnabled ? 'NOT_REPAIRABLE_KIND' : undefined,
      };
      const { actionCode, toolCode } = classifyFailure(failure);
      await persistRun(action, projectRoot, {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
        status: 'fail',
        failureCode: actionCode,
        failureDetail: firstOutput.slice(0, 500),
        trigger,
        autoRepair,
      });
      const meta = {
        actionId: args.actionId,
        failureKind: failure.kind,
        autoRepair,
        firstAttemptOutput: firstOutput.slice(0, 500),
      };
      const message = `cdp_run_action: ${args.actionId} failed (${failure.kind})${autoRepairEnabled ? ' — failure not auto-repairable' : ' — auto-repair disabled'}`;
      // failResult drops meta when the code arg is undefined (the (msg,
      // metaOrCode, maybeMeta) overload only stores `meta` when a code
      // string is also present). For unmapped kinds (TIMEOUT, UNKNOWN)
      // pass meta in the second slot so the autoRepair telemetry survives.
      return toolCode
        ? failResult(message, toolCode, meta)
        : failResult(message, meta);
    }

    // ─── SELECTOR_NOT_FOUND with auto-repair enabled ───────────────────
    if (failure.kind !== 'SELECTOR_NOT_FOUND') {
      // Defensive: isAutoRepairable should already exclude non-selector
      // failures, but TS doesn't narrow through `isAutoRepairable`.
      throw new Error('Internal: isAutoRepairable returned true for non-SELECTOR_NOT_FOUND failure');
    }

    const repairResult = await repairAction({
      actionId: args.actionId,
      failedSelector: failure.selector,
      projectRoot,
      agentReasoning: `auto-repair from cdp_run_action after maestro failure: ${failure.selector}`,
    });
    const repairEnv = parseEnvelope(repairResult);
    const repairPatched = repairEnv.ok === true && (repairEnv.data as { patched?: boolean })?.patched === true;

    if (!repairPatched) {
      const refusedReason = mapRefusedReason(
        (repairEnv as { code?: string }).code,
        repairEnv.error ?? '',
      );
      const autoRepair: AutoRepairOutcome = {
        attempted: true,
        outcome: 'refused',
        refusedReason,
      };
      await persistRun(action, projectRoot, {
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - t0,
        status: 'fail',
        failureCode: 'SELECTOR_NOT_FOUND',
        failureDetail: firstOutput.slice(0, 500),
        trigger,
        autoRepair,
      });
      return failResult(
        `cdp_run_action: ${args.actionId} failed with SELECTOR_NOT_FOUND; auto-repair refused (${refusedReason}): ${repairEnv.error ?? 'unknown'}`,
        'TESTID_NOT_FOUND',
        {
          actionId: args.actionId,
          autoRepair,
          repairError: repairEnv.error,
          firstAttemptOutput: firstOutput.slice(0, 500),
        },
      );
    }

    // ─── Repair succeeded — replay once ────────────────────────────────
    const repairData = repairEnv.data as {
      oldSelector: string;
      newSelector: string;
    };

    // The repair updated the action on disk. Re-load to pick up the
    // new body + bumped revision/state — saveAction's atomic pair-write
    // means we can read it back deterministically.
    const reloadedAction = loadAction(projectRoot, args.actionId);
    if (!reloadedAction) {
      // Shouldn't happen — repair just wrote it. Defensive surface.
      return failResult(
        `cdp_run_action: action disappeared between repair and retry — investigate filesystem`,
        'NO_PROJECT_ROOT',
      );
    }

    const retryResult = await maestroRun({
      flowPath: reloadedAction.filePath,
      platform: args.platform,
      timeoutMs,
    });
    const retryEnv = parseEnvelope(retryResult);
    const retryPassed = retryEnv.ok === true && retryEnv.data?.passed === true;
    const retryOutput = retryEnv.data?.output ?? retryEnv.error ?? '';

    const autoRepair: AutoRepairOutcome = {
      attempted: true,
      outcome: retryPassed ? 'passed' : 'failed',
      diff: {
        selector: { from: repairData.oldSelector, to: repairData.newSelector },
      },
    };

    await persistRun(reloadedAction, projectRoot, {
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - t0,
      status: retryPassed ? 'pass' : 'fail',
      failureCode: retryPassed ? undefined : 'SELECTOR_NOT_FOUND',
      failureDetail: retryPassed ? undefined : retryOutput.slice(0, 500),
      trigger,
      autoRepair,
    });

    if (retryPassed) {
      return okResult({
        passed: true,
        actionId: args.actionId,
        autoRepair,
        durationMs: Date.now() - t0,
        flowFile: reloadedAction.filePath,
        retriedAfterRepair: true,
        retryOutput: retryOutput.slice(0, 500),
      });
    }

    return failResult(
      `cdp_run_action: ${args.actionId} still failing after auto-repair (${repairData.oldSelector} → ${repairData.newSelector}). Retry output suggests a deeper screen change — manual investigation needed.`,
      'TESTID_NOT_FOUND',
      {
        actionId: args.actionId,
        autoRepair,
        firstAttemptOutput: firstOutput.slice(0, 500),
        retryOutput: retryOutput.slice(0, 500),
      },
    );
  };
}

/**
 * Append a RunRecord to the action's sidecar via the atomic pair-writer.
 * `loadAction` is called to refresh state in case the in-memory `action`
 * is stale (e.g. repair-action just rewrote it).
 */
async function persistRun(
  action: { filePath: string; metadata: unknown; body: string; state: unknown },
  projectRoot: string,
  record: RunRecord,
): Promise<void> {
  // Re-load to get the freshest state — repair-action may have just
  // bumped revision/repairHistory between our two saveAction calls.
  const fresh = loadAction(projectRoot, deriveActionIdFromPath(action.filePath));
  if (!fresh) return;
  const next = { ...fresh, state: appendRunRecord(fresh.state, record) };
  saveAction(next);
}

function deriveActionIdFromPath(filePath: string): string {
  // <root>/.rn-agent/actions/<id>.yaml → <id>
  const m = filePath.match(/[/\\]([^/\\]+)\.ya?ml$/);
  return m ? m[1] : '';
}
