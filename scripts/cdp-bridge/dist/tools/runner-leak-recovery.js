const RUNNER_APP_LABEL = 'AgentDeviceRunner';
const RUNNER_VISIBLE_TEXT = 'Agent Device Runner';
const RUNNER_FINGERPRINT_IDENTIFIERS = new Set(['Logo', 'PoweredBy']);
const SMALL_TREE_THRESHOLD = 12;
/**
 * B119/GH#35: detect when an iOS snapshot returned AgentDeviceRunner's own UI
 * tree instead of the session's target app. This happens when the agent-device
 * daemon dispatches a command to the Swift runner without `appBundleId`,
 * causing RunnerTests+CommandExecution.swift:111-122 to clear `currentApp`
 * and activate the runner itself. Snapshot succeeds but returns the wrong
 * tree (~6 nodes including the runner's splash UI).
 *
 * Heuristic — both must hold:
 *   1. Tree is small (<= 12 nodes) — real app trees are larger.
 *   2. Either: any node label === "AgentDeviceRunner" (the Application node),
 *      OR (visible "Agent Device Runner" text AND a fingerprint identifier).
 *
 * The double-check guards against rare false positives where a real app
 * happens to contain the literal string "AgentDeviceRunner" but has many
 * other elements.
 */
export function isAgentDeviceRunnerSentinel(nodes) {
    if (!nodes || nodes.length === 0)
        return false;
    if (nodes.length > SMALL_TREE_THRESHOLD)
        return false;
    const hasRunnerAppLabel = nodes.some((n) => n.label === RUNNER_APP_LABEL);
    if (hasRunnerAppLabel)
        return true;
    const hasVisibleText = nodes.some((n) => n.label === RUNNER_VISIBLE_TEXT);
    const hasFingerprintId = nodes.some((n) => n.identifier !== undefined && RUNNER_FINGERPRINT_IDENTIFIERS.has(n.identifier));
    return hasVisibleText && hasFingerprintId;
}
const DAEMON_SETTLE_MS = 600;
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * B119: attempt to recover from the runner-leak failure mode in two tiers.
 *
 *   Tier 1 — attachOnly reopen. Preserves the user's app state (JS heap,
 *   Hermes context, navigation stack, store state, form input). LIMITATION:
 *   agent-device's attachOnly mode opens a session WITHOUT passing the
 *   bundleId positional, so the daemon's SessionState.appBundleId stays
 *   unset — meaning the very condition that triggers the leak persists. In
 *   practice tier-1 will usually fail for this specific bug, but it's a
 *   cheap try and would help in any adjacent failure mode where attaching
 *   is enough.
 *
 *   Tier 2 — full app relaunch. Destructive (kills CDP context, drops
 *   in-memory state, resets navigation, wipes ring buffers) but gives the
 *   daemon a clean SessionState with appBundleId set.
 *
 * Returns { recovered: false } when prerequisites aren't met (no stored
 * appId, non-iOS, or already-attempted). Caller decides whether to map
 * that to a hard failure or a softer null/undefined sentinel.
 */
export async function recoverFromRunnerLeak(ctx, deps) {
    if (ctx.alreadyRecovered) {
        return { recovered: false, result: emptyResult(), reason: 'already-attempted' };
    }
    if ((ctx.platform ?? 'ios').toLowerCase() !== 'ios') {
        return { recovered: false, result: emptyResult(), reason: 'wrong-platform' };
    }
    if (!ctx.appId) {
        return { recovered: false, result: emptyResult(), reason: 'no-session-context' };
    }
    const sleep = deps.sleep ?? defaultSleep;
    // Tier 1: attachOnly reopen — preserves app state when it works.
    const tier1 = await attemptRecoveryCycle(ctx, deps, true, sleep);
    if (tier1.phase === 'success') {
        return { recovered: true, result: tier1.result, tier: 'attach-only' };
    }
    // Tier 2: full app relaunch — destructive but resets daemon state cleanly.
    const tier2 = await attemptRecoveryCycle(ctx, deps, false, sleep);
    if (tier2.phase === 'success') {
        return { recovered: true, result: tier2.result, tier: 'full-relaunch' };
    }
    if (tier2.phase === 'sentinel') {
        return { recovered: false, result: tier2.result, reason: 'still-sentinel' };
    }
    return { recovered: false, result: tier2.result, reason: 'reopen-failed' };
}
async function attemptRecoveryCycle(ctx, deps, attachOnly, sleep) {
    await deps.closeSession();
    await sleep(DAEMON_SETTLE_MS);
    const reopenResult = await deps.openSession({
        appId: ctx.appId,
        platform: 'ios',
        sessionName: ctx.sessionName,
        attachOnly,
    });
    if (reopenResult.isError) {
        return { phase: 'reopen-failed', result: reopenResult };
    }
    const retryResult = await deps.resnapshot();
    if (retryResult.isError) {
        return { phase: 'snapshot-failed', result: retryResult };
    }
    if (isAgentDeviceRunnerSentinel(deps.parseNodes(retryResult))) {
        return { phase: 'sentinel', result: retryResult };
    }
    return { phase: 'success', result: retryResult };
}
function emptyResult() {
    return { content: [{ type: 'text', text: '' }] };
}
