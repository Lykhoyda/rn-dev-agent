// D1206 Tier 2 Sprint D / Phase 129 — cdp_repair_action MCP tool.
//
// Orchestrates L3→L2 self-repair when /run-action fails with
// SELECTOR_NOT_FOUND: load action, check guardrails, snapshot device,
// fuzzy-match the stale selector against current testIDs, patch the
// YAML in place, persist the repair record. Pure repair logic lives in
// domain/repair-engine.ts; this file is the I/O orchestration.
import { runAgentDevice } from '../agent-device-wrapper.js';
import { okResult, failResult, withSession } from '../utils.js';
import { loadAction, saveAction, actionWasEditedExternally, } from '../domain/action-store.js';
import { extractAllTestIDs, attemptRepair, applyRepair, DEFAULT_REPAIR_THRESHOLD, } from '../domain/repair-engine.js';
import { repairBudgetAvailable } from '../domain/reusable-action.js';
import { snapshotEnvelopeFailed } from './device-batch.js';
export function createRepairActionHandler() {
    return withSession(async (args) => {
        if (!args.actionId || typeof args.actionId !== 'string') {
            return failResult('cdp_repair_action requires actionId', 'BAD_FILENAME');
        }
        if (!args.failedSelector || typeof args.failedSelector !== 'string') {
            // Future enhancement: scan all selectors and find all stale ones.
            // For now require an explicit hint so the engine has a single target.
            return failResult('cdp_repair_action requires failedSelector — pass the testID that the prior maestro_run reported as missing', 'BAD_FILENAME', {
                hint: 'Future enhancement: scan all selectors automatically. For now, parse the maestro stderr for "Element with id \'X\' not found" and pass X here.',
            });
        }
        const projectRoot = args.projectRoot ?? process.cwd();
        const action = loadAction(projectRoot, args.actionId);
        if (!action) {
            return failResult(`cdp_repair_action: action "${args.actionId}" not found at ${projectRoot}/.rn-agent/actions/${args.actionId}.yaml`, 'NO_PROJECT_ROOT', {
                hint: 'Verify the action exists with /list-learned-actions, or pass projectRoot if cdp-bridge is invoked outside the project directory.',
            });
        }
        // Phase 129 guardrail #1: respect human edits.
        if (actionWasEditedExternally(action)) {
            return failResult(`cdp_repair_action: action "${args.actionId}" YAML mtime is newer than the agent's last write — refusing to repair. A human likely edited it; reconcile manually before re-running.`, 'STALE_TARGET', {
                actionId: args.actionId,
                filePath: action.filePath,
                lastSeenMtimeMs: action.state.lastSeenMtimeMs,
                hint: 'If you intend to overwrite the human edit, manually re-trigger /run-action — that resets the lastSeenMtimeMs.',
            });
        }
        // Phase 129 guardrail #2: rolling 24h repair budget.
        if (!repairBudgetAvailable(action.state)) {
            return failResult(`cdp_repair_action: action "${args.actionId}" exhausted its 24h repair budget — refusing to repair. The corpus is signaling churn that needs human attention.`, 'STALE_TARGET', {
                actionId: args.actionId,
                recentRepairs: action.state.repairHistory.length,
                hint: 'Investigate why this action keeps drifting — usually means the underlying screen is being heavily refactored. Either redesign the action or wait for the screen to stabilise.',
            });
        }
        // Take a fresh device snapshot to see what testIDs are currently rendered.
        const snapResult = await runAgentDevice(['snapshot', '-i']);
        const snapEnvelope = snapResult.content?.[0]?.text ?? '';
        if (snapshotEnvelopeFailed(snapEnvelope)) {
            return failResult(`cdp_repair_action: snapshot failed while gathering candidate testIDs for "${args.actionId}" — agent-device unreachable`, 'SNAPSHOT_FAILED', {
                actionId: args.actionId,
                envelope: snapEnvelope.slice(0, 500),
                hint: 'Run cdp_status / device_list to verify the device + agent-device session are healthy. Repair cannot proceed without a snapshot.',
            });
        }
        const candidates = extractAllTestIDs(snapEnvelope);
        if (candidates.length === 0) {
            return failResult(`cdp_repair_action: snapshot returned ok but contained 0 testIDs — cannot match any candidate`, 'TESTID_NOT_FOUND', {
                actionId: args.actionId,
                hint: 'The screen may not have any rendered elements with testIDs (e.g. you are on a loading screen, splash, or dev-client picker). Navigate to the target screen first.',
            });
        }
        const result = attemptRepair(action, args.failedSelector, candidates, args.threshold ?? DEFAULT_REPAIR_THRESHOLD);
        if (result.kind === 'no-stale-selector') {
            return failResult(`cdp_repair_action: ${result.reason}`, 'TESTID_NOT_FOUND', {
                actionId: args.actionId,
                failedSelector: args.failedSelector,
                bodyPreview: action.body.slice(0, 800),
            });
        }
        if (result.kind === 'no-match') {
            return failResult(`cdp_repair_action: no confident replacement for "${args.failedSelector}". ${result.reason}`, 'TESTID_NOT_FOUND', {
                actionId: args.actionId,
                failedSelector: args.failedSelector,
                bestScore: result.bestScore,
                threshold: args.threshold ?? DEFAULT_REPAIR_THRESHOLD,
                candidatesSample: candidates.slice(0, 50),
                hint: 'Either lower the threshold, or call device_snapshot manually + identify the new testID + edit the YAML by hand.',
            });
        }
        // result.kind === 'patched'
        if (args.dryRun) {
            return okResult({
                dryRun: true,
                actionId: args.actionId,
                oldSelector: result.oldSelector,
                newSelector: result.newSelector,
                score: result.score,
                replacements: result.replacements,
                diff: {
                    before: result.oldBody,
                    after: result.newBody,
                },
            });
        }
        const repaired = applyRepair(action, result, () => new Date(), args.agentReasoning);
        const { filePath, sidecarPath } = saveAction(repaired);
        return okResult({
            patched: true,
            actionId: args.actionId,
            oldSelector: result.oldSelector,
            newSelector: result.newSelector,
            score: result.score,
            replacements: result.replacements,
            newRevision: repaired.state.revision,
            newStatus: repaired.metadata.status,
            filePath,
            sidecarPath,
            hint: `Action patched. Re-run /run-action ${args.actionId} to verify. status reset to "${repaired.metadata.status}" until the next clean replay.`,
        });
    });
}
