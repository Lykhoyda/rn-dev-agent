/*
 * Copyright (c) 2026 Anton Lykhoyda
 * SPDX-License-Identifier: MIT
 */
import { spawn, execFile } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { updateRefMapFromFlat, getCachedMetadata, type FlatNode } from '../fast-runner-ref-map.js';
import { findFreePort } from './free-port.js';
import { join } from 'node:path';
import { withKeyboardGuard } from './keyboard-guard.js';
import {
  runnerStatePath,
  readJsonStateFile,
  writeJsonStateFileAtomic,
  deleteStateFile,
  readLegacyTmpState,
  cleanupLegacyTmpState,
} from '../util/secure-state-file.js';
import {
  RUNNER_PROTOCOL_VERSION,
  getPluginVersion,
  classifyRunnerCompatibility,
} from './protocol.js';

const execFileAsync = promisify(execFile);

const DEFAULT_PORT = 22089;
const READY_TIMEOUT_MS = 30_000;
const INSTRUMENTATION =
  'dev.lykhoyda.rndevagent.androidrunner.test/androidx.test.runner.AndroidJUnitRunner';
const MAIN_LOOP_CLASS =
  'dev.lykhoyda.rndevagent.androidrunner.RnAndroidRunnerInstrumentedTest#mainLoop';
const HEALTH_POLL_INTERVAL_MS = 150;
const HEALTH_PROBE_TIMEOUT_MS = 1_000;

// Self-install (parity with the iOS rn-fast-runner cold build): the in-tree runner
// ships as a Gradle project; its APKs build/install on first use so there's no
// external CLI to install (matches the /setup + /doctor docs).
const RN_ANDROID_RUNNER_DIR = join(import.meta.dirname, '..', '..', '..', 'rn-android-runner');
const GRADLEW = join(RN_ANDROID_RUNNER_DIR, 'gradlew');
const APK_APP = join(
  RN_ANDROID_RUNNER_DIR,
  'app',
  'build',
  'outputs',
  'apk',
  'debug',
  'app-debug.apk',
);
const APK_TEST = join(
  RN_ANDROID_RUNNER_DIR,
  'app',
  'build',
  'outputs',
  'apk',
  'androidTest',
  'debug',
  'app-debug-androidTest.apk',
);
const GRADLE_BUILD_TIMEOUT_MS = 600_000; // cold assembleDebug can take minutes on a fresh machine
const ADB_INSTALL_TIMEOUT_MS = 120_000;

interface AndroidRunnerState {
  schemaVersion: 1;
  hostPort: number; // 127.0.0.1 port the TS client connects to (probed; globally contended)
  devicePort: number; // NanoHTTPD listener inside the emulator (fixed; emulator-namespaced)
  pid: number;
  deviceId?: string;
  bundleId?: string;
  startedAt: string;
  protocolVersion: number;
  runnerVersion?: string;
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
  v?: number;
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

export function _setFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

export function _setAndroidRunnerStateForTest(state: AndroidRunnerState | null): void {
  runnerState = state;
}

export function androidStatePath(serial: string): string {
  return runnerStatePath(`android-${serial}`);
}

function defaultProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parsePersistedAndroidState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): AndroidRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<AndroidRunnerState>;
  if (s.schemaVersion !== 1) return null;
  if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number') return null;
  if (typeof s.pid !== 'number') return null;
  if (!pidAlive(s.pid)) return null;
  return s as AndroidRunnerState;
}

