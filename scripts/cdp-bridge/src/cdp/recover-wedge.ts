import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CDPClient } from '../cdp-client.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { probeFreshness } from './recovery.js';

const execFile = promisify(execFileCb);
const DEFAULT_MAX_PER_SESSION = 3;
const FOREGROUND_SETTLE_MS = 800;

export type WedgeReason =
  | 'recovered'
  | 'still-wedged'
  | 'no-session'
  | 'flow-active'
  | 'unsupported-platform'
  | 'budget-exhausted';

export interface WedgeRecoveryResult {
  recovered: boolean;
  reason: WedgeReason;
  attempt: number;
}

let attempts = 0;
/** Reset the per-session recovery budget (on device_snapshot open AND on a successful recovery). */
export function resetWedgeRecoveryCounter(): void {
  attempts = 0;
}

export interface RecoverWedgeDeps {
  getSession?: () => { deviceId?: string; appId?: string; platform?: string } | null;
  isFlowActive?: () => boolean;
  launchApp?: (udid: string, appId: string) => Promise<void>;
  stopFastRunner?: () => void;
  reconnect?: () => Promise<void>;
  probeAlive?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxPerSession?: number;
}

async function defaultLaunchApp(udid: string, appId: string): Promise<void> {
  // Bare `simctl launch` (NO --terminate-running-process): empirically foregrounds
  // an already-running backgrounded app with the SAME pid, preserving JS state —
  // which resumes the paused JS thread. terminate+launch destroys state (hardReset).
  await execFile('xcrun', ['simctl', 'launch', udid, appId], { timeout: 10_000 });
}

/**
 * GH#202 Phase 2b: bounded recovery for the JS-thread-paused wedge — something
 * stole the simulator's foreground, so iOS suspended the app's JS thread and CDP
 * wedged. We do NOT diagnose the thief; we unconditionally re-foreground the
 * target (resumes its JS thread regardless). Steps: park L2 (lazily restarts) →
 * simctl launch the target → reconnect → confirm via a REAL CDP liveness probe
 * (not the isPaused debugger bit). Bounded to maxPerSession CONSECUTIVE failures
 * (default 3); resets on success and on device_snapshot action=open. SKIPS when a
 * Maestro flow holds the arbiter flow lease (cdp_status is unarbitrated, so
 * recovering mid-flow would yank the app out from under the flow).
 */
export async function recoverWedge(
  client: CDPClient,
  deps: RecoverWedgeDeps = {},
): Promise<WedgeRecoveryResult> {
  const max = deps.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const isFlowActive = deps.isFlowActive ?? (() => arbiter.snapshot.flowLeaseHeldBy !== null);

  // No-op early returns — these must NOT consume the budget.
  if (isFlowActive()) {
    return { recovered: false, reason: 'flow-active', attempt: attempts };
  }
  const session = (deps.getSession ?? getActiveSession)();
  if (!session?.deviceId || !session?.appId) {
    return { recovered: false, reason: 'no-session', attempt: attempts };
  }
  if ((session.platform ?? 'ios') !== 'ios') {
    return { recovered: false, reason: 'unsupported-platform', attempt: attempts };
  }
  if (attempts >= max) {
    return { recovered: false, reason: 'budget-exhausted', attempt: attempts };
  }

  // A real, side-effecting attempt.
  attempts += 1;
  const attempt = attempts;
  const udid = session.deviceId;
  const appId = session.appId;

  const stopFastRunner = deps.stopFastRunner ?? defaultStopFastRunner;
  const launchApp = deps.launchApp ?? defaultLaunchApp;
  const reconnect = deps.reconnect ?? (() => client.softReconnect());
  const probeAlive = deps.probeAlive ?? (async () => (await probeFreshness(client)).fresh);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  stopFastRunner();
  try {
    await launchApp(udid, appId);
  } catch {
    /* best-effort re-foreground */
  }
  await sleep(FOREGROUND_SETTLE_MS);
  try {
    await reconnect();
  } catch {
    /* best-effort; the liveness probe is the verdict */
  }

  if (await probeAlive()) {
    attempts = 0; // success bounds CONSECUTIVE wedges, not lifetime
    return { recovered: true, reason: 'recovered', attempt };
  }
  return { recovered: false, reason: 'still-wedged', attempt };
}
