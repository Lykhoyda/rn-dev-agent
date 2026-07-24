import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  captureMetroBinding,
  metroListenerPid,
  probeMetroListener,
  type MetroBinding,
  type MetroListenerProbe,
} from './metro-binding.js';
import {
  probeProcessBirth,
  readProcessBirth,
  type ProcessBirth,
  type ProcessBirthProbe,
} from './process-birth.js';

export interface ManagedMetroBinding extends MetroBinding {
  mode: 'managed';
  launcherPid: number;
  launcherBirth: string;
  managementProof: string;
}

interface ManagedMetroDependencies {
  exists?: (path: string) => boolean;
  readText?: (path: string) => string;
  spawnProcess?: (
    executable: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => ChildProcess;
  listenerPid?: (port: number) => number | null;
  listenerOwnedByLauncher?: (listenerPid: number, launcherPid: number) => boolean;
  capture?: typeof captureMetroBinding;
  readBirth?: (pid: number) => ProcessBirth | null;
  probeBirth?: (pid: number) => ProcessBirthProbe;
  probeListener?: (port: number) => ManagedMetroListenerProbe;
  signalTree?: (input: ManagedMetroSignal) => void;
  wait?: (ms: number) => Promise<void>;
}

interface ManagedMetroSignal {
  launcherPid: number;
  listenerPid: number;
  launcherPresent: boolean;
  signal: NodeJS.Signals;
}

interface ManagedMetroProcessIdentity {
  pid: number;
  birth: string;
}

function parentPid(pid: number): number | null {
  try {
    const output =
      process.platform === 'win32'
        ? execFileSync(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 },
          )
        : execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2_000,
          });
    const parsed = Number(output.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function listenerOwnedByLauncher(listenerPid: number, launcherPid: number): boolean {
  let current: number | null = listenerPid;
  const visited = new Set<number>();
  while (current && !visited.has(current)) {
    if (current === launcherPid) return true;
    visited.add(current);
    current = parentPid(current);
  }
  return false;
}

export function managedMetroListenerPid(
  port: number,
  platform: NodeJS.Platform = process.platform,
  execute: typeof execFileSync = execFileSync,
): number | null {
  return metroListenerPid(port, platform, execute);
}

export type ManagedMetroListenerProbe = MetroListenerProbe;

export function probeManagedMetroListener(
  port: number,
  platform: NodeJS.Platform = process.platform,
  execute: typeof execFileSync = execFileSync,
): ManagedMetroListenerProbe {
  return probeMetroListener(port, platform, execute);
}

export function resolveManagedMetroCommand(
  appRoot: string,
  dependencies: Pick<ManagedMetroDependencies, 'exists' | 'readText'> = {},
): { executable: string; args: string[] } {
  const exists = dependencies.exists ?? existsSync;
  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const packageJson = JSON.parse(readText(join(appRoot, 'package.json'))) as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const all = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (all.expo) {
    const executable = join(appRoot, 'node_modules', '.bin', 'expo');
    if (!exists(executable)) {
      throw new Error('METRO_START_UNAVAILABLE: package-local Expo CLI is unavailable');
    }
    return { executable, args: ['start', '--dev-client'] };
  }
  if (all['react-native']) {
    const executable = join(appRoot, 'node_modules', '.bin', 'react-native');
    if (!exists(executable)) {
      throw new Error('METRO_START_UNAVAILABLE: package-local React Native CLI is unavailable');
    }
    return { executable, args: ['start'] };
  }
  throw new Error('METRO_START_UNAVAILABLE: project is neither Expo nor bare React Native');
}

function managementProof(
  sessionId: string,
  launcherPid: number,
  launcherBirth: string,
  instanceId: string,
  signerCapability: string,
): string {
  return createHmac('sha256', signerCapability)
    .update(`${sessionId}\0${launcherPid}\0${launcherBirth}\0${instanceId}`)
    .digest('hex');
}

export async function startManagedMetro(
  input: {
    appRoot: string;
    runtimeRoot: string;
    sourceRoot: string;
    sessionId: string;
    port: number;
    instanceId: string;
    buildGeneration: number;
    signerCapability: string;
  },
  dependencies: ManagedMetroDependencies = {},
): Promise<ManagedMetroBinding> {
  const command = resolveManagedMetroCommand(input.appRoot, dependencies);
  const log = openSync(join(input.runtimeRoot, 'metro.log'), 'a', 0o600);
  const instanceId = input.instanceId;
  const child = (dependencies.spawnProcess ?? spawn)(
    command.executable,
    [...command.args, '--port', String(input.port)],
    {
      cwd: input.appRoot,
      env: {
        ...process.env,
        RCT_METRO_PORT: String(input.port),
        RN_DEV_AGENT_SESSION_ID: input.sessionId,
        RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
      },
      detached: true,
      stdio: ['ignore', log, log],
    },
  );
  closeSync(log);
  if (!child.pid) {
    throw new Error('METRO_START_UNAVAILABLE: package-local Metro process did not start');
  }
  const readBirth = dependencies.readBirth ?? readProcessBirth;
  const launcherBirth = readBirth(child.pid);
  if (!launcherBirth) {
    child.kill('SIGTERM');
    throw new Error('PROCESS_BIRTH_UNAVAILABLE: Metro launcher birth could not be proven');
  }
  child.unref();

  const listenerPid = dependencies.listenerPid ?? managedMetroListenerPid;
  const ownsListener = dependencies.listenerOwnedByLauncher ?? listenerOwnedByLauncher;
  const capture = dependencies.capture ?? captureMetroBinding;
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const wait =
    dependencies.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + 20_000;
  let lastError: unknown = null;
  let listenerIdentity: ManagedMetroProcessIdentity | null = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const pid = listenerPid(input.port);
    if (pid && ownsListener(pid, child.pid)) {
      const listenerBirth = probeBirth(pid);
      if (listenerBirth.status === 'present') {
        listenerIdentity = { pid, birth: listenerBirth.birth.token };
      }
      try {
        const binding = await capture(
          {
            port: input.port,
            pid,
            instanceId,
            sourceRoot: input.sourceRoot,
            buildGeneration: input.buildGeneration,
          },
          { servingRoot: () => input.sourceRoot },
        );
        return {
          ...binding,
          mode: 'managed',
          launcherPid: child.pid,
          launcherBirth: launcherBirth.token,
          managementProof: managementProof(
            input.sessionId,
            child.pid,
            launcherBirth.token,
            instanceId,
            input.signerCapability,
          ),
        };
      } catch (error) {
        lastError = error;
      }
    }
    await wait(100);
  }
  const cleanupProven = await stopManagedMetroProcesses(
    {
      port: input.port,
      launcher: { pid: child.pid, birth: launcherBirth.token },
      listener: listenerIdentity,
    },
    dependencies,
  );
  if (!cleanupProven) {
    throw new Error(
      'METRO_START_CLEANUP_UNPROVEN: failed Metro startup left process or listener state ambiguous',
    );
  }
  throw new Error(
    `METRO_START_UNAVAILABLE: allocated Metro did not become authoritative${
      lastError instanceof Error ? ` (${lastError.message})` : ''
    }`,
  );
}

