import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, unlinkSync, existsSync, copyFileSync, mkdirSync, renameSync, lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { ToolResult } from './utils.js';
import type { SessionState } from './types.js';
import { okResult, failResult } from './utils.js';
import {
  isFastRunnerAvailable,
  startFastRunner,
  probeFastRunnerLiveness,
  reapStaleFastRunner,
  hasBuiltTestProduct,
  derivedDataPathForRunner,
} from './runners/rn-fast-runner-client.js';
import type { FastRunnerLiveness } from './runners/rn-fast-runner-client.js';
import { resolveBootedIosUdid } from './tools/device-screenshot-raw.js';
import { refCenter, getScreenRect, clearRefMap, isRefMapFresh } from './fast-runner-ref-map.js';
import { resolveBundleId } from './project-config.js';

const execFile = promisify(execFileCb);

/**
 * CDP-015: derive a per-user, per-project session file path. The previous
 * fixed `/tmp/rn-dev-agent-session.json` location bled state across repos,
 * users, and bridge processes on the same host, and was vulnerable to
 * symlink races on multi-tenant systems.
 *
 * Layout:
 *   $XDG_STATE_HOME/rn-dev-agent/session-<projectHash>.json     (Linux/CI)
 *   ~/Library/Application Support/rn-dev-agent/session-<hash>.json (macOS)
 *   ~/.rn-dev-agent/session-<projectHash>.json                  (fallback)
 *
 * `<projectHash>` is sha256(cwd).slice(0, 12) so two checkouts of the same
 * repo at different paths get different session files.
 */
function getStateDir(): string {
  if (process.env.XDG_STATE_HOME) {
    return join(process.env.XDG_STATE_HOME, 'rn-dev-agent');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'rn-dev-agent');
  }
  return join(homedir(), '.rn-dev-agent');
}

function getSessionFilePath(): string {
  const projectId = createHash('sha256').update(process.cwd()).digest('hex').slice(0, 12);
  return join(getStateDir(), `session-${projectId}.json`);
}

const SESSION_FILE = getSessionFilePath();
const LEGACY_SESSION_FILE = '/tmp/rn-dev-agent-session.json';
const EXEC_TIMEOUT = 30_000;
const DAEMON_TIMEOUT = 30_000;

// --- Direct Daemon Socket Client ---

interface DaemonInfo {
  port: number;
  token: string;
}

let cachedDaemonInfo: DaemonInfo | null = null;

function loadDaemonInfo(): DaemonInfo | null {
  if (cachedDaemonInfo) return cachedDaemonInfo;
  return refreshDaemonInfo();
}

function refreshDaemonInfo(): DaemonInfo | null {
  const daemonPath = join(homedir(), '.agent-device', 'daemon.json');
  try {
    if (!existsSync(daemonPath)) return null;
    const raw = JSON.parse(readFileSync(daemonPath, 'utf-8')) as { port?: number; token?: string };
    if (!raw.port || !raw.token) return null;
    cachedDaemonInfo = { port: raw.port, token: raw.token };
    return cachedDaemonInfo;
  } catch {
    return null;
  }
}

function invalidateDaemonCache(): void {
  cachedDaemonInfo = null;
}

function extractFlags(args: string[]): { positionals: string[]; flags: Record<string, string | boolean> } {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--') && arg.length > 2) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function sendToDaemon(command: string, rawArgs: string[], session: string, timeoutMs = DAEMON_TIMEOUT): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string; hint?: string } }> {
  const info = loadDaemonInfo();
  if (!info) return Promise.reject(new Error('daemon not available'));

  const { positionals, flags } = extractFlags(rawArgs);

  const req = {
    token: info.token,
    session,
    command,
    positionals,
    flags,
  };

  return new Promise((resolve, reject) => {
    const sock = createConnection({ host: '127.0.0.1', port: info.port }, () => {
      sock.write(JSON.stringify(req) + '\n');
    });

    let data = '';
    sock.setEncoding('utf8');
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('daemon timeout')); }, timeoutMs);

    sock.on('data', (chunk: string) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl !== -1) {
        clearTimeout(timer);
        sock.end();
        try {
          resolve(JSON.parse(data.slice(0, nl).trim()));
        } catch {
          reject(new Error('invalid daemon response'));
        }
      }
    });
    sock.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

