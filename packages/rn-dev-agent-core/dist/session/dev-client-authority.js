import { managedMetroProxyUrl } from './build-adapter.js';
import { verifyManagedManifestLaunchAsset } from './expo-manifest.js';
import { verifyMetroAuthorityMarker } from './metro-authority.js';
export async function reconcileAuthoritativeBundle(status, dependencies) {
    const prior = status.bindings.bundle;
    if (!prior) {
        throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: durable bundle authority is unavailable');
    }
    const bundle = await dependencies.verifyRuntime();
    if (dependencies.hasActiveOperation())
        return;
    const priorTargetId = String(prior.targetId);
    const nextTargetId = String(bundle.targetId);
    const metroPort = String(status.bindings.metroPort);
    dependencies.commit({
        expectedAuthorityVersion: status.authorityVersion,
        state: 'ready',
        bindings: { bundle },
        releaseResources: priorTargetId !== nextTargetId
            ? [{ type: 'target', key: `${metroPort}:${priorTargetId}` }]
            : [],
        claimResources: priorTargetId !== nextTargetId
            ? [{ type: 'target', key: `${metroPort}:${nextTargetId}` }]
            : [],
    });
}
export function buildBundleAuthorityBinding(input) {
    return {
        sessionId: input.sessionId,
        metroInstanceId: input.metroInstanceId,
        worktreeKey: input.worktreeKey,
        appId: input.appId,
        platform: input.platform,
        buildGeneration: input.buildGeneration,
        deviceId: input.deviceId,
        metroPort: input.metroPort,
        ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
        launchMethod: input.devClientUrl ? 'url' : 'app',
        targetId: input.targetId,
        connectionGeneration: input.connectionGeneration,
        authorityScope: 'initial-bundle',
        sourceFidelity: 'not-proven',
    };
}
export function boundConnectConflict(status, request) {
    const device = status.bindings.device;
    const bundle = status.bindings.bundle;
    if (typeof request.metroPort === 'number' && request.metroPort !== status.bindings.metroPort) {
        return {
            code: 'METRO_AUTHORITY_MISMATCH',
            message: 'metroPort does not match the authority-bound Metro port',
        };
    }
    if (typeof request.platform === 'string' && request.platform.toLowerCase() !== device?.platform) {
        return {
            code: 'DEVICE_AUTHORITY_MISMATCH',
            message: 'platform does not match the authority-bound device',
        };
    }
    if (typeof request.bundleId === 'string' &&
        (typeof device?.appId !== 'string' ||
            request.bundleId.toLowerCase() !== device.appId.toLowerCase())) {
        return {
            code: 'DEVICE_AUTHORITY_MISMATCH',
            message: 'bundleId does not match the authority-bound app',
        };
    }
    if (typeof request.targetId === 'string' &&
        (typeof bundle?.targetId !== 'string' || request.targetId !== bundle.targetId)) {
        return {
            code: 'CDP_TARGET_AUTHORITY_MISMATCH',
            message: 'targetId is not the target already proven by this session',
        };
    }
    return null;
}
export async function pinExactDevClient(input, dependencies) {
    if (!Number.isSafeInteger(input.metroPort) || input.metroPort < 1 || input.metroPort > 65_535) {
        throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: authority-bound Metro port is unavailable');
    }
    const derivedIosExpoLaunchTarget = input.platform === 'ios' && input.runtimeKind === 'expo-dev-client'
        ? managedMetroProxyUrl(input)
        : undefined;
    if (input.devClientUrl !== input.expectedDevClientUrl) {
        throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: declared dev-client URL does not match the session endpoint');
    }
    if (input.runtimeKind === 'bare-react-native' && input.devClientUrl) {
        throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: launch kind contradicts the signed build provenance');
    }
    const managedManifestHost = '127.0.0.1';
    if (input.runtimeKind === 'expo-dev-client') {
        if (!dependencies.readManagedManifest) {
            throw new Error('METRO_MANIFEST_ENDPOINT_MISMATCH: managed manifest verification is unavailable');
        }
        const response = await dependencies.readManagedManifest({
            host: managedManifestHost,
            metroPort: input.metroPort,
            platform: input.platform,
        });
        verifyManagedManifestLaunchAsset(response, {
            host: managedManifestHost,
            port: input.metroPort,
        });
    }
    if (input.devClientUrl) {
        await dependencies.openUrl(input.platform, input.deviceId, input.devClientUrl, input.appId);
        if (input.platform === 'ios')
            await dependencies.acceptIosOpenDialog(input.deviceId);
    }
    else if (derivedIosExpoLaunchTarget) {
        await dependencies.launchExactAppWithInitialUrl(input.deviceId, input.appId, derivedIosExpoLaunchTarget);
    }
    else {
        await dependencies.launchExactApp(input.platform, input.deviceId, input.appId);
    }
    const connected = await dependencies.connectExact({
        metroPort: input.metroPort,
        platform: input.platform,
        appId: input.appId,
        deviceId: input.deviceId,
    });
    try {
        if (connected.deviceId !== input.deviceId) {
            throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: selected target is not proven on the claimed device');
        }
        const hasStagedLifecycle = 'run' in connected;
        const authority = await (hasStagedLifecycle
            ? connected.run(() => dependencies.readMarker(connected))
            : dependencies.readMarker(connected));
        if (!authority?.marker || authority.status !== 'signed') {
            throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: runtime did not expose a signed authority marker');
        }
        verifyMetroAuthorityMarker(authority.marker, input.signerCapability, {
            sessionId: input.sessionId,
            metroInstanceId: input.metroInstanceId,
            worktreeKey: input.worktreeKey,
            appId: input.appId,
            platform: input.platform,
            buildGeneration: input.buildGeneration,
        });
        const bundle = buildBundleAuthorityBinding({
            ...input,
            deviceId: input.deviceId,
            metroPort: input.metroPort,
            ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
            targetId: connected.targetId,
            connectionGeneration: connected.connectionGeneration,
        });
        if (hasStagedLifecycle) {
            connected.assertActive();
            if (!dependencies.commitBundle) {
                throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: atomic bundle commit is unavailable');
            }
            dependencies.commitBundle(bundle, {
                assertActive: connected.assertActive,
                publish: connected.publish,
            });
        }
        return bundle;
    }
    catch (error) {
        if ('cancel' in connected)
            connected.cancel();
        throw error;
    }
}
