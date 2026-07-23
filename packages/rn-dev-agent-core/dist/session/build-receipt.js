import { createHmac, timingSafeEqual } from 'node:crypto';
function serialize(payload) {
    return JSON.stringify(payload);
}
function sign(payload, capability) {
    return createHmac('sha256', capability).update(serialize(payload)).digest('hex');
}
export function createBuildReceipt(payload, capability) {
    return { version: 1, payload, signature: sign(payload, capability) };
}
export function verifyBuildReceipt(receipt, capability, expected) {
    if (receipt.version !== 1 || !receipt.payload || !receipt.signature) {
        throw new Error('BUILD_RECEIPT_INVALID: build receipt shape is invalid');
    }
    const expectedSignature = Buffer.from(sign(receipt.payload, capability), 'hex');
    const actualSignature = Buffer.from(receipt.signature, 'hex');
    if (expectedSignature.length !== actualSignature.length ||
        !timingSafeEqual(expectedSignature, actualSignature)) {
        throw new Error('BUILD_RECEIPT_INVALID: build receipt signature is invalid');
    }
    for (const [key, value] of Object.entries(expected)) {
        if (receipt.payload[key] !== value) {
            throw new Error(`SESSION_BUILD_IDENTITY_CONFLICT: ${key} contradicts the active session`);
        }
    }
    return receipt.payload;
}