async function runViaDaemon(command: string, positionals: string[], session: string): Promise<ToolResult> {
  try {
    const resp = await sendToDaemon(command, positionals, session);
    if (resp.ok) {
      return okResult(resp.data ?? {});
    }
    const e = resp.error!;
    return failResult(e.message, { code: e.code, ...(e.hint ? { hint: e.hint } : {}) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // B95 fix: If daemon connection refused, the daemon may have restarted
    // with a new port. Invalidate cache and retry once with fresh daemon info.
    if (msg.includes('ECONNREFUSED')) {
      invalidateDaemonCache();
      const freshInfo = refreshDaemonInfo();
      if (freshInfo) {
        try {
          const retryResp = await sendToDaemon(command, positionals, session);
          if (retryResp.ok) return okResult(retryResp.data ?? {});
          const e = retryResp.error!;
          return failResult(e.message, { code: e.code, ...(e.hint ? { hint: e.hint } : {}) });
        } catch (retryErr) {
          return failResult(`Daemon error (after refresh): ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`);
        }
      }
    }
    return failResult(`Daemon error: ${msg}`);
  }
}

let activeSession: SessionState | null = null;

// CDP-015: load session, refusing to follow symlinks (defends against the
// classic /tmp/<predictable-name> -> arbitrary-write attack). On failure
// silently start fresh — the next setActiveSession() call writes the
// canonical per-project location.
function readSessionSafely(path: string): SessionState | null {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return null; // refuse to follow
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

activeSession = readSessionSafely(SESSION_FILE);
if (!activeSession) {
  // Migrate from the legacy /tmp location if present — one-time best-effort
  // so existing users don't lose their open session on upgrade. We only
  // migrate when the new location has nothing — never overwrite.
  const legacy = readSessionSafely(LEGACY_SESSION_FILE);
  if (legacy) {
    activeSession = legacy;
    try {
      mkdirSync(dirname(SESSION_FILE), { recursive: true });
      writeFileSync(SESSION_FILE, JSON.stringify(legacy), { encoding: 'utf8', mode: 0o600 });
    } catch { /* migration is best-effort */ }
  }
}

export function getActiveSession(): SessionState | null {
  return activeSession;
}

export function setActiveSession(info: SessionState): void {
  activeSession = info;
  // CDP-015: atomic write via tmp + rename, restrictive perms (0600 — only
  // the user can read).
  try {
    mkdirSync(dirname(SESSION_FILE), { recursive: true });
    const tmpPath = `${SESSION_FILE}.tmp.${process.pid}`;
    writeFileSync(tmpPath, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
    renameSync(tmpPath, SESSION_FILE);
  } catch { /* ignore — in-memory session is still valid */ }
}

export function clearActiveSession(): void {
  activeSession = null;
  clearRefMap();
  try { unlinkSync(SESSION_FILE); } catch { /* ignore */ }
}

// Exported for tests + diagnostics.
export function getSessionFilePathForTest(): string { return SESSION_FILE; }

// Test-only: reset the in-memory session pointer without touching the on-disk
// file. Tests that exercise paths gated on hasActiveSession() (e.g. the
// HELPERS_NOT_INJECTED → handleDevClientPicker fallback) need this so they
// don't trip over a real session left behind by the developer's live MCP run.
// clearActiveSession() unlinks the file too, which would break that live run.
export function resetActiveSessionInMemoryForTest(): void {
  activeSession = null;
}

export function hasActiveSession(): boolean {
  return activeSession !== null;
}

// Per-platform snapshot cache for cross-platform verification (P4-3).
// Updated by fetchSnapshotNodes() in device-interact.ts whenever a snapshot succeeds.
interface CachedSnapshot {
  platform: string;
  nodes: { ref: string; label?: string; identifier?: string; type?: string; hittable?: boolean }[];
  capturedAt: string;
}

const snapshotCache = new Map<string, CachedSnapshot>();

export function cacheSnapshot(platform: string, nodes: CachedSnapshot['nodes']): void {
  snapshotCache.set(platform, { platform, nodes, capturedAt: new Date().toISOString() });
}

export function getCachedSnapshot(platform: string): CachedSnapshot | undefined {
  return snapshotCache.get(platform);
}

export function listCachedSnapshots(): string[] {
  return [...snapshotCache.keys()];
}

// Returns the `-s <serial>` args for adb when a specific device/emulator is
// targeted. Prefers the active session's deviceId IFF that session is Android,
// then ANDROID_SERIAL env. Returns an empty array when no target is set (adb
// will pick the only connected device, or fail with "more than one device" if
// multiple exist).
//
// GH #60: prior to this gate, an active iOS session would leak its UDID into
// adb commands (e.g. `device_deeplink platform:"android"` → `adb -s <iOS-UDID>
// not found`) when both iOS and Android were booted simultaneously.
export function getAdbSerial(): string[] {
  const session = getActiveSession();
  if (session?.platform === 'android' && session.deviceId) return ['-s', session.deviceId];
  if (process.env.ANDROID_SERIAL) return ['-s', process.env.ANDROID_SERIAL];
  return [];
}

// --- iOS short-circuit: route every supported command through rn-fast-runner ---
//
// GH #105 / rn-device iOS-MVP §3.1: iOS commands no longer touch agent-device
// (neither the daemon nor the CLI). They go through our own HTTP runner via
// runIOS(). The buildRunIOSArgs() helper translates the legacy CLI argv shape
// (e.g. `['press', '@e3', '--hold-ms', '500']`) into the structured RunIOSArgs
// the new client expects. The legacy daemon + CLI tiers below remain — they
// now serve Android exclusively.
//
// GH #105 iOS-MVP follow-up (post-validation): the original short-circuit
// list left `swipe` / `scroll` / `longpress` / `pinch` / `find` on the
// legacy daemon/CLI path. Live validation showed the daemon respawns the
// upstream AgentDeviceRunner on every such call, which then fights our
// RnFastRunner for focus. Each of these now routes through the runner's
// `/command` endpoint (the Swift `.drag` / `.longPress` / `.pinch` / `.findText`
// handlers). Coordinate-based gestures: the Swift `.swipe` case is tvOS-only;
// iOS coordinate-form swipes/scrolls use `.drag`.

const RN_FAST_RUNNER_COMMANDS = new Set<string>([
  'snapshot',
  'tap',
  'press',
  'fill',
  'type',
  'back',
  'screenshot',
  'keyboard',
  'swipe',
  'scroll',
  'longpress',
  'pinch',
]);

export function getCachedScreenRect(): { width: number; height: number } | null {
  return getScreenRect();
}

export function buildRunIOSArgs(
  cliArgs: string[],
  bundleId?: string,
): import('./runners/rn-fast-runner-client.js').RunIOSArgs {
  const cmd = cliArgs[0];
  const positionals = positionalArgs(cliArgs);
  switch (cmd) {
    case 'press':
    case 'tap': {
      const ref = positionals[0];
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) {
          return { command: 'tap', _staleRef: ref, ...(bundleId ? { bundleId } : {}) };
        }
        return { command: 'tap', x: center.x, y: center.y, ...(bundleId ? { bundleId } : {}) };
      }
      const [xS, yS] = positionals;
      const x = Number(xS), y = Number(yS);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error(`buildRunIOSArgs: tap requires a @ref or numeric x, y`);
      }
      return { command: 'tap', x, y, ...(bundleId ? { bundleId } : {}) };
    }
    case 'fill':
    case 'type': {
      // The Swift runner's `.type` command focuses an input at x/y AND types
      // in one call (see RnFastRunnerTests+CommandExecution.swift:429-468 —
      // `textInputAt(app:, x:, y:)` falls back to `focusedTextInput`). So no
      // separate tap is needed: pass coords + text together.
      const ref = positionals[0];
      const text = positionals.slice(1).join(' ');
      const delayRaw = optionValue(cliArgs, '--delay-ms');
      const delayMs = delayRaw !== undefined && !Number.isNaN(Number(delayRaw)) ? Number(delayRaw) : undefined;
      const extra: { delayMs?: number; clearFirst?: boolean } = {};
      if (delayMs !== undefined) extra.delayMs = delayMs;
      if (cliArgs.includes('--clear-first')) extra.clearFirst = true;
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) {
          return { command: 'type', _staleRef: ref, text, ...extra, ...(bundleId ? { bundleId } : {}) };
        }
        return { command: 'type', x: center.x, y: center.y, text, ...extra, ...(bundleId ? { bundleId } : {}) };
      }
      return { command: 'type', text, ...extra, ...(bundleId ? { bundleId } : {}) };
    }
    case 'snapshot':
      return { command: 'snapshot', interactiveOnly: true, ...(bundleId ? { bundleId } : {}) };
    case 'back':
      return { command: 'back', ...(bundleId ? { bundleId } : {}) };
    case 'screenshot':
      return { command: 'screenshot', ...(bundleId ? { bundleId } : {}) };
    case 'keyboard':
      return { command: 'dismissKeyboard', ...(bundleId ? { bundleId } : {}) };
    case 'swipe':
    case 'scroll': {
      // Coordinate-based gesture. The Swift `.swipe` is tvOS-only; iOS
      // coord-form gestures use `.drag`. CLI shapes seen:
      //   ['swipe',  x1, y1, x2, y2, durationMs?]
      //   ['scroll', x1, y1, x2, y2, durationMs?]
      // Direction-form (`['scroll', 'down', amount?]`) cannot reach this
      // path: device-interact converts direction→coords up-front and
      // dispatches the coord shape.
      const [x1S, y1S, x2S, y2S, durationS] = positionals;
      const x1 = Number(x1S), y1 = Number(y1S), x2 = Number(x2S), y2 = Number(y2S);
      if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
        throw new Error(`buildRunIOSArgs: ${cmd} requires four numeric coordinates`);
      }
      const args: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
        command: 'drag', x: x1, y: y1, x2, y2,
        ...(bundleId ? { bundleId } : {}),
      };
      if (durationS !== undefined) {
        const n = Number(durationS);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }
    case 'longpress': {
      // CLI shape: ['longpress', x, y, durationMs?]
      const [xS, yS, durationS] = positionals;
      const x = Number(xS), y = Number(yS);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error(`buildRunIOSArgs: longpress requires numeric x, y`);
      }
      const args: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
        command: 'longPress', x, y,
        ...(bundleId ? { bundleId } : {}),
      };
      if (durationS !== undefined) {
        const n = Number(durationS);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }
    case 'pinch': {
      // CLI shape: ['pinch', scale, x?, y?]
      const [scaleS, xS, yS] = positionals;
      const scale = Number(scaleS);
      if (Number.isNaN(scale)) {
        throw new Error(`buildRunIOSArgs: pinch requires numeric scale`);
      }
      const args: import('./runners/rn-fast-runner-client.js').RunIOSArgs = {
        command: 'pinch', scale,
        ...(bundleId ? { bundleId } : {}),
      };
      if (xS !== undefined && yS !== undefined) {
        const x = Number(xS), y = Number(yS);
        if (!Number.isNaN(x)) args.x = x;
        if (!Number.isNaN(y)) args.y = y;
      }
      return args;
    }
    default:
      throw new Error(`buildRunIOSArgs: unsupported command "${cmd ?? '<empty>'}"`);
  }
}

