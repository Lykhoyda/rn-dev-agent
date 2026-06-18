import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { okResult, failResult } from '../utils.js';
import { detectPlatform } from './platform-utils.js';
import { getAdbSerial } from '../agent-device-wrapper.js';
import { annotateDeepLinkDepth } from '../verification/deep-link-depth.js';
import { isValidBundleId } from '../domain/maestro-validator.js';
import { clearDevClientPickerIfPresent } from './dev-client-picker.js';
const execFile = promisify(execFileCb);
const EXEC_TIMEOUT_MS = 10_000;
async function openIosDeeplink(url) {
    try {
        const { stdout, stderr } = await execFile('xcrun', ['simctl', 'openurl', 'booted', url], {
            timeout: EXEC_TIMEOUT_MS,
        });
        return okResult({
            opened: true,
            platform: 'ios',
            url,
            output: (stdout || stderr).trim() || undefined,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return failResult(`xcrun simctl openurl failed: ${msg}`, {
            code: 'DEEPLINK_FAILED',
            platform: 'ios',
            url,
        });
    }
}
/**
 * Phase 134.2-followup (deepsec HIGH revalidation 20260512193352): the
 * Phase 134.2 fix validated `packageName` but missed `url`. `adb shell
 * <argv...>` joins argv with spaces and sends the result to the Android
 * remote shell as a raw command line — it does NOT per-argument escape.
 * Without quoting, `url='myapp://path;reboot'` produces a shell command
 * `am start ... -d myapp://path;reboot` where `;reboot` runs after
 * `am start` completes.
 *
 * Two-layer defense: validate URL shape first (reject newlines / control
 * chars), then POSIX single-quote the resolved URL so any remaining shell
 * metacharacters are inert. Same quoting pattern as
 * device-interact.ts:524 (`buildAdbInputTextArgv`).
 */
function posixSingleQuote(s) {
    return `'${s.replace(/'/g, "'\\''")}'`;
}
async function openAndroidDeeplink(url, packageName) {
    const serial = getAdbSerial();
    const quotedUrl = posixSingleQuote(url);
    const args = [
        ...serial,
        'shell',
        'am',
        'start',
        '-a',
        'android.intent.action.VIEW',
        '-d',
        quotedUrl,
    ];
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
        return failResult(`adb am start failed: ${msg}`, {
            code: 'DEEPLINK_FAILED',
            platform: 'android',
            url,
        });
    }
}
/**
 * GH #136 sub-3: annotate a deeplink result envelope with best-effort picker
 * outcome. `null` outcome means no session was open, so the picker was not
 * checked. Never mutates an error result.
 */
export function annotatePicker(result, outcome) {
    if (result.isError)
        return result;
    let envelope;
    try {
        envelope = JSON.parse(result.content[0].text);
    }
    catch {
        return result;
    }
    const existingMeta = envelope.meta && typeof envelope.meta === 'object'
        ? envelope.meta
        : {};
    envelope.meta =
        outcome === null
            ? { ...existingMeta, pickerChecked: false }
            : { ...existingMeta, pickerChecked: true, pickerDismissed: outcome.dismissed };
    result.content[0].text = JSON.stringify(envelope);
    return result;
}
export function createDeviceDeeplinkHandler() {
    return async (args) => {
        if (!args.url || args.url.length === 0) {
            return failResult('url is required', { code: 'INVALID_ARGS' });
        }
        // Phase 134.2-followup (deepsec HIGH revalidation 20260512193352):
        // `url` flows into the adb shell command line. POSIX-quoting in
        // openAndroidDeeplink covers the shell-metachar layer, but a URL
        // containing a newline or control char would break out of the
        // quoted string entirely. Reject those at the boundary.
        // oxlint-disable-next-line no-control-regex -- intentional: security check rejects control chars before passing URL to adb shell
        if (typeof args.url !== 'string' || /[\u0000-\u001F\u0085\u2028\u2029]/.test(args.url)) {
            return failResult(`url contains control characters or newlines — refuse to pass to adb shell (Phase 134.2-followup)`, { code: 'INVALID_ARGS' });
        }
        if (args.url.length > 4096) {
            return failResult('url too long (max 4096 chars)', { code: 'INVALID_ARGS' });
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
        const annotated = annotateDeepLinkDepth(result, { url: args.url });
        // GH #136 sub-3: the picker can appear after a deep link. Best-effort
        // dismiss on Android (no-op when no session is open); never fail the deeplink.
        if (platform === 'android' && !annotated.isError) {
            const outcome = await clearDevClientPickerIfPresent('android').catch(() => null);
            return annotatePicker(annotated, outcome);
        }
        return annotated;
    };
}
