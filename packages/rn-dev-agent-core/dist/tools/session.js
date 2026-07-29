import { authorityErrorMeta, SessionAuthorityError } from '../session/registry.js';
import { failResult, okResult } from '../utils.js';
import { verifyBuildReceipt } from '../session/build-receipt.js';
import { captureInstallGeneration, } from '../session/install-authority.js';
import { captureMetroBinding } from '../session/metro-binding.js';
import { applyPackageIntegration, previewMetroIntegration, previewPackageIntegration, readPackageIntegrationInputs, restorePackageIntegrationFiles, serializePackageIntegrationManifest, } from '../session/package-integration.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { inspectSessionOwner } from '../session/process-owner.js';
import { projectPublicAuthorityStatus } from '../session/public-status.js';
import { probeProcessBirth } from '../session/process-birth.js';
import { inspectManagedMetroLifecycle, stopManagedMetro, } from '../session/managed-metro.js';
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
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', `${action} requires releasing active ${activeBindings.join(', ')} authority`);
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
    try {
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
    catch {
        return {
            ...authority,
            bindings: {
                ...authority.bindings,
                metro: null,
                metroCleanup: metro,
                metroTerminal,
                bundle: null,
            },
        };
    }
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
                const metro = (status.bindings.metroCleanup ?? status.bindings.metro);
                if (!metro) {
                    return okResult({
                        stopped: false,
                        alreadyStopped: true,
                        session: projectPublicAuthorityStatus(runtime.status()),
                    });
                }
                if (metro.mode !== 'managed') {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'stop_metro cannot terminate an externally managed Metro');
                }
                const signerCapability = dependencies.getSignerCapability?.();
                if (!signerCapability) {
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'managed Metro cleanup requires the session signer capability');
                }
                const stopped = await (dependencies.stopManagedMetro ?? stopManagedMetro)(metro, {
                    sessionId: session.sessionId,
                    signerCapability,
                });
                if (!stopped) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro could not be stopped with exact process authority');
                }
                const priorTargetId = status.bindings.bundle
                    ?.targetId;
                const metroPort = Number(status.bindings.metroPort);
                registry.updateBindings(session, {
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
                    stopped: true,
                    alreadyStopped: false,
                    session: projectPublicAuthorityStatus(runtime.status()),
                    nextAction: 'Restore package integration with confirmed=true, then release the exact session.',
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
                const manifestSource = integrationInputs.manifest ?? restorationManifestSource ?? installationManifestSource;
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
                        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'integration manifest is unavailable for restoration');
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
                    if (!restorationManifestSource) {
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
                    throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'package integration is already owned by an active session lifecycle');
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
                if (current.state !== 'handoff_cleanup') {
                    registry.adoptStaleWithHandle(session, adoptionHandle, current.worker.instanceId);
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
                return okResult({
                    adopted: true,
                    session: projectPublicAuthorityStatus(runtime.status()),
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
