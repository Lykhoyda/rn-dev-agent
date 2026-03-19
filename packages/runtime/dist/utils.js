"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.safeStringify = safeStringify;
exports.resolvePath = resolvePath;
function safeStringify(obj, maxLen = 50000) {
    try {
        const seen = new WeakSet();
        const str = JSON.stringify(obj, function (_key, val) {
            try {
                if (typeof val === 'function')
                    return '[Function]';
                if (typeof val === 'symbol')
                    return val.toString();
                if (val instanceof Error)
                    return { message: val.message, stack: val.stack };
                if (typeof val === 'object' && val !== null) {
                    if (seen.has(val))
                        return '[Circular]';
                    seen.add(val);
                }
                return val;
            }
            catch {
                return '[Unserializable]';
            }
        });
        if (str && str.length > maxLen) {
            return JSON.stringify({
                __agent_truncated: true,
                originalLength: str.length,
                hint: 'Use a filter or narrower path to reduce output size.',
            });
        }
        return str !== null && str !== void 0 ? str : 'null';
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ __agent_error: `Serialization failed: ${msg}` });
    }
}
function resolvePath(obj, path) {
    const parts = path.split('.');
    let current = obj;
    for (const part of parts) {
        if (current == null || typeof current !== 'object')
            return undefined;
        current = current[part];
    }
    return current;
}
