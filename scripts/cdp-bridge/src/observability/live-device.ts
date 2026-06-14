// src/observability/live-device.ts
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { classifyFamily } from './events.js';

/**
 * GH #206: which tools change on-screen state and so should trigger a live
 * /observe refresh. Single source of truth, derived from events.ts families —
 * all INTERACTION-family tools plus cdp_navigate. Read-only NAVIGATION tools
 * (cdp_navigation_state, cdp_nav_graph) are excluded: reads change nothing.
 */
export function isStateMutating(tool: string): boolean {
  return classifyFamily(tool) === 'interaction' || tool === 'cdp_navigate';
}

export interface LiveCaptureDeps {
  hasObservers: () => boolean;
  isFlowActive: () => boolean;
  getPlatform: () => 'ios' | 'android' | null;
  captureScreenshot: (platform: 'ios' | 'android', path: string) => Promise<{ ok: true; path: string } | { ok: false }>;
  readRoute: () => Promise<string | null>;
  readShotFile: (path: string) => { buf: Buffer; contentType: string } | null;
  pushLive: (frame: { shot?: { buf: Buffer; contentType: string }; route?: string }) => void;
  tmpPath: () => string;
}

let inFlight = false;
let pending = false;

/** Test-only: reset the single-flight latches between cases. */
export function _resetLiveCaptureForTest(): void { inFlight = false; pending = false; }

export async function maybeCaptureLiveFrame(deps: LiveCaptureDeps): Promise<void> {
  try {
    if (!deps.hasObservers() || deps.isFlowActive()) return;
    if (inFlight) { pending = true; return; }
    inFlight = true;
  } catch { return; }
  try {
    await runCapture(deps);
  } finally {
    inFlight = false;
    if (pending) { pending = false; void maybeCaptureLiveFrame(deps); }
  }
}

async function runCapture(deps: LiveCaptureDeps): Promise<void> {
  const platform = deps.getPlatform();
  if (!platform) return;
  const frame: { shot?: { buf: Buffer; contentType: string }; route?: string } = {};
  try {
    const shot = await deps.captureScreenshot(platform, deps.tmpPath());
    if (shot.ok) {
      const bytes = deps.readShotFile(shot.path);
      if (bytes) frame.shot = bytes;
    }
  } catch { /* screenshot best-effort */ }
  try {
    const route = await deps.readRoute();
    if (route) frame.route = route;
  } catch { /* route best-effort */ }
  if (frame.shot || frame.route) deps.pushLive(frame);
}