function optionValue(cliArgs: string[], flag: string): string | undefined {
  const i = cliArgs.indexOf(flag);
  if (i === -1) return undefined;
  const value = cliArgs[i + 1];
  return value && !value.startsWith('-') ? value : undefined;
}

// Extract positional args, dropping flag tokens AND their values (`--count 3`,
// `--pattern xy`). A naive `filter(a => !a.startsWith('--'))` strips the flag
// token but keeps its value, which then mis-parses as a trailing positional
// (e.g. count's `3` landing in the swipe duration slot → a 3ms flick).
function positionalArgs(cliArgs: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < cliArgs.length; i++) {
    const a = cliArgs[i];
    if (a.startsWith('-')) {
      const value = cliArgs[i + 1];
      if (value && !value.startsWith('-')) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export function buildRunAndroidArgs(
  cliArgs: string[],
  bundleId?: string,
): import('./runners/rn-android-runner-client.js').RunAndroidArgs {
  type RunAndroidArgs = import('./runners/rn-android-runner-client.js').RunAndroidArgs;
  const cmd = cliArgs[0];
  const positionals = positionalArgs(cliArgs);
  const withBundle = bundleId ? { bundleId } : {};

  switch (cmd) {
    case 'press':
    case 'tap': {
      const ref = positionals[0];
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) return { command: 'tap', _staleRef: ref, ...withBundle };
        return { command: 'tap', x: center.x, y: center.y, ...withBundle };
      }
      const [xS, yS] = positionals;
      const x = Number(xS), y = Number(yS);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error(`buildRunAndroidArgs: tap requires a @ref or numeric x, y`);
      }
      return { command: 'tap', x, y, ...withBundle };
    }

    case 'fill':
    case 'type': {
      const ref = positionals[0];
      const text = positionals.slice(1).join(' ');
      if (ref && ref.startsWith('@')) {
        const center = isRefMapFresh() ? refCenter(ref) : null;
        if (!center) return { command: 'type', _staleRef: ref, text, ...withBundle };
        return { command: 'type', x: center.x, y: center.y, text, ...withBundle };
      }
      return { command: 'type', text: positionals.join(' '), ...withBundle };
    }

    case 'snapshot':
      return { command: 'snapshot', interactiveOnly: true, ...withBundle };

    case 'back':
      return { command: 'back', ...withBundle };

    case 'screenshot':
      return { command: 'screenshot', outPath: optionValue(cliArgs, '--out'), ...withBundle };

    case 'keyboard':
    case 'dismissKeyboard':
      return { command: 'dismissKeyboard', ...withBundle };

    // `find` is intentionally NOT handled here — `device_find` is a TS orchestrator
    // on Android (mirrors iOS), built on top of runAndroid('snapshot') + findInLatestSnapshot.

    case 'swipe':
    case 'scroll':
    case 'drag': {
      const [x1S, y1S, x2S, y2S, durationS] = positionals;
      const x1 = Number(x1S), y1 = Number(y1S), x2 = Number(x2S), y2 = Number(y2S);
      if ([x1, y1, x2, y2].some((n) => Number.isNaN(n))) {
        throw new Error(`buildRunAndroidArgs: ${cmd} requires four numeric coordinates`);
      }
      const args: RunAndroidArgs = { command: 'drag', x1, y1, x2, y2, ...withBundle };
      if (durationS !== undefined) {
        const n = Number(durationS);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }

    case 'longpress': {
      const [target, yOrDuration, durationMaybe] = positionals;
      if (target?.startsWith('@')) {
        const center = refCenter(target);
        if (!center) return { command: 'longPress', _staleRef: target, ...withBundle };
        const duration = Number(yOrDuration);
        return {
          command: 'longPress',
          x: center.x,
          y: center.y,
          ...(Number.isNaN(duration) ? {} : { durationMs: duration }),
          ...withBundle,
        };
      }
      const x = Number(target), y = Number(yOrDuration);
      if (Number.isNaN(x) || Number.isNaN(y)) {
        throw new Error('buildRunAndroidArgs: longpress requires numeric x, y or a @ref');
      }
      const args: RunAndroidArgs = { command: 'longPress', x, y, ...withBundle };
      if (durationMaybe !== undefined) {
        const n = Number(durationMaybe);
        if (!Number.isNaN(n)) args.durationMs = n;
      }
      return args;
    }

    case 'pinch': {
      const [scaleS, xS, yS] = positionals;
      const scale = Number(scaleS);
      if (Number.isNaN(scale)) {
        throw new Error('buildRunAndroidArgs: pinch requires numeric scale');
      }
      const args: RunAndroidArgs = { command: 'pinch', scale, ...withBundle };
      if (xS !== undefined && yS !== undefined) {
        const x = Number(xS), y = Number(yS);
        if (!Number.isNaN(x)) args.x = x;
        if (!Number.isNaN(y)) args.y = y;
      }
      return args;
    }

    default:
      throw new Error(`buildRunAndroidArgs: unsupported command "${cmd ?? '<empty>'}"`);
  }
}

