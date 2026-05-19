import { runAgentDevice } from '../agent-device-wrapper.js';
import { failResult } from '../utils.js';
import { resizeWithSips } from './device-screenshot-resize.js';
import { tryRawScreenshot } from './device-screenshot-raw.js';
import { pathHasTraversal } from '../domain/path-safety.js';
let runAgentDeviceFn = runAgentDevice;
export function _setRunAgentDeviceForTest(fn) {
    runAgentDeviceFn = fn;
}
export function _resetRunAgentDeviceForTest() {
    runAgentDeviceFn = runAgentDevice;
}
export function createDeviceListHandler() {
    return async () => runAgentDeviceFn(['devices'], { skipSession: true });
}
/**
 * Pure derivation of the output path for a screenshot call. Extracted so the
 * handler can know the path independently from `buildScreenshotArgs` (used to
 * pass it to the post-resize step) and to keep `buildScreenshotArgs` tests stable.
 */
export function deriveScreenshotPath(args, now = Date.now, rand = Math.random) {
    // Phase 134.3 (deepsec MEDIUM path-traversal): caller-supplied `path`
    // could contain `..` segments that escape the intended directory.
    // Absolute paths to legitimate locations (e.g. ~/Desktop) are still
    // allowed — only `..` traversal is refused.
    if (args.path && pathHasTraversal(args.path)) {
        throw new PathTraversalScreenshotError(`Screenshot path "${args.path}" contains '..' traversal segments — refuse to write to a path that escapes its parent directory`);
    }
    if (args.path)
        return args.path;
    const ext = args.format === 'jpeg' ? 'jpg' : args.format === 'png' ? 'png' : 'jpg';
    // Add a short random suffix so two parallel calls in the same ms can't
    // clobber each other's output. deepsec MEDIUM: predictable /tmp files
    // allow cross-run races. `rand` is injectable for tests.
    const suffix = rand().toString(36).slice(2, 8);
    return `/tmp/rn-screenshot-${now()}-${suffix}.${ext}`;
}
class PathTraversalScreenshotError extends Error {
    constructor(message) {
        super(message);
        this.name = 'PathTraversalScreenshotError';
    }
}
/**
 * B113 fix (D636): agent-device >= 0.8.0 exposes only `[path]` and `--out <path>`
 * — no `--format`. Emitting --format caused 100% failure ("Unknown flag: --format").
 * Use --out so no dispatch tier can misparse the path as a positional arg
 * (GH #26 concern is solved by the explicit flag). Extension determines format implicitly.
 *
 * Exported for unit tests — pure function, no I/O.
 */
export function buildScreenshotArgs(args, now = Date.now, rand = Math.random) {
    return ['screenshot', '--out', deriveScreenshotPath(args, now, rand)];
}
/**
 * B120 / GH #36: extract the path agent-device actually wrote to. Daemon and
 * Swift-runner paths echo it via `data.path`; fast-runner uses its own tmp
 * file (`/tmp/rn-fast-screenshot-*.png`) regardless of `--out`, also exposed
 * via `data.path`. Falls back to the requested path when the response shape
 * is unexpected so resize still has a target to attempt.
 */
export function resolveScreenshotPath(result, fallback) {
    try {
        const envelope = JSON.parse(result.content[0].text);
        const candidate = envelope?.data?.path;
        if (typeof candidate === 'string' && candidate.startsWith('/')) {
            return candidate;
        }
    }
    catch { /* malformed envelope — use fallback */ }
    return fallback;
}
export function wrapResultWithResize(result, resize) {
    if (result.isError)
        return result;
    try {
        const envelope = JSON.parse(result.content[0].text);
        const resizeMeta = { resized: resize.resized };
        if (resize.resized) {
            if (resize.originalDims)
                resizeMeta.fromDims = resize.originalDims;
            if (resize.newDims)
                resizeMeta.toDims = resize.newDims;
            if (resize.originalBytes !== undefined)
                resizeMeta.fromBytes = resize.originalBytes;
            if (resize.newBytes !== undefined)
                resizeMeta.toBytes = resize.newBytes;
            if (resize.originalBytes && resize.newBytes) {
                resizeMeta.savedPercent = Math.round((1 - resize.newBytes / resize.originalBytes) * 100);
            }
        }
        else if (resize.reason) {
            resizeMeta.reason = resize.reason;
        }
        envelope.meta = { ...envelope.meta, resize: resizeMeta };
        if (envelope.data && resize.resized) {
            envelope.data.path = resize.path;
        }
        return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    }
    catch {
        return result;
    }
}
export function computeScreenshotAdvisories(args, requestedPath) {
    const out = [];
    if (requestedPath.startsWith('/tmp/') || requestedPath.startsWith('/var/folders/')) {
        out.push({
            code: 'EPHEMERAL_PATH',
            message: `Screenshot saved to an ephemeral path (${requestedPath}). The OS may clean it without warning, so it is not safe for PR artifacts or longer-running sessions. ` +
                'Pass path="docs/proof/<feature-slug>/<NN>-<step>.jpg" for deliverables, or path="docs/diag/<YYYY-MM-DD>/<NN>-<symptom>.jpg" for debug captures.',
        });
    }
    if (args.maxWidth === 0) {
        out.push({
            code: 'FULL_RESOLUTION',
            message: 'maxWidth=0 disables auto-downscaling — capturing at full native resolution. iPhone 15/17 Pro JPEGs can be 1.5-2.5MB, which is expensive in LLM context. ' +
                'Default 800px preserves label readability and visual confirmation. Use maxWidth=0 only for visual-diff or design-review captures.',
        });
    }
    return out;
}
export function wrapResultWithAdvisories(result, advisories) {
    if (result.isError || advisories.length === 0)
        return result;
    try {
        const envelope = JSON.parse(result.content[0].text);
        envelope.meta = { ...envelope.meta, advisories };
        return { content: [{ type: 'text', text: JSON.stringify(envelope) }] };
    }
    catch {
        return result;
    }
}
/**
 * B121: shared capture + resize helper. Extracted from
 * `createDeviceScreenshotHandler` so internal callers like `device_batch`
 * (action=screenshot, on-failure / on-each / on-end auto-captures) and
 * `proof_step` (per-phase screenshots) can opt into the same resize pipeline
 * as the public tool — without needing a CDP client context. B120's savings
 * previously applied only to direct `device_screenshot` calls; batch and
 * proof flows produced raw native-resolution images.
 */
