import { execFileSync } from 'node:child_process';
export function deviceExistsOnHost(platform, deviceId) {
    if (platform === 'ios') {
        const output = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5_000,
        });
        const parsed = JSON.parse(output);
        return Object.values(parsed.devices ?? {})
            .flat()
            .some((device) => device.udid === deviceId && device.isAvailable !== false);
    }
    const output = execFileSync('adb', ['devices'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 5_000,
    });
    return output
        .split('\n')
        .some((line) => line.split(/\s+/)[0] === deviceId && /\sdevice\s*$/.test(line));
}
