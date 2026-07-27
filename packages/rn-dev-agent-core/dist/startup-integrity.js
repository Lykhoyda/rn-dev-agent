import { createHash } from 'node:crypto';
export const STARTUP_INTEGRITY_SYMBOL = 'rn-dev-agent.startup-integrity';
function sourceBytes(source) {
    if (typeof source === 'string')
        return Buffer.from(source);
    if (ArrayBuffer.isView(source)) {
        return Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    }
    return Buffer.from(source);
}
export function instrumentStartupSource(entrypointUrl, source) {
    const bytes = sourceBytes(source);
    const attestation = {
        entrypointUrl,
        coreBundleSha256: createHash('sha256').update(bytes).digest('hex'),
    };
    const statement = `Object.defineProperty(globalThis,Symbol.for(${JSON.stringify(STARTUP_INTEGRITY_SYMBOL)}),{value:Object.freeze(${JSON.stringify(attestation)}),configurable:false,enumerable:false,writable:false});\n`;
    const text = bytes.toString('utf8');
    const newline = text.indexOf('\n');
    const instrumented = text.startsWith('#!') && newline >= 0
        ? `${text.slice(0, newline + 1)}${statement}${text.slice(newline + 1)}`
        : `${statement}${text}`;
    return { source: instrumented, attestation };
}
export function readStartupIntegrityAttestation() {
    const value = globalThis[Symbol.for(STARTUP_INTEGRITY_SYMBOL)];
    if (!value ||
        typeof value.entrypointUrl !== 'string' ||
        !value.entrypointUrl.startsWith('file:') ||
        typeof value.coreBundleSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.coreBundleSha256)) {
        return null;
    }
    return {
        entrypointUrl: value.entrypointUrl,
        coreBundleSha256: value.coreBundleSha256,
    };
}
