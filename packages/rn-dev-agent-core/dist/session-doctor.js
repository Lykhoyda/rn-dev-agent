#!/usr/bin/env node
// GH #792: headless recovery for a wedged source root, usable where /mcp is not.
// `repair` runs the same proven-dead startup cleanup a fresh transport runs.
import { parseDeclaredManifests } from './session/declared-source-contract.js';
import { inspectSessionOwner } from './session/process-owner.js';
import { openSessionRegistry, SessionAuthorityError, } from './session/registry.js';
import { HEADLESS_SESSION_RECOVERY_COMMAND, sessionCleanupObligationRemedy, sessionOwnerInspectionRemedy, sessionRecoveryRemedy, } from './session/recovery-remedy.js';
import { resolveSourceIdentity } from './session/source-identity.js';
import { runStartupCleanupForSource } from './session/startup-cleanup.js';
import { resolveAuthorityStateLayout } from './session/state-root.js';
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
    if (ownership.owner === 'absent') {
        return 'No same-root owner holds this worktree; nothing to recover.';
    }
    if (!ownership.sameRoot) {
        if (ownership.owner === 'live') {
            return sessionOwnerInspectionRemedy('A live owner of a different app root or declared source in this worktree holds it.');
        }
        if (ownership.owner === 'unprovable') {
            return sessionOwnerInspectionRemedy('The identity of the owner holding this worktree could not be proven, so it is treated as live; it belongs to a different app root or declared source.');
        }
        return sessionOwnerInspectionRemedy('The proven-dead owner belongs to a different app root or declared source in this worktree, so this root cannot release it.');
    }
    if (ownership.owner === 'live') {
        return sessionOwnerInspectionRemedy('A live same-root owner holds this worktree.');
    }
    if (ownership.owner === 'unprovable') {
        return sessionOwnerInspectionRemedy('The same-root owner identity could not be proven, so it is treated as live.');
    }
    if (ownership.startupCleanupBlocked) {
        const blocked = ownership.startupCleanupBlocked;
        return sessionCleanupObligationRemedy(`The prior owner is proven dead, but startup cleanup refused with ${blocked.code} and will refuse again until that is resolved: ${blocked.reason}.`);
    }
    return sessionRecoveryRemedy('The prior owner is proven dead and can be released now.');
}
// Nothing this root can release by itself: an unprovable owner, a retained refusal, or
// another root's owner. A live owner is excluded — it self-heals when that session closes.
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
    const layout = resolveAuthorityStateLayout(stateDir());
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
    const layout = resolveAuthorityStateLayout(stateDir());
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
    const message = error instanceof Error ? error.message : String(error);
    const typed = /^([A-Z][A-Z0-9_]+): ([\s\S]*)$/.exec(message);
    const code = error instanceof SessionAuthorityError ? error.code : (typed?.[1] ?? 'SESSION_DOCTOR_FAILED');
    const detail = typed !== null && typed[1] === code ? (typed[2] ?? message) : message;
    // Repairing cannot resolve an unusable state home, so that failure names its own remedy.
    const remedy = code.startsWith('AUTHORITY_STATE_')
        ? 'Point RN_DEV_AGENT_STATE_DIR at the authority state home that holds this session, or unset it to use the default.'
        : `Run ${HEADLESS_SESSION_RECOVERY_COMMAND} from the app root that owns this session.`;
    process.stderr.write(`${code}: ${detail}\n${remedy}\n`);
    process.exitCode = 1;
});
