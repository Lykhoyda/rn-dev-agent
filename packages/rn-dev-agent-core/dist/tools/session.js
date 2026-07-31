import { authorityErrorMeta, SessionAuthorityError } from '../session/registry.js';
import { failResult, okResult } from '../utils.js';
import { verifyBuildReceipt } from '../session/build-receipt.js';
import { captureInstallGeneration, } from '../session/install-authority.js';
import { captureMetroBinding } from '../session/metro-binding.js';
import { applyPackageIntegration, inspectPackageIntegrationFileState, previewMetroIntegration, previewPackageIntegration, readPackageIntegrationInputs, restorePackageIntegrationFiles, serializePackageIntegrationManifest, } from '../session/package-integration.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectSessionOwner } from '../session/process-owner.js';
import { projectPublicAuthorityStatus } from '../session/public-status.js';
import { probeProcessBirth } from '../session/process-birth.js';
import { inspectManagedMetroCleanupEvidence, inspectManagedMetroLifecycle, probeManagedMetroListener, stopManagedMetro, stopManagedMetroWithEvidence, } from '../session/managed-metro.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { stopBoundObserve, stopBoundRecorder, stopBoundRunner, } from '../session/process-cleanup.js';
import { deviceExistsOnHost } from '../session/device-existence.js';
function sameMetroAuthority(current, next) {
    return (current?.port === next.port &&
        current.pid === next.pid &&
        current.birth === next.birth &&
        current.instanceId === next.instanceId &&
        current.servingRoot === next.servingRoot &&
        current.buildGeneration === next.buildGeneration &&
        current.mode === next.mode);
}
function verifiedManifestSource(candidate, manifestSha256) {
    if (typeof candidate !== 'string' || typeof manifestSha256 !== 'string')
        return undefined;
    return createHash('sha256').update(candidate).digest('hex') === manifestSha256
        ? candidate
        : undefined;
}
function durableBindingManifestSource(binding) {
    return verifiedManifestSource(binding?.manifestSource, binding?.manifestSha256);
}
function recoverableManifestSource(appRoot, binding) {
    let onDisk;
    try {
        onDisk = readPackageIntegrationInputs(appRoot).manifest;
    }
    catch {
        onDisk = undefined;
    }
    const restoration = binding?.restoration?.phase === 'started' ? binding.restoration.manifestSource : undefined;
    const installation = binding?.installation?.phase === 'started' ? binding.installation.manifestSource : undefined;
    return (verifiedManifestSource(onDisk, binding?.manifestSha256) ??
        verifiedManifestSource(restoration, binding?.manifestSha256) ??
        verifiedManifestSource(installation, binding?.manifestSha256) ??
        durableBindingManifestSource(binding));
}
const MANIFEST_RECOVERY_GUIDANCE = 'Restore the exact integration manifest at .rn-agent/integration/rn-session-integration.json from your own version control history or backups so it matches the manifest SHA-256 recorded on the binding';
const MISSING_DIGEST_GUIDANCE = 'No trusted manifest SHA-256 digest is recorded on this binding, so no manifest bytes can be verified against it; operator recovery from a trusted session-state-plus-manifest backup is required while the refusal fence remains.';
function hasTrustedManifestDigest(binding) {
    return (typeof binding?.manifestSha256 === 'string' && /^[0-9a-f]{64}$/.test(binding.manifestSha256));
}
function manifestRecoveryNextAction(binding, retry) {
    return hasTrustedManifestDigest(binding)
        ? `${MANIFEST_RECOVERY_GUIDANCE}, then ${retry}.`
        : MISSING_DIGEST_GUIDANCE;
}
function describeIntegrationFileDiagnostics(appRoot) {
    let state;
    if (!appRoot) {
        state = { verdict: 'partial', markers: ['app-root-unavailable'] };
    }
    else {
        try {
            state = inspectPackageIntegrationFileState(appRoot);
        }
        catch {
            state = { verdict: 'partial', markers: ['integration-files-uninspectable'] };
        }
    }
    return `${state.verdict}: ${state.markers.join(', ') || 'no-integration-markers'}`;
}
function assertPackageIntegrationInactive(bindings, action) {
    const activeBindings = [
        'metro',
        'metroCleanup',
        'runner',
        'observe',
        'recorder',
        'proof',
        'pendingBuild',
        'handoffCleanup',
    ].filter((binding) => bindings[binding] != null);
    if (activeBindings.length > 0) {
        const guidance = action === 'apply_integration' &&
            activeBindings.length === 1 &&
            activeBindings[0] === 'observe'
            ? '; run observe action "stop" for this session, then retry apply_integration'
            : '';
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `${action} requires releasing active ${activeBindings.join(', ')} authority${guidance}`);
    }
}
async function stopHandoffObserve(binding, listenerProbe, processProbe, timeoutMs = 2_000) {
    const stopRequestedAt = Number(binding.stopRequestedAt);
    if (!Number.isFinite(stopRequestedAt)) {
        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'source Observe cleanup authority is incomplete');
    }
    await stopBoundObserve(binding, listenerProbe, processProbe, timeoutMs);
}
async function stopHandoffRunner(binding, processProbe = probeProcessBirth, signalProcess = process.kill, timeoutMs = 2_000) {
    const claimKey = String(binding.claimKey ?? '');
    const stopRequestedAt = Number(binding.stopRequestedAt);
    if (!claimKey || !Number.isFinite(stopRequestedAt)) {
        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'source runner cleanup identity is incomplete');
    }
    await stopBoundRunner(binding, processProbe, signalProcess, timeoutMs);
}
function authorityFailure(error) {
    if (error instanceof SessionAuthorityError) {
        return failResult(error.message, error.code, authorityErrorMeta(error));
    }
    const message = error instanceof Error ? error.message : String(error);
    const code = /^([A-Z][A-Z0-9_]+):/.exec(message)?.[1] ?? 'SESSION_AUTHORITY_REQUIRED';
    return failResult(message, code);
}
function required(value, name) {
    if (value === undefined || value === '') {
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `${name} is required for this session transition`);
    }
    return value;
}
function describeMetroCleanupEvidence(evidence) {
    const port = evidence.port.status === 'listening' ? `listening:${evidence.port.pid}` : evidence.port.status;
    return `launcher=${evidence.launcher}, listener=${evidence.listener}, port=${port}, evidenceSocket=${evidence.evidenceSocket}`;
}
export function reconcileManagedMetroStatus(runtime, dependencies = {}) {
    const authority = runtime.status();
    const metro = authority.available
        ? authority.bindings.metro
        : null;
    if (!authority.available || metro?.mode !== 'managed')
        return authority;
    const signerCapability = dependencies.getSignerCapability?.(authority.sessionId);
    const inspection = signerCapability
        ? (dependencies.inspectManagedMetroLifecycle ?? inspectManagedMetroLifecycle)(metro, {
            sessionId: authority.sessionId,
            signerCapability,
        })
        : {
            status: 'lost',
            code: 'METRO_MANAGEMENT_PROOF_INVALID',
            reason: 'managed Metro session signer is unavailable',
        };
    if (inspection.status === 'live')
        return authority;
    const { registry, session } = runtime.requireAvailable();
    const priorTargetId = authority.bindings.bundle
        ?.targetId;
    const metroPort = Number(authority.bindings.metroPort);
    const metroTerminal = {
        code: inspection.code,
        reason: inspection.reason,
        phase: authority.bindings.bundle ? 'after-bind' : 'before-bind',
        observedAt: (dependencies.now ?? Date.now)(),
        instanceId: metro.instanceId,
    };
    registry.updateBindings(session, {
        expectedAuthorityVersion: authority.authorityVersion,
        state: authority.bindings.install
            ? 'device_bound'
            : authority.bindings.device
                ? 'device_claimed'
                : 'source_bound',
        bindings: {
            metro: null,
            metroCleanup: metro,
            metroTerminal,
            bundle: null,
        },
        releaseResources: typeof priorTargetId === 'string' && Number.isSafeInteger(metroPort)
            ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
            : [],
    });
    return runtime.status();
}
export function createSessionHandler(runtime, dependencies = {}) {
    return async (input) => {
        if (input.action === 'status') {
            try {
                const projectedAuthority = reconcileManagedMetroStatus(runtime, dependencies);
                return okResult({
                    authoritative: false,
                    authority: projectPublicAuthorityStatus(projectedAuthority, { includeSessionId: true }),
                });
            }
            catch (error) {
                return authorityFailure(error);
            }
        }
        try {
            const isRecovery = input.action === 'accept_handoff' || input.action === 'adopt_stale';
            const { registry, session } = isRecovery
                ? runtime.requireRecovery()
                : runtime.requireOperational();
            if (input.action === 'recover_arbiter') {
                if (input.confirmed !== true) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'recover_arbiter requires confirmed=true');
                }
                const arbiterReset = (dependencies.resetArbiter ?? ((reason) => arbiter.reset(reason)))('manual via fenced rn_session');
                return okResult({
                    arbiterReset,
                    session: projectPublicAuthorityStatus(runtime.status()),
                });
            }
            if (input.action === 'bind_device') {
                const platform = required(input.platform, 'platform');
                const deviceId = required(input.deviceId, 'deviceId');
                const appId = required(input.appId, 'appId');
                const status = registry.getSessionStatus(session.sessionId);
                const signer = dependencies.getSignerCapability?.();
                if (!status) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'session disappeared before device binding');
                }
                if (status.bindings.runner || status.bindings.observe || status.bindings.proof) {
                    throw new SessionAuthorityError('DEVICE_AUTHORITY_MISMATCH', 'device rebinding requires runner, Observe, or proof authority to be released first');
                }
                let deviceExists;
                try {
                    deviceExists = (dependencies.deviceExists ?? deviceExistsOnHost)(platform, deviceId);
                }
                catch (error) {
                    throw new SessionAuthorityError('DEVICE_DISCOVERY_UNAVAILABLE', `could not verify exact ${platform} device ${deviceId}: ${error instanceof Error ? error.message : String(error)}`);
                }
                if (!deviceExists) {
                    throw new SessionAuthorityError('DEVICE_NOT_FOUND', `exact ${platform} device ${deviceId} does not exist or is unavailable`);
                }
                const currentInstall = status.bindings.install;
                if (!input.buildReceipt &&
                    currentInstall &&
                    (currentInstall.platform !== platform ||
                        currentInstall.deviceId !== deviceId ||
                        currentInstall.appId !== appId)) {
                    throw new SessionAuthorityError('DEVICE_RECEIPT_INCOMPATIBLE', 'cannot replace exact-device authority while an incompatible install receipt is bound');
                }
                if (!input.buildReceipt) {
                    registry.replaceDeviceAuthority(session, {
                        resource: { type: 'device', key: `${platform}:${deviceId}` },
                        device: {
                            platform,
                            deviceId,
                            appId,
                            ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
                        },
                    });
                    return okResult({
                        session: projectPublicAuthorityStatus(runtime.status()),
                        buildReceiptRequired: true,
                    });
                }
                if (!signer) {
                    throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'the session signer is unavailable for build receipt verification');
                }
                const receipt = verifyBuildReceipt(input.buildReceipt, signer, {
                    sessionId: session.sessionId,
                    sourceKey: status.sourceKey,
                    worktreeKey: status.worktreeKey,
                    appRootKey: status.appRootKey,
                    platform,
                    deviceId,
                    appId,
                    metroPort: Number(status.bindings.metroPort),
                });
                const observedGeneration = (dependencies.captureInstallGeneration ?? captureInstallGeneration)({
                    platform,
                    deviceId,
                    appId,
                });
                if (observedGeneration !== receipt.installGeneration) {
                    throw new SessionAuthorityError('APP_INSTALL_IDENTITY_CHANGED', 'installed artifact generation does not match the signed build receipt');
                }
                registry.replaceDeviceAuthority(session, {
                    resource: { type: 'device', key: `${platform}:${deviceId}` },
                    device: { platform, deviceId, appId },
                    install: { ...receipt },
                });
                return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
            }
            if (input.action === 'bind_metro') {
                if (input.mode === 'managed') {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro authority can only be established by the verified managed launcher');
                }
                const port = required(input.metroPort, 'metroPort');
                const pid = required(input.metroPid, 'metroPid');
                const instanceId = required(input.metroInstanceId, 'metroInstanceId');
                const buildGeneration = required(input.buildGeneration, 'buildGeneration');
                const status = registry.getSessionStatus(session.sessionId);
                if (status?.bindings.metroPort !== port) {
                    throw new SessionAuthorityError('METRO_PORT_CLAIM_CONFLICT', 'requested Metro port does not match the session allocation');
                }
                const sourceRoot = String(status.source.contentRoot ?? '');
                const metro = await (dependencies.captureMetro ?? captureMetroBinding)({
                    port,
                    pid,
                    instanceId,
                    sourceRoot,
                    buildGeneration,
                });
                const nextMetro = { ...metro, mode: 'external' };
                const priorMetro = status.bindings.metro;
                const priorBundle = status.bindings.bundle;
                const priorTargetId = priorBundle?.targetId;
                const metroUnchanged = sameMetroAuthority(priorMetro, nextMetro);
                registry.claimResources(session, [{ type: 'metro-port', key: String(port) }]);
                registry.updateBindings(session, {
                    state: metroUnchanged
                        ? status.state
                        : status.bindings.install
                            ? 'device_bound'
                            : 'metro_bound',
                    bindings: metroUnchanged ? { metro: nextMetro } : { metro: nextMetro, bundle: null },
                    releaseResources: !metroUnchanged && typeof priorTargetId === 'string'
                        ? [{ type: 'target', key: `${String(status.bindings.metroPort)}:${priorTargetId}` }]
                        : [],
                });
                return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
            }
            if (input.action === 'pin_dev_client') {
                const status = registry.getSessionStatus(session.sessionId);
                if (!status || !dependencies.pinDevClient) {
                    throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'pinning integration is unavailable');
                }
                for (const requiredBinding of ['install', 'metro', 'device']) {
                    if (!status.bindings[requiredBinding]) {
                        throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', `${requiredBinding} must be bound before pinning`);
                    }
                }
                const priorTargetId = status.bindings.bundle
                    ?.targetId;
                if (input.force === true && typeof priorTargetId === 'string') {
                    registry.releaseResources(session, [
                        { type: 'target', key: `${String(status.bindings.metroPort)}:${priorTargetId}` },
                    ]);
                    registry.updateBindings(session, {
                        state: 'device_bound',
                        bindings: { bundle: null },
                    });
                }
                const bundle = await dependencies.pinDevClient(status, {
                    force: input.force === true,
                });
                registry.claimResources(session, [
                    { type: 'target', key: `${bundle.metroPort}:${bundle.targetId}` },
                ]);
                registry.updateBindings(session, {
                    state: 'ready',
                    bindings: { bundle },
                });
                return okResult({ session: projectPublicAuthorityStatus(runtime.status()) });
            }
            if (input.action === 'prepare_handoff') {
                const targetHandle = required(input.targetHandle, 'targetHandle');
                return okResult(registry.prepareHandoffForHandle(session, {
                    targetHandle,
                    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
                }));
            }
            if (input.action === 'cancel_handoff') {
                const handoffId = required(input.handoffId, 'handoffId');
                registry.cancelHandoff(session, handoffId);
                return okResult({
                    cancelled: true,
                    session: projectPublicAuthorityStatus(runtime.status()),
                });
            }
            if (input.action === 'stop_metro') {
                const status = registry.getSessionStatus(session.sessionId);
                if (!status) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'session disappeared before managed Metro cleanup');
                }
                if (status.bindings.runner) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'stop_metro requires device_snapshot action=close before releasing active runner authority');
                }
                const metro = (status.bindings.metroCleanup ?? status.bindings.metro);
                if (!metro) {
                    const metroPort = Number(status.bindings.metroPort);
                    if (Number.isSafeInteger(metroPort)) {
                        let listener = { status: 'unknown' };
                        try {
                            listener = (dependencies.probeListener ?? probeManagedMetroListener)(metroPort);
                        }
                        catch { }
                        if (listener.status !== 'absent') {
                            const listenerIdentity = listener.status === 'listening' && typeof listener.pid === 'number'
                                ? ` by listener pid ${listener.pid}`
                                : '';
                            throw new SessionAuthorityError('METRO_CLEANUP_PENDING', `allocated Metro port ${metroPort} is still ${listener.status}${listenerIdentity} after cleanup authority was invalidated; do not signal an unbound process, wait for managed launcher cleanup, then retry rn_session stop_metro`);
                        }
                    }
                    return okResult({
                        stopped: false,
                        alreadyStopped: true,
                        session: projectPublicAuthorityStatus(runtime.status()),
                    });
                }
                const metroPort = Number(status.bindings.metroPort);
                if (!Number.isSafeInteger(metroPort) || metro.port !== metroPort) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'Metro cleanup binding does not match the exact allocated session port');
                }
                const signerCapability = dependencies.getSignerCapability?.();
                const runtimeEvidenceSocket = metro.mode === 'managed' && typeof metro.runtimeEvidenceSocket === 'string'
                    ? metro.runtimeEvidenceSocket
                    : undefined;
                let socketReferencedByOtherSession = true;
                if (runtimeEvidenceSocket) {
                    try {
                        socketReferencedByOtherSession = registry.isMetroEvidenceSocketReferencedByOtherSession(session.sessionId, runtimeEvidenceSocket);
                    }
                    catch { }
                }
                const evidenceDependencies = {
                    authorizeEvidenceSocketRemoval: () => input.confirmed === true && !socketReferencedByOtherSession,
                    ...(dependencies.evidenceSocketExists
                        ? { exists: dependencies.evidenceSocketExists }
                        : {}),
                    ...(dependencies.probeProcessBirth ? { probeBirth: dependencies.probeProcessBirth } : {}),
                    ...(dependencies.probeListener ? { probeListener: dependencies.probeListener } : {}),
                    ...(dependencies.removeEvidenceSocket
                        ? { removeEvidenceSocket: dependencies.removeEvidenceSocket }
                        : {}),
                };
                let cleanup;
                if (metro.mode === 'managed') {
                    if (dependencies.stopManagedMetroWithEvidence) {
                        cleanup = await dependencies.stopManagedMetroWithEvidence(metro, {
                            sessionId: session.sessionId,
                            signerCapability: signerCapability ?? '',
                        }, evidenceDependencies);
                    }
                    else if (dependencies.stopManagedMetro && signerCapability) {
                        const stopped = await dependencies.stopManagedMetro(metro, {
                            sessionId: session.sessionId,
                            signerCapability,
                        });
                        const evidence = stopped
                            ? {
                                complete: true,
                                launcher: 'absent',
                                listener: 'absent',
                                port: { status: 'absent' },
                                evidenceSocket: 'absent',
                            }
                            : inspectManagedMetroCleanupEvidence(metro, evidenceDependencies);
                        cleanup = { authenticated: stopped, stopped, evidence };
                    }
                    else {
                        cleanup = await stopManagedMetroWithEvidence(metro, {
                            sessionId: session.sessionId,
                            signerCapability: signerCapability ?? '',
                        }, evidenceDependencies);
                    }
                }
                else {
                    const evidence = inspectManagedMetroCleanupEvidence(metro, evidenceDependencies);
                    cleanup = { authenticated: false, stopped: false, evidence };
                }
                const onlySocketRemains = cleanup.evidence.launcher === 'absent' &&
                    cleanup.evidence.listener === 'absent' &&
                    cleanup.evidence.port.status === 'absent' &&
                    cleanup.evidence.evidenceSocket === 'present';
                if (!cleanup.authenticated && onlySocketRemains && input.confirmed !== true) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'confirmed=true is required to remove the stale session-owned Metro evidence socket');
                }
                if (!cleanup.authenticated && onlySocketRemains && socketReferencedByOtherSession) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'the Metro evidence socket remains referenced by another session; recover that owning session before retrying rn_session stop_metro');
                }
                if (!cleanup.evidence.complete) {
                    const socketRecovery = onlySocketRemains && runtimeEvidenceSocket
                        ? `; remove the exact session-owned socket ${runtimeEvidenceSocket} through its filesystem owner, then retry rn_session stop_metro`
                        : '; stop the exact owning process and retry rn_session stop_metro';
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', `Metro cleanup is unresolved (${describeMetroCleanupEvidence(cleanup.evidence)})${socketRecovery}`);
                }
                if (!cleanup.authenticated && input.confirmed !== true) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'non-signaling Metro authority release requires confirmed=true after exact process, listener, and socket absence is verified');
                }
                const priorTargetId = status.bindings.bundle
                    ?.targetId;
                registry.updateBindings(session, {
                    expectedAuthorityVersion: status.authorityVersion,
                    state: status.bindings.install
                        ? 'device_bound'
                        : status.bindings.device
                            ? 'device_claimed'
                            : 'source_bound',
                    bindings: {
                        metro: null,
                        metroCleanup: null,
                        metroTerminal: null,
                        bundle: null,
                    },
                    releaseResources: typeof priorTargetId === 'string' && Number.isSafeInteger(metroPort)
                        ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
                        : [],
                });
                return okResult({
                    stopped: cleanup.stopped,
                    alreadyStopped: !cleanup.stopped,
                    bindingReleased: !cleanup.authenticated,
                    session: projectPublicAuthorityStatus(runtime.status()),
                    nextAction: 'Retry the managed Metro/build command for the literal Expo native build.',
                    alternativeAction: 'To tear down instead, restore package integration with confirmed=true, then release the exact session.',
                });
            }
            if (input.action === 'preview_integration' ||
                input.action === 'apply_integration' ||
                input.action === 'restore_integration') {
                const status = registry.getSessionStatus(session.sessionId);
                const appRoot = String(status?.source.appRoot ?? '');
                if (!status || !appRoot) {
                    throw new SessionAuthorityError('SOURCE_WORKTREE_MISMATCH', 'session app root is unavailable for integration');
                }
                const packagePath = join(appRoot, 'package.json');
                const integrationInputs = readPackageIntegrationInputs(appRoot);
                const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
                const packageJson = JSON.parse(integrationInputs.packageJson);
                const integrationBinding = status.bindings.packageIntegration;
                const installationManifestSource = integrationBinding?.installation?.phase === 'started' &&
                    typeof integrationBinding.installation.manifestSource === 'string'
                    ? integrationBinding.installation.manifestSource
                    : undefined;
                const restorationManifestSource = integrationBinding?.restoration?.phase === 'started' &&
                    typeof integrationBinding.restoration.manifestSource === 'string'
                    ? integrationBinding.restoration.manifestSource
                    : undefined;
                const manifestSource = input.action === 'restore_integration' && integrationBinding
                    ? (verifiedManifestSource(integrationInputs.manifest, integrationBinding?.manifestSha256) ??
                        verifiedManifestSource(restorationManifestSource, integrationBinding?.manifestSha256) ??
                        verifiedManifestSource(installationManifestSource, integrationBinding?.manifestSha256) ??
                        durableBindingManifestSource(integrationBinding))
                    : (integrationInputs.manifest ??
                        restorationManifestSource ??
                        installationManifestSource ??
                        durableBindingManifestSource(integrationBinding));
                let existing;
                try {
                    existing =
                        manifestSource === undefined
                            ? undefined
                            : JSON.parse(manifestSource);
                }
                catch (error) {
                    if (!(error instanceof SyntaxError))
                        throw error;
                }
                const sessionCli = process.env.RN_DEV_AGENT_SESSION_CLI ??
                    join(dirname(fileURLToPath(import.meta.url)), '..', 'rn-session.js');
                if (input.action === 'restore_integration') {
                    if (input.confirmed !== true) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'restore_integration requires confirmed=true');
                    }
                    if (!existing) {
                        if (!integrationBinding) {
                            throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'integration manifest is unavailable for restoration', undefined, {
                                nextAction: 'No package-integration binding is active for this session; proceed to release.',
                            });
                        }
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `integration restoration requires a SHA-256-verified manifest and none is available; the binding is preserved and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(appRoot)})`, undefined, {
                            nextAction: manifestRecoveryNextAction(integrationBinding, 'retry restore_integration with confirmed=true'),
                        });
                    }
                    assertPackageIntegrationInactive(status.bindings, input.action);
                    const manifestSha256 = createHash('sha256')
                        .update(manifestSource ?? '')
                        .digest('hex');
                    if (integrationBinding?.version !== 1 ||
                        typeof integrationBinding.installedBySessionId !== 'string' ||
                        integrationBinding.manifestSha256 !== manifestSha256) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'integration restoration requires the transferred manifest authority binding');
                    }
                    if (restorationManifestSource !== manifestSource) {
                        registry.updateBindings(session, {
                            bindings: {
                                packageIntegration: {
                                    ...integrationBinding,
                                    restoration: { phase: 'started', manifestSource },
                                },
                            },
                        });
                    }
                    restorePackageIntegrationFiles({ appRoot, manifestSource });
                    registry.updateBindings(session, {
                        bindings: { packageIntegration: null },
                    });
                    return okResult({ restored: true, packagePath, manifestPath });
                }
                const preview = previewPackageIntegration(packageJson, existing, sessionCli);
                const metroConfigPath = integrationInputs.metroConfig.path;
                const metroBefore = integrationInputs.metroConfig.contents;
                const metroAfter = previewMetroIntegration(metroBefore);
                if (input.action === 'preview_integration') {
                    return okResult({
                        confirmed: false,
                        packagePath,
                        before: packageJson,
                        after: preview.packageJson,
                        metroConfigPath,
                        metroBefore,
                        metroAfter,
                        manifest: preview.manifest,
                    });
                }
                if (input.confirmed !== true) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'apply_integration requires confirmed=true after reviewing preview_integration');
                }
                assertPackageIntegrationInactive(status.bindings, input.action);
                if (integrationBinding && !installationManifestSource) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'package integration is already owned by an active session lifecycle', undefined, {
                        nextAction: 'Run restore_integration with confirmed=true to restore or reconcile the owning integration binding, then retry apply_integration.',
                    });
                }
                preview.manifest.metroConfig = metroConfigPath.slice(appRoot.length + 1);
                const expectedManifestSource = installationManifestSource ?? serializePackageIntegrationManifest(preview.manifest);
                const expectedManifestSha256 = createHash('sha256')
                    .update(expectedManifestSource)
                    .digest('hex');
                if (installationManifestSource &&
                    (integrationBinding?.version !== 1 ||
                        integrationBinding.installedBySessionId !== session.sessionId ||
                        integrationBinding.manifestSha256 !== expectedManifestSha256)) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'integration installation requires the original session manifest authority binding');
                }
                if (!installationManifestSource) {
                    registry.updateBindings(session, {
                        bindings: {
                            packageIntegration: {
                                version: 1,
                                installedBySessionId: session.sessionId,
                                manifestSha256: expectedManifestSha256,
                                installation: { phase: 'started', manifestSource: expectedManifestSource },
                            },
                        },
                    });
                }
                try {
                    applyPackageIntegration({ appRoot, sessionCli });
                    const installedManifest = readPackageIntegrationInputs(appRoot).manifest;
                    if (!installedManifest) {
                        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: applied manifest is unavailable');
                    }
                    if (createHash('sha256').update(installedManifest).digest('hex') !== expectedManifestSha256) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'applied integration manifest no longer matches its durable installation authority');
                    }
                    registry.updateBindings(session, {
                        bindings: {
                            packageIntegration: {
                                version: 1,
                                installedBySessionId: session.sessionId,
                                manifestSha256: expectedManifestSha256,
                                manifestSource: expectedManifestSource,
                            },
                        },
                    });
                }
                catch (error) {
                    try {
                        restorePackageIntegrationFiles({
                            appRoot,
                            manifestSource: expectedManifestSource,
                        });
                        registry.updateBindings(session, {
                            bindings: { packageIntegration: null },
                        });
                    }
                    catch (rollbackError) {
                        throw new AggregateError([error, rollbackError]);
                    }
                    throw error;
                }
                return okResult({ applied: true, packagePath, manifestPath });
            }
            if (input.action === 'accept_handoff') {
                const handoffId = required(input.handoffId, 'handoffId');
                const token = required(input.token, 'token');
                const status = registry.getSessionStatus(session.sessionId);
                if (!status?.worker.instanceId) {
                    throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'target worker identity is unavailable');
                }
                let cleanup = status.bindings.handoffCleanup;
                const priorSessionId = registry.getHandoffOwner(handoffId);
                const priorStatus = priorSessionId ? registry.getSessionStatus(priorSessionId) : null;
                const priorRunner = (cleanup?.runner ?? priorStatus?.bindings.runner);
                const acceptAppRoot = String(status.source.appRoot ?? '');
                const retryAccept = 'retry accept_handoff with the same handoffId and token';
                if (status.state === 'handoff_cleanup') {
                    const transferredBinding = status.bindings.packageIntegration;
                    if (transferredBinding &&
                        !(acceptAppRoot && recoverableManifestSource(acceptAppRoot, transferredBinding))) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `resumed handoff cleanup carries package-integration authority without a SHA-256-verified restoration manifest; cleanup refuses before any lifecycle mutation, and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(acceptAppRoot)})`, undefined, { nextAction: manifestRecoveryNextAction(transferredBinding, retryAccept) });
                    }
                }
                else {
                    const donorBinding = priorStatus?.bindings.packageIntegration;
                    if (donorBinding &&
                        !(acceptAppRoot && recoverableManifestSource(acceptAppRoot, donorBinding))) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `handoff donor carries package-integration authority without a SHA-256-verified restoration manifest; acceptance refuses before any reservation, cleanup, transfer, or registry mutation, and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(acceptAppRoot)})`, undefined, { nextAction: manifestRecoveryNextAction(donorBinding, retryAccept) });
                    }
                }
                if (status.state !== 'handoff_cleanup' &&
                    priorRunner &&
                    (typeof priorRunner.pid !== 'number' ||
                        typeof priorRunner.processBirth !== 'string' ||
                        inspectSessionOwner({
                            sessionId: priorSessionId ?? 'unknown',
                            pid: priorRunner.pid,
                            token: priorRunner.processBirth,
                        }) !== 'match')) {
                    throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'prior runner process identity cannot be proven for capability rotation');
                }
                if (status.state !== 'handoff_cleanup') {
                    const priorManagedMetro = priorStatus?.bindings.metro &&
                        typeof priorStatus.bindings.metro === 'object' &&
                        priorStatus.bindings.metro.mode === 'managed'
                        ? priorStatus.bindings.metro
                        : null;
                    let signerCapability = null;
                    if (priorManagedMetro) {
                        if (!priorSessionId) {
                            throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro handoff source authority is unavailable');
                        }
                        signerCapability = dependencies.getSignerCapability?.(priorSessionId) ?? null;
                        if (!signerCapability) {
                            throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'managed Metro handoff requires the source session signer capability');
                        }
                    }
                    const reservation = registry.reserveManagedMetroHandoffCleanup(session, {
                        handoffId,
                        token,
                        targetInstance: status.worker.instanceId,
                    });
                    if (reservation && reservation.phase !== 'shutdown_completed') {
                        const sourceSessionId = reservation.metro.sourceSessionId;
                        if (typeof sourceSessionId !== 'string' || !signerCapability) {
                            throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'managed Metro handoff reservation requires the source session signer capability');
                        }
                        const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(reservation.metro, {
                            sessionId: sourceSessionId,
                            signerCapability,
                        });
                        if (!stopped) {
                            registry.refuseManagedMetroHandoffCleanup(session, {
                                handoffId,
                                token,
                                targetInstance: status.worker.instanceId,
                            });
                            throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro shutdown was refused; the handoff was cancelled and donor authority was restored');
                        }
                        registry.completeManagedMetroHandoffCleanup(session, {
                            handoffId,
                            token,
                            targetInstance: status.worker.instanceId,
                        });
                    }
                    cleanup = registry.acceptHandoffInto(session, {
                        handoffId,
                        token,
                        targetInstance: status.worker.instanceId,
                    });
                }
                if (cleanup?.recorder && typeof cleanup.recorder.completedAt !== 'number') {
                    const recorderCleanup = registry.beginHandoffCleanupResource(session, status.worker.instanceId, 'recorder');
                    if (!recorderCleanup) {
                        throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'recorder cleanup binding disappeared while fenced');
                    }
                    await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(recorderCleanup);
                    registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'recorder');
                }
                const afterRecorder = registry.getSessionStatus(session.sessionId);
                cleanup = afterRecorder?.bindings.handoffCleanup;
                if (cleanup?.runner && typeof cleanup.runner.completedAt !== 'number') {
                    const runnerCleanup = registry.beginHandoffCleanupResource(session, status.worker.instanceId, 'runner');
                    if (!runnerCleanup) {
                        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'runner cleanup binding disappeared while fenced');
                    }
                    if (dependencies.stopHandoffRunner) {
                        await dependencies.stopHandoffRunner(runnerCleanup);
                    }
                    else {
                        await stopHandoffRunner(runnerCleanup, dependencies.probeProcessBirth, dependencies.signalProcess, dependencies.cleanupTimeoutMs);
                    }
                    registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'runner');
                }
                const afterRunner = registry.getSessionStatus(session.sessionId);
                cleanup = afterRunner?.bindings.handoffCleanup;
                if (cleanup?.observe && typeof cleanup.observe.completedAt !== 'number') {
                    const observeCleanup = registry.beginHandoffCleanupResource(session, status.worker.instanceId, 'observe');
                    if (!observeCleanup) {
                        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup binding disappeared while fenced');
                    }
                    if (dependencies.stopHandoffObserve) {
                        await dependencies.stopHandoffObserve(observeCleanup);
                    }
                    else {
                        await stopHandoffObserve(observeCleanup, dependencies.probeListener, dependencies.probeProcessBirth, dependencies.cleanupTimeoutMs);
                    }
                    registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'observe');
                }
                const afterObserve = registry.getSessionStatus(session.sessionId);
                cleanup = afterObserve?.bindings.handoffCleanup;
                if (cleanup?.metro && typeof cleanup.metro.completedAt !== 'number') {
                    const metroCleanup = registry.beginHandoffCleanupResource(session, status.worker.instanceId, 'metro');
                    if (!metroCleanup || typeof metroCleanup.sourceSessionId !== 'string') {
                        throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro cleanup binding disappeared while fenced');
                    }
                    const signerCapability = dependencies.getSignerCapability?.(metroCleanup.sourceSessionId);
                    if (!signerCapability) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'managed Metro handoff cleanup requires the source session signer capability');
                    }
                    const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metroCleanup, {
                        sessionId: metroCleanup.sourceSessionId,
                        signerCapability,
                    });
                    if (!stopped) {
                        throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro could not be stopped with its source session authority');
                    }
                    registry.completeHandoffCleanupResource(session, status.worker.instanceId, 'metro');
                }
                registry.finishHandoffCleanup(session, status.worker.instanceId);
                const acceptedStatus = registry.getSessionStatus(session.sessionId);
                const transferredIntegration = acceptedStatus?.bindings.packageIntegration;
                return okResult({
                    accepted: true,
                    session: projectPublicAuthorityStatus(runtime.status()),
                    runnerCapabilityRotated: Boolean(priorRunner),
                    integrationRestoration: typeof transferredIntegration?.installedBySessionId === 'string'
                        ? {
                            required: true,
                            action: 'restore_integration',
                            ownerSessionId: session.sessionId,
                            installedBySessionId: transferredIntegration.installedBySessionId,
                        }
                        : { required: false },
                    nextAction: typeof transferredIntegration?.installedBySessionId === 'string'
                        ? 'The recipient now owns integration restoration; call restore_integration with confirmed=true before release.'
                        : 'Reopen the exact device runner and pin the dev client before authoritative tools.',
                });
            }
            if (input.action === 'adopt_stale') {
                const adoptionHandle = required(input.adoptionHandle, 'adoptionHandle');
                const current = registry.getSessionStatus(session.sessionId);
                if (!current?.worker.instanceId) {
                    throw new SessionAuthorityError('HANDOFF_NOT_AUTHORIZED', 'recovery worker identity is unavailable');
                }
                const adoptionAppRoot = String(current.source.appRoot ?? '');
                const refuseManifestlessBinding = (subject, binding) => {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `${subject} without a SHA-256-verified restoration manifest; recovery refuses before any transfer, cleanup, or registry mutation, and canonical files were inspected for diagnostics only (${describeIntegrationFileDiagnostics(adoptionAppRoot)})`, undefined, {
                        nextAction: manifestRecoveryNextAction(binding, 'retry adopt_stale with the same adoptionHandle'),
                    });
                };
                if (current.state !== 'handoff_cleanup') {
                    const recoveryHandles = current.bindings.recoveryHandles;
                    const priorSessionId = typeof recoveryHandles?.adoptStale?.priorSessionId === 'string'
                        ? recoveryHandles.adoptStale.priorSessionId
                        : undefined;
                    const priorIntegration = priorSessionId
                        ? registry.getSessionStatus(priorSessionId)?.bindings.packageIntegration
                        : undefined;
                    if (priorIntegration &&
                        !(adoptionAppRoot && recoverableManifestSource(adoptionAppRoot, priorIntegration))) {
                        refuseManifestlessBinding('stale session carries package-integration authority', priorIntegration);
                    }
                    registry.adoptStaleWithHandle(session, adoptionHandle, current.worker.instanceId, {
                        expectedTargetAuthorityVersion: current.authorityVersion,
                    });
                }
                else {
                    registry.verifyStaleAdoptionResumption(session, adoptionHandle, current.worker.instanceId);
                    const transferredBinding = current.bindings.packageIntegration;
                    if (transferredBinding &&
                        !(adoptionAppRoot && recoverableManifestSource(adoptionAppRoot, transferredBinding))) {
                        refuseManifestlessBinding('resumed stale adoption carries package-integration authority', transferredBinding);
                    }
                }
                const adopted = registry.getSessionStatus(session.sessionId);
                const cleanup = adopted?.bindings.handoffCleanup;
                if (cleanup?.recorder && typeof cleanup.recorder.completedAt !== 'number') {
                    const recorderCleanup = registry.beginHandoffCleanupResource(session, current.worker.instanceId, 'recorder');
                    if (!recorderCleanup) {
                        throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'stale recorder cleanup binding disappeared while fenced');
                    }
                    await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(recorderCleanup);
                    registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'recorder');
                }
                if (cleanup?.runner && typeof cleanup.runner.completedAt !== 'number') {
                    const runnerCleanup = registry.beginHandoffCleanupResource(session, current.worker.instanceId, 'runner');
                    if (!runnerCleanup) {
                        throw new SessionAuthorityError('RUNNER_ADOPTION_REQUIRED', 'stale runner cleanup binding disappeared while fenced');
                    }
                    if (dependencies.stopHandoffRunner) {
                        await dependencies.stopHandoffRunner(runnerCleanup);
                    }
                    else {
                        await stopHandoffRunner(runnerCleanup, dependencies.probeProcessBirth, dependencies.signalProcess, dependencies.cleanupTimeoutMs);
                    }
                    registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'runner');
                }
                if (cleanup?.observe && typeof cleanup.observe.completedAt !== 'number') {
                    const observeCleanup = registry.beginHandoffCleanupResource(session, current.worker.instanceId, 'observe');
                    if (!observeCleanup) {
                        throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'stale Observe cleanup binding disappeared while fenced');
                    }
                    if (dependencies.stopHandoffObserve) {
                        await dependencies.stopHandoffObserve(observeCleanup);
                    }
                    else {
                        await stopHandoffObserve(observeCleanup, dependencies.probeListener, dependencies.probeProcessBirth, dependencies.cleanupTimeoutMs);
                    }
                    registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'observe');
                }
                if (cleanup?.metro && typeof cleanup.metro.completedAt !== 'number') {
                    const metroCleanup = registry.beginHandoffCleanupResource(session, current.worker.instanceId, 'metro');
                    if (!metroCleanup || typeof metroCleanup.sourceSessionId !== 'string') {
                        throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'stale Metro cleanup binding disappeared while fenced');
                    }
                    const signerCapability = dependencies.getSignerCapability?.(metroCleanup.sourceSessionId);
                    if (!signerCapability) {
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'stale Metro cleanup requires the source session signer capability');
                    }
                    const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metroCleanup, {
                        sessionId: metroCleanup.sourceSessionId,
                        signerCapability,
                    });
                    if (!stopped) {
                        throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'stale managed Metro could not be stopped with exact process authority');
                    }
                    registry.completeHandoffCleanupResource(session, current.worker.instanceId, 'metro');
                }
                if (adopted?.state === 'handoff_cleanup') {
                    registry.finishHandoffCleanup(session, current.worker.instanceId);
                }
                const settled = registry.getSessionStatus(session.sessionId);
                const transferredIntegration = settled?.bindings.packageIntegration;
                const integrationOutcome = transferredIntegration
                    ? {
                        integrationRestoration: {
                            required: true,
                            action: 'restore_integration',
                            installedBySessionId: transferredIntegration.installedBySessionId,
                        },
                        nextAction: 'The adopter now owns integration restoration; call restore_integration with confirmed=true before release.',
                    }
                    : {
                        integrationRestoration: { required: false },
                    };
                return okResult({
                    adopted: true,
                    session: projectPublicAuthorityStatus(runtime.status()),
                    ...integrationOutcome,
                    runner: {
                        adopted: false,
                        reason: 'runner capability is never crash-adopted; reopen the exact device to bind a fresh runner',
                    },
                });
            }
            const status = registry.getSessionStatus(session.sessionId);
            if (!status) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'session disappeared before release cleanup');
            }
            if (status.bindings.packageIntegration) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'package integration must be restored before session release');
            }
            const metro = status.bindings.metro;
            const runner = status.bindings.runner;
            const recorder = status.bindings.recorder;
            if (recorder) {
                const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
                if (!status.claims.some((claim) => claim.type === 'recorder' &&
                    claim.key === claimKey &&
                    claim.sessionId === session.sessionId &&
                    claim.claimEpoch === session.claimEpoch)) {
                    throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'recorder cleanup claim no longer matches the authenticated binding');
                }
                await (dependencies.stopHandoffRecorder ?? stopBoundRecorder)(recorder);
            }
            if (runner) {
                const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`;
                if (!status.claims.some((claim) => claim.type === 'runner' &&
                    claim.key === claimKey &&
                    claim.sessionId === session.sessionId &&
                    claim.claimEpoch === session.claimEpoch)) {
                    throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'runner cleanup claim no longer matches the authenticated binding');
                }
                const cleanup = { ...runner, claimKey, stopRequestedAt: Date.now() };
                if (dependencies.stopHandoffRunner) {
                    await dependencies.stopHandoffRunner(cleanup);
                }
                else {
                    await stopBoundRunner(cleanup, dependencies.probeProcessBirth, dependencies.signalProcess, dependencies.cleanupTimeoutMs);
                }
            }
            const observe = status.bindings.observe;
            if (observe) {
                const port = String(observe.port);
                if (status.bindings.observePort !== observe.port ||
                    !status.claims.some((claim) => claim.type === 'observe-port' &&
                        claim.key === port &&
                        claim.sessionId === session.sessionId &&
                        claim.claimEpoch === session.claimEpoch)) {
                    throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup claim no longer matches the authenticated binding');
                }
                const cleanup = { ...observe, stopRequestedAt: Date.now() };
                if (dependencies.stopHandoffObserve) {
                    await dependencies.stopHandoffObserve(cleanup);
                }
                else {
                    await stopBoundObserve(cleanup, dependencies.probeListener, dependencies.probeProcessBirth, dependencies.cleanupTimeoutMs);
                }
            }
            if (metro?.mode === 'managed') {
                const signerCapability = dependencies.getSignerCapability?.();
                if (!signerCapability) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'managed Metro release requires the session signer capability');
                }
                const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metro, {
                    sessionId: session.sessionId,
                    signerCapability,
                });
                if (!stopped) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro could not be stopped with exact process authority');
                }
            }
            registry.releaseSession(session);
            return okResult({ released: true, sessionId: session.sessionId });
        }
        catch (error) {
            return authorityFailure(error);
        }
    };
}