export type RunnerSpawnDecision =
  | { action: 'proceed' }
  | { action: 'spawn'; deviceId: string }
  | { action: 'error'; message: string };

// #210: pure decision for the iOS device_* auto-spawn. Cold-build-safe — only auto-starts
// when a prebuilt .xctestrun exists; a missing rig or no device returns an actionable error
// instead of a silent multi-minute xcodebuild.
export function decideRunnerSpawn(input: {
  liveness: FastRunnerLiveness;
  prebuilt: boolean;
  deviceId: string | null;
}): RunnerSpawnDecision {
  if (input.liveness === 'alive') return { action: 'proceed' };
  if (!input.deviceId) {
    return {
      action: 'error',
      message:
        'rn-fast-runner not started and no booted iOS simulator found. Boot a simulator and run `device_snapshot action=open appId=<your.app.id> platform=ios` first.',
    };
  }
  if (!input.prebuilt) {
    return {
      action: 'error',
      message:
        'rn-fast-runner not started and not prebuilt. Run `device_snapshot action=open appId=<your.app.id> platform=ios` first (one-time cold build, ~minutes), then retry — or pre-build once with `xcodebuild build-for-testing` (see plugin Prerequisites).',
    };
  }
  return { action: 'spawn', deviceId: input.deviceId };
}

