import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonStateFile } from '../util/secure-state-file.js';
import { stopManagedMetro } from './managed-metro.js';
import { removeAndroidMetroReverse, } from './android-metro-reverse.js';
import { readPackageIntegrationInputs, restorePackageIntegrationFiles, } from './package-integration.js';
import { stopBoundObserve, stopBoundRecorder, stopBoundRunner } from './process-cleanup.js';
import { openSessionRegistry, SessionAuthorityError, } from './registry.js';
import { createAuthorityStateLayout } from './state-root.js';
export function startupCleanupFailureMessage() {
    return 'rn-dev-agent startup cleanup failed: STARTUP_CLEANUP_FAILED\n';
}
const EXECUTION_ORDER = [
    'androidMetroReverse',
    'recorder',
    'runner',
    'observe',
    'metro',
];
/**
 * L4: release a proven-dead same-root owner at supervisor startup. Obligations run
 * against the durable journal on the dead session's row; a live or unproven owner —
 * or any unproven obligation — yields a typed refusal and leaves everything in place.
 */
export async function runStartupOwnerCleanup(input, dependencies = {}) {
    const released = [];
    for (let round = 0; round < 8; round += 1) {
        const candidate = input.registry.findStartupCleanupCandidate(input);
        if (!candidate)
            return { status: 'clean', released };
        try {
            const plan = input.registry.beginStartupOwnerCleanup(candidate);
            await completeObligations(input.registry, candidate, dependencies);
            restoreDeadOwnerIntegration(input, candidate, plan, dependencies);
            input.registry.finishStartupOwnerCleanup(candidate);
            released.push(candidate.sessionId);
        }
        catch (error) {
            const refusal = refusalOf(error);
            retainRefusal(input.registry, candidate, refusal);
            return { status: 'refused', released, refusal };
        }
    }
    return {
        status: 'refused',
        released,
        refusal: publicRefusal({
            code: 'RESOURCE_CLAIM_CONFLICT',
            message: 'startup cleanup did not converge for this worktree',
        }),
    };
}
/** Open the shared authority registry and run the cleanup for one resolved source. */
export async function runStartupCleanupForSource(input) {
    const layout = createAuthorityStateLayout(input.stateDir);
    const registry = openSessionRegistry(layout.registry, {
        ownerStatus: input.ownerStatus,
        leaseMs: 30_000,
    });
    try {
        return await runStartupOwnerCleanup({
            registry,
            sourceKey: input.source.sourceKey,
            worktreeKey: input.source.worktreeKey,
            appRootKey: input.source.appRootKey,
            appRoot: input.source.appRoot,
        }, {
            readSessionSecret: (sessionId) => readJsonStateFile(join(layout.sessions, sessionId, 'secret.json')),
        });
    }
    finally {
        registry.close();
    }
}
async function completeObligations(registry, prior, dependencies) {
    for (const resource of EXECUTION_ORDER) {
        const entry = registry.verifyStartupOwnerObligation(prior, resource);
        if (!entry || typeof entry.completedAt === 'number')
            continue;
        if (resource === 'androidMetroReverse') {
            (dependencies.removeAndroidMetroReverse ?? removeAndroidMetroReverse)(entry);
        }
        else if (resource === 'recorder') {
            await (dependencies.stopBoundRecorder ?? stopBoundRecorder)(entry);
        }
        else if (resource === 'runner') {
            await (dependencies.stopBoundRunner ?? stopBoundRunner)(entry);
        }
        else if (resource === 'observe') {
            await (dependencies.stopBoundObserve ?? stopBoundObserve)(entry);
        }
        else {
            const secret = dependencies.readSessionSecret?.(prior.sessionId) ?? null;
            const signerCapability = typeof secret?.signerCapability === 'string' ? secret.signerCapability : '';
            const stop = dependencies.stopManagedMetro ??
                ((binding, stopInput) => stopManagedMetro(binding, stopInput));
            const stopped = await stop(entry, { sessionId: prior.sessionId, signerCapability });
            if (!stopped) {
                throw new SessionAuthorityError('METRO_CLEANUP_PENDING', 'managed Metro could not be stopped with exact process authority');
            }
        }
        registry.completeStartupOwnerObligation(prior, resource);
    }
}
function restoreDeadOwnerIntegration(input, prior, plan, dependencies) {
    if (!plan.integration || typeof plan.integration.completedAt === 'number')
        return;
    const binding = input.registry.getSessionStatus(prior.sessionId)?.bindings.packageIntegration;
    if (!binding || typeof binding !== 'object')
        return;
    const manifestSha256 = typeof binding.manifestSha256 === 'string' ? binding.manifestSha256 : '';
    const manifestSource = verifiedDeadOwnerManifestSource(input.appRoot, binding, manifestSha256);
    if (!manifestSource) {
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'integration restoration requires a SHA-256-verified manifest and none is available; the dead owner binding is preserved', undefined, {
            nextAction: 'Restore the exact integration manifest at .rn-agent/integration/rn-session-integration.json from your own version control history or backups so it matches the manifest SHA-256 recorded on the binding, then restart the MCP transport.',
        });
    }
    input.registry.verifyStartupOwnerIntegrationRestore(prior, {
        sourceKey: input.sourceKey,
        worktreeKey: input.worktreeKey,
        appRootKey: input.appRootKey,
        manifestSha256,
    });
    (dependencies.restoreIntegrationFiles ?? restorePackageIntegrationFiles)({
        appRoot: input.appRoot,
        manifestSource,
    });
    input.registry.completeStartupOwnerIntegrationRestore(prior, { manifestSha256 });
}
function verifiedDeadOwnerManifestSource(appRoot, binding, manifestSha256) {
    if (!/^[0-9a-f]{64}$/.test(manifestSha256))
        return undefined;
    const verified = (candidate) => typeof candidate === 'string' &&
        createHash('sha256').update(candidate).digest('hex') === manifestSha256
        ? candidate
        : undefined;
    let liveManifest;
    try {
        liveManifest = readPackageIntegrationInputs(appRoot).manifest ?? undefined;
    }
    catch {
        liveManifest = undefined;
    }
    const phase = (value) => value && typeof value === 'object' ? value : null;
    const restoration = phase(binding.restoration);
    const installation = phase(binding.installation);
    return (verified(liveManifest) ??
        verified(restoration?.phase === 'started' ? restoration.manifestSource : undefined) ??
        verified(installation?.phase === 'started' ? installation.manifestSource : undefined) ??
        verified(binding.manifestSource));
}
/** Best-effort because an early refusal may predate the cleanup journal. */
function retainRefusal(registry, prior, refusal) {
    try {
        registry.recordStartupCleanupRefusal(prior, {
            code: refusal.code,
            reason: refusal.message,
            ...(refusal.nextAction ? { nextAction: refusal.nextAction } : {}),
        });
    }
    catch {
        // The original refusal remains authoritative.
    }
}
/**
 * The refusal reasons this cleanup path itself authors. Every one is a static,
 * identifier-free sentence. Being a `SessionAuthorityError` is NOT evidence of that:
 * a claim conflict renders `device:<udid> is held`, and process cleanup wraps an
 * underlying `adb`/recorder message that carries serials, PIDs, and paths. So the
 * allowlist is by exact text, and anything absent from it degrades to a generic
 * reason — a new authored refusal loses detail rather than leaking identity.
 */
