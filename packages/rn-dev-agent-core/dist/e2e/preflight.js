import { request } from 'node:http';
export function preflight(input) {
    if (!input.metroReachable) {
        return {
            ok: false,
            code: 'SETUP_ERROR',
            detail: 'Metro is not reachable — start it (npx expo start).',
        };
    }
    if (!input.udid) {
        return {
            ok: false,
            code: 'SETUP_ERROR',
            detail: 'No single booted device resolved — boot exactly one simulator/emulator.',
        };
    }
    if (input.appInstalled === false) {
        return {
            ok: false,
            code: 'SETUP_ERROR',
            detail: `App ${input.appId ?? ''} is not installed on ${input.udid}.`,
        };
    }
    return { ok: true };
}
export function probeMetro(port, timeoutMs = 1500) {
    return new Promise((resolve) => {
        const req = request({ host: '127.0.0.1', port, path: '/status', method: 'GET', timeout: timeoutMs }, (res) => {
            res.resume();
            resolve((res.statusCode ?? 500) < 500);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => {
            req.destroy();
            resolve(false);
        });
        req.end();
    });
}