export interface EnsureRunnerDeps {
  probe?: () => Promise<FastRunnerLiveness>;
  ensure?: (deviceId: string, bundleId: string) => Promise<void>;
  prebuilt?: () => boolean;
}

// #210: orchestrate probe → gate → spawn → RE-VERIFY → structured result. ensureFastRunner
// swallows start errors, so the re-probe is what turns a failed spawn into a clean message
// rather than the unstructured postCommand throw downstream (A6, multi-review).
export async function ensureRunnerForCommand(
  deviceId: string | null,
  bundleId: string,
  deps: EnsureRunnerDeps = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const probe = deps.probe ?? probeFastRunnerLiveness;
  const ensure = deps.ensure ?? ensureFastRunner;
  const prebuilt = deps.prebuilt ?? (() => hasBuiltTestProduct(derivedDataPathForRunner()));

  const liveness = await probe();
  const decision = decideRunnerSpawn({ liveness, prebuilt: prebuilt(), deviceId });
  if (decision.action === 'proceed') return { ok: true };
  if (decision.action === 'error') return { ok: false, message: decision.message };

  await ensure(decision.deviceId, bundleId);
  const after = await probe();
  if (after === 'alive') return { ok: true };
  return {
    ok: false,
    message:
      'rn-fast-runner did not become ready after auto-spawn. Retry, or run `device_snapshot action=open appId=<your.app.id> platform=ios` to surface the build error.',
  };
}

