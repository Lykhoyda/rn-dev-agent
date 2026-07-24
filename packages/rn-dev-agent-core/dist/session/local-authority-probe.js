import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cwdForPort, pathMatchesRoot } from '../cdp/metro-cwd.js';
import { captureInstallGeneration } from './install-authority.js';
import { verifyMetroAuthorityMarker } from './metro-authority.js';
import { metroListenerPid } from './metro-binding.js';
import { inspectSessionOwner } from './process-owner.js';
import { readProcessBirth } from './process-birth.js';
import { SessionAuthorityError } from './registry.js';
import { resolveSourceIdentity } from './source-identity.js';
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
function defaultDeviceExists(platform, deviceId) {
    if (platform === 'ios') {
        const output = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5_000,
        });
        const parsed = JSON.parse(output);
        return Object.values(parsed.devices ?? {})
            .flat()
            .some((device) => device.udid === deviceId && device.isAvailable !== false);
    }
    const output = execFileSync('adb', ['devices'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
    });
    return output
        .split('\n')
        .some((line) => line.split(/\s+/)[0] === deviceId && /\sdevice\s*$/.test(line));
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
    const sourceResolver = dependencies.resolveSource ?? defaultSource;
    const deviceExists = dependencies.deviceExists ?? defaultDeviceExists;
    const inspectOwner = dependencies.inspectOwner ?? inspectSessionOwner;
    return async ({ axis, status, tool, args }) => {
        if (axis === 'C') {
            const { registry, session } = dependencies.runtime.requireAvailable();
            const controller = tool === 'rn_session' && args?.action === 'cancel_handoff'
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
            const observedGeneration = captureInstallGeneration(expected);
            if (observedGeneration !== expected.installGeneration) {
                throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'installed artifact generation no longer matches the session build');
            }
            return {
                axis,
                identity: identity({
                    platform: expected.platform,
                    deviceId: expected.deviceId,
                    appId: expected.appId,
                    installGeneration: observedGeneration,
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
            const statusText = await fetchText(`http://127.0.0.1:${port}/status`);
            if (!statusText.includes('packager-status:running')) {
                throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'claimed Metro endpoint is not running');
            }
            const servingRoot = cwdForPort(port) ??
                (metro.mode === 'managed' && typeof metro.servingRoot === 'string'
                    ? metro.servingRoot
                    : null);
            const expectedRoot = String(status.source.contentRoot ?? '');
            if (!servingRoot || !pathMatchesRoot(servingRoot, expectedRoot)) {
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
            const secret = dependencies.getSecret()?.signerCapability;
            if (!outer?.marker || outer.status !== 'signed' || !secret) {
                throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'signed authority marker or signer capability is unavailable');
            }
            const payload = verifyMetroAuthorityMarker(outer.marker, secret, {
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
                    payload,
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
            for (const key of ['instanceId', 'sessionId', 'claimEpoch', 'deviceId', 'appId']) {
                if (health[key] !== runner[key]) {
                    throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', `runner ${key} no longer matches the session binding`);
                }
            }
            return { axis, identity: identity({ health, pid, processBirth }) };
        }
        if (axis === 'O') {
            const observe = objectBinding(status, 'observe');
            const port = Number(observe.port);
            const capability = dependencies.getSecret()?.observeCapability ?? '';
            const observed = await fetchJson(`http://127.0.0.1:${port}/api/authority`, {
                headers: {
                    authorization: `Bearer ${capability}`,
                    'x-rn-observe-instance': String(observe.instanceId ?? ''),
                },
            });
            if (observed.sessionId !== status.sessionId || observed.instanceId !== observe.instanceId) {
                throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe endpoint no longer matches the session binding');
            }
            return { axis, identity: identity(observed) };
        }
        const proof = objectBinding(status, 'proof');
        const runId = String(proof.runId ?? '');
        if (!runId || !dependencies.proofActive?.(runId)) {
            throw new SessionAuthorityError('PROOF_AUTHORITY_MISMATCH', 'strict proof run is not active under this session');
        }
        return { axis, identity: identity({ runId, claimEpoch: status.claimEpoch }) };
    };
}
