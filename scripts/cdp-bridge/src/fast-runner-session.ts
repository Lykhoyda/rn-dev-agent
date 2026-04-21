import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, readFileSync, existsSync } from 'node:fs';
import type { FastRunnerState } from './types.js';

const DEFAULT_PORT = 22088;
const READY_TIMEOUT_MS = 30_000;
const HTTP_TIMEOUT_MS = 10_000;
const STATE_FILE = '/tmp/rn-fast-runner-state.json';
const FAST_RUNNER_PROJECT = join(import.meta.dirname, '..', '..', 'fast-runner');

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
    const projectPath = join(FAST_RUNNER_PROJECT, 'build', 'FastRunner.xcodeproj');

    if (!existsSync(projectPath)) {
      reject(new Error(`FastRunner.xcodeproj not found at ${projectPath}. Run xcodegen first.`));
      return;
    }

    const derivedDataPath = join(FAST_RUNNER_PROJECT, 'build', 'DerivedData');
    const args = [
      'test-without-building',
      '-project', projectPath,
      '-scheme', 'FastRunnerApp',
      '-destination', `platform=iOS Simulator,id=${deviceId}`,
      '-derivedDataPath', derivedDataPath,
      '-only-testing:FastRunnerUITests/FastRunnerTests/testRunServer',
    ];

    const child = spawn('xcodebuild', args, {
      env: {
        ...process.env,
        FAST_RUNNER_PORT: String(port),
        TARGET_BUNDLE_ID: bundleId,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runnerProcess = child;
    let stdoutBuf = '';
    let resolved = false;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`Fast runner did not become ready within ${READY_TIMEOUT_MS / 1000}s`));
    }, READY_TIMEOUT_MS);

    child.stdout!.setEncoding('utf-8');
    child.stdout!.on('data', (chunk: string) => {
      if (resolved) return;
      stdoutBuf += chunk;
      const match = stdoutBuf.match(/FASTXCT_READY (\{.*\})/);
      if (match) {
        resolved = true;
        stdoutBuf = '';
        clearTimeout(timer);
        try {
          const info = JSON.parse(match[1]) as { port: number };
          const state: FastRunnerState = {
            port: info.port,
            pid: child.pid!,
            deviceId,
            bundleId,
            startedAt: new Date().toISOString(),
          };
          runnerState = state;
          try { writeFileSync(STATE_FILE, JSON.stringify(state), 'utf-8'); } catch { /* ignore */ }
          resolve(state);
        } catch (err) {
          reject(new Error(`Failed to parse FASTXCT_READY: ${err}`));
        }
      }
    });

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

// --- HTTP client ---

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

// --- Route methods ---

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
