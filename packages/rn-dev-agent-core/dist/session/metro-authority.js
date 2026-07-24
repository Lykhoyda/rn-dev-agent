import { createHmac, createSecretKey, timingSafeEqual } from 'node:crypto';
function serializePayload(payload) {
    return JSON.stringify(payload);
}
function signPayload(payload, signerCapability) {
    const signingKey = createSecretKey(Buffer.from(signerCapability, 'base64url'));
    return createHmac('sha256', signingKey).update(serializePayload(payload)).digest('hex');
}
function mismatch() {
    return new Error('BUNDLE_IDENTITY_MISMATCH: signed initial-bundle binding did not match');
}
export function createMetroAuthorityMarker(binding, signerCapability) {
    const payload = {
        ...binding,
        authorityScope: 'initial-bundle',
        sourceFidelity: 'not-proven',
    };
    return { version: 1, payload, signature: signPayload(payload, signerCapability) };
}
export function verifyMetroAuthorityMarker(marker, signerCapability, expected = {}) {
    if (marker.version !== 1 || !marker.payload || typeof marker.signature !== 'string') {
        throw mismatch();
    }
    const signature = Buffer.from(marker.signature, 'hex');
    const actual = Buffer.from(signPayload(marker.payload, signerCapability), 'hex');
    if (signature.length !== actual.length || !timingSafeEqual(signature, actual)) {
        throw mismatch();
    }
    for (const [key, value] of Object.entries(expected)) {
        if (marker.payload[key] !== value)
            throw mismatch();
    }
    return marker.payload;
}
export function withMetroAuthorityModule(config, markerModulePath) {
    const serializer = config.serializer ?? {};
    const original = serializer.getModulesRunBeforeMainModule;
    return {
        ...config,
        serializer: {
            ...serializer,
            getModulesRunBeforeMainModule(entryFile) {
                return [markerModulePath, ...(original?.(entryFile) ?? [])];
            },
        },
    };
}
export function createMetroAuthorityModule(marker) {
    const value = marker
        ? { status: 'signed', marker }
        : {
            status: 'unavailable',
            authorityScope: 'initial-bundle',
            sourceFidelity: 'not-proven',
        };
    return `globalThis.__RN_DEV_AGENT_AUTHORITY__=${JSON.stringify(value)};\n`;
}
