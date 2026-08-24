import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
const execFile = promisify(execFileCb);
const runtimeCache = new Map();
export function parseIosRuntimeMajorForUdid(simctlJson, udid) {
    if (!simctlJson || typeof simctlJson !== 'object')
        return null;
    const devices = simctlJson.devices;
    if (!devices || typeof devices !== 'object')
        return null;
    for (const [runtimeKey, list] of Object.entries(devices)) {
        if (!Array.isArray(list))
            continue;
        if (!list.some((device) => device?.udid === udid))
            continue;
        const match = runtimeKey.match(/SimRuntime\.iOS-(\d+)/);
        return match ? Number(match[1]) : null;
    }
    return null;
}
export async function getIosRuntimeMajorForUdid(udid, execFn = (cmd, args) => execFile(cmd, args, { timeout: 5000, encoding: 'utf8' })) {
    if (runtimeCache.has(udid))
        return runtimeCache.get(udid) ?? null;
    try {
        const { stdout } = await execFn('xcrun', ['simctl', 'list', 'devices', '--json']);
        const major = parseIosRuntimeMajorForUdid(JSON.parse(stdout), udid);
        runtimeCache.set(udid, major);
        return major;
    }
    catch {
        return null;
    }
}
export function _resetIosRuntimeCacheForTest() {
    runtimeCache.clear();
}
