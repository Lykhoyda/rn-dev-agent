import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { filterValidTargets, targetMatchesBundleId } from '../cdp/discovery.js';
import { cwdForPort, pathIsWithinRoot } from '../cdp/metro-cwd.js';
import { captureInstalledArtifact, captureInstallGeneration, verifyInstalledArtifact, } from './install-authority.js';
import { verifyMetroAuthorityMarker } from './metro-authority.js';
import { provenMetroOriginMismatch, recordedMetroOriginConflict, } from './metro-origin.js';
import { metroListenerPid } from './metro-binding.js';
import { inspectSessionOwner } from './process-owner.js';
import { readProcessBirth } from './process-birth.js';
import { SessionAuthorityError } from './registry.js';
import { resolveSourceIdentity } from './source-identity.js';
import { proveTargetDeviceAssociations, } from './target-device-authority.js';
import { requiresExactInstalledArtifact } from './tool-profiles.js';
import { deviceExistsOnHost } from './device-existence.js';
function identity(value) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function objectBinding(status, name) {
    const value = status.bindings[name];
    if (!value || typeof value !== 'object') {
        throw new SessionAuthorityError(name === 'bundle' ? 'BUNDLE_HANDSHAKE_UNAVAILABLE' : 'SESSION_AUTHORITY_REQUIRED', `${name} authority is not bound`);
    }
    return value;
}
function defaultSource(status) {
    const stored = status.source;
    return resolveSourceIdentity(stored.appRoot, stored.kind === 'declared-root'
        ? {
            declaredRoot: stored.contentRoot,
            declaredManifests: stored.declaredManifests,
        }
        : {});
}
async function defaultFetchText(url, init) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_000);
    try {
        const response = await fetch(url, { ...init, signal: controller.signal });
        if (!response.ok)
            throw new Error(`HTTP ${response.status}`);
        return await response.text();
    }
    finally {
        clearTimeout(timer);
    }
}
async function defaultFetchJson(url, init) {
    return JSON.parse(await defaultFetchText(url, init));
}
function sameSource(expected, observed) {
    return (expected.kind === observed.kind &&
        expected.sourceKey === observed.sourceKey &&
        expected.worktreeKey === observed.worktreeKey &&
        expected.appRootKey === observed.appRootKey &&
        (expected.kind !== 'declared-root' ||
            (observed.kind === 'declared-root' && expected.manifestDigest === observed.manifestDigest)));
}
export function createLocalAuthorityProbe(dependencies) {
    const fetchText = dependencies.fetchText ?? defaultFetchText;
    const fetchJson = dependencies.fetchJson ?? defaultFetchJson;
    const fetchTargets = dependencies.fetchTargets ??
        (async (port) => JSON.parse(await fetchText(`http://127.0.0.1:${port}/json/list`)));
    const proveTargetDevices = dependencies.proveTargetDevices ??
        ((input) => proveTargetDeviceAssociations(input, {
            execute: async (file, args) => ({
                stdout: execFileSync(file, args, {
                    encoding: 'utf8',
                    stdio: ['ignore', 'pipe', 'ignore'],
                    timeout: 5_000,
                }),
            }),
        }));
    const sourceResolver = dependencies.resolveSource ?? defaultSource;
    const deviceExists = dependencies.deviceExists ?? deviceExistsOnHost;
    const inspectOwner = dependencies.inspectOwner ?? inspectSessionOwner;
    const captureInstalled = dependencies.captureInstalled ?? captureInstalledArtifact;
    const captureGeneration = dependencies.captureInstallGeneration ?? captureInstallGeneration;
    return async ({ axis, phase, status, tool, args }) => {
        if (axis === 'C') {
            const { registry, session } = dependencies.runtime.requireAvailable();
            const controller = phase === 'preflight' && tool === 'rn_session' && args?.action === 'cancel_handoff'
                ? registry.getHandoffCancellationControllerBinding(session)
                : registry.getControllerBinding(session);
            const supervisor = inspectOwner({
                sessionId: controller.sessionId,
                pid: controller.supervisor.pid,
                token: controller.supervisor.token,
            });
            const workerBirth = controller.worker.pid === process.pid && controller.worker.token
                ? readProcessBirth(process.pid)
                : null;
            if (supervisor !== 'match' ||
                !controller.worker.instanceId ||
                !workerBirth ||
                workerBirth.token !== controller.worker.token) {
                throw new SessionAuthorityError('SESSION_OWNER_LOST', 'controller process identity no longer matches the fenced session');
            }
            return { axis, identity: identity(controller) };
        }
        if (axis === 'S') {
            const expected = status.source;
            const observed = sourceResolver(status);
            if (!sameSource(expected, observed)) {
                throw new SessionAuthorityError('SOURCE_WORKTREE_MISMATCH', 'current source root does not match the session worktree identity');
            }
            return {
                axis,
                identity: identity({
                    kind: observed.kind,
                    sourceKey: observed.sourceKey,
                    worktreeKey: observed.worktreeKey,
                    appRootKey: observed.appRootKey,
                    ...(observed.kind === 'declared-root' ? { manifestDigest: observed.manifestDigest } : {}),
                }),
            };
        }
        if (axis === 'I') {
            const expected = objectBinding(status, 'install');
            const exactArtifactBoundary = requiresExactInstalledArtifact(tool ?? '', args ?? {});
            try {
                if (exactArtifactBoundary) {
                    verifyInstalledArtifact(expected, captureInstalled(expected));
                }
                else if (captureGeneration(expected) !== expected.installGeneration) {
                    throw new Error('install generation changed');
                }
            }
            catch {
                throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'installed artifact identity no longer matches the session build');
            }
            return {
                axis,
                identity: identity({
                    platform: expected.platform,
                    deviceId: expected.deviceId,
                    appId: expected.appId,
                    artifactDigest: expected.artifactDigest,
                    installGeneration: expected.installGeneration,
                }),
            };
        }
        if (axis === 'M') {
            const metro = objectBinding(status, 'metro');
            const port = Number(metro.port);
            const pid = Number(metro.pid);
            const birth = String(metro.birth ?? '');
            if (!Number.isSafeInteger(port) ||
                !Number.isSafeInteger(pid) ||
                !birth ||
                metroListenerPid(port) !== pid ||
                inspectSessionOwner({ sessionId: status.sessionId, pid, token: birth }) !== 'match') {
                throw new SessionAuthorityError('METRO_INSTANCE_CHANGED', 'Metro process identity no longer matches the bound instance');
            }
            let statusText;
            try {
                statusText = await fetchText(`http://127.0.0.1:${port}/status`);
            }
            catch {
                throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'claimed Metro endpoint could not be inspected');
            }
            if (!statusText.includes('packager-status:running')) {
                throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'claimed Metro endpoint is not running');
            }
            const servingRoot = cwdForPort(port) ??
                (metro.mode === 'managed' && typeof metro.servingRoot === 'string'
                    ? metro.servingRoot
                    : null);
            const expectedRoot = String(status.source.contentRoot ?? '');
            if (!servingRoot || !pathIsWithinRoot(servingRoot, expectedRoot)) {
                throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'Metro serving root cannot be proven for this worktree');
            }
            return {
                axis,
                identity: identity({
                    instanceId: metro.instanceId,
                    port,
                    pid,
                    birth,
                    servingRoot,
                    buildGeneration: metro.buildGeneration,
                }),
            };
        }
        if (axis === 'A') {
            const metro = objectBinding(status, 'metro');
            const device = objectBinding(status, 'device');
            const port = Number(metro.port);
            const platform = device.platform;
            const deviceId = String(device.deviceId ?? '');
            const appId = String(device.appId ?? '');
            if (!Number.isSafeInteger(port) ||
                (platform !== 'ios' && platform !== 'android') ||
                !deviceId ||
                !appId) {
                throw new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'native app origin authority is incomplete');
            }
            const expectedMetroPort = Number(device.expectedMetroPort ?? port);
            if (Number.isSafeInteger(expectedMetroPort) && expectedMetroPort !== port) {
                throw recordedMetroOriginConflict(expectedMetroPort, port);
            }
            const refuseWithForeignOriginEvidence = async (unprovable) => {
                const evidence = await dependencies
                    .findForeignMetroOrigin?.({ expectedMetroPort: port, platform, deviceId, appId })
                    .catch(() => null);
                if (evidence)
                    throw provenMetroOriginMismatch(port, { platform, deviceId, appId }, evidence);
                throw unprovable;
            };
            let targets;
            try {
                targets = filterValidTargets(await fetchTargets(port)).filter((target) => targetMatchesBundleId(target, appId));
            }
            catch {
                return refuseWithForeignOriginEvidence(new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'authority-bound Metro targets could not be inspected'));
            }
            try {
                await proveTargetDevices({
                    platform,
                    deviceId,
                    targetDeviceNames: targets.map(({ deviceName }) => deviceName),
                });
            }
            catch {
                return refuseWithForeignOriginEvidence(new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'the claimed device app is not attached to the authority-bound Metro'));
            }
            return {
                axis,
                identity: identity({
                    port,
                    platform,
                    deviceId,
                    appId,
                }),
                detail: { authorityScope: 'live-metro-target-device' },
            };
        }
        if (axis === 'B') {
            const client = dependencies.getClient();
            const bundle = objectBinding(status, 'bundle');
            if (!client.isConnected || !client.connectedTarget) {
                throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'live CDP runtime is unavailable for bundle verification');
            }
            let evaluated;
            try {
                evaluated = await client.evaluate('JSON.stringify(globalThis.__RN_DEV_AGENT_AUTHORITY__ ?? null)');
            }
            catch {
                throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'live CDP runtime could not be evaluated for bundle verification');
            }
            if (typeof evaluated.value !== 'string') {
                throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'runtime did not expose a signed authority marker');
            }
            let outer;
            try {
                outer = JSON.parse(evaluated.value);
            }
            catch {
                throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'live CDP runtime returned an invalid bundle authority marker');
            }
            const signerCapability = dependencies.getSecret()?.signerCapability;
            if (!outer?.marker || outer.status !== 'signed' || !signerCapability) {
                throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'signed authority marker or signer capability is unavailable');
            }
            verifyMetroAuthorityMarker(outer.marker, signerCapability, {
                sessionId: status.sessionId,
                metroInstanceId: String(bundle.metroInstanceId),
                worktreeKey: status.worktreeKey,
                appId: String(bundle.appId),
                platform: bundle.platform,
                buildGeneration: Number(bundle.buildGeneration),
            });
            if (client.connectedTarget.id !== bundle.targetId ||
                client.connectionGeneration !== bundle.connectionGeneration) {
                throw new SessionAuthorityError('CDP_TARGET_AUTHORITY_MISMATCH', 'CDP target generation no longer matches the pinned bundle');
            }
            return {
                axis,
                identity: identity({
                    payload: outer.marker.payload,
                    targetId: client.connectedTarget.id,
                    connectionGeneration: client.connectionGeneration,
                }),
                detail: { authorityScope: 'initial-bundle', sourceFidelity: 'not-proven' },
            };
        }
        if (axis === 'D') {
            const device = objectBinding(status, 'device');
            const platform = device.platform;
            const deviceId = String(device.deviceId ?? '');
            if ((platform !== 'ios' && platform !== 'android') ||
                !deviceId ||
                !deviceExists(platform, deviceId)) {
                throw new SessionAuthorityError('DEVICE_AUTHORITY_MISMATCH', 'exact claimed device is no longer available');
            }
            return { axis, identity: identity({ platform, deviceId }) };
        }
        if (axis === 'R') {
            const runner = objectBinding(status, 'runner');
            const port = Number(runner.port);
            const pid = Number(runner.pid);
            const processBirth = String(runner.processBirth ?? '');
            const capability = String(runner.capability ?? '');
            if (!Number.isSafeInteger(port) ||
                !Number.isSafeInteger(pid) ||
                !processBirth ||
                !capability ||
                inspectOwner({ sessionId: status.sessionId, pid, token: processBirth }) !== 'match') {
                throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'runner process identity and endpoint capability no longer match the binding');
            }
            const health = await fetchJson(`http://127.0.0.1:${port}/health`, {
                headers: { authorization: `Bearer ${capability}` },
            });
            if (health.ok !== true) {
                const reason = typeof health.reason === 'string' && health.reason.trim()
                    ? `: ${health.reason.trim()}`
                    : '';
                throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', `runner health is not operational${reason}`);
            }
            for (const key of [
                'instanceId',
                'sessionId',
                'claimEpoch',
                'deviceId',
                'appId',
                'protocolVersion',
            ]) {
                if (health[key] !== runner[key]) {
                    throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', `runner ${key} no longer matches the session binding`);
                }
            }
            return {
                axis,
                identity: identity({
                    port,
                    pid,
                    processBirth,
                    instanceId: runner.instanceId,
                    sessionId: runner.sessionId,
                    claimEpoch: runner.claimEpoch,
                    deviceId: runner.deviceId,
                    appId: runner.appId,
                    protocolVersion: runner.protocolVersion,
                }),
            };
        }
        const proof = objectBinding(status, 'proof');
        const runId = String(proof.runId ?? '');
        if (!runId || !dependencies.proofActive?.(runId)) {
            throw new SessionAuthorityError('PROOF_AUTHORITY_MISMATCH', 'strict proof run is not active under this session');
        }
        return { axis, identity: identity({ runId, claimEpoch: status.claimEpoch }) };
    };
}
