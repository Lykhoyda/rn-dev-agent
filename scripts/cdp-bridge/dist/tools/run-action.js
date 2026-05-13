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
import { loadAction, saveActionWithCAS } from '../domain/action-store.js';
import { appendRunRecord, } from '../domain/reusable-action.js';
import { parseMaestroFailure, isAutoRepairable, } from '../domain/maestro-error-parser.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { createRepairActionHandler } from './repair-action.js';
import { isValidActionId } from '../domain/path-safety.js';
/**
 * Map a parsed Maestro failure kind to an `ActionFailureCode` (for
 * RunRecord telemetry) and a `ToolErrorCode` (for the failResult
 * envelope). The two enums overlap but are NOT identical — RunRecord
 * captures action-domain semantics, ToolErrorCode is the agent-facing
 * error contract.
 */
function classifyFailure(failure) {
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
function parseEnvelope(toolResult, toolName) {
    try {
        return JSON.parse(toolResult.content?.[0]?.text ?? '{}');
    }
    catch {
        return { ok: false, error: `Unparseable ${toolName} envelope` };
    }
}
/**
 * Multi-LLM review of PR #115 (Codex C1, conf 95): when `maestro_run`
 * catches an execFile timeout, it surfaces the partial output through
 * `meta.output` rather than `data.output`. Read both shapes so the
 * parser still sees the underlying failure even when devices are slow
 * — that's the failure mode auto-repair is most valuable for.
 */
function readMaestroOutput(env) {
    if (typeof env.data?.output === 'string')
        return env.data.output;
    const metaOutput = env.meta?.output;
    if (typeof metaOutput === 'string')
        return metaOutput;
    return env.error ?? '';
}
/**
 * Map repair-action's failResult code → an AutoRepairRefusedReason.
 *
 * TODO(repair-action structural disambiguation): the STALE_TARGET branch
 * below disambiguates BUDGET_EXHAUSTED vs EXTERNAL_EDIT by regexing the
 * error STRING ("repair budget"). Multi-LLM review of PR #115 flagged
 * this as brittle — if `repair-action.ts:101`'s wording changes
 * (e.g. shortened to "rolling-budget cap"), BUDGET_EXHAUSTED would
 * silently flip to EXTERNAL_EDIT and MTTR analytics would
 * mis-categorise every churn-driven refusal. The structural fix is to
 * have `cdp_repair_action` expose `meta.subReason: 'BUDGET_EXHAUSTED' |
 * 'EXTERNAL_EDIT'` so this function can read it directly. Filed as a
 * separate issue; the wording-lock test below at least raises the
 * alarm on regression.
 */
function mapRefusedReason(repairCode, repairError) {
    if (repairCode === 'SNAPSHOT_FAILED')
        return 'SNAPSHOT_FAILED';
    if (repairCode === 'TESTID_NOT_FOUND')
        return 'NO_MATCH';
    if (repairCode === 'STALE_TARGET') {
        if (/repair budget/i.test(repairError))
            return 'BUDGET_EXHAUSTED';
        return 'EXTERNAL_EDIT';
    }
    // Unknown / unmapped — map to INTERNAL_ERROR (NOT NO_MATCH) so MTTR
    // doesn't conflate transport / contract bugs with "screen state
    // legitimately doesn't have the testID".
    return 'INTERNAL_ERROR';
}
export function createRunActionHandler(deps = {}) {
    const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
    const repairAction = deps.repairAction ?? createRepairActionHandler();
    return async (args) => {
        if (!args.actionId || typeof args.actionId !== 'string') {
            return failResult('cdp_run_action requires actionId', 'BAD_FILENAME');
        }
        // Phase 134.3 (deepsec HIGH path-traversal): same chokepoint as
        // cdp_repair_action — actionId flows into the .rn-agent/actions/
        // path segment. Reject malicious slugs at the boundary.
        if (!isValidActionId(args.actionId)) {
            return failResult(`Invalid actionId "${String(args.actionId).slice(0, 80)}" — must match /^[A-Za-z0-9][A-Za-z0-9_-]*$/ and be <= 64 chars`, 'BAD_FILENAME');
        }
        const projectRoot = args.projectRoot ?? process.cwd();
        const action = loadAction(projectRoot, args.actionId);
        if (!action) {
            return failResult(`cdp_run_action: action "${args.actionId}" not found at ${projectRoot}/.rn-agent/actions/${args.actionId}.yaml`, 'NO_PROJECT_ROOT', { hint: 'Verify with /list-learned-actions, or pass projectRoot if cdp-bridge is invoked outside the project dir.' });
        }
        const autoRepairEnabled = args.autoRepair !== false;
        const trigger = args.trigger ?? 'agent';
        const timeoutMs = args.timeoutMs ?? 120_000;
        const t0 = Date.now();
        // Multi-LLM review of PR #115 (Gemini conf 95): wrap the orchestration
        // body so a thrown exception (maestroRun timeout, repairAction
        // throwing through withSession, etc.) is caught and surfaces as a
        // structured failResult WITH a persisted RunRecord, instead of
        // bubbling up unwrapped to the MCP framework.
        try {
            // ─── First attempt ───────────────────────────────────────────────
            // Issue #120: capture per-phase timing so MTTR analysis (#105) can
            // distinguish "fast detection / slow repair" from "slow detection
            // / fast repair". Phase boundaries: t0 → tFirstDone → tRepairDone
            // → tRetryDone.
            const tBeforeFirst = Date.now();
            const firstResult = await maestroRun({
                flowPath: action.filePath,
                platform: args.platform,
                timeoutMs,
                params: args.params,
            });
            const firstAttemptMs = Date.now() - tBeforeFirst;
            const firstEnv = parseEnvelope(firstResult, 'maestro_run');
            const firstPassed = firstEnv.ok === true && firstEnv.data?.passed === true;
            const firstOutput = readMaestroOutput(firstEnv);
            if (firstPassed) {
                // Happy path — append RunRecord with no auto-repair.
                const autoRepair = {
                    attempted: false,
                    outcome: 'skipped',
                    phases: { firstAttemptMs },
                };
                await persistRun(args.actionId, projectRoot, {
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - t0,
                    status: 'pass',
                    trigger,
                    autoRepair,
                });
                return okResult({
                    passed: true,
                    actionId: args.actionId,
                    autoRepair,
                    durationMs: Date.now() - t0,
                    flowFile: action.filePath,
                    firstAttemptOutput: firstOutput.slice(0, 500),
                });
            }
            // ─── First attempt failed — classify ─────────────────────────────
            const failure = parseMaestroFailure(firstOutput);
            // Skip repair if disabled or if the failure isn't a repair shape.
            if (!autoRepairEnabled || !isAutoRepairable(failure)) {
                // PR #115 review (both providers conf 88): distinguish opt-out
                // (USER_DISABLED) from the kind-not-repairable skip path so MTTR
                // analysis can tell "user said no" from "kind isn't repairable".
                const autoRepair = autoRepairEnabled
                    ? { attempted: false, outcome: 'skipped', refusedReason: 'NOT_REPAIRABLE_KIND', phases: { firstAttemptMs } }
                    : { attempted: false, outcome: 'refused', refusedReason: 'USER_DISABLED', phases: { firstAttemptMs } };
                const { actionCode, toolCode } = classifyFailure(failure);
                await persistRun(args.actionId, projectRoot, {
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
                return toolCode
                    ? failResult(message, toolCode, meta)
                    : failResult(message, meta);
            }
            // ─── SELECTOR_NOT_FOUND with auto-repair enabled ─────────────────
            if (failure.kind !== 'SELECTOR_NOT_FOUND') {
                // Defensive: isAutoRepairable should already exclude non-selector
                // failures, but TS doesn't narrow through `isAutoRepairable`.
                // PR #115 review (Codex conf 80): bare `throw` here was uncaught
                // — now lands in the outer catch and becomes a structured
                // failResult + persisted RunRecord.
                throw new Error('Internal: isAutoRepairable returned true for non-SELECTOR_NOT_FOUND failure');
            }
            const tBeforeRepair = Date.now();
            const repairResult = await repairAction({
                actionId: args.actionId,
                failedSelector: failure.selector,
                projectRoot,
                agentReasoning: `auto-repair from cdp_run_action after maestro failure: ${failure.selector}`,
            });
            const repairMs = Date.now() - tBeforeRepair;
            const repairEnv = parseEnvelope(repairResult, 'cdp_repair_action');
            const repairPatched = repairEnv.ok === true && repairEnv.data?.patched === true;
            if (!repairPatched) {
                const refusedReason = mapRefusedReason(repairEnv.code, repairEnv.error ?? '');
                const autoRepair = {
                    attempted: true,
                    outcome: 'refused',
                    refusedReason,
                    phases: { firstAttemptMs, repairMs },
                };
                await persistRun(args.actionId, projectRoot, {
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - t0,
                    status: 'fail',
                    failureCode: 'SELECTOR_NOT_FOUND',
                    failureDetail: firstOutput.slice(0, 500),
                    trigger,
                    autoRepair,
                });
                return failResult(`cdp_run_action: ${args.actionId} failed with SELECTOR_NOT_FOUND; auto-repair refused (${refusedReason}): ${repairEnv.error ?? 'unknown'}`, 'TESTID_NOT_FOUND', {
                    actionId: args.actionId,
                    autoRepair,
                    repairError: repairEnv.error,
                    firstAttemptOutput: firstOutput.slice(0, 500),
                });
            }
            // ─── Repair succeeded — replay once ──────────────────────────────
            const repairData = repairEnv.data;
            // The repair updated the action on disk. Re-load to pick up the
            // new body + bumped revision/state — saveAction's atomic pair-write
            // means we can read it back deterministically.
            const reloadedAction = loadAction(projectRoot, args.actionId);
            if (!reloadedAction) {
                // Shouldn't happen — repair just wrote it. Defensive surface.
                // Persist the failure RunRecord so MTTR sees the outcome.
                await persistRun(args.actionId, projectRoot, {
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - t0,
                    status: 'fail',
                    failureCode: 'UNKNOWN',
                    failureDetail: 'action disappeared between repair and retry',
                    trigger,
                    autoRepair: {
                        attempted: true,
                        outcome: 'refused',
                        refusedReason: 'INTERNAL_ERROR',
                        phases: { firstAttemptMs, repairMs },
                    },
                });
                return failResult(`cdp_run_action: action disappeared between repair and retry — investigate filesystem`, 'NO_PROJECT_ROOT');
            }
            const tBeforeRetry = Date.now();
            const retryResult = await maestroRun({
                flowPath: reloadedAction.filePath,
                platform: args.platform,
                timeoutMs,
                params: args.params,
            });
            const retryMs = Date.now() - tBeforeRetry;
            const retryEnv = parseEnvelope(retryResult, 'maestro_run');
            const retryPassed = retryEnv.ok === true && retryEnv.data?.passed === true;
            const retryOutput = readMaestroOutput(retryEnv);
            // Issue #120: pull the repair-engine's similarity score and the
            // RepairRecord's timestamp into the AutoRepairOutcome so MTTR can
            // both rank patches by confidence and cross-reference to the
            // RepairRecord without timestamp-fuzzy-matching.
            const repairScore = repairEnv.data?.score;
            const repairTimestamp = reloadedAction.state.repairHistory.length > 0
                ? reloadedAction.state.repairHistory[reloadedAction.state.repairHistory.length - 1].timestamp
                : undefined;
            const autoRepair = {
                attempted: true,
                outcome: retryPassed ? 'passed' : 'failed',
                diff: {
                    selector: {
                        from: repairData.oldSelector,
                        to: repairData.newSelector,
                        ...(typeof repairScore === 'number' ? { score: repairScore } : {}),
                    },
                },
                phases: { firstAttemptMs, repairMs, retryMs },
                repairTimestamp,
            };
            await persistRun(args.actionId, projectRoot, {
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
            return failResult(`cdp_run_action: ${args.actionId} still failing after auto-repair (${repairData.oldSelector} → ${repairData.newSelector}). Retry output suggests a deeper screen change — manual investigation needed.`, 'TESTID_NOT_FOUND', {
                actionId: args.actionId,
                autoRepair,
                firstAttemptOutput: firstOutput.slice(0, 500),
                retryOutput: retryOutput.slice(0, 500),
            });
        }
        catch (err) {
            // Multi-LLM review of PR #115 (Gemini conf 95): top-level catch
            // ensures any thrown exception during orchestration (maestroRun
            // timeout, repairAction throw through withSession, etc.) lands
            // here as a structured failResult WITH a persisted RunRecord —
            // not as an uncaught exception that crashes the MCP request and
            // loses telemetry entirely.
            const msg = err instanceof Error ? err.message : String(err);
            const autoRepair = {
                attempted: false,
                outcome: 'refused',
                refusedReason: 'INTERNAL_ERROR',
            };
            try {
                await persistRun(args.actionId, projectRoot, {
                    timestamp: new Date().toISOString(),
                    durationMs: Date.now() - t0,
                    status: 'fail',
                    failureCode: 'UNKNOWN',
                    failureDetail: `Internal error: ${msg.slice(0, 400)}`,
                    trigger,
                    autoRepair,
                });
            }
            catch {
                // Don't let a persistence failure mask the original error —
                // surface the original exception via failResult below.
            }
            return failResult(`cdp_run_action: ${args.actionId} threw an uncaught exception during orchestration: ${msg.slice(0, 500)}`, { actionId: args.actionId, autoRepair, internalError: msg.slice(0, 500) });
        }
    };
}
/**
 * Append a RunRecord to the action's sidecar via the atomic pair-writer.
 *
 * Multi-LLM review of PR #115:
 *   - Codex I6 (conf 80): `actionId` is now passed explicitly rather
 *     than derived from `action.filePath`. The previous regex-based
 *     derivation broke for non-canonical paths (inline-yaml synthetic
 *     paths, symlinks) and silently dropped the RunRecord on a derive
 *     failure.
 *   - Codex C2 / Gemini C2 (conf 92): if `loadAction` returns null we
 *     log the dropped record to stderr instead of swallowing silently
 *     so the operator can see telemetry loss in their MCP logs.
 */
async function persistRun(actionId, projectRoot, record) {
    // Re-load to get the freshest state — repair-action may have just
    // bumped revision/repairHistory between our two saveAction calls.
    // Issue #117: lost-update guard via CAS + bounded retry. Two
    // concurrent `cdp_run_action` calls against the same actionId would
    // otherwise interleave their read-modify-write and lose one
    // RunRecord. saveActionWithCAS detects an in-flight conflict by
    // comparing on-disk lastSeenMtimeMs to the snapshot we loaded; on
    // conflict, reload + retry. Bounded at 5 attempts so persistent
    // contention surfaces as a console.error instead of a hang.
    const MAX_ATTEMPTS = 5;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        const fresh = loadAction(projectRoot, actionId);
        if (!fresh) {
            console.error(`cdp_run_action: persistRun could not reload action "${actionId}" — RunRecord dropped (status=${record.status}, autoRepair.outcome=${record.autoRepair?.outcome ?? 'n/a'})`);
            return;
        }
        const next = { ...fresh, state: appendRunRecord(fresh.state, record) };
        const result = saveActionWithCAS(next);
        if (result.ok)
            return;
        // CAS conflict — another writer raced us. Reload and retry.
        if (attempt === MAX_ATTEMPTS) {
            console.error(`cdp_run_action: persistRun for "${actionId}" hit ${MAX_ATTEMPTS} consecutive CAS conflicts; ` +
                `disk mtime=${result.diskMtimeMs}, expected=${result.expectedMtimeMs}. ` +
                `RunRecord dropped — investigate concurrent writers.`);
            return;
        }
    }
}
