import { basename } from 'node:path';
import { shortAuthorityIdentity } from '../session/registry.js';
const DEVICE_ID_RE = /\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi;
const POSIX_PATH_RE = /(?:\/(?:Users|home|private|tmp|var\/folders)\/[^\s:'"),\]]+)+/g;
const MAX_PUBLIC_DIAGNOSTIC = 2_000;
export function publicDeviceIdentity(deviceId) {
    return `device-${shortAuthorityIdentity(deviceId).slice(0, 12)}`;
}
/**
 * Bound subprocess diagnostics are useful, but raw stderr/ps output can carry a
 * simulator UDID, username, or absolute checkout path. Keep the diagnostic
 * shape while replacing authority-bearing/local values before they cross the
 * MCP boundary.
 */
export function sanitizePublicDiagnostic(value, options = {}) {
    let safe = value.replace(/[^\t\n\r\x20-\x7e]/g, '?');
    for (const deviceId of [...(options.deviceIds ?? [])].sort((a, b) => b.length - a.length)) {
        if (deviceId)
            safe = safe.replaceAll(deviceId, publicDeviceIdentity(deviceId));
    }
    safe = safe.replace(DEVICE_ID_RE, (id) => publicDeviceIdentity(id));
    safe = safe.replace(POSIX_PATH_RE, (path) => `<local-path>/${basename(path)}`);
    safe = safe.replace(/\b(?:Bearer|Basic)\s+\S+/gi, '<redacted-authorization>');
    return safe.slice(0, options.maxLength ?? MAX_PUBLIC_DIAGNOSTIC);
}
export function sanitizeAutomationProcessLines(lines, deviceId) {
    return lines.slice(0, 8).map((line) => {
        const pid = line.trim().match(/^(\d+)\b/)?.[1] ?? 'unknown';
        const executable = /WebDriverAgentRunner-Runner/.test(line)
            ? 'WebDriverAgentRunner-Runner'
            : /\bxcodebuild\b/.test(line)
                ? 'xcodebuild'
                : /\bmaestro(?:-runner)?\b/i.test(line)
                    ? 'maestro-runner'
                    : 'automation-process';
        const identity = deviceId ? ` ${publicDeviceIdentity(deviceId)}` : '';
        return sanitizePublicDiagnostic(`pid=${pid} executable=${executable}${identity}`, {
            deviceIds: deviceId ? [deviceId] : [],
            maxLength: 240,
        });
    });
}
