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
export function buildSignedMetroMarker(binding, signerCapability) {
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
    const originalPolyfills = serializer.getPolyfills;
    const prependMarker = (paths) => [
        markerModulePath,
        ...paths.filter((path) => path !== markerModulePath),
    ];
    return {
        ...config,
        serializer: {
            ...serializer,
            getPolyfills(...args) {
                const paths = originalPolyfills?.(...args) ?? [];
                return paths instanceof Promise ? paths.then(prependMarker) : prependMarker(paths);
            },
            getModulesRunBeforeMainModule(entryFile) {
                return (original?.(entryFile) ?? []).filter((path) => path !== markerModulePath);
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
export function createBootErrorCaptureModule() {
    return `(function(){
  try {
    var root = globalThis;
    if (root.__RN_DEV_AGENT_BOOT_ERROR_CAPTURE_INSTALLED__) return;
    var errorUtils = root.ErrorUtils;
    if (!errorUtils || typeof errorUtils.getGlobalHandler !== 'function' || typeof errorUtils.setGlobalHandler !== 'function') return;
    var errors = Array.isArray(root.__RN_DEV_AGENT_BOOT_ERRORS__) ? root.__RN_DEV_AGENT_BOOT_ERRORS__ : [];
    root.__RN_DEV_AGENT_BOOT_ERRORS__ = errors;
    var previous = errorUtils.getGlobalHandler();
    var bounded = function(value, limit) {
      return String(value == null ? '' : value).replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').slice(0, limit);
    };
    errorUtils.setGlobalHandler(function(error, isFatal) {
      if (isFatal === true && !root.__RN_AGENT) {
        errors.push({
          message: bounded(error && error.message ? error.message : error, 512),
          stack: bounded(error && error.stack ? error.stack : '', 2048),
          isFatal: true,
          type: 'startup',
          timestamp: new Date().toISOString()
        });
        if (errors.length > 8) errors.shift();
      }
      if (typeof previous === 'function') previous(error, isFatal);
    });
    root.__RN_DEV_AGENT_BOOT_ERROR_CAPTURE_INSTALLED__ = true;
  } catch (error) {}
})();\n`;
}
