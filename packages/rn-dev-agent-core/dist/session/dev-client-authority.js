import { verifyMetroAuthorityMarker } from './metro-authority.js';
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
    if (input.devClientUrl !== input.expectedDevClientUrl) {
        throw new Error('DEV_CLIENT_ENDPOINT_NOT_FOUND: declared dev-client URL does not match the session endpoint');
    }
    if (input.devClientUrl) {
        await dependencies.openUrl(input.platform, input.deviceId, input.devClientUrl, input.appId);
        if (input.platform === 'ios')
            await dependencies.acceptIosOpenDialog(input.deviceId);
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
    if (connected.deviceId !== input.deviceId) {
        throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: selected target is not proven on the claimed device');
    }
    const authority = await dependencies.readMarker();
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
    return buildBundleAuthorityBinding({
        ...input,
        deviceId: input.deviceId,
        metroPort: input.metroPort,
        ...(input.devClientUrl ? { devClientUrl: input.devClientUrl } : {}),
        targetId: connected.targetId,
        connectionGeneration: connected.connectionGeneration,
    });
}
