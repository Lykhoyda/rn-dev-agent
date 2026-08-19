#!/usr/bin/env node
// GH #792: headless recovery for a wedged source root, usable where /mcp is not.
// `repair` runs the same proven-dead startup cleanup a fresh transport runs.
import { parseDeclaredManifests } from './session/declared-source-contract.js';
import { inspectSessionOwner } from './session/process-owner.js';
import { openSessionRegistry, SessionAuthorityError, } from './session/registry.js';
import { HEADLESS_SESSION_RECOVERY_COMMAND, sessionOwnerInspectionRemedy, sessionRecoveryRemedy, } from './session/recovery-remedy.js';
import { resolveSourceIdentity } from './session/source-identity.js';
import { runStartupCleanupForSource } from './session/startup-cleanup.js';
import { createAuthorityStateLayout } from './session/state-root.js';
const USAGE = 'usage: session-doctor [report|repair] [--json]\n' +
    '  report  releases nothing: is this source root wedged, and by what\n' +
    '  repair  release a proven-dead same-root owner and reap abandoned contenders\n';
function resolveSource() {
    return resolveSourceIdentity(process.cwd(), {
        declaredRoot: process.env.RN_DEV_AGENT_DECLARED_ROOT,
        declaredManifests: parseDeclaredManifests(process.env.RN_DEV_AGENT_DECLARED_MANIFESTS),
    });
}
function stateDir() {
    return process.env.RN_DEV_AGENT_STATE_DIR || undefined;
}
function remedyFor(ownership) {
    if (ownership.owner === 'live') {
        return sessionOwnerInspectionRemedy('A live same-root owner holds this worktree.');
    }
    if (ownership.owner === 'unprovable') {
        return sessionOwnerInspectionRemedy('The same-root owner identity could not be proven, so it is treated as live.');
    }
    if (ownership.owner === 'stale' && !ownership.sameRoot) {
        return sessionOwnerInspectionRemedy('The proven-dead owner belongs to a different app root or declared source in this worktree, so this root cannot release it.');
    }
    if (ownership.owner === 'stale') {
        return sessionRecoveryRemedy('The prior owner is proven dead and can be released now.');
    }
    return 'No same-root owner holds this worktree; nothing to recover.';
}
/** Nothing this root can release by itself: a live or unprovable owner, a retained refusal, or another root's owner. */
function isWedged(ownership) {
    if (ownership.owner === 'unprovable')
        return true;
    if (ownership.owner !== 'stale')
        return false;
    return !ownership.sameRoot || ownership.startupCleanupBlocked !== undefined;
}
/** A proven-dead owner of this exact root — `repair` (or the next transport) releases it. */
function isRepairable(ownership) {
    return ownership.owner === 'stale' && ownership.sameRoot && !isWedged(ownership);
}
function inspect() {
    const layout = createAuthorityStateLayout(stateDir());
    const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
    try {
        return { ownership: registry.inspectSourceOwnership(resolveSource()), layout };
    }
    finally {
        registry.close();
    }
}
function report() {
    const source = resolveSource();
    const { ownership, layout } = inspect();
    return {
        ok: !isWedged(ownership),
        payload: {
            authorityStore: layout.registry,
            appRoot: source.appRoot,
            worktree: source.worktreeKey.slice(0, 12),
            sameRootOwner: ownership.owner,
            ownerIsThisRoot: ownership.sameRoot,
            abandonedContenders: ownership.abandonedContenders,
            wedged: isWedged(ownership),
            repairable: isRepairable(ownership),
            ...(ownership.startupCleanupBlocked
                ? { startupCleanupBlocked: ownership.startupCleanupBlocked }
                : {}),
            remedy: remedyFor(ownership),
        },
    };
}
async function repair() {
    const source = resolveSource();
    const layout = createAuthorityStateLayout(stateDir());
    const outcome = await runStartupCleanupForSource({
        source,
        stateDir: stateDir(),
        ownerStatus: inspectSessionOwner,
    });
    // `clean` only means cleanup released nothing it was allowed to touch; an owner of
    // another app root leaves this root just as unusable.
    const ownership = inspect().ownership;
    const wedged = isWedged(ownership);
    return {
        ok: outcome.status === 'clean' && !wedged,
        payload: {
            authorityStore: layout.registry,
            appRoot: source.appRoot,
            status: outcome.status,
            released: outcome.released,
            discardedContenders: outcome.discardedContenders,
            wedged,
            ...(outcome.refusal ? { refusal: outcome.refusal } : {}),
            remedy: wedged || ownership.owner === 'live'
                ? remedyFor(ownership)
                : outcome.status === 'clean'
                    ? 'This source root is recoverable now; start rn-dev-agent here again.'
                    : (outcome.refusal?.nextAction ??
                        sessionRecoveryRemedy('Startup cleanup preserved the prior owner.')),
        },
    };
}
function write(payload, json) {
    if (json) {
        process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
        return;
    }
    for (const [key, value] of Object.entries(payload)) {
        process.stdout.write(`${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}\n`);
    }
}
async function main() {
    const positional = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
    const json = process.argv.includes('--json');
    const command = positional[0] ?? 'report';
    if (command !== 'report' && command !== 'repair') {
        process.stderr.write(USAGE);
        process.exitCode = 2;
        return;
    }
    const result = command === 'report' ? report() : await repair();
    write(result.payload, json);
    process.exitCode = result.ok ? 0 : 1;
}
main().catch((error) => {
    const code = error instanceof SessionAuthorityError ? error.code : 'SESSION_DOCTOR_FAILED';
    process.stderr.write(`${code}: ${error instanceof Error ? error.message : String(error)}\n` +
        `Run ${HEADLESS_SESSION_RECOVERY_COMMAND} from the app root that owns this session.\n`);
    process.exitCode = 1;
});