// GH #383 (review amendment): lenient one-shot parse of the pre-#383 legacy
// /tmp state — mirrors parseLegacyRunnerState on iOS. protocolVersion 0 makes
// the reuse-time health gate classify the live runner 'legacy' → reap.
export function parseLegacyAndroidState(
  raw: unknown,
  pidAlive: (pid: number) => boolean = defaultProcessAlive,
): AndroidRunnerState | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as {
    hostPort?: unknown;
    devicePort?: unknown;
    pid?: unknown;
    deviceId?: unknown;
    bundleId?: unknown;
  };
  if (typeof s.hostPort !== 'number' || typeof s.devicePort !== 'number') return null;
  if (typeof s.pid !== 'number') return null;
  if (!pidAlive(s.pid)) return null;
  return {
    schemaVersion: 1,
    hostPort: s.hostPort,
    devicePort: s.devicePort,
    pid: s.pid,
    ...(typeof s.deviceId === 'string' ? { deviceId: s.deviceId } : {}),
    ...(typeof s.bundleId === 'string' ? { bundleId: s.bundleId } : {}),
    startedAt: '',
    protocolVersion: 0,
  };
}

// Serial-scoped adoption (review amendment: NO 'default' key — an unknown
// serial means no persistence, so two projects driving two different
// unspecified devices can never share a state file).
export function adoptPersistedAndroidState(serial?: string): void {
  if (runnerState) return;
  if (serial) {
    const path = androidStatePath(serial);
    const raw = readJsonStateFile(path);
    if (raw !== null) {
      const parsed = parsePersistedAndroidState(raw);
      if (!parsed) {
        deleteStateFile(path);
        return;
      }
      runnerState = parsed;
      return;
    }
  }
  const legacy = readLegacyTmpState('android');
  if (legacy === null) return;
  const parsedLegacy = parseLegacyAndroidState(legacy);
  if (!parsedLegacy) {
    cleanupLegacyTmpState();
    return;
  }
  if (!serial || !parsedLegacy.deviceId || parsedLegacy.deviceId === serial) {
    runnerState = parsedLegacy;
  }
}

function clearAndroidStateFile(): void {
  const path = runnerState?.deviceId ? androidStatePath(runnerState.deviceId) : null;
  runnerState = null;
  runnerProcess = null;
  if (path) deleteStateFile(path);
}

export function parseAdbDevicesSerials(stdout: string): string[] {
  return stdout
    .split('\n')
    .slice(1)
    .map((l) => l.trim())
    .map((l) => /^(\S+)\s+device\b/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => m[1]);
}

export async function resolveAndroidSerial(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.ANDROID_SERIAL) return process.env.ANDROID_SERIAL;
  try {
    const { stdout } = await execFileAsync('adb', ['devices']);
    const serials = parseAdbDevicesSerials(stdout);
    return serials.length === 1 ? serials[0] : undefined;
  } catch {
    return undefined;
  }
}

function adbSerialArgs(deviceId?: string): string[] {
  if (deviceId) return ['-s', deviceId];
  if (process.env.ANDROID_SERIAL) return ['-s', process.env.ANDROID_SERIAL];
  return [];
}

export function buildAdbForwardArgs(
  deviceId: string | undefined,
  hostPort: number,
  devicePort: number,
): string[] {
  return [...adbSerialArgs(deviceId), 'forward', `tcp:${hostPort}`, `tcp:${devicePort}`];
}

export function buildAdbForwardRemoveArgs(
  deviceId: string | undefined,
  hostPort: number,
): string[] {
  return [...adbSerialArgs(deviceId), 'forward', '--remove', `tcp:${hostPort}`];
}

export function buildInstrumentPortArgs(devicePort: number): string[] {
  return ['-e', 'RN_ANDROID_RUNNER_PORT', String(devicePort)];
}

export function buildInstrumentVersionArgs(pluginVersion: string | null): string[] {
  return pluginVersion ? ['-e', 'RN_PLUGIN_VERSION', pluginVersion] : [];
}

export function buildAdbInstallArgs(deviceId: string | undefined, apkPath: string): string[] {
  return [...adbSerialArgs(deviceId), 'install', '-r', apkPath];
}

export function buildGradleAssembleArgs(): string[] {
  return [':app:assembleDebug', ':app:assembleDebugAndroidTest'];
}

/**
 * True when `adb shell pm list instrumentation` names our exact `<pkg>/<runner>` id.
 * Anchored to the full id (not the bare package) so a superstring package
 * (`…androidrunner.testfoo`) or a `(target=…)` mention can't false-positive.
 */