const PUBLIC_REFUSAL_REASONS = new Set([
    'integration restoration requires a SHA-256-verified manifest and none is available; the dead owner binding is preserved',
    'integration restoration requires the recorded manifest authority',
    'integration restoration requires the active startup journal and recorded manifest authority',
    'managed Metro could not be stopped with exact process authority',
    'managed Metro cleanup has not been durably completed',
    'startup cleanup did not converge for this worktree',
    'startup cleanup no longer matches the exact source and app root',
    'no startup cleanup is in progress',
    'the same-root owner is live; a live owner is never released',
    'the same-root owner identity could not be proven, so it is treated as live',
    'expired lease owner identity could not be proven',
    'the startup cleanup owner no longer matches the proven claim epoch',
    ...['androidMetroReverse', 'recorder', 'runner', 'observe', 'metro'].flatMap((resource) => [
        `${resource} cleanup has not been durably completed`,
        `${resource} cleanup was not durably requested`,
    ]),
]);
const GENERIC_REFUSAL_REMEDY = 'Startup cleanup refused and preserved the prior owner binding. Resolve the refusal named by this code, then restart the MCP transport; another restart alone does not release the owner.';
/**
 * The outcome is the single boundary where a refusal becomes durable — journaled on
 * the dead owner's row, projected into the contender's public status, and written to
 * the supervisor's startup diagnostics. Raw producer diagnostics are never persisted
 * past it: the typed code always survives, an authored reason and its remedy survive
 * only together and only when the reason is provably identifier-free, and every
 * refusal keeps an actionable remedy.
 */
function publicRefusal(refusal) {
    // `SessionAuthorityError` renders as `CODE: sentence`; the code travels separately.
    const sentence = refusal.message.replace(/^[A-Z][A-Z0-9_]+: /, '');
    const authored = PUBLIC_REFUSAL_REASONS.has(sentence);
    return {
        code: refusal.code,
        message: authored
            ? sentence
            : `startup cleanup refused with ${refusal.code} and preserved the prior owner binding`,
        nextAction: authored ? (refusal.nextAction ?? GENERIC_REFUSAL_REMEDY) : GENERIC_REFUSAL_REMEDY,
    };
}
function refusalOf(error) {
    if (error instanceof SessionAuthorityError) {
        return publicRefusal({
            code: error.code,
            message: error.message,
            ...(error.details?.nextAction ? { nextAction: error.details.nextAction } : {}),
        });
    }
    const code = error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'STARTUP_CLEANUP_FAILED';
    return publicRefusal({
        code,
        message: error instanceof Error ? error.message : String(error),
    });
}
