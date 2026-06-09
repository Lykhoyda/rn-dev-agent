/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { updateRefMapFromFlat, getCachedMetadata, type FlatNode } from '../fast-runner-ref-map.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 22089;
const READY_TIMEOUT_MS = 30_000;
const STATE_FILE = '/tmp/rn-android-runner-state.json';
const INSTRUMENTATION = 'dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner';
const MAIN_LOOP_CLASS = 'dev.lykhoyda.rndevagent.androidrunner.RnAndroidRunnerInstrumentedTest#mainLoop';
const HEALTH_POLL_INTERVAL_MS = 150;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

interface AndroidRunnerState {
  port: number;
  pid: number;
  deviceId?: string;
  bundleId?: string;
  startedAt: string;
}

export interface RunAndroidArgs {
  command:
    | 'snapshot'
    | 'tap'
    | 'press'
    | 'drag'
    | 'swipe'
    | 'longPress'
    | 'pinch'
    | 'findText'
    | 'type'
    | 'fill'
    | 'dismissKeyboard'
    | 'screenshot'
    | 'back';
  bundleId?: string;
  deviceId?: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  text?: string;
  exact?: boolean;
  durationMs?: number;
  scale?: number;
  interactiveOnly?: boolean;
  outPath?: string;
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

let runnerProcess: ChildProcess | null = null;
let runnerState: AndroidRunnerState | null = null;
let fetchImpl: typeof fetch = globalThis.fetch;

try {
  if (existsSync(STATE_FILE)) {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf-8')) as AndroidRunnerState;
    try {
      process.kill(raw.pid, 0);
      runnerState = raw;
    } catch {
      unlinkSync(STATE_FILE);
    }
  }
} catch {
  runnerState = null;
}

export function _setFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

export function _setAndroidRunnerStateForTest(state: AndroidRunnerState | null): void {
  runnerState = state;
}

function adbSerialArgs(deviceId?: string): string[] {
  if (deviceId) return ['-s', deviceId];
  if (process.env.ANDROID_SERIAL) return ['-s', process.env.ANDROID_SERIAL];
  return [];
}

export function isAndroidRunnerAvailable(): boolean {
  if (!runnerState) return false;
  try {
    process.kill(runnerState.pid, 0);
    return true;
  } catch {
    runnerState = null;
    try { unlinkSync(STATE_FILE); } catch { /* already removed */ }
    return false;
  }
}

/**
 * GH#202 parity with iOS shouldReuseRunner: only adopt a live runner when it is
 * bound to the SAME emulator. The state file path is a fixed constant shared
 * across projects/sessions, so a runner bound to emulator-A must never be reused
 * to drive emulator-B (its adb forward + port still point at A — every command
 * would silently hit the wrong device). When no specific deviceId is requested
 * (single-device flow), any live runner is acceptable.
 */
export function shouldReuseAndroidRunner(state: AndroidRunnerState | null, deviceId?: string): boolean {
  if (state === null) return false;
  if (!deviceId) return true;
  return state.deviceId === deviceId;
}

/**
 * GH#243: HTTP-truthful readiness. The runner logs RN_ANDROID_RUNNER_LISTENER_READY,
 * but `adb logcat` replays the ring buffer — a prior runner's ready line (same tag +
 * fixed port) fired readiness before the new ServerSocket bound, so the first
 * post-flow POST /command hit a dead port ("fetch failed"). Poll the runner's own
 * GET /health, which is true only once the socket is accepting. Bounded by timeoutMs
 * (defaults to the cold-start ready budget); never throws — returns false on timeout.
 */
export async function waitForAndroidRunnerHealth(
  port: number,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? READY_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? HEALTH_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
    try {
      const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
      if (resp.ok) {
        const body = (await resp.json()) as { ok?: boolean };
        if (body?.ok === true) return true;
      }
    } catch {
      // server not accepting yet — keep polling
    } finally {
      clearTimeout(timer);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

export async function startAndroidRunner(deviceId?: string, bundleId?: string, port = DEFAULT_PORT): Promise<AndroidRunnerState> {
  if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId)) return runnerState!;

  const serial = adbSerialArgs(deviceId);
  await execFileAsync('adb', [...serial, 'forward', `tcp:${port}`, `tcp:${port}`]);

  return new Promise((resolve, reject) => {
    let resolved = false;

    const child = spawn('adb', [
      ...serial,
      'shell',
      'am',
      'instrument',
      '-w',
      '-r',
      '-e',
      'RN_ANDROID_RUNNER_PORT',
      String(port),
      '-e',
      'class',
      MAIN_LOOP_CLASS,
      INSTRUMENTATION,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runnerProcess = child;

    // GH#243: drain + tail the instrument's own output so a cold-start failure stays
    // debuggable now that logcat is gone, and so an unconsumed stdio:'pipe' can't fill
    // its ~64KB buffer and wedge the child.
    let diag = '';
    const capture = (chunk: Buffer) => { diag = (diag + chunk.toString('utf-8')).slice(-4_000); };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const finishReady = () => {
      if (resolved) return;
      resolved = true;
      const state: AndroidRunnerState = {
        port,
        pid: child.pid!,
        ...(deviceId ? { deviceId } : {}),
        ...(bundleId ? { bundleId } : {}),
        startedAt: new Date().toISOString(),
      };
      runnerState = state;
      try { writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8'); } catch { /* non-fatal */ }
      resolve(state);
    };

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`Failed to spawn Android runner instrumentation: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (runnerProcess === child) {
        runnerProcess = null;
        runnerState = null;
        try { unlinkSync(STATE_FILE); } catch { /* already removed */ }
      }
      if (!resolved) {
        resolved = true;
        reject(new Error(`Android runner instrumentation exited before readiness (code ${code})${diag ? `\n${diag.trim()}` : ''}`));
      }
    });

    // GH#243: readiness is the runner's own /health, not the (stale-prone) logcat
    // ring buffer. /health is true only once the ServerSocket is actually accepting.
    void waitForAndroidRunnerHealth(port).then((healthy) => {
      if (resolved) return;
      if (healthy) {
        finishReady();
        return;
      }
      resolved = true;
      child.kill('SIGTERM');
      reject(new Error(`Android runner did not become ready within ${READY_TIMEOUT_MS / 1000}s (no /health on port ${port})${diag ? `\n${diag.trim()}` : ''}`));
    });
  });
}

export async function stopAndroidRunner(deviceId?: string): Promise<void> {
  const serial = adbSerialArgs(deviceId ?? runnerState?.deviceId);
  runnerProcess?.kill('SIGTERM');
  runnerProcess = null;
  runnerState = null;
  try { unlinkSync(STATE_FILE); } catch { /* already removed */ }
  try { await execFileAsync('adb', [...serial, 'forward', '--remove', `tcp:${DEFAULT_PORT}`]); } catch { /* non-fatal */ }
}

async function postCommand(body: { command?: unknown }): Promise<RunnerResponse> {
  const state = runnerState;
  if (!state) throw new Error('rn-android-runner not started');
  // Bound every command so a wedged UIAutomator instrument can't hang the tool
  // indefinitely. type/snapshot/screenshot run long; everything else is fast.
  const slow = body.command === 'type' || body.command === 'snapshot' || body.command === 'screenshot';
  const timeoutMs = slow ? 35_000 : 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(`http://127.0.0.1:${state.port}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      throw new Error(`RUNNER_TIMEOUT: rn-android-runner did not respond to "${String(body.command)}" within ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  try {
    return await resp.json() as RunnerResponse;
  } catch {
    throw new Error('rn-android-runner returned a non-JSON response body');
  }
}

function mapRunnerNodesToFlat(nodes: RunnerSnapshotNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  let synthCounter = 0;
  for (const n of nodes) {
    if (!n.rect) continue;
    const ref = `@e${n.index ?? synthCounter++}`;
    const flat: FlatNode = { ref, type: n.type ?? '', rect: n.rect };
    if (n.label !== undefined) flat.label = n.label;
    if (n.identifier !== undefined) flat.identifier = n.identifier;
    if (n.enabled !== undefined) flat.enabled = n.enabled;
    if (n.hittable !== undefined) flat.hittable = n.hittable;
    out.push(flat);
  }
  return out;
}

export async function runAndroid(args: RunAndroidArgs): Promise<ToolResult> {
  if (args._staleRef) {
    return failResult(
      `Element at ref ${args._staleRef} no longer hittable - UI re-rendered since snapshot`,
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
  if (args.exact !== undefined) body.exact = args.exact;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.scale !== undefined) body.scale = args.scale;
  if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;

  let resp: RunnerResponse;
  try {
    await startAndroidRunner(args.deviceId, args.bundleId);
    resp = await postCommand(body);
  } catch (err) {
    const m = errMessage(err);
    // GH#243: a connection failure (runner just restarted after a flow, or can't bind
    // its port) must surface as a structured, retryable error — never a bare
    // "fetch failed". RUNNER_TIMEOUT (a wedged-but-bound instrument) is NOT a connection
    // failure and is rethrown unchanged.
    if (isAndroidConnectionFailure(m)) {
      return failResult(
        `rn-android-runner is not reachable: ${m}`,
        'RN_ANDROID_RUNNER_DOWN',
        { hint: 'The runner could not start or bind its port (e.g. just restarted after a Maestro flow). Retry the command; if it persists, ensure the emulator is booted and the app is installed.' },
      );
    }
    throw err;
  }
  if (!resp.ok) {
    const message = resp.error?.message ?? 'Android runner returned !ok with no error';
    const code = resp.error?.code;
    // Mirror the iOS `.type` runner-timeout shim (rn-fast-runner-client.ts:553-562).
    // UIAutomator's `typeText` waits for window-content idle internally even with
    // `Configurator.setWaitForIdleTimeout(0)`. RN apps with Reanimated/RAF active
    // never report idle, so the call resolves with an `InvocationTargetException`
    // wrapping "Could not detect idle state" AFTER the text has already been
    // appended to the field. Live trials (Task 10) confirm the side-effect
    // always succeeds. Treat this specific error shape as success on `.type`
    // and surface a meta marker so callers can audit telemetry.
    if (
      args.command === 'type' &&
      typeof message === 'string' &&
      (message.includes('Could not detect idle state') ||
        message.includes('window-content-idle') ||
        message.includes('Idle timeout exceeded'))
    ) {
      return okResult(
        { typed: true, text: args.text },
        { meta: { sideEffectSucceeded: true, runnerTimeoutShim: true } },
      );
    }
    return code ? failResult(message, code as Parameters<typeof failResult>[1]) : failResult(message);
  }

  if (args.command === 'snapshot' && resp.data && typeof resp.data === 'object') {
    const data = resp.data as { nodes?: RunnerSnapshotNode[] };
    if (Array.isArray(data.nodes)) {
      const flat = mapRunnerNodesToFlat(data.nodes);
      updateRefMapFromFlat(flat);
      return okResult({ nodes: flat });
    }
  }

  if (args.command === 'screenshot') {
    const data = resp.data as { pngBase64?: string } | undefined;
    if (!data?.pngBase64) return failResult('Android runner screenshot response did not include pngBase64', 'SCREENSHOT_FAILED');
    const outPath = args.outPath ?? `/tmp/rn-android-screenshot-${Date.now()}.png`;
    writeFileSync(outPath, Buffer.from(data.pngBase64, 'base64'));
    return okResult({ path: outPath });
  }

  return okResult(resp.data ?? {});
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAndroidConnectionFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|rn-android-runner not started|did not become ready|Android runner instrumentation exited before readiness|Failed to spawn Android runner instrumentation/i.test(message);
}