export async function captureAndResizeScreenshot(args) {
    const requestedPath = deriveScreenshotPath(args);
    // Pin the path explicitly so the post-resize step targets the same file
    // regardless of which dispatch tier (fast-runner / daemon / CLI) responded.
    const argsWithPath = { ...args, path: requestedPath };
    const advisories = computeScreenshotAdvisories(args, requestedPath);
    // GH #136 PR-B: when `platform:` is explicit, hard-fail instead of falling
    // through to runAgentDevice. The original PR-A "graceful degradation" was
    // backwards — if the caller explicitly asked for iOS or Android, silently
    // capturing the other platform via agent-device's broken `--platform`
    // routing defeats the entire purpose of passing the arg. Re-evidence on
    // the user-reported regression: an OOM-unstable emulator leaves
    // `adb devices` returning the emulator as `offline`, parseAdbDevicesEmu
    // skips it, the fallback fires, iOS screen is returned.
    let result;
    if (args.platformExplicit && (args.platform === 'ios' || args.platform === 'android')) {
        const raw = await tryRawScreenshot(args.platform, requestedPath);
        if (raw.ok) {
            result = {
                content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { path: raw.path } }) }],
            };
        }
        else {
            const cli = args.platform === 'ios' ? 'xcrun simctl' : 'adb';
            const hint = raw.reason === 'no-device'
                ? `No booted ${args.platform === 'ios' ? 'iOS Simulator' : 'Android emulator'} detected by ${cli}. Boot one and retry; if your emulator is in 'offline' or 'unauthorized' state, restart it.`
                : `Capture command failed (${cli}). The device may be transitioning state (booting, OOM, locked). Retry once it stabilizes.`;
            return failResult(`device_screenshot platform=${args.platform} failed: ${hint}`, 'SCREENSHOT_FAILED', { platform: args.platform, reason: raw.reason });
        }
    }
    if (!result) {
        result = await runAgentDeviceFn(buildScreenshotArgs(argsWithPath), { platform: args.platform ?? null });
    }
    if (result.isError)
        return result;
    const actualPath = resolveScreenshotPath(result, requestedPath);
    const resizeOpts = {};
    if (args.maxWidth !== undefined)
        resizeOpts.maxWidth = args.maxWidth;
    if (args.quality !== undefined)
        resizeOpts.quality = args.quality;
    const resize = await resizeWithSips(actualPath, resizeOpts);
    const resized = wrapResultWithResize(result, resize);
    return wrapResultWithAdvisories(resized, advisories);
}
/**
 * B117/D638: device_screenshot accepts an optional `platform` and, when not
 * provided, falls back to the current CDP target's platform. Prevents
 * wrong-device screenshots when both iOS sim and Android emulator are booted.
 *
 * B120 / GH #36: post-process via macOS `sips` to downscale native-resolution
 * images that otherwise blow LLM context budgets. Defaults to maxWidth=800,
 * quality=85 (JPEG only). Set maxWidth=0 to disable. Gracefully degrades on
 * non-macOS / missing sips — original screenshot is still returned with a
 * `meta.resize.reason` explaining why.
 *
 * getClient is optional so existing callers/tests still compile.
 */
export function createDeviceScreenshotHandler(getClient) {
    return async (args) => {
        const platformExplicit = args.platform === 'ios' || args.platform === 'android';
        const platform = args.platform ?? getClient?.()?.connectedTarget?.platform ?? null;
        return captureAndResizeScreenshot({ ...args, platform, platformExplicit });
    };
}
