import { mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CDPClient } from '../cdp-client.js';
import { runNative, getActiveSession } from '../agent-device-wrapper.js';
import { failResult, okResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { resizeWithSips, type ResizeResult, type ResizeOpts } from './device-screenshot-resize.js';
import { tryRawScreenshot } from './device-screenshot-raw.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { foreignFlowGate } from '../lifecycle/foreign-flow-gate.js';
import { pathHasTraversal } from '../domain/path-safety.js';
import { parseAdbDevicesSerials } from '../runners/rn-android-runner-client.js';
import { recorder } from '../observability/recorder.js';

// ── screenshot test seam (used by captureAndResizeScreenshot tests) ────────────
type RunAgentDeviceFn = typeof runNative;
let runAgentDeviceFn: RunAgentDeviceFn = runNative;

export function _setRunAgentDeviceForTest(fn: RunAgentDeviceFn): void {
  runAgentDeviceFn = fn;
}

export function _resetRunAgentDeviceForTest(): void {
  runAgentDeviceFn = runNative;
}

// ── device-list native enumeration ───────────────────────────────────────────

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);
const defaultExec: ExecFn = (cmd, args) => execFileAsync(cmd, args);
let execFn: ExecFn = defaultExec;

export function _setDeviceListExecForTest(fn: ExecFn): void {
  execFn = fn;
}

export function _resetDeviceListExecForTest(): void {
  execFn = defaultExec;
}

/**
 * Parse `xcrun simctl list devices --json` output into a flat list of booted
 * iOS simulators. Returns [] on any parse error so one platform's absence
 * never breaks the other.
 */