function signalProcessTree(input: ManagedMetroSignal): void {
  if (process.platform === 'win32') {
    const pid = input.launcherPresent ? input.launcherPid : input.listenerPid;
    execFileSync('taskkill.exe', ['/PID', String(pid), '/T'], {
      stdio: 'ignore',
      timeout: 2_000,
    });
    return;
  }
  process.kill(input.launcherPresent ? -input.launcherPid : input.listenerPid, input.signal);
}

type ExactProcessState = 'present' | 'stopped' | 'unknown';

function exactProcessState(
  expected: ManagedMetroProcessIdentity,
  probe: ProcessBirthProbe,
): ExactProcessState {
  if (probe.status === 'unknown') return 'unknown';
  if (probe.status === 'absent') return 'stopped';
  return probe.birth.token === expected.birth ? 'present' : 'stopped';
}

async function stopManagedMetroProcesses(
  input: {
    port: number;
    launcher: ManagedMetroProcessIdentity;
    listener: ManagedMetroProcessIdentity | null;
  },
  dependencies: Pick<
    ManagedMetroDependencies,
    'probeBirth' | 'probeListener' | 'signalTree' | 'wait'
  >,
): Promise<boolean> {
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
  const signalTree = dependencies.signalTree ?? signalProcessTree;
  const wait =
    dependencies.wait ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const inspect = () => {
    const launcher = exactProcessState(input.launcher, probeBirth(input.launcher.pid));
    const listener = input.listener
      ? exactProcessState(input.listener, probeBirth(input.listener.pid))
      : 'stopped';
    const port = probeListener(input.port);
    return { launcher, listener, port };
  };
  const initial = inspect();
  if (
    initial.launcher === 'unknown' ||
    initial.listener === 'unknown' ||
    initial.port.status === 'unknown'
  ) {
    return false;
  }
  if (
    initial.port.status === 'listening' &&
    (!input.listener ||
      initial.port.pid !== input.listener.pid ||
      initial.listener !== 'present')
  ) {
    return false;
  }
  if (
    initial.launcher === 'stopped' &&
    initial.listener === 'stopped' &&
    initial.port.status === 'absent'
  ) {
    return true;
  }
  try {
    signalTree({
      launcherPid: input.launcher.pid,
      listenerPid: input.listener?.pid ?? input.launcher.pid,
      launcherPresent: initial.launcher === 'present',
      signal: 'SIGTERM',
    });
  } catch {
    return false;
  }
  const deadline = Date.now() + 2_000;
  while (true) {
    const current = inspect();
    if (
      current.launcher === 'unknown' ||
      current.listener === 'unknown' ||
      current.port.status === 'unknown'
    ) {
      return false;
    }
    if (
      current.launcher === 'stopped' &&
      current.listener === 'stopped' &&
      current.port.status === 'absent'
    ) {
      return true;
    }
    if (
      current.port.status === 'listening' &&
      (!input.listener ||
        current.port.pid !== input.listener.pid ||
        current.listener !== 'present')
    ) {
      return false;
    }
    if (Date.now() >= deadline) return false;
    await wait(25);
  }
}

