import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import type { FastRunnerState } from '../types.js';
import { updateRefMapFromFlat, getCachedMetadata, type FlatNode } from '../fast-runner-ref-map.js';

const DEFAULT_PORT = 22088;
const READY_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
const STATE_FILE = '/tmp/rn-fast-runner-state.json';
const FAST_RUNNER_PROJECT = join(import.meta.dirname, '..', '..', '..', 'rn-fast-runner');

// --- READY-signal parser (pure, testable without xcodebuild) ---
//
// The imported rn-fast-runner XCTest emits its handshake via two NSLog lines:
//   RN_FAST_RUNNER_LISTENER_READY
//   RN_FAST_RUNNER_PORT=<port>
//
// (Replacing the legacy single-line `FASTXCT_READY {"port":N}` JSON shape.)
//
// Failure markers we must surface:
//   RN_FAST_RUNNER_LISTENER_FAILED — listener crashed during startup
//   RN_FAST_RUNNER_PORT_NOT_SET    — listener ready but env port read failed
//
// xcodebuild streams stdout in arbitrary-sized chunks, so the parser
// holds a small buffer + a `seenReady` flag and walks complete lines.

export type ReadySignalResult =
  | { ready: true; port: number }
  | { error: string };

export interface ReadySignalParser {
  /**
   * Feed the next stdout chunk. Returns a resolved/rejected result when
   * the two-line handshake (or a failure marker) is observed, otherwise
   * `null` if more input is needed.
   */
  feed(chunk: string): ReadySignalResult | null;
}

/**
 * Pure function variant: parse an entire stdout buffer in one shot.
 * Exists so unit tests can exercise the parser without juggling
 * stateful chunk feeds. Mirrors what `createReadySignalParser` would
 * produce after one synthetic feed of `buf`.
 */
export function parseReadySignal(buf: string): ReadySignalResult | null {
  const parser = createReadySignalParser();
  return parser.feed(buf);
}

export function createReadySignalParser(): ReadySignalParser {
  let pending = '';
  let seenReady = false;
  return {
    feed(chunk: string): ReadySignalResult | null {
      pending += chunk;
      // Process complete lines only; keep the trailing partial line buffered.
      let nl: number;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).replace(/\r$/, '');
        pending = pending.slice(nl + 1);
        // Failure markers may appear anywhere — check first.
        if (line.includes('RN_FAST_RUNNER_LISTENER_FAILED')) {
          return { error: 'RN_FAST_RUNNER_LISTENER_FAILED' };
        }
        if (line.includes('RN_FAST_RUNNER_PORT_NOT_SET')) {
          return { error: 'RN_FAST_RUNNER_PORT_NOT_SET' };
        }
        if (!seenReady) {
          if (line.includes('RN_FAST_RUNNER_LISTENER_READY')) {
            seenReady = true;
          }
          continue;
        }
        // After READY, scan for the port. NSLog wraps the marker in a
        // timestamp + process prefix, so match anywhere in the line.
        const portMatch = line.match(/RN_FAST_RUNNER_PORT=(\d+)/);
        if (portMatch) {
          return { ready: true, port: Number(portMatch[1]) };
        }
      }
      return null;
    },
  };
}

// --- Singleton state ---

let runnerProcess: ChildProcess | null = null;
let runnerState: FastRunnerState | null = null;

try {
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as FastRunnerState;
    try { process.kill(raw.pid, 0); runnerState = raw; } catch { unlinkSync(STATE_FILE); }
  }
} catch { /* start fresh */ }

export function getFastRunnerState(): FastRunnerState | null {
  return runnerState;
}

/**
 * Test-only seam: inject a fake runner state so callers (e.g. runIOS)
 * can be unit-tested without spawning xcodebuild. Production code must
 * never call this.
 */
export function _setRunnerStateForTest(state: FastRunnerState | null): void {
  runnerState = state;
}

export function isFastRunnerAvailable(): boolean {
  if (!runnerState) return false;
  try { process.kill(runnerState.pid, 0); return true; } catch { /* process dead */ }
  runnerState = null;
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
  return false;
}

// --- Lifecycle ---

