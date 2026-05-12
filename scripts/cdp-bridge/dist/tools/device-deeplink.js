import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { okResult, failResult } from '../utils.js';
import { detectPlatform } from './platform-utils.js';
import { getAdbSerial } from '../agent-device-wrapper.js';
import { annotateDeepLinkDepth } from '../verification/deep-link-depth.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
const execFile = promisify(execFileCb);
const EXEC_TIMEOUT_MS = 10_000;
async function openIosDeeplink(url) {
    try {
        const { stdout, stderr } = await execFile('xcrun', ['simctl', 'openurl', 'booted', url], { timeout: EXEC_TIMEOUT_MS });
        return okResult({
            opened: true,
            platform: 'ios',
            url,
            output: (stdout || stderr).trim() || undefined,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(`xcrun simctl openurl failed: ${msg}`, { code: 'DEEPLINK_FAILED', platform: 'ios', url });
    }
}
async function openAndroidDeeplink(url, packageName) {
    const serial = getAdbSerial();
    const args = [...serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url];
    if (packageName)
        args.push('-n', packageName);
    try {
        const { stdout, stderr } = await execFile('adb', args, { timeout: EXEC_TIMEOUT_MS });
        const output = (stdout || stderr).trim();
        // adb am start returns exit 0 even when the intent fails to resolve. Check for
        // the full range of failure signals that show up in stdout:
        //   "Error: Activity not started, ..."  (classic failure)
        //   "Error type 3"                      (numeric error type)
        //   "Warning: Activity not started, unable to resolve Intent"
        //   "No Activity found to handle Intent"
        //   "Status: error"
        if (/Error:|Error type \d|Warning: Activity not started|No Activity found|Status: error/i.test(output)) {
            return failResult(`adb am start reported error: ${output.slice(0, 300)}`, {
                code: 'DEEPLINK_FAILED',
                platform: 'android',
                url,
            });
        }
        return okResult({
            opened: true,
            platform: 'android',
            url,
            packageName,
            output: output || undefined,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(`adb am start failed: ${msg}`, { code: 'DEEPLINK_FAILED', platform: 'android', url });
    }
}
export function createDeviceDeeplinkHandler() {
    return async (args) => {
        if (!args.url || args.url.length === 0) {
            return failResult('url is required', { code: 'INVALID_ARGS' });
        }
        // Phase 134.2 (deepsec HIGH): `packageName` reaches `adb shell am start
        // -n <packageName>`, where the remote Android shell re-interprets argv.
        // Validate against the strict bundle-ID regex. packageName remains
        // optional — when omitted, no validation is needed.
        if (args.packageName !== undefined && !isValidBundleId(args.packageName)) {
            return failResult(`Invalid packageName "${String(args.packageName).slice(0, 80)}" — must be reverse-DNS bundle identifier (e.g. com.example.app)`, { code: 'INVALID_PACKAGE_NAME' });
        }
        const platform = args.platform ?? (await detectPlatform());
        if (!platform) {
            return failResult('No iOS simulator or Android device detected. Pass platform explicitly or boot a device.', { code: 'NO_DEVICE' });
        }
        const result = platform === 'ios'
            ? await openIosDeeplink(args.url)
            : await openAndroidDeeplink(args.url, args.packageName);
        // GH #61 B.1: warn on suspicious-looking deep links (3+ segments OR
        // success-state suffix). Stateless heuristic; no overhead on short URLs.
        return annotateDeepLinkDepth(result, { url: args.url });
    };
}
