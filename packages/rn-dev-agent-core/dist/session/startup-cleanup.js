import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readJsonStateFile } from '../util/secure-state-file.js';
import { stopManagedMetro } from './managed-metro.js';
import { readPackageIntegrationInputs, restorePackageIntegrationFiles, } from './package-integration.js';
import { stopBoundObserve, stopBoundRecorder, stopBoundRunner } from './process-cleanup.js';
import { openSessionRegistry, SessionAuthorityError, } from './registry.js';
import { createAuthorityStateLayout } from './state-root.js';
const EXECUTION_ORDER = [
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
        const candidate = input.registry.findStartupCleanupCandidate(input.worktreeKey);
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
            return { status: 'refused', released, refusal: refusalOf(error) };
        }
    }
    return {
        status: 'refused',
        released,
        refusal: {
            code: 'RESOURCE_CLAIM_CONFLICT',
            message: 'startup cleanup did not converge for this worktree',
        },
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
        return await runStartupOwnerCleanup({ registry, worktreeKey: input.source.worktreeKey, appRoot: input.source.appRoot }, {
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
        if (resource === 'recorder') {
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
function refusalOf(error) {
    if (error instanceof SessionAuthorityError) {
        return {
            code: error.code,
            message: error.message,
            ...(error.details?.nextAction ? { nextAction: error.details.nextAction } : {}),
        };
    }
    const code = error && typeof error === 'object' && typeof error.code === 'string'
        ? error.code
        : 'STARTUP_CLEANUP_FAILED';
    return { code, message: error instanceof Error ? error.message : String(error) };
}