export function startFastRunner(deviceId: string, bundleId: string, port = DEFAULT_PORT): Promise<FastRunnerState> {
  if (runnerState) return Promise.resolve(runnerState);

  return new Promise((resolve, reject) => {
    const projectPath = join(FAST_RUNNER_PROJECT, 'RnFastRunner', 'RnFastRunner.xcodeproj');

    if (!existsSync(projectPath)) {
      reject(new Error(`RnFastRunner.xcodeproj not found at ${projectPath}.`));
      return;
    }

    const derivedDataPath = join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');
    const args = [
      'test-without-building',
      '-project', projectPath,
      '-scheme', 'RnFastRunner',
      '-destination', `platform=iOS Simulator,id=${deviceId}`,
      '-derivedDataPath', derivedDataPath,
      '-only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand',
    ];

    const child = spawn('xcodebuild', args, {
      env: {
        ...process.env,
        RN_FAST_RUNNER_PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runnerProcess = child;
    const parser = createReadySignalParser();
    let resolved = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Fast runner did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);

    const handleChunk = (chunk: string): void => {
      if (resolved) return;
      const result = parser.feed(chunk);
      if (!result) return;
      resolved = true;
      clearTimeout(timer);
      if ('error' in result) {
        reject(new Error(`Fast runner failed to start: ${result.error}`));
        return;
      }
      const state: FastRunnerState = {
        port: result.port,
        pid: child.pid!,
        deviceId,
        bundleId,
        startedAt: new Date().toISOString(),
      };
      runnerState = state;
      try { writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8'); } catch { /* ignore */ }
      resolve(state);
    };

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', handleChunk);

    child.stderr!.setEncoding('utf-8');
    child.stderr!.on('data', () => { /* xcodebuild is noisy — ignore stderr */ });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (runnerProcess === child) {
        runnerProcess = null;
        runnerState = null;
      }
      reject(new Error(`Failed to spawn xcodebuild: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (runnerProcess === child) {
        runnerProcess = null;
        runnerState = null;
        try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
      }
      clearTimeout(timer);
      reject(new Error(`xcodebuild exited unexpectedly (code ${code})`));
    });
  });
}

export function stopFastRunner(): void {
  if (runnerProcess) {
    runnerProcess.kill('SIGTERM');
    runnerProcess = null;
  } else if (runnerState?.pid) {
    try { process.kill(runnerState.pid, 'SIGTERM'); } catch { /* already dead */ }
  }
  runnerState = null;
  try { unlinkSync(STATE_FILE); } catch { /* ignore */ }
}

// --- HTTP client (legacy /tap, /snapshot routes — kept for device-interact.ts swipe + other callers) ---

async function postJSON<T>(path: string, body?: Record<string, unknown>): Promise<T> {
  if (!runnerState) throw new Error('Fast runner not started');
  const url = `http://[::1]:${runnerState.port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return await res.json() as T;
  } finally {
    clearTimeout(timer);
  }
}

async function postBinary(path: string): Promise<Buffer> {
  if (!runnerState) throw new Error('Fast runner not started');
  const url = `http://[::1]:${runnerState.port}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'POST', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

// --- Legacy route methods (kept for device-interact.ts swipe path + restart hooks) ---

interface FastRunnerResponse {
  ok: boolean;
  error?: string;
  hint?: string;
  [key: string]: unknown;
}

export async function fastTap(x: number, y: number, duration?: number): Promise<FastRunnerResponse> {
  return postJSON('/tap', { x, y, ...(duration != null ? { duration } : {}) });
}

export async function fastType(text: string): Promise<FastRunnerResponse> {
  return postJSON('/type', { text });
}

export async function fastSwipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number): Promise<FastRunnerResponse> {
  return postJSON('/swipe', { x1, y1, x2, y2, ...(durationMs != null ? { durationMs } : {}) });
}

export async function fastSnapshot(bundleId?: string): Promise<FastRunnerResponse> {
  return postJSON('/snapshot', bundleId ? { bundleId } : {});
}

export async function fastScreenshot(): Promise<Buffer> {
  return postBinary('/screenshot');
}

export async function fastDismissKeyboard(): Promise<FastRunnerResponse> {
  return postJSON('/dismissKeyboard');
}

// --- Health check ---

export async function fastHealthCheck(): Promise<boolean> {
  if (!runnerState) return false;
  try {
    const result = await defaultHttpProbe(runnerState.port, 2000);
    return result.ok && result.status === 200 && result.bodyOk === true;
  } catch {
    // Preserve the original contract: any network/abort/parse error → false.
    // (The probe helper throws on fetch errors; M7 review caught this regression.)
    return false;
  }
}

// ─── M7 / Phase 109: tri-state liveness probe ──────────────────────────
//
// Prior art: isFastRunnerAvailable() above only checks PID via
// process.kill(pid, 0). A process whose PID is alive but whose HTTP
// server has hung (crashed listener, wedged XCTest thread) would be
// reported as available, and every device_press then stalled on a
// 10s fetch timeout before falling back to the daemon.
//
// The tri-state distinction:
//   'alive' — PID lives AND /health returns {ok:true}. Happy path.
//   'stale' — PID lives but /health times out / 500s / ok:false.
//             Must be reaped before a fresh startFastRunner.
//   'dead'  — PID doesn't exist (or no state file). Cold-launch OK.
//
// Separation of concerns: the probe is read-only (clears state only
// on 'dead' discovery, never mutates a living process). The reap
// helper is the explicit action — SIGTERM, wait 500ms, SIGKILL if
// still alive. Callers compose: probe → (stale ? reap : …) → act.

export type FastRunnerLiveness = 'alive' | 'stale' | 'dead';

export interface StateSnapshot {
  pid: number;
  port: number;
  deviceId: string;
  bundleId: string;
}

export interface HttpProbeResult {
  ok: boolean;
  status: number;
  bodyOk?: boolean;
}

export interface LivenessProbeDeps {
  /** Defaults to the module singleton. Tests inject a fake snapshot. */
  getState?: () => StateSnapshot | null;
  /** Defaults to `process.kill(pid, 0)` guard. */
  processAlive?: (pid: number) => boolean;
  /** Defaults to GET /health over IPv6 loopback with the timeout. */
  httpProbe?: (port: number, timeoutMs: number) => Promise<HttpProbeResult>;
  /** Called when probe discovers 'dead' state. Defaults to the real teardown. */
  clearState?: () => void;
  /** HTTP probe timeout in ms. Default 2000 (matches existing fastHealthCheck). */
  timeoutMs?: number;
}

export interface ReapDeps {
  getState?: () => StateSnapshot | null;
  processAlive?: (pid: number) => boolean;
  sendSignal?: (pid: number, sig: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<void>;
  clearState?: () => void;
  /** Time to wait between SIGTERM and SIGKILL escalation. Default 500ms. */
  graceMs?: number;
}

function defaultProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function defaultHttpProbe(port: number, timeoutMs: number): Promise<HttpProbeResult> {
  const url = `http://[::1]:${port}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    let bodyOk: boolean | undefined;
    try {
      const body = await res.json() as { ok?: boolean };
      bodyOk = body.ok === true;
    } catch {
      bodyOk = false;
    }
    return { ok: true, status: res.status, bodyOk };
  } finally {
    clearTimeout(timer);
  }
}

function clearStateFile(): void {
  runnerState = null;
  // M7 review (Gemini): null the child-process handle too. Previously a reap
  // left `runnerProcess` pointing at a dead PID; the on('exit') handler would
  // eventually self-heal, but during the window a concurrent stopFastRunner
  // could signal an already-dead process. Clearing here is defensive.
  runnerProcess = null;
  try { unlinkSync(STATE_FILE); } catch { /* already gone */ }
}

export async function probeFastRunnerLiveness(deps: LivenessProbeDeps = {}): Promise<FastRunnerLiveness> {
  const getState = deps.getState ?? (() => runnerState);
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const httpProbe = deps.httpProbe ?? defaultHttpProbe;
  const clearState = deps.clearState ?? clearStateFile;
  const timeoutMs = deps.timeoutMs ?? 2000;

  const state = getState();
  if (!state) return 'dead';

  if (!processAlive(state.pid)) {
    clearState();
    return 'dead';
  }

  try {
    const res = await httpProbe(state.port, timeoutMs);
    if (res.ok && res.status === 200 && res.bodyOk === true) return 'alive';
    return 'stale';
  } catch {
    return 'stale';
  }
}

export async function reapStaleFastRunner(deps: ReapDeps = {}): Promise<void> {
  const getState = deps.getState ?? (() => runnerState);
  const processAlive = deps.processAlive ?? defaultProcessAlive;
  const sendSignal = deps.sendSignal ?? ((pid, sig) => process.kill(pid, sig));
  const sleep = deps.sleep ?? ((ms) => new Promise(r => setTimeout(r, ms)));
  const clearState = deps.clearState ?? clearStateFile;
  const graceMs = deps.graceMs ?? 500;

  const state = getState();
  if (!state) return;

  try { sendSignal(state.pid, 'SIGTERM'); } catch { /* already dead */ }
  await sleep(graceMs);
  if (processAlive(state.pid)) {
    try { sendSignal(state.pid, 'SIGKILL'); } catch { /* race: died between checks */ }
  }
  clearState();
}

// ─── /command HTTP client + runIOS() — used by the iOS short-circuit ────
//
// The imported rn-fast-runner accepts a single endpoint, POST /command,
// with JSON body `{ command: <CommandType>, appBundleId?, x?, y?, text?, ... }`.
// Snapshots return `data: { nodes: [...] }` (flat — already includes
// parentIndex/depth), NOT a nested tree. So the snapshot path here maps
// runner SnapshotNodes → FlatNode and calls updateRefMapFromFlat() so
// subsequent press/fill via runAgentDevice('press @e3') can resolve refs.

export interface RunIOSArgs {
  command:
    | 'snapshot'
    | 'tap'
    | 'swipe'
    | 'type'
    | 'dismissKeyboard'
    | 'screenshot'
    | 'back'
    | 'scroll'
    | 'pressHome'
    | 'appState'
    | 'activate'
    | 'terminate';
  bundleId?: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  text?: string;
  durationMs?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  scope?: string;
  /**
   * Internal sentinel: when buildRunIOSArgs() in agent-device-wrapper resolves
   * a @ref via refCenter() and gets back null (snapshot stale), it injects
   * the ref here so runIOS() returns a STALE_REF failResult with cached
   * metadata + a hint to refresh. Production callers should never set this
   * directly.
   */
  _staleRef?: string;
}

interface RunnerResponse {
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string };
}

interface RunnerSnapshotNode {
  index?: number;
  type?: string;
  label?: string;
  identifier?: string;
  rect?: { x: number; y: number; width: number; height: number };
  enabled?: boolean;
  hittable?: boolean;
}

let fetchImpl: typeof fetch = globalThis.fetch;

export function _setFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

async function postCommand(body: object): Promise<RunnerResponse> {
  const state = runnerState;
  if (!state) {
    throw new Error('rn-fast-runner not started — open a device session first');
  }
  const resp = await fetchImpl(`http://127.0.0.1:${state.port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json() as Promise<RunnerResponse>;
}

/**
 * Convert a runner SnapshotNode array (flat, already indexed) → FlatNode[]
 * for the ref-map. Each runner node gets a synthetic ref `@e<index>` so
 * downstream press/fill can target it.
 */
function mapRunnerNodesToFlat(nodes: RunnerSnapshotNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  let synthCounter = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    const refId = n.index !== undefined ? `e${n.index}` : `e${synthCounter++}`;
    const flat: FlatNode = {
      ref: `@${refId}`,
      type: n.type ?? '',
      rect: n.rect,
    };
    if (n.label !== undefined) flat.label = n.label;
    if (n.identifier !== undefined) flat.identifier = n.identifier;
    if (n.enabled !== undefined) flat.enabled = n.enabled;
    if (n.hittable !== undefined) flat.hittable = n.hittable;
    out.push(flat);
  }
  return out;
}

export async function runIOS(args: RunIOSArgs): Promise<ToolResult> {
  // STALE_REF sentinel from buildRunIOSArgs(): the caller tried to press/type
  // a @ref but refCenter() returned null. Surface cached metadata so the agent
  // knows what it asked for, plus a hint to call device_snapshot.
  if (args._staleRef) {
    return failResult(
      `Element at ref ${args._staleRef} no longer hittable — UI re-rendered since snapshot`,
      'STALE_REF',
      {
        cachedMetadata: getCachedMetadata(args._staleRef),
        hint: 'Call device_snapshot action=snapshot to refresh refs, then retry the action with the new ref.',
      },
    );
  }

  const body: Record<string, unknown> = { command: args.command };
  if (args.bundleId) body.appBundleId = args.bundleId;
  if (args.x !== undefined) body.x = args.x;
  if (args.y !== undefined) body.y = args.y;
  if (args.x1 !== undefined) body.x1 = args.x1;
  if (args.y1 !== undefined) body.y1 = args.y1;
  if (args.x2 !== undefined) body.x2 = args.x2;
  if (args.y2 !== undefined) body.y2 = args.y2;
  if (args.text !== undefined) body.text = args.text;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.direction !== undefined) body.direction = args.direction;
  if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;
  if (args.compact !== undefined) body.compact = args.compact;
  if (args.depth !== undefined) body.depth = args.depth;
  if (args.scope !== undefined) body.scope = args.scope;

  const resp = await postCommand(body);
  if (!resp.ok) {
    const message = resp.error?.message ?? 'runner returned !ok with no error';
    const code = resp.error?.code;
    if (code) {
      return failResult(message, code as Parameters<typeof failResult>[1]);
    }
    return failResult(message);
  }

  // Snapshot post-processing: feed the ref map so future press/fill calls
  // can resolve @refs without a separate fetch.
  if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
    const data = resp.data as { nodes?: RunnerSnapshotNode[]; tree?: unknown };
    if (Array.isArray(data.nodes)) {
      const flat = mapRunnerNodesToFlat(data.nodes);
      updateRefMapFromFlat(flat);
      return okResult({ nodes: flat });
    }
    // Defensive fallback: the test seam mocks `{ tree: ... }`. Don't crash.
    return okResult(resp.data);
  }

  return okResult(resp.data ?? {});
}
