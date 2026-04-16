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
    const url = `http://[::1]:${runnerState.port}/health`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) return false;
      const body = await res.json() as { ok?: boolean };
      return body.ok === true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}