export function isInstrumentationRegistered(
  pmListStdout: string,
  instrumentation: string,
): boolean {
  const escaped = instrumentation.replace(/[.$*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|:)${escaped}(\\s|$)`, 'm').test(pmListStdout);
}

export type AndroidInstallAction = 'reuse' | 'install' | 'build-then-install';

/** Decide how to provision the runner: reuse (already on device), install the prebuilt
 *  APKs, or cold-build then install (fresh machine — mirrors the iOS cold xcodebuild). */
export function resolveAndroidInstallAction(opts: {
  instrumentationRegistered: boolean;
  apksExist: boolean;
}): AndroidInstallAction {
  if (opts.instrumentationRegistered) return 'reuse';
  if (opts.apksExist) return 'install';
  return 'build-then-install';
}

/**
 * Self-install the in-tree runner on first use (parity with rn-fast-runner's cold build):
 * if the instrumentation isn't registered on the device, install the prebuilt APKs — and
 * if those don't exist yet, cold-build them via Gradle first. Throws an actionable error
 * (surfaced as RN_ANDROID_RUNNER_DOWN by the caller) when the SDK/Gradle/adb step fails.
 */
async function ensureAndroidRunnerInstalled(
  deviceId?: string,
  opts: { forceReinstall?: boolean } = {},
): Promise<void> {
  // Fail fast if the target isn't online — never start a multi-minute cold build (or an
  // install) against an offline/absent device. (Codex review: avoid the build-then-fail trap.)
  try {
    const { stdout } = await execFileAsync('adb', [...adbSerialArgs(deviceId), 'get-state'], {
      timeout: 5_000,
    });
    if (stdout.trim() !== 'device') throw new Error(`adb state is "${stdout.trim()}"`);
  } catch (err) {
    throw new Error(
      `rn-android-runner: target device not online (adb get-state) — boot the emulator / connect the device. ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let pmOut = '';
  try {
    pmOut = (
      await execFileAsync('adb', [
        ...adbSerialArgs(deviceId),
        'shell',
        'pm',
        'list',
        'instrumentation',
      ])
    ).stdout;
  } catch {
    // adb/pm unavailable → treat as not registered; the install/adb step below surfaces the real error.
  }
  const action = resolveAndroidInstallAction({
    instrumentationRegistered:
      !opts.forceReinstall && isInstrumentationRegistered(pmOut, INSTRUMENTATION),
    apksExist: existsSync(APK_APP) && existsSync(APK_TEST),
  });
  if (action === 'reuse') return;

  if (action === 'build-then-install') {
    try {
      await execFileAsync(GRADLEW, buildGradleAssembleArgs(), {
        cwd: RN_ANDROID_RUNNER_DIR,
        timeout: GRADLE_BUILD_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch (err) {
      throw new Error(
        `rn-android-runner cold build failed (gradlew assembleDebug assembleDebugAndroidTest in ${RN_ANDROID_RUNNER_DIR}). ` +
          `Ensure the Android SDK + a JDK are installed and on PATH. ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    await execFileAsync('adb', buildAdbInstallArgs(deviceId, APK_APP), {
      timeout: ADB_INSTALL_TIMEOUT_MS,
    });
    await execFileAsync('adb', buildAdbInstallArgs(deviceId, APK_TEST), {
      timeout: ADB_INSTALL_TIMEOUT_MS,
    });
  } catch (err) {
    throw new Error(
      `rn-android-runner APK install failed (adb install -r). Is the emulator/device online? ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function isAndroidRunnerAvailable(): boolean {
  if (!runnerState) return false;
  try {
    process.kill(runnerState.pid, 0);
    return true;
  } catch {
    clearAndroidStateFile();
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
export function shouldReuseAndroidRunner(
  state: AndroidRunnerState | null,
  deviceId?: string,
): boolean {
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
      const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, {
        signal: controller.signal,
      });
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

export interface AndroidHealthInfo {
  reachable: boolean;
  ok?: boolean;
  protocolVersion?: number;
  runnerVersion?: string;
}

export async function probeAndroidRunnerHealthInfo(port: number): Promise<AndroidHealthInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    });
    if (!resp.ok) return { reachable: false };
    const body = (await resp.json()) as {
      ok?: boolean;
      protocolVersion?: number;
      runnerVersion?: string;
    };
    return {
      reachable: true,
      ok: body.ok === true,
      ...(typeof body.protocolVersion === 'number'
        ? { protocolVersion: body.protocolVersion }
        : {}),
      ...(typeof body.runnerVersion === 'string' ? { runnerVersion: body.runnerVersion } : {}),
    };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

// GH #383: set when a mismatched runner was transparently reaped; consumed by
// runNative so the triggering tool result carries meta.note. MUST be cleared
// on the mismatch-reject path too (review amendment) or a later successful
// call would attach a stale "runner upgraded" note.
let pendingUpgradeNote: string | undefined;

export function consumePendingAndroidUpgradeNote(): string | undefined {
  const note = pendingUpgradeNote;
  pendingUpgradeNote = undefined;
  return note;
}

// Review amendment (BLOCKER): a single `am force-stop` of the app package does
// NOT reliably free the device-side UiAutomation slot (#237 — system_server
// keeps it; see release-android-slot.ts:115-128). Reuse the battle-tested
// helper, which stops our runner then force-stops BOTH owned packages.
// Dynamic import because release-android-slot.ts statically imports this
// module — a static back-import would be a cycle.
async function reapMismatchedAndroidRunner(deviceId?: string): Promise<void> {
  const { releaseAndroidInteractionSlot } = await import('./release-android-slot.js');
  await releaseAndroidInteractionSlot(deviceId ? { deviceId } : {});
}

function classifyAndroidHealth(info: AndroidHealthInfo) {
  return classifyRunnerCompatibility(
    {
      ...(info.protocolVersion !== undefined ? { protocolVersion: info.protocolVersion } : {}),
      ...(info.runnerVersion !== undefined ? { runnerVersion: info.runnerVersion } : {}),
    },
    getPluginVersion(),
  );
}

export async function startAndroidRunner(
  deviceId?: string,
  bundleId?: string,
  devicePort = DEFAULT_PORT,
): Promise<AndroidRunnerState> {
  const serial = deviceId ?? (await resolveAndroidSerial());
  adoptPersistedAndroidState(serial);
  let forceReinstall = false;
  if (isAndroidRunnerAvailable() && shouldReuseAndroidRunner(runnerState, deviceId)) {
    const info = await probeAndroidRunnerHealthInfo(runnerState!.hostPort);
    if (info.reachable && info.ok) {
      const compat = classifyAndroidHealth(info);
      if (compat.compatible) return runnerState!;
      // GH #383: a reachable-but-incompatible runner is reaped (force-stop +
      // state clear) and force-reinstalled so the fresh APK supersedes it.
      pendingUpgradeNote = 'runner upgraded (protocol/version mismatch)';
      forceReinstall = true;
      await reapMismatchedAndroidRunner(deviceId);
    }
    // unreachable/unhealthy: fall through — the fresh start below supersedes it.
  }

  // Self-install on first use (no external CLI) — build/install the in-tree runner APKs
  // if the instrumentation isn't on the device yet. Mirrors rn-fast-runner's cold build.
  await ensureAndroidRunnerInstalled(deviceId, { forceReinstall });

  let hostPort = await findFreePort(devicePort);
  try {
    await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort));
  } catch {
    // host port raced between probe and forward → re-probe once with any free port
    hostPort = await findFreePort(0);
    await execFileAsync('adb', buildAdbForwardArgs(deviceId, hostPort, devicePort));
  }

  return new Promise((resolve, reject) => {
    let resolved = false;

    const child = spawn(
      'adb',
      [
        ...adbSerialArgs(deviceId),
        'shell',
        'am',
        'instrument',
        '-w',
        '-r',
        ...buildInstrumentPortArgs(devicePort),
        ...buildInstrumentVersionArgs(getPluginVersion()),
        '-e',
        'class',
        MAIN_LOOP_CLASS,
        INSTRUMENTATION,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    runnerProcess = child;

    // GH#243: drain + tail the instrument's own output so a cold-start failure stays
    // debuggable now that logcat is gone, and so an unconsumed stdio:'pipe' can't fill
    // its ~64KB buffer and wedge the child.
    let diag = '';
    const capture = (chunk: Buffer) => {
      diag = (diag + chunk.toString('utf-8')).slice(-4_000);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const finishReady = () => {
      if (resolved) return;
      resolved = true;
      const state: AndroidRunnerState = {
        schemaVersion: 1,
        hostPort,
        devicePort,
        pid: child.pid!,
        ...(serial ? { deviceId: serial } : {}),
        ...(bundleId ? { bundleId } : {}),
        startedAt: new Date().toISOString(),
        protocolVersion: RUNNER_PROTOCOL_VERSION,
        ...(getPluginVersion() !== null ? { runnerVersion: getPluginVersion()! } : {}),
      };
      runnerState = state;
      if (serial) {
        try {
          writeJsonStateFileAtomic(androidStatePath(serial), state);
        } catch {
          /* non-fatal */
        }
      }
      cleanupLegacyTmpState();
      resolve(state);
    };

    child.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      reject(new Error(`Failed to spawn Android runner instrumentation: ${err.message}`));
    });

    child.on('exit', (code) => {
      if (runnerProcess === child) {
        const exitState = runnerState;
        clearAndroidStateFile();
        if (typeof exitState?.hostPort === 'number') {
          execFileAsync(
            'adb',
            buildAdbForwardRemoveArgs(exitState.deviceId, exitState.hostPort),
          ).catch(() => {
            /* best-effort: must never throw from exit handler */
          });
        }
      }
      if (!resolved) {
        resolved = true;
        reject(
          new Error(
            `Android runner instrumentation exited before readiness (code ${code})${diag ? `\n${diag.trim()}` : ''}`,
          ),
        );
      }
    });

    // GH#243: readiness is the runner's own /health, not the (stale-prone) logcat
    // ring buffer. /health is true only once the ServerSocket is actually accepting.
    void waitForAndroidRunnerHealth(hostPort).then(async (healthy) => {
      if (resolved) return;
      if (healthy) {
        const info = await probeAndroidRunnerHealthInfo(hostPort);
        const compat = classifyAndroidHealth(info);
        if (!compat.compatible) {
          resolved = true;
          pendingUpgradeNote = undefined; // review amendment: never report an upgrade that failed
          child.kill('SIGTERM');
          reject(
            new Error(
              `RUNNER_PROTOCOL_MISMATCH: installed rn-android-runner speaks protocol ` +
                `${info.protocolVersion ?? 'none'} (bridge expects ${RUNNER_PROTOCOL_VERSION}). ` +
                `Rebuild + reinstall the runner APKs: cd ${RN_ANDROID_RUNNER_DIR} && ` +
                `./gradlew :app:assembleDebug :app:assembleDebugAndroidTest, then adb install -r both APKs.`,
            ),
          );
          return;
        }
        finishReady();
        return;
      }
      resolved = true;
      child.kill('SIGTERM');
      reject(
        new Error(
          `Android runner did not become ready within ${READY_TIMEOUT_MS / 1000}s (no /health on port ${hostPort})${diag ? `\n${diag.trim()}` : ''}`,
        ),
      );
    });
  });
}

export async function stopAndroidRunner(deviceId?: string): Promise<void> {
  // GH #383 (review amendment): adopt first so a post-respawn stop finds the
  // persisted runner (empty in-memory state would otherwise leak the forward).
  adoptPersistedAndroidState(deviceId ?? undefined);
  const stoppedState = runnerState;
  runnerProcess?.kill('SIGTERM');
  clearAndroidStateFile();
  if (typeof stoppedState?.hostPort === 'number') {
    const resolvedDeviceId = deviceId ?? stoppedState.deviceId;
    try {
      await execFileAsync(
        'adb',
        buildAdbForwardRemoveArgs(resolvedDeviceId, stoppedState.hostPort),
      );
    } catch {
      /* non-fatal */
    }
  }
}

async function postCommand(body: { command?: unknown }): Promise<RunnerResponse> {
  const state = runnerState;
  if (!state) throw new Error('rn-android-runner not started');
  // Bound every command so a wedged UIAutomator instrument can't hang the tool
  // indefinitely. type/snapshot/screenshot run long; everything else is fast.
  const slow =
    body.command === 'type' || body.command === 'snapshot' || body.command === 'screenshot';
  const timeoutMs = slow ? 35_000 : 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetchImpl(`http://127.0.0.1:${state.hostPort}/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as { name?: string } | undefined)?.name === 'AbortError') {
      throw new Error(
        `RUNNER_TIMEOUT: rn-android-runner did not respond to "${String(body.command)}" within ${timeoutMs}ms`,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
  let parsed: RunnerResponse;
  try {
    parsed = (await resp.json()) as RunnerResponse;
  } catch {
    throw new Error('rn-android-runner returned a non-JSON response body');
  }
  // GH #383: mirror the iOS /command v-stamp check — a runner hot-swapped to an
  // incompatible wire protocol mid-session is caught here (the reuse gate only
  // runs at start). runAndroid's catch maps this BEFORE isAndroidConnectionFailure.
  if (typeof parsed.v === 'number' && parsed.v !== RUNNER_PROTOCOL_VERSION) {
    throw new Error(
      `RUNNER_PROTOCOL_MISMATCH: runner replied with wire protocol v${parsed.v}, bridge expects v${RUNNER_PROTOCOL_VERSION}`,
    );
  }
  return parsed;
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
    resp = await postCommand(
      withKeyboardGuard(body, args.command, process.env) as Record<string, unknown>,
    );
  } catch (err) {
    const m = errMessage(err);
    // GH #383: a protocol mismatch (reuse-gate reject, post-start verify, or the
    // /command v-stamp) is a distinct, actionable failure — surface it before the
    // generic connection-failure mapping so it is never mislabeled RN_ANDROID_RUNNER_DOWN.
    if (m.startsWith('RUNNER_PROTOCOL_MISMATCH')) {
      return failResult(m, 'RUNNER_PROTOCOL_MISMATCH', {
        hint: 'The installed runner APK predates this plugin version. Rebuild + reinstall (command in the error), then retry.',
      });
    }
    // GH#243: a connection failure (runner just restarted after a flow, or can't bind
    // its port) must surface as a structured, retryable error — never a bare
    // "fetch failed". RUNNER_TIMEOUT (a wedged-but-bound instrument) is NOT a connection
    // failure and is rethrown unchanged.
    if (isAndroidConnectionFailure(m)) {
      return failResult(`rn-android-runner is not reachable: ${m}`, 'RN_ANDROID_RUNNER_DOWN', {
        hint: 'The runner could not start or bind its port (e.g. just restarted after a Maestro flow). Retry the command; if it persists, ensure the emulator is booted and the app is installed.',
      });
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
    return code
      ? failResult(message, code as Parameters<typeof failResult>[1])
      : failResult(message);
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
    if (!data?.pngBase64)
      return failResult(
        'Android runner screenshot response did not include pngBase64',
        'SCREENSHOT_FAILED',
      );
    const outPath = args.outPath ?? join(tmpdir(), `rn-android-screenshot-${Date.now()}.png`);
    writeFileSync(outPath, Buffer.from(data.pngBase64, 'base64'));
    return okResult({ path: outPath });
  }

  return okResult(resp.data ?? {});
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isAndroidConnectionFailure(message: string): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|rn-android-runner not started|did not become ready|Android runner instrumentation exited before readiness|Failed to spawn Android runner instrumentation/i.test(
    message,
  );
}
