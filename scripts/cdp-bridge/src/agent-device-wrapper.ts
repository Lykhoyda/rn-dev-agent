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
  getFastRunnerState,
  fastTap,
  fastType,
  fastSwipe,
  fastSnapshot,
  fastScreenshot,
  fastDismissKeyboard,
  startFastRunner,
  probeFastRunnerLiveness,
  reapStaleFastRunner,
} from './fast-runner-session.js';
import { updateRefMap, refCenter, getScreenRect, hasRefMap, clearRefMap } from './fast-runner-ref-map.js';
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

// --- Fast-runner dispatch (highest-priority tier for iOS) ---

const SWIPE_DURATION_MS = 300;
const SCROLL_FRACTION = 0.4;
const FOCUS_DELAY_MS = 100;

export function getCachedScreenRect(): { width: number; height: number } | null {
  return getScreenRect();
}

function computeSwipeCoords(direction: string, screen: { width: number; height: number }): { x1: number; y1: number; x2: number; y2: number } | null {
  const cx = Math.round(screen.width / 2);
  const cy = Math.round(screen.height / 2);
  const dy = Math.round(screen.height * SCROLL_FRACTION);
  const dx = Math.round(screen.width * SCROLL_FRACTION);
  switch (direction) {
    case 'down': return { x1: cx, y1: cy + dy, x2: cx, y2: cy - dy };
    case 'up': return { x1: cx, y1: cy - dy, x2: cx, y2: cy + dy };
    case 'left': return { x1: cx + dx, y1: cy, x2: cx - dx, y2: cy };
    case 'right': return { x1: cx - dx, y1: cy, x2: cx + dx, y2: cy };
    default: return null;
  }
}

