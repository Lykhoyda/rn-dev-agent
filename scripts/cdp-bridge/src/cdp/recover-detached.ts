import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CDPClient } from '../cdp-client.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { stopFastRunner as defaultStopFastRunner } from '../runners/rn-fast-runner-client.js';
import { arbiter } from '../lifecycle/device-arbiter.js';
import { probeFreshness } from './recovery.js';

const execFile = promisify(execFileCb);
const DEFAULT_MAX_PER_SESSION = 3;
const RELAUNCH_SETTLE_MS = 1200;

export type DetachedReason =
  | 'recovered'
  | 'still-detached'
  | 'no-session'
  | 'flow-active'
  | 'opted-out'
  | 'unsupported-platform'
  | 'budget-exhausted';

export interface DetachedRecoveryResult {
  recovered: boolean;
  reason: DetachedReason;
  attempt: number;
  /** GH #208 review (Codex F3): a `simctl launch` failure message, surfaced instead of hidden. */
  error?: string;
}

let attempts = 0;
/** Reset the per-session recovery budget (on device_snapshot open AND on a successful recovery). */
export function resetDetachedRecoveryCounter(): void { attempts = 0; }

type Exec = (cmd: string, args: string[], opts?: { timeout?: number }) => Promise<{ stdout: string; stderr: string }>;

/**
 * GH #208 (RC3): cold-restart the target app on the booted simulator — terminate
 * THEN launch. Unlike recover-wedge's bare `simctl launch` (which re-foregrounds
 * a still-running backgrounded app with the same pid, preserving JS state), a
 * DETACHED app isn't running at all (dev launcher / crashed), so we force a clean
 * cold start. The terminate is best-effort: it errors with "found no matching
 * processes" when the app isn't running — the normal detached case — so swallow it.
 *
 * `exec` is injectable so the terminate-then-launch sequence is unit-testable
 * without spawning simctl.
 */
export async function defaultRelaunchApp(
  udid: string,
  appId: string,
  exec: Exec = execFile as unknown as Exec,
): Promise<void> {
  try {
    await exec('xcrun', ['simctl', 'terminate', udid, appId], { timeout: 10_000 });
  } catch {
    // App wasn't running (the detached case) — terminate is a no-op; proceed to launch.
  }
  await exec('xcrun', ['simctl', 'launch', udid, appId], { timeout: 10_000 });
}

export interface RecoverDetachedDeps {
  getSession?: () => { deviceId?: string; appId?: string; platform?: string } | null;
  isFlowActive?: () => boolean;
  isOptedOut?: () => boolean;
  relaunchApp?: (udid: string, appId: string) => Promise<void>;
  stopFastRunner?: () => void;
  reconnect?: () => Promise<void>;
  probeAlive?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  maxPerSession?: number;
}

/**
 * GH #208 (RC3): bounded recovery for the DETACHED-app wedge — Metro is up but
 * advertises 0 Hermes targets (AppDetachedError), so there's no target to connect
 * to. Cold-restart the app (terminate+launch) → reconnect → confirm via a REAL CDP
 * liveness probe. Bounded to maxPerSession CONSECUTIVE failures (default 3; resets
 * on success and on device_snapshot action=open). SKIPS when a Maestro flow holds
 * the arbiter flow lease (don't yank the app from a flow) and when opted out via
 * RN_AUTO_RELAUNCH_ON_DETACH=0.
 *
 * Reverse-risk note: a cold restart destroys in-progress JS state. That's
 * acceptable ONLY because this fires when the app is ALREADY detached (the session
 * is already broken) — never against a working app. The opt-out exists for users
 * who'd rather recover manually.
 */
export async function recoverDetached(
  client: CDPClient,
  deps: RecoverDetachedDeps = {},
): Promise<DetachedRecoveryResult> {
  const max = deps.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const isFlowActive = deps.isFlowActive ?? (() => arbiter.snapshot.flowLeaseHeldBy !== null);
  const isOptedOut = deps.isOptedOut ?? (() => process.env.RN_AUTO_RELAUNCH_ON_DETACH === '0');

  // No-op early returns — these must NOT consume the budget.
  if (isOptedOut()) {
    return { recovered: false, reason: 'opted-out', attempt: attempts };
  }
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
  const relaunchApp = deps.relaunchApp ?? defaultRelaunchApp;
  const reconnect = deps.reconnect ?? (() => client.softReconnect());
  const probeAlive = deps.probeAlive ?? (async () => (await probeFreshness(client)).fresh);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  stopFastRunner();
  let relaunchError: string | undefined;
  try {
    await relaunchApp(udid, appId);
  } catch (e) {
    // The terminate step is already swallowed inside defaultRelaunchApp, so a throw
    // here is a real `simctl launch` failure (bad UDID/bundleId, sim unavailable).
    // Capture it (Codex F3) so the verdict is actionable, not a bare "still-detached".
    relaunchError = e instanceof Error ? e.message : String(e);
  }
  await sleep(RELAUNCH_SETTLE_MS);
  try { await reconnect(); } catch { /* best-effort; the liveness probe is the verdict */ }

  if (await probeAlive()) {
    attempts = 0; // success bounds CONSECUTIVE detaches, not lifetime
    return { recovered: true, reason: 'recovered', attempt };
  }
  return { recovered: false, reason: 'still-detached', attempt, ...(relaunchError ? { error: relaunchError } : {}) };
}
