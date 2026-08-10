#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBuildReceipt } from './session/build-receipt.js';
import { captureInstalledArtifact } from './session/install-authority.js';
import { resolveExpoAndroidDevice } from './session/expo-android-device.js';
import { parseDeclaredManifests } from './session/declared-source-contract.js';
import { buildSignedMetroMarker, createMetroAuthorityModule } from './session/metro-authority.js';
import { captureMetroBinding } from './session/metro-binding.js';
import { inspectManagedMetroLifecycle, refreshManagedMetroBuildGeneration, startManagedMetro, stopManagedMetro, verifyManagedMetroManagementProof, } from './session/managed-metro.js';
import { inspectSessionOwner } from './session/process-owner.js';
import { openSessionRegistry, SessionAuthorityError, } from './session/registry.js';
import { resolveSourceIdentity } from './session/source-identity.js';
import { createAuthorityStateLayout, openAuthorityStateLayout, sessionRuntimeDirectory, } from './session/state-root.js';
import { inspectAuthorityMigration } from './session/migration-diagnostic.js';
import { projectPublicAuthorityStatus } from './session/public-status.js';
import { stopBoundObserve, stopBoundRecorder, stopBoundRunner } from './session/process-cleanup.js';
import { ensureAndroidMetroReverse, removeAndroidMetroReverse, } from './session/android-metro-reverse.js';
import { closeBoundDirectories, openBoundDirectory, openBoundSubdirectory, writeBoundDirectoryFile, } from './session/bound-directory.js';
function resolveStatus() {
    const requestedStateHome = process.env.RN_DEV_AGENT_STATE_DIR;
    const layout = requestedStateHome
        ? openAuthorityStateLayout(requestedStateHome)
        : createAuthorityStateLayout();
    const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
    const explicit = process.env.RN_DEV_AGENT_SESSION_ID;
    const source = resolveSourceIdentity(process.cwd(), {
        declaredRoot: process.env.RN_DEV_AGENT_DECLARED_ROOT,
        declaredManifests: parseDeclaredManifests(process.env.RN_DEV_AGENT_DECLARED_MANIFESTS),
    });
    const candidates = explicit
        ? [registry.getSessionStatus(explicit)].filter((status) => status !== null)
        : registry
            .findSessionsByWorktree(source.worktreeKey)
            .filter((status) => status.appRootKey === source.appRootKey);
    if (candidates.length !== 1) {
        registry.close();
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', candidates.length === 0
            ? `no live session in authority registry ${layout.registry} matches this canonical worktree and app root`
            : `multiple live sessions in authority registry ${layout.registry} match this worktree and app root; set RN_DEV_AGENT_SESSION_ID`);
    }
    const status = candidates[0];
    if (explicit &&
        (status.worktreeKey !== source.worktreeKey || status.appRootKey !== source.appRootKey)) {
        registry.close();
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'explicit session belongs to a different canonical worktree or app root');
    }
    return Object.assign(status, {
        closeRegistry: () => registry.close(),
        registry,
        layout,
    });
}
function readSigner(status) {
    const secret = JSON.parse(readFileSync(join(status.layout.sessions, status.sessionId, 'secret.json'), 'utf8'));
    if (typeof secret.signerCapability !== 'string') {
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'session build signer is unavailable');
    }
    return secret.signerCapability;
}
function reconcileManagedMetroStatus(status) {
    const metro = status.bindings.metro;
    if (metro?.mode !== 'managed')
        return status;
    const inspection = inspectManagedMetroLifecycle(metro, {
        sessionId: status.sessionId,
        signerCapability: readSigner(status),
    });
    if (inspection.status === 'live')
        return status;
    const priorTargetId = status.bindings.bundle
        ?.targetId;
    const metroPort = Number(status.bindings.metroPort);
    const session = { sessionId: status.sessionId, claimEpoch: status.claimEpoch };
    status.registry.updateBindings(session, {
        expectedAuthorityVersion: status.authorityVersion,
        state: status.bindings.install
            ? 'device_bound'
            : status.bindings.device
                ? 'device_claimed'
                : 'source_bound',
        bindings: {
            metro: null,
            metroCleanup: metro,
            metroTerminal: {
                code: inspection.code,
                reason: inspection.reason,
                phase: status.bindings.bundle ? 'after-bind' : 'before-bind',
                observedAt: Date.now(),
                instanceId: metro.instanceId,
            },
            bundle: null,
        },
        releaseResources: typeof priorTargetId === 'string' && Number.isSafeInteger(metroPort)
            ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
            : [],
    });
    const current = status.registry.getSessionStatus(status.sessionId);
    if (!current) {
        throw new SessionAuthorityError('SESSION_OWNER_LOST', 'session disappeared during managed Metro reconciliation');
    }
    return Object.assign(current, {
        closeRegistry: status.closeRegistry,
        registry: status.registry,
        layout: status.layout,
    });
}
function sameAndroidMetroReverse(current, next) {
    if (!current || !next)
        return current === next;
    const binding = current;
    return (binding.platform === next.platform &&
        binding.deviceId === next.deviceId &&
        binding.metroPort === next.metroPort &&
        binding.local === next.local &&
        binding.remote === next.remote);
}
function ensurePhysicalAndroidMetroReachability(status) {
    const device = status.bindings.device;
    if (device?.platform !== 'android' || typeof device.deviceId !== 'string')
        return status;
    const existing = status.bindings.androidMetroReverse;
    const result = ensureAndroidMetroReverse({
        deviceId: device.deviceId,
        metroPort: Number(status.bindings.metroPort),
        binding: existing,
    });
    if (sameAndroidMetroReverse(existing ?? null, result.binding))
        return status;
    try {
        status.registry.updateBindings({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, {
            expectedAuthorityVersion: status.authorityVersion,
            bindings: { androidMetroReverse: result.binding },
        });
    }
    catch (error) {
        if (result.created && result.binding) {
            try {
                removeAndroidMetroReverse(result.binding);
            }
            catch (cleanupError) {
                throw new AggregateError([error, cleanupError], 'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: adb reverse was created but its authority binding could not be persisted or safely cleaned');
            }
        }
        throw error;
    }
    const current = status.registry.getSessionStatus(status.sessionId);
    if (!current) {
        throw new SessionAuthorityError('SESSION_OWNER_LOST', 'session disappeared after physical Android Metro reachability was established');
    }
    return Object.assign(current, {
        closeRegistry: status.closeRegistry,
        registry: status.registry,
        layout: status.layout,
    });
}
function removeSessionAndroidMetroReverse(status) {
    const binding = status.bindings.androidMetroReverse;
    if (binding)
        removeAndroidMetroReverse(binding);
}
function beginCliOperation(status, tool, profile) {
    const operation = status.registry.beginOperation({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, { operationId: randomUUID(), tool, profile });
    if (operation.authorityVersion !== status.authorityVersion) {
        status.registry.cancelOperation(operation);
        throw new SessionAuthorityError('AUTHORITY_LOST_DURING_OPERATION', 'session authority changed before CLI operation reservation');
    }
    return operation;
}
function writeMarker(status, input) {
    const appRoot = String(status.source.appRoot);
    const marker = buildSignedMetroMarker({
        sessionId: status.sessionId,
        metroInstanceId: input.metroInstanceId,
        worktreeKey: status.worktreeKey,
        appId: input.appId,
        platform: input.platform,
        buildGeneration: input.buildGeneration,
    }, input.signerCapability);
    const agent = openBoundDirectory(join(appRoot, '.rn-agent'));
    let integration;
    let primaryError;
    try {
        integration = openBoundSubdirectory(agent, 'integration');
        writeBoundDirectoryFile(integration, 'authority-marker.js', Buffer.from(createMetroAuthorityModule(marker)), 0o600);
    }
    catch (error) {
        primaryError = error;
        throw error;
    }
    finally {
        closeBoundDirectories([integration, agent], primaryError);
    }
}
async function ensureManagedMetro(status) {
    const device = status.bindings.device;
    if ((device?.platform !== 'ios' && device?.platform !== 'android') ||
        typeof device.appId !== 'string') {
        throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'an exact device/app binding is required before managed Metro starts');
    }
    const platform = device.platform;
    const appId = device.appId;
    if (!inspectAuthorityMigration(status).packageIntegration.installed) {
        throw new SessionAuthorityError('BUNDLE_HANDSHAKE_UNAVAILABLE', 'session package and Metro integration must be applied before managed Metro starts');
    }
    const signerCapability = readSigner(status);
    const existing = status.bindings.metro;
    const retainedCleanup = status.bindings.metroCleanup;
    const operation = beginCliOperation(status, 'rn-session ensure-metro', 'transition:ensure-metro');
    let currentOperation = operation;
    let startedBinding = null;
    let cleanupBindingCommitted = false;
    let bindingCommitted = false;
    try {
        await status.registry.runWithOperation(operation, async () => {
            if (retainedCleanup) {
                if (!verifyManagedMetroManagementProof(retainedCleanup, {
                    sessionId: status.sessionId,
                    signerCapability,
                })) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'retained Metro cleanup is not authenticated managed authority; run rn_session stop_metro with confirmed=true for safe release or exact owner recovery');
                }
                if (!(await stopManagedMetro(retainedCleanup, {
                    sessionId: status.sessionId,
                    signerCapability,
                }))) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'retained managed Metro cleanup is unresolved; run rn_session stop_metro');
                }
                status.registry.verifyOperation(currentOperation);
                currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
                    bindings: { metroCleanup: null, bundle: null },
                });
            }
            if (existing &&
                !verifyManagedMetroManagementProof(existing, {
                    sessionId: status.sessionId,
                    signerCapability,
                })) {
                throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'existing Metro binding is not authenticated managed authority');
            }
            if (typeof existing?.pid === 'number' &&
                typeof existing.port === 'number' &&
                typeof existing.instanceId === 'string' &&
                typeof existing.buildGeneration === 'number') {
                let isCurrent = false;
                try {
                    await captureMetroBinding({
                        port: existing.port,
                        pid: existing.pid,
                        instanceId: existing.instanceId,
                        sourceRoot: String(status.source.contentRoot),
                        buildGeneration: existing.buildGeneration,
                    });
                    isCurrent = true;
                }
                catch { }
                if (isCurrent) {
                    status.registry.verifyOperation(currentOperation);
                    return;
                }
                if (!(await stopManagedMetro(existing, {
                    sessionId: status.sessionId,
                    signerCapability,
                }))) {
                    throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'existing external Metro binding is stale and cannot be replaced automatically');
                }
                status.registry.verifyOperation(currentOperation);
                currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
                    bindings: { metro: null, bundle: null },
                });
            }
            const instanceId = randomUUID();
            const buildGeneration = Math.max(Number(existing?.buildGeneration ?? 0), Number(retainedCleanup?.buildGeneration ?? 0), Number(status.bindings.install?.buildGeneration ?? 0)) + 1;
            writeMarker(status, {
                platform,
                appId,
                metroInstanceId: instanceId,
                buildGeneration,
                signerCapability,
            });
            status.registry.verifyOperation(currentOperation);
            startedBinding = await startManagedMetro({
                appRoot: String(status.source.appRoot),
                runtimeRoot: sessionRuntimeDirectory(status.layout, status.sessionId),
                sourceRoot: String(status.source.contentRoot),
                sessionId: status.sessionId,
                port: Number(status.bindings.metroPort),
                instanceId,
                buildGeneration,
                signerCapability,
            });
            currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
                bindings: { metroCleanup: startedBinding },
            });
            cleanupBindingCommitted = true;
            currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
                state: 'device_claimed',
                bindings: {
                    metro: startedBinding,
                    metroCleanup: null,
                    metroTerminal: null,
                    bundle: null,
                },
            });
            cleanupBindingCommitted = false;
            bindingCommitted = true;
        });
        status.registry.endOperation(currentOperation);
    }
    catch (error) {
        let failure = error;
        let cleanupProven = startedBinding === null || bindingCommitted;
        if (startedBinding && !bindingCommitted) {
            try {
                cleanupProven = await stopManagedMetro(startedBinding, {
                    sessionId: status.sessionId,
                    signerCapability,
                });
                if (!cleanupProven) {
                    failure = new AggregateError([
                        failure,
                        new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'uncommitted managed Metro replacement cleanup could not be proven'),
                    ]);
                }
            }
            catch (cleanupError) {
                cleanupProven = false;
                failure = new AggregateError([failure, cleanupError]);
            }
        }
        if (cleanupProven && cleanupBindingCommitted) {
            try {
                currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
                    bindings: { metroCleanup: null },
                });
                cleanupBindingCommitted = false;
            }
            catch (cleanupPersistenceError) {
                cleanupProven = false;
                failure = new AggregateError([failure, cleanupPersistenceError]);
            }
        }
        if (cleanupProven)
            status.registry.cancelOperation(currentOperation);
        throw failure;
    }
}
async function main() {
    const command = process.argv[2] ?? 'status';
    let status = resolveStatus();
    try {
        if (command === 'status' || command === 'feedback-json' || command === 'prepare-build') {
            status = reconcileManagedMetroStatus(status);
        }
        if (command === 'status') {
            process.stdout.write(`${JSON.stringify(projectPublicAuthorityStatus({ available: true, ...status }, { recoveryRequirement: status.registry.inspectRecoveryRequirement(status.sessionId) }), null, 2)}\n`);
            return;
        }
        if (command === 'feedback-json') {
            process.stdout.write(`${JSON.stringify({
                sessionAvailable: true,
                authorityState: status.state,
                ownMetroAllocated: Number.isSafeInteger(Number(status.bindings.metroPort)),
                ownMetroBound: Boolean(status.bindings.metro),
                foreignSessionCount: status.registry.countOtherOperationalSessions(status.sessionId),
            })}\n`);
            return;
        }
        if (command === 'build-json') {
            const device = status.bindings.device;
            const metroPort = Number(status.bindings.metroPort);
            if ((device?.platform !== 'ios' && device?.platform !== 'android') ||
                typeof device.deviceId !== 'string' ||
                typeof device.appId !== 'string' ||
                !Number.isSafeInteger(metroPort)) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'device and allocated Metro port must be bound before a session build');
            }
            process.stdout.write(`${JSON.stringify({
                platform: device.platform,
                deviceId: device.deviceId,
                appId: device.appId,
                metroPort,
                sessionId: status.sessionId,
            })}\n`);
            return;
        }
        if (command === 'ensure-metro') {
            await ensureManagedMetro(status);
            const current = status.registry.getSessionStatus(status.sessionId);
            process.stdout.write(`${JSON.stringify({
                metroBound: true,
                metroPort: current?.bindings.metroPort,
            })}\n`);
            return;
        }
        if (command === 'resolve-expo-android-device') {
            const requestedDeviceId = process.argv[3];
            const device = status.bindings.device;
            if (device?.platform !== 'android' ||
                typeof device.deviceId !== 'string' ||
                requestedDeviceId !== device.deviceId) {
                throw new SessionAuthorityError('EXPO_DEVICE_IDENTITY_MISMATCH', 'the requested Expo device does not equal the authority-bound adb serial');
            }
            process.stdout.write(`${JSON.stringify(resolveExpoAndroidDevice(device.deviceId))}\n`);
            return;
        }
        if (command === 'prepare-build') {
            const platform = process.argv[3];
            const deliveredBuildToken = process.argv[4];
            const buildKind = process.argv[5];
            const device = status.bindings.device;
            const metro = status.bindings.metro;
            if ((platform !== 'ios' && platform !== 'android') ||
                device?.platform !== platform ||
                typeof device.deviceId !== 'string' ||
                typeof device.appId !== 'string' ||
                typeof metro?.instanceId !== 'string') {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'an exact device/app and live Metro binding are required before build');
            }
            if (typeof deliveredBuildToken !== 'string' ||
                !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(deliveredBuildToken)) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'prepare-build publishes only against a caller-delivered abort capability (canonical UUID)');
            }
            if (buildKind !== 'expo' && buildKind !== 'bare-react-native') {
                throw new SessionAuthorityError('SESSION_BUILD_COMMAND_UNSUPPORTED', 'prepare-build requires the parsed native build command kind');
            }
            const appId = device.appId;
            const metroInstanceId = metro.instanceId;
            const signerCapability = readSigner(status);
            const metroInspection = inspectManagedMetroLifecycle(metro, {
                sessionId: status.sessionId,
                signerCapability,
            });
            if (metro.mode !== 'managed' || metroInspection.status !== 'live') {
                const recovery = metro.mode === 'external'
                    ? 'stop external Metro through its owning process, then run rn_session stop_metro with confirmed=true'
                    : 'run rn_session stop_metro with confirmed=true for safe release or exact owner recovery';
                throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', metroInspection.status === 'lost'
                    ? `${metroInspection.reason}; ${recovery} before retrying`
                    : 'build requires authenticated managed Metro authority');
            }
            status = ensurePhysicalAndroidMetroReachability(status);
            const buildGeneration = Math.max(Number(metro.buildGeneration ?? 0), Number(status.bindings.install?.buildGeneration ?? 0)) + 1;
            const buildToken = deliveredBuildToken;
            const buildMetro = refreshManagedMetroBuildGeneration(metro, {
                sessionId: status.sessionId,
                buildGeneration,
                signerCapability,
            });
            const runner = status.bindings.runner;
            const recorder = status.bindings.recorder;
            const releaseResources = [];
            if (recorder) {
                const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
                if (!status.claims.some((claim) => claim.type === 'recorder' &&
                    claim.key === claimKey &&
                    claim.sessionId === status.sessionId &&
                    claim.claimEpoch === status.claimEpoch)) {
                    throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'recorder cleanup claim no longer matches the authenticated binding');
                }
                releaseResources.push({ type: 'recorder', key: claimKey });
            }
            if (runner) {
                const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`;
                if (!status.claims.some((claim) => claim.type === 'runner' &&
                    claim.key === claimKey &&
                    claim.sessionId === status.sessionId &&
                    claim.claimEpoch === status.claimEpoch)) {
                    throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'runner cleanup claim no longer matches the authenticated binding');
                }
                releaseResources.push({ type: 'runner', key: claimKey });
            }
            const operation = beginCliOperation(status, 'rn-session prepare-build', 'transition:prepare-build');
            let currentOperation = operation;
            try {
                await status.registry.runWithOperation(operation, async () => {
                    if (recorder) {
                        await stopBoundRecorder(recorder);
                        status.registry.verifyOperation(operation);
                    }
                    if (runner) {
                        await stopBoundRunner(runner);
                        status.registry.verifyOperation(operation);
                    }
                    writeMarker(status, {
                        platform,
                        appId,
                        metroInstanceId,
                        buildGeneration,
                        signerCapability,
                    });
                    status.registry.verifyOperation(operation);
                    currentOperation = status.registry.replaceBindingsDuringOperation(operation, {
                        releaseResources,
                        bindings: {
                            metro: buildMetro,
                            pendingBuild: { buildToken, platform, buildGeneration, buildKind },
                            bundle: null,
                            runner: null,
                            recorder: null,
                        },
                    });
                });
                status.registry.endOperation(currentOperation);
            }
            catch (error) {
                status.registry.cancelOperation(currentOperation);
                throw error;
            }
            process.stdout.write(`${JSON.stringify({
                platform,
                deviceId: device.deviceId,
                appId: device.appId,
                metroPort: Number(status.bindings.metroPort),
                sessionId: status.sessionId,
                buildToken,
                buildKind,
                ...(platform === 'ios' ? { simulator: true } : {}),
                ...(typeof device.devClientUrl === 'string' ? { devClientUrl: device.devClientUrl } : {}),
            })}\n`);
            return;
        }
        if (command === 'complete-build') {
            const platform = process.argv[3];
            const buildToken = process.argv[4];
            const device = status.bindings.device;
            if ((platform !== 'ios' && platform !== 'android') ||
                device?.platform !== platform ||
                typeof device.deviceId !== 'string' ||
                typeof device.appId !== 'string' ||
                typeof buildToken !== 'string') {
                throw new SessionAuthorityError('SESSION_BUILD_IDENTITY_CONFLICT', 'completed build does not match the exact claimed device and app');
            }
            const pending = status.bindings.pendingBuild;
            if (pending?.buildToken !== buildToken ||
                pending.platform !== platform ||
                !Number.isSafeInteger(pending.buildGeneration) ||
                (pending.buildKind !== 'expo' && pending.buildKind !== 'bare-react-native')) {
                throw new SessionAuthorityError('SESSION_BUILD_IDENTITY_CONFLICT', 'build completion capability is stale or foreign');
            }
            const signerCapability = readSigner(status);
            const installed = captureInstalledArtifact({
                platform,
                deviceId: device.deviceId,
                appId: device.appId,
            });
            const receipt = createBuildReceipt({
                sessionId: status.sessionId,
                sourceKey: status.sourceKey,
                worktreeKey: status.worktreeKey,
                appRootKey: status.appRootKey,
                platform,
                deviceId: device.deviceId,
                appId: device.appId,
                metroPort: Number(status.bindings.metroPort),
                artifactDigest: installed.artifactDigest,
                installGeneration: installed.installGeneration,
                buildGeneration: Number(pending.buildGeneration),
                buildKind: pending.buildKind,
                ...(typeof device.devClientUrl === 'string' ? { devClientUrl: device.devClientUrl } : {}),
            }, signerCapability);
            status.registry.claimResources({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, [{ type: 'device', key: `${platform}:${device.deviceId}` }]);
            status.registry.updateBindings({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, {
                expectedAuthorityVersion: status.authorityVersion + 1,
                state: 'device_bound',
                bindings: { install: receipt.payload, pendingBuild: null },
            });
            process.stdout.write(`${JSON.stringify(receipt)}\n`);
            return;
        }
        if (command === 'abort-build') {
            const platform = process.argv[3];
            const buildToken = process.argv[4];
            if ((platform !== 'ios' && platform !== 'android') || typeof buildToken !== 'string') {
                throw new SessionAuthorityError('SESSION_BUILD_IDENTITY_CONFLICT', 'aborting a build requires the exact platform and build capability');
            }
            const pending = status.bindings.pendingBuild;
            if (!pending) {
                process.stdout.write(`${JSON.stringify({ aborted: false, alreadyClear: true })}\n`);
                return;
            }
            if (pending.buildToken !== buildToken || pending.platform !== platform) {
                throw new SessionAuthorityError('SESSION_BUILD_IDENTITY_CONFLICT', 'build abort capability is stale or foreign');
            }
            status.registry.updateBindings({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, {
                expectedAuthorityVersion: status.authorityVersion,
                bindings: { pendingBuild: null },
            });
            process.stdout.write(`${JSON.stringify({
                aborted: true,
                platform,
                buildGeneration: pending.buildGeneration,
            })}\n`);
            return;
        }
        if (command === 'release') {
            const epoch = Number(process.env.RN_DEV_AGENT_CLAIM_EPOCH);
            if (process.env.RN_DEV_AGENT_SESSION_ID !== status.sessionId || epoch !== status.claimEpoch) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'release requires the exact session ID and claim epoch in the environment');
            }
            const signerCapability = readSigner(status);
            const recorder = status.bindings.recorder;
            if (recorder) {
                const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
                if (!status.claims.some((claim) => claim.type === 'recorder' &&
                    claim.key === claimKey &&
                    claim.sessionId === status.sessionId &&
                    claim.claimEpoch === status.claimEpoch)) {
                    throw new SessionAuthorityError('RECORDING_AUTHORITY_MISMATCH', 'recorder cleanup claim no longer matches the authenticated binding');
                }
            }
            const runner = status.bindings.runner;
            if (runner) {
                const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`;
                if (!status.claims.some((claim) => claim.type === 'runner' &&
                    claim.key === claimKey &&
                    claim.sessionId === status.sessionId &&
                    claim.claimEpoch === status.claimEpoch)) {
                    throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'runner cleanup claim no longer matches the authenticated binding');
                }
            }
            const observe = status.bindings.observe;
            if (observe) {
                const port = String(observe.port);
                if (status.bindings.observePort !== observe.port ||
                    !status.claims.some((claim) => claim.type === 'observe-port' &&
                        claim.key === port &&
                        claim.sessionId === status.sessionId &&
                        claim.claimEpoch === status.claimEpoch)) {
                    throw new SessionAuthorityError('OBSERVE_AUTHORITY_MISMATCH', 'Observe cleanup claim no longer matches the authenticated binding');
                }
            }
            const metro = status.bindings.metro;
            if (status.bindings.packageIntegration) {
                throw new SessionAuthorityError('SESSION_AUTHORITY_REQUIRED', 'package integration must be restored before session release');
            }
            const operation = beginCliOperation(status, 'rn-session release', 'transition:release');
            let released = false;
            try {
                await status.registry.runWithOperation(operation, async () => {
                    removeSessionAndroidMetroReverse(status);
                    status.registry.verifyOperation(operation);
                    if (recorder) {
                        await stopBoundRecorder(recorder);
                        status.registry.verifyOperation(operation);
                    }
                    if (runner) {
                        await stopBoundRunner(runner);
                        status.registry.verifyOperation(operation);
                    }
                    if (observe) {
                        await stopBoundObserve(observe);
                        status.registry.verifyOperation(operation);
                    }
                    if (metro?.mode === 'managed' &&
                        !(await stopManagedMetro(metro, {
                            sessionId: status.sessionId,
                            signerCapability,
                        }))) {
                        throw new SessionAuthorityError('METRO_AUTHORITY_MISMATCH', 'managed Metro could not be stopped with exact process authority');
                    }
                    status.registry.verifyOperation(operation);
                    status.registry.releaseSession({ sessionId: status.sessionId, claimEpoch: epoch });
                    released = true;
                });
            }
            finally {
                if (!released)
                    status.registry.cancelOperation(operation);
            }
            process.stdout.write(`${JSON.stringify({ released: true })}\n`);
            return;
        }
        throw new SessionAuthorityError('SESSION_BUILD_COMMAND_UNSUPPORTED', `unknown rn-session command: ${command}`);
    }
    finally {
        status.closeRegistry();
    }
}
main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
});