async function tryFastRunner(command: string, positionals: string[]): Promise<ToolResult | null> {
  // M7 / Phase 109 (D666): tri-state liveness — distinguishes a hung HTTP
  // server (stale) from a dead process. Before M7, any PID-alive-but-HTTP-hung
  // state caused every press to wait out the 10s fetch timeout.
  const liveness = await probeFastRunnerLiveness();
  if (liveness === 'stale') {
    // Runner process is alive but its HTTP server is wedged. Reap it now;
    // fall through to the daemon for this call. Next call probes 'dead'
    // and will cold-launch a fresh runner if iOS.
    await reapStaleFastRunner();
    return null;
  }
  if (liveness === 'dead') {
    const session = getActiveSession();
    if (session?.platform === 'ios' && session.deviceId) {
      // CDP-012: prefer the active session's appId over project-wide
      // resolveBundleId(). Previously a session opened for a non-default
      // bundle would be restarted against the project default app, leaving
      // subsequent taps and snapshots targeting the wrong process.
      const restartAppId = session.appId ?? resolveBundleId('ios') ?? 'unknown';
      try { await startFastRunner(session.deviceId, restartAppId); } catch { /* auto-restart failed */ }
      // startFastRunner only resolves after FASTXCT_READY, so a sync PID
      // check here is sufficient — avoids a second HTTP round-trip.
      if (!isFastRunnerAvailable()) return null;
    } else {
      return null;
    }
  }
  const state = getFastRunnerState()!;

  try {
    switch (command) {
      case 'screenshot': {
        const pngBuffer = await fastScreenshot();
        const tmpPath = `/tmp/rn-fast-screenshot-${Date.now()}.png`;
        writeFileSync(tmpPath, pngBuffer);
        const requestedPath = positionals.find(p => !p.startsWith('-'));
        if (requestedPath && requestedPath !== tmpPath) {
          try {
            mkdirSync(dirname(requestedPath), { recursive: true });
            copyFileSync(tmpPath, requestedPath);
            return okResult({ path: requestedPath, method: 'fast-runner' });
          } catch { /* fall through to tmpPath */ }
        }
        return okResult({ path: tmpPath, method: 'fast-runner' });
      }
      case 'snapshot': {
        const resp = await fastSnapshot(state.bundleId);
        if (!resp.ok) return null;
        return okResult({ ...resp, method: 'fast-runner' });
      }
      case 'keyboard': {
        if (positionals[0] === 'dismiss') {
          const resp = await fastDismissKeyboard();
          if (!resp.ok) return null;
          return okResult({ ...resp, method: 'fast-runner' });
        }
        return null;
      }
      case 'press': {
        if (!hasRefMap()) return null;
        const ref = positionals[0];
        if (!ref) return null;
        const center = refCenter(ref);
        if (!center) return null;
        const holdMs = positionals.includes('--hold-ms')
          ? Number(positionals[positionals.indexOf('--hold-ms') + 1]) / 1000
          : undefined;
        const resp = await fastTap(center.x, center.y, holdMs);
        if (!resp.ok) return null;
        return okResult({ ...resp, ref, method: 'fast-runner' });
      }
      case 'fill': {
        if (!hasRefMap()) return null;
        const ref = positionals[0];
        const text = positionals[1];
        if (!ref || !text) return null;
        const center = refCenter(ref);
        if (!center) return null;
        const tapResp = await fastTap(center.x, center.y);
        if (!tapResp.ok) return null;
        await new Promise(r => setTimeout(r, FOCUS_DELAY_MS));
        const typeResp = await fastType(text);
        if (!typeResp.ok) return null;
        return okResult({ filled: true, ref, length: text.length, method: 'fast-runner' });
      }
      case 'scroll': {
        const screen = getScreenRect();
        if (!screen) return null;
        const direction = positionals[0];
        if (!direction) return null;
        const coords = computeSwipeCoords(direction, screen);
        if (!coords) return null;
        const resp = await fastSwipe(coords.x1, coords.y1, coords.x2, coords.y2, SWIPE_DURATION_MS);
        if (!resp.ok) return null;
        return okResult({ direction, method: 'fast-runner' });
      }
      case 'swipe': {
        const [x1, y1, x2, y2, durationStr] = positionals;
        if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
        const duration = durationStr ? Number(durationStr) : SWIPE_DURATION_MS;
        const resp = await fastSwipe(Number(x1), Number(y1), Number(x2), Number(y2), duration);
        if (!resp.ok) return null;
        return okResult({ method: 'fast-runner' });
      }
      case 'longpress': {
        const [xStr, yStr, durationStr] = positionals;
        if (xStr == null || yStr == null) return null;
        const duration = durationStr ? Number(durationStr) / 1000 : 1.0;
        const resp = await fastTap(Number(xStr), Number(yStr), duration);
        if (!resp.ok) return null;
        return okResult({ method: 'fast-runner' });
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export async function ensureFastRunner(deviceId: string, bundleId: string): Promise<void> {
  if (isFastRunnerAvailable()) return;
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

function cacheRefMapFromResult(result: ToolResult): void {
  try {
    const envelope = JSON.parse(result.content[0].text) as { ok?: boolean; data?: { nodes?: Array<{ ref: string; rect: { x: number; y: number; width: number; height: number } }> } };
    if (envelope.ok && envelope.data?.nodes && Array.isArray(envelope.data.nodes)) {
      updateRefMap(envelope.data.nodes);
    }
  } catch { /* not a snapshot response — ignore */ }
}

export async function runAgentDevice(
  cliArgs: string[],
  opts: { skipSession?: boolean; platform?: 'ios' | 'android' | null } = {},
): Promise<ToolResult> {
  // GH #60: when an explicit platform is requested AND it doesn't match the
  // active session's platform (e.g. user asks for android while an iOS
  // session is active from prior work), skip the session-bound dispatch
  // tiers (fast-runner, daemon) — they would otherwise route to the wrong
  // device. Forcing CLI with `--platform` is correct in this case.
  const platformMismatch =
    !!opts.platform && !!activeSession?.platform && opts.platform !== activeSession.platform;
  const sessionName = (!opts.skipSession && !platformMismatch && activeSession) ? activeSession.name : '';
  const isSnapshotCmd = cliArgs[0] === 'snapshot';

  // Fastest path: XCTest fast-runner HTTP (iOS only, ~5-30ms/op)
  // Note: fast-runner snapshots return { tree: ... } (nested XCUIElement dict), not { nodes: [...] }
  // (flat array with @refs). The ref map can only be populated from daemon/CLI snapshots.
  // So we skip fast-runner for snapshot commands when ref map is empty — force daemon/CLI to populate it.
  if (sessionName && activeSession?.platform === 'ios') {
    if (isSnapshotCmd && !hasRefMap()) {
      // Fall through to daemon/CLI to get a nodes-format snapshot that populates the ref map
    } else {
      const fastResult = await tryFastRunner(cliArgs[0], cliArgs.slice(1));
      if (fastResult) return fastResult;
    }
  }

  // Fast path: direct daemon socket (eliminates ~300ms CLI spawn)
  if (sessionName && loadDaemonInfo()) {
    const command = cliArgs[0];
    const positionals = cliArgs.slice(1);
    try {
      const daemonResult = await runViaDaemon(command, positionals, sessionName);
      if (isSnapshotCmd && !daemonResult.isError) cacheRefMapFromResult(daemonResult);
      return daemonResult;
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

    const cliResult = okResult(parsed.data ?? {});
    if (isSnapshotCmd) cacheRefMapFromResult(cliResult);
    return cliResult;
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
