import type { CDPClient } from '../cdp-client.js';
import { runAgentDevice } from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';
import { resizeWithSips, type ResizeResult, type ResizeOpts } from './device-screenshot-resize.js';

export function createDeviceListHandler(): (args: Record<string, never>) => Promise<ToolResult> {
  return async () => runAgentDevice(['devices'], { skipSession: true });
}

/**
 * Pure derivation of the output path for a screenshot call. Extracted so the
 * handler can know the path independently from `buildScreenshotArgs` (used to
 * pass it to the post-resize step) and to keep `buildScreenshotArgs` tests stable.
 */
export function deriveScreenshotPath(args: { path?: string; format?: string }, now: () => number = Date.now): string {
  if (args.path) return args.path;
  const ext = args.format === 'jpeg' ? 'jpg' : args.format === 'png' ? 'png' : 'jpg';
  return `/tmp/rn-screenshot-${now()}.${ext}`;
}

/**
 * B113 fix (D636): agent-device >= 0.8.0 exposes only `[path]` and `--out <path>`
 * — no `--format`. Emitting --format caused 100% failure ("Unknown flag: --format").
 * Use --out so no dispatch tier can misparse the path as a positional arg
 * (GH #26 concern is solved by the explicit flag). Extension determines format implicitly.
 *
 * Exported for unit tests — pure function, no I/O.
 */
export function buildScreenshotArgs(args: { path?: string; format?: string }, now: () => number = Date.now): string[] {
  return ['screenshot', '--out', deriveScreenshotPath(args, now)];
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
    const envelope = JSON.parse(result.content[0].text) as { ok?: boolean; data?: { path?: unknown } };
    const candidate = envelope?.data?.path;
    if (typeof candidate === 'string' && candidate.startsWith('/')) {
      return candidate;
    }
  } catch { /* malformed envelope — use fallback */ }
  return fallback;
}

export function wrapResultWithResize(result: ToolResult, resize: ResizeResult): ToolResult {
  if (result.isError) return result;
  try {
    const envelope = JSON.parse(result.content[0].text) as { ok?: boolean; data?: { path?: unknown } & Record<string, unknown>; meta?: Record<string, unknown> };
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

export interface ScreenshotArgs {
  path?: string;
  format?: string;
  platform?: 'ios' | 'android' | null;
  maxWidth?: number;
  quality?: number;
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
export async function captureAndResizeScreenshot(
  args: ScreenshotArgs,
): Promise<ToolResult> {
  const requestedPath = deriveScreenshotPath(args);
  // Pin the path explicitly so the post-resize step targets the same file
  // regardless of which dispatch tier (fast-runner / daemon / CLI) responded.
  const argsWithPath = { ...args, path: requestedPath };
  const result = await runAgentDevice(buildScreenshotArgs(argsWithPath), { platform: args.platform ?? null });
  if (result.isError) return result;

  const actualPath = resolveScreenshotPath(result, requestedPath);
  const resizeOpts: ResizeOpts = {};
  if (args.maxWidth !== undefined) resizeOpts.maxWidth = args.maxWidth;
  if (args.quality !== undefined) resizeOpts.quality = args.quality;
  const resize = await resizeWithSips(actualPath, resizeOpts);
  return wrapResultWithResize(result, resize);
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
    const platform: 'ios' | 'android' | null =
      args.platform ?? (getClient?.()?.connectedTarget?.platform as 'ios' | 'android' | undefined) ?? null;
    return captureAndResizeScreenshot({ ...args, platform });
  };
}
