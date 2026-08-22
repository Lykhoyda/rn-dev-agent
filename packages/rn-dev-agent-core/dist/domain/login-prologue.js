import { createHash, timingSafeEqual } from 'node:crypto';
export const LOGIN_PROLOGUE_ALIAS = 'user-login';
export const LOGIN_PROLOGUE_BLOCKED = 'LOGIN_PROLOGUE_BLOCKED';
export const ACTION_LOGIN_HELPER = 'ACTION_LOGIN_HELPER';
export const LOCKED_E2E_LOGIN_TOOLS = ['cdp_lock_e2e_test', 'cdp_run_e2e_suite'];
export function readLoginPrologueOutcome(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return null;
    const candidate = value;
    if (candidate.schemaVersion !== 1 ||
        candidate.alias !== LOGIN_PROLOGUE_ALIAS ||
        (candidate.state !== 'passed' && candidate.state !== LOGIN_PROLOGUE_BLOCKED) ||
        typeof candidate.startedAt !== 'string' ||
        typeof candidate.endedAt !== 'string' ||
        typeof candidate.elapsedMs !== 'number' ||
        !Array.isArray(candidate.steps)) {
        return null;
    }
    return candidate;
}
function lockedE2eProofAllowed(tool, args, resolvedLockedTestIds) {
    if (tool === 'cdp_lock_e2e_test')
        return args.actionId === LOGIN_PROLOGUE_ALIAS;
    if (tool === 'cdp_run_e2e_suite') {
        return resolvedLockedTestIds?.length === 1 && resolvedLockedTestIds[0] === LOGIN_PROLOGUE_ALIAS;
    }
    return false;
}
function cleanupAllowed(tool, args) {
    if (tool === 'cdp_login_prologue')
        return true;
    if (tool === 'cdp_disconnect')
        return true;
    if (tool === 'device_snapshot' && args.action === 'close')
        return true;
    if (tool === 'device_record' && (args.action === 'stop' || args.action === 'status'))
        return true;
    if (tool === 'observe' && (args.action === 'stop' || args.action === 'status'))
        return true;
    if (tool === 'proof_capture' && (args.action === 'discard' || args.action === 'status')) {
        return true;
    }
    return (tool === 'rn_session' &&
        (args.action === 'release' ||
            args.action === 'stop_metro' ||
            args.action === 'cancel_handoff' ||
            args.action === 'status'));
}
function tokenMatches(expected, supplied) {
    if (!expected || expected.length < 16 || !supplied || supplied.length < 16)
        return false;
    const expectedHash = createHash('sha256').update(expected).digest();
    const suppliedHash = createHash('sha256').update(supplied).digest();
    return timingSafeEqual(expectedHash, suppliedHash);
}
export function inspectLoginPrologueGuard(input) {
    const outcome = readLoginPrologueOutcome(input.binding);
    if (outcome?.state !== LOGIN_PROLOGUE_BLOCKED ||
        !input.mutation ||
        cleanupAllowed(input.tool, input.args) ||
        lockedE2eProofAllowed(input.tool, input.args, input.resolvedLockedTestIds)) {
        return { blocked: false };
    }
    return {
        blocked: true,
        suppliedOverride: typeof input.args.supervisorOverrideToken === 'string'
            ? input.args.supervisorOverrideToken
            : undefined,
    };
}
export function authorizeLoginSupervisorOverride(input) {
    if (!tokenMatches(input.expectedOverrideToken, input.suppliedOverrideToken))
        return null;
    return { tool: input.tool, usedAt: (input.now ?? (() => new Date()))().toISOString() };
}
export function evaluateLoginPrologueGuard(input) {
    const inspection = inspectLoginPrologueGuard(input);
    if (!inspection.blocked)
        return { allowed: true, override: false };
    const audit = authorizeLoginSupervisorOverride({
        expectedOverrideToken: input.expectedOverrideToken,
        suppliedOverrideToken: inspection.suppliedOverride,
        tool: input.tool,
        now: input.now,
    });
    return audit
        ? { allowed: true, override: true, audit }
        : { allowed: false, suppliedOverride: inspection.suppliedOverride !== undefined };
}
export function appendLoginOverrideAudit(outcome, audit) {
    return { ...outcome, overrides: [...(outcome.overrides ?? []), audit].slice(-20) };
}