export async function ensureFastRunner(deviceId: string, bundleId: string): Promise<void> {
  // M7/Phase-109: probe tri-state liveness instead of the PID-only
  // isFastRunnerAvailable(). A runner whose PID is alive but whose HTTP server
  // has wedged ('stale') must be reaped before a fresh start — otherwise it is
  // reused and every subsequent device_* command burns the full HTTP timeout
  // before failing. /health responds in ms when healthy, so the happy path is
  // cheap; only a wedged runner pays the 2s probe timeout (vs. 10s per command).
  const liveness = await probeFastRunnerLiveness();
  if (liveness === 'alive') return;
  if (liveness === 'stale') {
    await reapStaleFastRunner();
  }
  try {
    await startFastRunner(deviceId, bundleId);
  } catch (err) {
    console.error(`Fast runner auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

interface AgentDeviceJsonSuccess {
  success: true;
  data: unknown;
}

interface AgentDeviceJsonError {
  success: false;
  error: { code: string; message: string; hint?: string };
}

type AgentDeviceJson = AgentDeviceJsonSuccess | AgentDeviceJsonError;

// Issue #103 — test-only override hook. Tests that exercise handlers
// orchestrating agent-device snapshots (e.g. cdp_repair_action) can
// inject a fake CLI response without booting a device. Production code
// path is untouched when the override is null.
type RunAgentDeviceFn = (
  cliArgs: string[],
  opts?: { skipSession?: boolean; platform?: 'ios' | 'android' | null },
) => Promise<ToolResult>;
let _runAgentDeviceOverrideForTest: RunAgentDeviceFn | null = null;

// GH #110: test-seam fuse. Once any production runAgentDevice call has
// dispatched in this process, refuse to install a new override —
// makes test-pollution-into-prod impossible by construction. The fuse
// is intentionally one-way: tests that need both production and override
// paths in the same suite should use `node --test --test-isolation=process`
// (Node 22 LTS supports this) to get a fresh worker per file. A reset
// seam here would defeat the entire guarantee — any code that could call
// the reset is the same code that could leak the override (Codex review
// conf 90).
let _testSeamFused = false;
let _testSeamFuseBlownBy: string | null = null;

export function _setRunAgentDeviceForTest(fn: RunAgentDeviceFn | null): void {
  if (_testSeamFused) {
    throw new Error(
      `_setRunAgentDeviceForTest: blown fuse — a production runAgentDevice ` +
      `call (cliArgs[0]=${JSON.stringify(_testSeamFuseBlownBy)}) already ` +
      `dispatched in this process. The test seam cannot be re-armed at runtime ` +
      `(GH #110 hardening). The most likely cause is a prior test forgot to ` +
      `clear its override in afterEach. Spawn a fresh Node process — e.g. ` +
      `\`node --test --test-isolation=process\` — if you genuinely need to ` +
      `mix production and override paths.`,
    );
  }
  _runAgentDeviceOverrideForTest = fn;
}

export async function runNative(
  cliArgs: string[],
  opts: { skipSession?: boolean; platform?: 'ios' | 'android' | null } = {},
): Promise<ToolResult> {
  if (_runAgentDeviceOverrideForTest) {
    return _runAgentDeviceOverrideForTest(cliArgs, opts);
  }
  // GH #110: production dispatch reached. Lock the fuse BEFORE any tier
  // selection so a production call that throws downstream still seals
  // the seam (Codex review conf 90).
  if (!_testSeamFused) {
    _testSeamFused = true;
    _testSeamFuseBlownBy = cliArgs[0] ?? '<empty>';
  }

  // GH #105 iOS-MVP §3.1: iOS short-circuit. Every supported command goes
  // through our rn-fast-runner HTTP client (no daemon, no CLI). The runner
  // is started lazily — if no session has cold-launched it yet, we surface
  // a clear failure so the agent can call device_snapshot action=open.
  const targetPlatform = opts.platform ?? activeSession?.platform;
  if (
    targetPlatform === 'ios' &&
    !opts.skipSession &&
    RN_FAST_RUNNER_COMMANDS.has(cliArgs[0])
  ) {
    const appId = activeSession?.appId ?? resolveBundleId('ios') ?? undefined;
    // A2/#210: device_screenshot has its own simctl fallback (device-list.ts) — never block
    // it here; the gate is only for verbs that genuinely require the XCUITest runner.
    if (cliArgs[0] !== 'screenshot') {
      const deviceId = activeSession?.deviceId ?? (await resolveBootedIosUdid());
      const ready = await ensureRunnerForCommand(deviceId ?? null, appId ?? '');
      if (!ready.ok) return failResult(ready.message, 'RN_FAST_RUNNER_DOWN');
    }
    const { runIOS } = await import('./runners/rn-fast-runner-client.js');
    const ios = buildRunIOSArgs(cliArgs, appId);
    return runIOS(ios);
  }

  // `find` is intentionally NOT in this Set — Android, like iOS, treats `device_find`
  // as a pure-TS orchestrator (snapshot → match → tap) for cross-platform symmetry.
  // UIAutomator's `By.text()` returns regex-match semantics while findInLatestSnapshot
  // returns exact-or-substring; routing through the runner would diverge from iOS (D1217).
  const RN_ANDROID_RUNNER_COMMANDS = new Set<string>(['snapshot', 'tap', 'press', 'fill', 'type', 'back', 'screenshot', 'keyboard', 'swipe', 'scroll', 'drag', 'longpress', 'pinch']);
  if (
    targetPlatform === 'android' && process.env.RN_ANDROID_RUNNER !== '0' && !opts.skipSession &&
    RN_ANDROID_RUNNER_COMMANDS.has(cliArgs[0])
  ) {
    const { runAndroid } = await import('./runners/rn-android-runner-client.js');
    const android = buildRunAndroidArgs(cliArgs, activeSession?.appId ?? resolveBundleId('android') ?? undefined);
    return runAndroid({ ...android, deviceId: activeSession?.deviceId });
  }

  // GH #60: when an explicit platform is requested AND it doesn't match the
  // active session's platform (e.g. user asks for android while an iOS
  // session is active from prior work), skip the session-bound dispatch
  // tier — it would otherwise route to the wrong device. Forcing CLI with
  // `--platform` is correct in this case.
  const platformMismatch =
    !!opts.platform && !!activeSession?.platform && opts.platform !== activeSession.platform;
  const sessionName = (!opts.skipSession && !platformMismatch && activeSession) ? activeSession.name : '';

  // Fast path: direct daemon socket (Android only — iOS short-circuited above)
  if (sessionName && loadDaemonInfo()) {
    const command = cliArgs[0];
    const positionals = cliArgs.slice(1);
    try {
      return await runViaDaemon(command, positionals, sessionName);
    } catch {
      // Daemon unavailable — fall through to CLI
    }
  }

  const args = [...cliArgs, '--json'];
  if (sessionName) {
    args.push('--session', sessionName);
  } else if (opts.platform) {
    // B117/D638: when no session is open but a platform hint is provided (e.g. from
    // CDPClient.connectedTarget.platform), pass --platform so agent-device doesn't
    // default to whichever booted device it finds first. Avoids wrong-device
    // screenshots when both iOS sim and Android emulator are booted.
    args.push('--platform', opts.platform);
  }

  try {
    const { stdout } = await execFile('agent-device', args, {
      timeout: EXEC_TIMEOUT,
      encoding: 'utf8',
    });

    let parsed: AgentDeviceJson;
    try {
      parsed = JSON.parse(stdout) as AgentDeviceJson;
    } catch {
      return failResult(`agent-device returned non-JSON: ${stdout.slice(0, 300)}`);
    }

    if (!parsed.success) {
      const e = parsed.error;
      return failResult(
        e.message,
        { code: e.code, ...(e.hint ? { hint: e.hint } : {}) },
      );
    }

    return okResult(parsed.data ?? {});
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);

    if (msg.includes('ENOENT') || msg.includes('not found')) {
      return failResult(
        'agent-device CLI not found. Install with: npm install -g agent-device',
      );
    }

    // Detect timeout (SIGTERM from execFile timeout)
    if (typeof err === 'object' && err !== null && 'killed' in err && (err as { killed?: boolean }).killed) {
      return failResult(`agent-device timed out after ${EXEC_TIMEOUT / 1000}s`);
    }

    // Try to parse JSON from stdout on non-zero exit
    if (typeof err === 'object' && err !== null && 'stdout' in err) {
      const stdout = (err as { stdout: string }).stdout;
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout) as AgentDeviceJson;
          if (parsed.success) {
            return okResult(parsed.data ?? {});
          }
          const e = parsed.error;
          return failResult(
            e.message,
            { code: e.code, ...(e.hint ? { hint: e.hint } : {}) },
          );
        } catch {
          // Not JSON — fall through
        }
      }
    }

    return failResult(`agent-device error: ${msg}`);
  }
}

export { runNative as runAgentDevice };
