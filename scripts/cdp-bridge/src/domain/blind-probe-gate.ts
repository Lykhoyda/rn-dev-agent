// GH #397 (Story 13 Phase 2): iOS-only at-risk gate for the proactive
// blind-probe. Pure logic; the exec edge is injected. Fail-open: any missing
// input resolves toward "not at risk" (today's maestro-first path).
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { RunRecord } from './reusable-action.js';

const execFile = promisify(execFileCb);

export type BlindProbeAtRisk = 'ios26' | 'prior-transport-blind';

export interface BlindProbeGateInput {
  platform: 'ios' | 'android' | undefined;
  iosRuntimeMajor: number | null;
  deviceId: string | null;
  runHistory: readonly RunRecord[];
}

const WDA_BLIND_MIN_IOS_MAJOR = 26;
const RECENT_WINDOW = 5;

export function evaluateBlindProbeGate(input: BlindProbeGateInput): {
  atRisk: BlindProbeAtRisk | null;
} {
  if (input.platform === 'android') return { atRisk: null };
  // iOS-only by positive evidence: explicit platform, or a successful iOS
  // runtime resolution (parseIosRuntimeMajorForUdid returns null for non-iOS
  // runtimes, so a number proves the UDID is an iOS sim). No evidence ⇒ no latch.
  if (input.platform !== 'ios' && input.iosRuntimeMajor === null) return { atRisk: null };
  if (input.iosRuntimeMajor !== null && input.iosRuntimeMajor >= WDA_BLIND_MIN_IOS_MAJOR) {
    return { atRisk: 'ios26' };
  }
  // Bounded latch over the last RECENT_WINDOW device-matching records,
  // newest-first: a clean maestro pass (transport unset) clears, TRANSPORT_BLIND
  // sets, a cdp-js pass proves nothing about WDA and is skipped — one transient
  // TRANSPORT_BLIND cannot permanently route the action through the narrower
  // cdp-js grammar. Matching is strict (both device ids present and equal), so
  // device-less pre-upgrade records never latch other devices.
  const matches = (r: RunRecord) =>
    r.deviceId !== undefined && input.deviceId !== null && r.deviceId === input.deviceId;
  const recent = input.runHistory.filter(matches).slice(-RECENT_WINDOW).reverse();
  for (const r of recent) {
    if (r.status === 'pass' && !r.transport) return { atRisk: null };
    if (r.failureCode === 'TRANSPORT_BLIND') return { atRisk: 'prior-transport-blind' };
  }
  return { atRisk: null };
}

export function parseIosRuntimeMajorForUdid(simctlJson: unknown, udid: string): number | null {
  if (!simctlJson || typeof simctlJson !== 'object') return null;
  const devices = (simctlJson as { devices?: unknown }).devices;
  if (!devices || typeof devices !== 'object') return null;
  for (const [runtimeKey, list] of Object.entries(devices as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    if (!list.some((d) => d && typeof d === 'object' && (d as { udid?: string }).udid === udid)) {
      continue;
    }
    const m = runtimeKey.match(/SimRuntime\.iOS-(\d+)/);
    return m ? Number(m[1]) : null;
  }
  return null;
}

type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const runtimeCache = new Map<string, number | null>();

export function _resetIosRuntimeCacheForTest(): void {
  runtimeCache.clear();
}

export async function getIosRuntimeMajorForUdid(
  udid: string,
  execFn: ExecFn = (cmd, args) => execFile(cmd, args, { timeout: 5000, encoding: 'utf8' }),
): Promise<number | null> {
  if (runtimeCache.has(udid)) return runtimeCache.get(udid) ?? null;
  let major: number | null = null;
  try {
    const { stdout } = await execFn('xcrun', ['simctl', 'list', 'devices', '--json']);
    major = parseIosRuntimeMajorForUdid(JSON.parse(stdout), udid);
  } catch {
    major = null;
  }
  runtimeCache.set(udid, major);
  return major;
}