export function parseSimctlDevicesAll(
  jsonText: string,
): Array<{ platform: 'ios'; id: string; name: string; state: string }> {
  try {
    const parsed = JSON.parse(jsonText) as {
      devices?: Record<string, Array<{ udid: string; name: string; state: string }>>;
    };
    const runtimes = parsed?.devices;
    if (!runtimes || typeof runtimes !== 'object') return [];
    const result: Array<{ platform: 'ios'; id: string; name: string; state: string }> = [];
    for (const devices of Object.values(runtimes)) {
      if (!Array.isArray(devices)) continue;
      for (const d of devices) {
        // Guard udid/name: beta Xcode runtimes occasionally emit a partial
        // Booted entry; an undefined id would poison the UDID lock path.
        if (d.state === 'Booted' && d.udid && d.name) {
          result.push({ platform: 'ios', id: d.udid, name: d.name, state: d.state });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

export function createDeviceListHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return async () => {
    const [iosDevices, androidSerials] = await Promise.all([
      execFn('xcrun', ['simctl', 'list', 'devices', '--json'])
        .then(({ stdout }) => parseSimctlDevicesAll(stdout))
        .catch(() => []),
      execFn('adb', ['devices'])
        .then(({ stdout }) => parseAdbDevicesSerials(stdout))
        .catch(() => []),
    ]);

    const androidDevices = androidSerials.map((serial) => ({
      platform: 'android' as const,
      id: serial,
      name: serial,
      state: 'device',
    }));

    return okResult({ devices: [...iosDevices, ...androidDevices] });
  };
}

/**
 * Pure derivation of the output path for a screenshot call. Extracted so the
 * handler can know the path independently from `buildScreenshotArgs` (used to
 * pass it to the post-resize step) and to keep `buildScreenshotArgs` tests stable.
 */
export function deriveScreenshotPath(
  args: { path?: string; format?: string },
  now: () => number = Date.now,
  rand: () => number = Math.random,
): string {
  // Phase 134.3 (deepsec MEDIUM path-traversal): caller-supplied `path`
  // could contain `..` segments that escape the intended directory.
  // Absolute paths to legitimate locations are still allowed — only `..`
  // traversal is refused. The guard runs on the RAW input, before tilde
  // expansion, so `~/../` can't smuggle a collapsed `..` past it via join().
  if (args.path && pathHasTraversal(args.path)) {
    throw new PathTraversalScreenshotError(
      `Screenshot path "${args.path}" contains '..' traversal segments — refuse to write to a path that escapes its parent directory`,
    );
  }
  // GH #265 (codex review): Node never expands `~`, and with the mkdir-p
  // precondition a `~/Desktop/x.jpg` path would otherwise create a literal
  // `./~/Desktop/` under the bridge cwd and report success into the wrong
  // location. Expand a leading `~/` here so every consumer (mkdir,
  // advisories, all capture tiers) sees the same real path; refuse the
  // unexpandable forms (`~user/...`, bare `~`) instead of mislanding.
  if (args.path?.startsWith('~')) {
    if (args.path.startsWith('~/')) return join(homedir(), args.path.slice(2));
    throw new TildeScreenshotPathError(
      `Screenshot path "${args.path}" starts with '~' which the bridge cannot expand (only a leading '~/' is expanded to the home directory). Pass an absolute path instead.`,
    );
  }
  if (args.path) return args.path;
  const ext = args.format === 'jpeg' ? 'jpg' : args.format === 'png' ? 'png' : 'jpg';
  // Add a short random suffix so two parallel calls in the same ms can't
  // clobber each other's output. deepsec MEDIUM: predictable /tmp files
  // allow cross-run races. `rand` is injectable for tests.
  const suffix = rand().toString(36).slice(2, 8);
  return `/tmp/rn-screenshot-${now()}-${suffix}.${ext}`;
}

/**
 * GH #265: every dispatch tier (simctl raw, rn-fast-runner, agent-device
 * daemon/CLI, adb stream) fails opaquely when the target's parent directory
 * doesn't exist — and that failure used to be blamed on device state
 * ("transitioning state (booting, OOM, locked)"). New directories are the
 * EXPECTED case: the EPHEMERAL_PATH advisory itself steers agents toward
 * fresh `docs/proof/<slug>/` paths. Create the parent up front; surface a
 * filesystem error honestly when creation fails.
 */
export function ensureScreenshotDir(path: string): { ok: true } | { ok: false; error: string } {
  try {
    mkdirSync(dirname(path), { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

class PathTraversalScreenshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathTraversalScreenshotError';
  }
}

class TildeScreenshotPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TildeScreenshotPathError';
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
export function buildScreenshotArgs(
  args: { path?: string; format?: string },
  now: () => number = Date.now,
  rand: () => number = Math.random,
): string[] {
  return ['screenshot', '--out', deriveScreenshotPath(args, now, rand)];
}

/**
 * B120 / GH #36: extract the path agent-device actually wrote to. Daemon and
 * Swift-runner paths echo it via `data.path`; fast-runner uses its own tmp
 * file (`/tmp/rn-fast-screenshot-*.png`) regardless of `--out`, also exposed
 * via `data.path`. Falls back to the requested path when the response shape
 * is unexpected so resize still has a target to attempt.
 */
export function resolveScreenshotPath(result: ToolResult, fallback: string): string {
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { path?: unknown };
    };
    const candidate = envelope?.data?.path;
    if (typeof candidate === 'string' && candidate.startsWith('/')) {
      return candidate;
    }
  } catch {
    /* malformed envelope — use fallback */
  }
  return fallback;
}

export function wrapResultWithResize(result: ToolResult, resize: ResizeResult): ToolResult {
  if (result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { path?: unknown } & Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    const resizeMeta: Record<string, unknown> = { resized: resize.resized };
    if (resize.resized) {
      if (resize.originalDims) resizeMeta.fromDims = resize.originalDims;
      if (resize.newDims) resizeMeta.toDims = resize.newDims;
      if (resize.originalBytes !== undefined) resizeMeta.fromBytes = resize.originalBytes;
      if (resize.newBytes !== undefined) resizeMeta.toBytes = resize.newBytes;
      if (resize.originalBytes && resize.newBytes) {
        resizeMeta.savedPercent = Math.round((1 - resize.newBytes / resize.originalBytes) * 100);
      }
    } else if (resize.reason) {
      resizeMeta.reason = resize.reason;
    }
    envelope.meta = { ...envelope.meta, resize: resizeMeta };
    if (envelope.data && resize.resized) {
      envelope.data.path = resize.path;
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
  } catch {
    return result;
  }
}

/**
 * B150 / Phase 124: non-blocking screenshot guardrails.
 *
 * The plugin can't refuse a screenshot — too many legitimate one-off uses —
 * but agents over-screenshot in two predictable ways:
 *   1. Saving to /tmp (or /var/folders) and treating it as a deliverable.
 *      OS cleanup wipes those files; PR artifacts vanish.
 *   2. Passing maxWidth=0 reflexively (full native resolution), blowing
 *      LLM context with 1.5-2.5MB JPEGs when an 800px JPEG would do.
 *
 * Advisories surface in `meta.advisories[]` on the tool result so the
 * caller (and the skill prose that frames the result) can react without
 * the call itself failing.
 */
export type ScreenshotAdvisoryCode = 'EPHEMERAL_PATH' | 'FULL_RESOLUTION';

export interface ScreenshotAdvisory {
  code: ScreenshotAdvisoryCode;
  message: string;
}

export function computeScreenshotAdvisories(
  args: { maxWidth?: number },
  requestedPath: string,
): ScreenshotAdvisory[] {
  const out: ScreenshotAdvisory[] = [];
  if (requestedPath.startsWith('/tmp/') || requestedPath.startsWith('/var/folders/')) {
    out.push({
      code: 'EPHEMERAL_PATH',
      message:
        `Screenshot saved to an ephemeral path (${requestedPath}). The OS may clean it without warning, so it is not safe for PR artifacts or longer-running sessions. ` +
        'Pass path="docs/proof/<feature-slug>/<NN>-<step>.jpg" for deliverables, or path="docs/diag/<YYYY-MM-DD>/<NN>-<symptom>.jpg" for debug captures.',
    });
  }
  if (args.maxWidth === 0) {
    out.push({
      code: 'FULL_RESOLUTION',
      message:
        'maxWidth=0 disables auto-downscaling — capturing at full native resolution. iPhone 15/17 Pro JPEGs can be 1.5-2.5MB, which is expensive in LLM context. ' +
        'Default 800px preserves label readability and visual confirmation. Use maxWidth=0 only for visual-diff or design-review captures.',
    });
  }
  return out;
}

export function wrapResultWithAdvisories(
  result: ToolResult,
  advisories: ScreenshotAdvisory[],
): ToolResult {
  if (result.isError || advisories.length === 0) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: Record<string, unknown>;
      meta?: Record<string, unknown>;
    };
    envelope.meta = { ...envelope.meta, advisories };
    return { content: [{ type: 'text' as const, text: JSON.stringify(envelope) }] };
  } catch {
    return result;
  }
}

export interface ScreenshotArgs {
  path?: string;
  format?: string;
  platform?: 'ios' | 'android' | null;
  /**
   * GH #136 PR-A internal signal: did the caller pass `platform` explicitly,
   * or was it inferred from the connected CDP target? Explicit calls always
   * take the raw `xcrun simctl` / `adb` path. Since GH #422 iOS takes the raw
   * path even when inferred (the runner verb cannot honor the caller's path);
   * inferred Android still uses the `runAgentDevice` flow.
   */
  platformExplicit?: boolean;
  maxWidth?: number;
  quality?: number;
}

/**
 * #210: pick the screenshot backend.
 * - flow active + platform known → 'simctl' (OS-level, flow-safe).
 * - flow active + platform unknown → 'fail' (NEVER the runner — would hit XCUITest
 *   unleased and crash the flow, A3).
 * - no flow, iOS → 'simctl' (GH #422: the rn-fast-runner screenshot verb writes
 *   inside its own sandbox and returns a relative tmp/ path — the caller's `path`
 *   cannot reach it over the wire, so simctl is the only iOS backend that can
 *   honor it; "pixels → simctl" per D1249).
 * - no flow, otherwise → 'runner' (Android's runner honors outPath host-side).
 */
export function chooseScreenshotPath(input: {
  flowActive: boolean;
  platform: 'ios' | 'android' | null;
}): 'simctl' | 'runner' | 'fail' {
  if (input.flowActive) return input.platform ? 'simctl' : 'fail';
  if (input.platform === 'ios') return 'simctl';
  return 'runner';
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
export async function captureAndResizeScreenshot(args: ScreenshotArgs): Promise<ToolResult> {
  const requestedPath = deriveScreenshotPath(args);
  // Pin the path explicitly so the post-resize step targets the same file
  // regardless of which dispatch tier (fast-runner / daemon / CLI) responded.
  const argsWithPath = { ...args, path: requestedPath };
  const advisories = computeScreenshotAdvisories(args, requestedPath);
  // GH #265: precondition check BEFORE any device probing — an unwritable
  // target path must never be diagnosed as a device-state problem.
  const targetDir = ensureScreenshotDir(requestedPath);
  if (!targetDir.ok) {
    return failResult(
      `device_screenshot: target directory for "${requestedPath}" does not exist and could not be created (${targetDir.error}). The device is not at fault — fix the output path and retry.`,
      'SCREENSHOT_FAILED',
      { reason: 'target-dir-unavailable', path: requestedPath },
    );
  }
  // GH #136 PR-B: when `platform:` is explicit, hard-fail instead of falling
  // through to runAgentDevice. The original PR-A "graceful degradation" was
  // backwards — if the caller explicitly asked for iOS or Android, silently
  // capturing the other platform via agent-device's broken `--platform`
  // routing defeats the entire purpose of passing the arg. Re-evidence on
  // the user-reported regression: an OOM-unstable emulator leaves
  // `adb devices` returning the emulator as `offline`, parseAdbDevicesEmuAll
  // skips it, the fallback fires, iOS screen is returned.
  const rawResultOk = (path: string, platform: 'ios' | 'android'): ToolResult => ({
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          ok: true,
          data: { path, via: platform === 'android' ? 'adb' : 'simctl' },
        }),
      },
    ],
  });
  const rawResultFail = (platform: 'ios' | 'android', reason: string): ToolResult => {
    const cli = platform === 'ios' ? 'xcrun simctl' : 'adb';
    const hint =
      reason === 'no-device'
        ? `No booted ${platform === 'ios' ? 'iOS Simulator' : 'Android emulator'} was unambiguously resolvable by ${cli} — none booted, or several booted with no open device session. Boot exactly one, or open a session (device_snapshot action=open) to bind the target; if your emulator is 'offline'/'unauthorized', restart it.`
        : `Capture command failed (${cli}). The device may be transitioning state (booting, OOM, locked). Retry once it stabilizes.`;
    return failResult(
      `device_screenshot platform=${platform} failed: ${hint}`,
      'SCREENSHOT_FAILED',
      { platform, reason },
    );
  };

  let result: ToolResult | undefined;
  // GH#186: a foreign flow routes pixels to simctl exactly like a local one.
  // lastActive is never falsely-false here: device_screenshot is an
  // interaction tool, so arbiterWrap ran gate.check() before this handler.
  const route = chooseScreenshotPath({
    flowActive: arbiter.flowActive || foreignFlowGate.lastActive,
    platform: args.platform ?? null,
  });

  // A3: a Maestro flow owns the device and no platform could be resolved to simctl on →
  // refuse rather than touch the XCUITest runner (which would crash the flow).
  if (route === 'fail') {
    return failResult(
      'device_screenshot: a Maestro flow owns the device and the platform could not be resolved for a simctl fallback. Pass platform=ios|android, or retry after the flow completes.',
      'SCREENSHOT_FAILED',
      { flowActive: true },
    );
  }

  // simctl path: a flow owns the device (raw-ONLY — never fall through to the runner, A3),
  // OR the existing GH#136 explicit-platform disambiguation (no flow). Both hard-fail on error.
  // GH #422: bind raw captures to the open session's device when platforms
  // match — raw is now the primary iOS path and must not pick "first booted"
  // over the session device on multi-sim setups.
  const session = getActiveSession();
  const sessionDeviceId =
    session && session.platform === args.platform ? session.deviceId : undefined;
  if (
    (route === 'simctl' || args.platformExplicit) &&
    (args.platform === 'ios' || args.platform === 'android')
  ) {
    const raw = await tryRawScreenshot(args.platform, requestedPath, sessionDeviceId);
    if (raw.ok) result = rawResultOk(raw.path, args.platform);
    else return rawResultFail(args.platform, raw.reason);
  }

  if (!result) {
    // route === 'runner' (NO flow — runAgentDevice can never run while a flow is active here).
    // Since GH #422 a known-iOS platform never reaches this branch (routed to simctl above);
    // it serves Android and the platform-unresolved case. A2: the runner client THROWS when
    // down, so catch it, then fall back to raw capture when the platform is known.
    try {
      result = await runAgentDeviceFn(buildScreenshotArgs(argsWithPath), {
        platform: args.platform ?? null,
      });
    } catch (err) {
      result = failResult(err instanceof Error ? err.message : String(err), 'SCREENSHOT_FAILED');
    }
    if (result.isError && (args.platform === 'ios' || args.platform === 'android')) {
      const raw = await tryRawScreenshot(args.platform, requestedPath, sessionDeviceId);
      if (raw.ok) result = rawResultOk(raw.path, args.platform);
    }
  }
  if (result.isError) return result;

  const actualPath = resolveScreenshotPath(result, requestedPath);
  // GH #429: grant the observe recorder a one-shot read of what THIS capture
  // wrote. Both paths are granted because legacy runner envelopes surface the
  // file via data.message, which resolveScreenshotPath can't see (it falls
  // back to requestedPath) while the recorder-side extractor still reads it.
  recorder.registerCapturedScreenshot(requestedPath);
  recorder.registerCapturedScreenshot(actualPath);
  const resizeOpts: ResizeOpts = {};
  if (args.maxWidth !== undefined) resizeOpts.maxWidth = args.maxWidth;
  if (args.quality !== undefined) resizeOpts.quality = args.quality;
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
export function createDeviceScreenshotHandler(
  getClient?: () => CDPClient,
): (args: ScreenshotArgs) => Promise<ToolResult> {
  return async (args) => {
    const platformExplicit = args.platform === 'ios' || args.platform === 'android';
    const platform: 'ios' | 'android' | null =
      args.platform ??
      (getClient?.()?.connectedTarget?.platform as 'ios' | 'android' | undefined) ??
      (getActiveSession()?.platform as 'ios' | 'android' | undefined) ?? // A3: so a flow-active capture has a platform
      null;
    return captureAndResizeScreenshot({ ...args, platform, platformExplicit });
  };
}
