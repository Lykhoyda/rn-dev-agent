import { homedir } from 'node:os';
const HOME = homedir();
const HOME_RE = new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
const SECRET_PATTERNS = [
    /(?:sk|pk|api|key|token|secret|password|auth)[-_]?[A-Za-z0-9_\-]{20,}/gi,
    /Bearer\s+[A-Za-z0-9_\-./+=]{20,}/g,
    /ghp_[A-Za-z0-9_]{36}/g,
    /eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[baprs]-[A-Za-z0-9\-]+\b/g,
    /\bAIza[0-9A-Za-z\-_]{35}\b/g,
    /-----BEGIN (?:RSA |OPENSSH |PRIVATE )?KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |PRIVATE )?KEY-----/g,
];
const PII_PATTERNS = [
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
    /\b\d{3}[-]?\d{2}[-]?\d{4}\b/g,
];
const AUTH_PATHS = /\b(auth|authorization|session|token|accessToken|refreshToken|credential|password|secret|apiKey|api_key|cookie|set-cookie|clientSecret|client_secret)\b/i;
const MAX_STRING_LENGTH = 2000;
function redactString(value) {
    let result = value.length > MAX_STRING_LENGTH
        ? value.slice(0, MAX_STRING_LENGTH) + `[TRUNCATED:${value.length}]`
        : value;
    result = result.replace(HOME_RE, '~');
    for (const pattern of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        result = result.replace(pattern, '[REDACTED_SECRET]');
    }
    for (const pattern of PII_PATTERNS) {
        pattern.lastIndex = 0;
        result = result.replace(pattern, '[PII_REDACTED]');
    }
    return result;
}
function redactValue(value, path) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'string')
        return redactString(value);
    if (Array.isArray(value)) {
        return value.map((item, i) => redactValue(item, `${path}[${i}]`));
    }
    if (typeof value === 'object') {
        const obj = value;
        const result = {};
        for (const [key, val] of Object.entries(obj)) {
            const fullPath = path ? `${path}.${key}` : key;
            if (AUTH_PATHS.test(key) && typeof val !== 'object') {
                result[key] = `[REDACTED:${typeof val}]`;
            }
            else {
                result[key] = redactValue(val, fullPath);
            }
        }
        return result;
    }
    return value;
}
export function redact(data) {
    return redactValue(data, '');
}