export async function stopManagedMetro(
  binding: Partial<ManagedMetroBinding> | null | undefined,
  input: { sessionId: string; signerCapability: string },
  dependencies: Pick<
    ManagedMetroDependencies,
    'probeBirth' | 'probeListener' | 'signalTree' | 'wait'
  > = {},
): Promise<boolean> {
  if (
    binding?.mode !== 'managed' ||
    typeof binding.port !== 'number' ||
    typeof binding.pid !== 'number' ||
    typeof binding.birth !== 'string' ||
    typeof binding.launcherPid !== 'number' ||
    typeof binding.launcherBirth !== 'string' ||
    typeof binding.instanceId !== 'string' ||
    typeof binding.managementProof !== 'string'
  ) {
    return false;
  }
  const expected = managementProof(
    input.sessionId,
    binding.launcherPid,
    binding.launcherBirth,
    binding.instanceId,
    input.signerCapability,
  );
  const expectedBuffer = Buffer.from(expected, 'hex');
  const observedBuffer = Buffer.from(binding.managementProof, 'hex');
  if (
    expectedBuffer.length !== observedBuffer.length ||
    !timingSafeEqual(expectedBuffer, observedBuffer)
  ) {
    return false;
  }
  return stopManagedMetroProcesses(
    {
      port: binding.port,
      launcher: { pid: binding.launcherPid, birth: binding.launcherBirth },
      listener: { pid: binding.pid, birth: binding.birth },
    },
    dependencies,
  );
}
