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

const METRO_LAUNCHER_SOURCE = String.raw`
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const executable = process.env.RN_DEV_AGENT_METRO_EXECUTABLE;
const args = JSON.parse(process.env.RN_DEV_AGENT_METRO_ARGS || '[]');
const runtimeLoads = process.env.RN_DEV_AGENT_METRO_RUNTIME_LOADS;
if (!executable || !runtimeLoads) process.exit(1);
writeFileSync(runtimeLoads, '', { mode: 0o600 });
const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});
child.once('error', () => process.exit(1));
child.once('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
setInterval(() => {}, 1 << 30);
`;

export function parseNodeOptions(value: string): string[] {
  const tokens: string[] = [];
  let token = '';
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    let character = value[index]!;
    if (character === '\\' && quoted) {
      if (index + 1 === value.length) return tokens;
      character = value[(index += 1)]!;
    } else if (character === ' ' && !quoted) {
      if (token) tokens.push(token);
      token = '';
      continue;
    } else if (character === '"') {
      quoted = !quoted;
      continue;
    }
    token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

export function hasNodeLoaderOption(value: string): boolean {
  return parseNodeOptions(value).some((token) => {
    const equals = token.indexOf('=');
    const option = equals < 0 ? token : token.slice(0, equals);
    return ['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(
      option.replaceAll('_', '-'),
    );
  });
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
  authority: {
    port: number;
    pid: number;
    birth: string;
    launcherPid: number;
    launcherBirth: string;
    instanceId: string;
  },
  signerCapability: string,
): string {
  return createHmac('sha256', signerCapability)
    .update(
      [
        sessionId,
        authority.port,
        authority.pid,
        authority.birth,
        authority.launcherPid,
        authority.launcherBirth,
        authority.instanceId,
      ].join('\0'),
    )
    .digest('hex');
}

async function stopSpawnedProcessGroup(
  input: { launcherPid: number; port: number },
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
  let signalFailed = false;
  try {
    signalTree({
      launcherPid: input.launcherPid,
      listenerPid: input.launcherPid,
      launcherPresent: true,
      signal: 'SIGTERM',
    });
  } catch {
    signalFailed = true;
  }
  const deadline = Date.now() + 2_000;
  while (true) {
    const launcher = probeBirth(input.launcherPid);
    const port = probeListener(input.port);
    if (launcher.status === 'unknown' || port.status === 'unknown') return false;
    if (launcher.status === 'absent' && port.status === 'absent') return true;
    if (signalFailed) return false;
    if (Date.now() >= deadline) return false;
    await wait(25);
  }
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
  const instanceId = input.instanceId;
  const runtimePolicyCapability = createHmac('sha256', input.signerCapability)
    .update('metro-runtime-policy')
    .digest('base64url');
  const baseNodeOptions = (process.env.NODE_OPTIONS ?? '').trim();
  if (hasNodeLoaderOption(baseNodeOptions)) {
    throw new Error('METRO_START_UNAVAILABLE: NODE_OPTIONS loaders are unsupported');
  }
  const authorityPreload = join(input.appRoot, '.rn-agent', 'integration', 'rn-session-metro.cjs');
  const runtimeLoads = join(input.appRoot, '.rn-agent', 'integration', 'metro-runtime-loads.jsonl');
  const authorityNodeOptions = [baseNodeOptions, `--require=${JSON.stringify(authorityPreload)}`]
    .filter(Boolean)
    .join(' ');
  const log = openSync(join(input.runtimeRoot, 'metro.log'), 'a', 0o600);
  const child = (dependencies.spawnProcess ?? spawn)(
    process.execPath,
    ['-e', METRO_LAUNCHER_SOURCE],
    {
      cwd: input.appRoot,
      env: {
        ...process.env,
        RN_DEV_AGENT_METRO_EXECUTABLE: command.executable,
        RN_DEV_AGENT_METRO_ARGS: JSON.stringify([...command.args, '--port', String(input.port)]),
        RCT_METRO_PORT: String(input.port),
        RN_DEV_AGENT_SESSION_ID: input.sessionId,
        RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
        RN_DEV_AGENT_METRO_POLICY_CAPABILITY: runtimePolicyCapability,
        RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD: authorityPreload,
        RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS: baseNodeOptions,
        RN_DEV_AGENT_METRO_RUNTIME_LOADS: runtimeLoads,
        NODE_OPTIONS: authorityNodeOptions,
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
    const cleanupProven = await stopSpawnedProcessGroup(
      { launcherPid: child.pid, port: input.port },
      dependencies,
    );
    if (!cleanupProven) {
      throw new Error(
        'METRO_START_CLEANUP_UNPROVEN: Metro launcher birth and cleanup could not be proven',
      );
    }
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
    if (child.exitCode !== null || child.signalCode != null) break;
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
        const authority = {
          ...binding,
          mode: 'managed',
          launcherPid: child.pid,
          launcherBirth: launcherBirth.token,
        } satisfies Omit<ManagedMetroBinding, 'managementProof'>;
        return {
          ...authority,
          managementProof: managementProof(input.sessionId, authority, input.signerCapability),
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
  process.kill(-input.launcherPid, input.signal);
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
    (input.listener
      ? initial.port.pid !== input.listener.pid || initial.listener !== 'present'
      : initial.launcher !== 'present')
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
      input.listener &&
      (current.port.pid !== input.listener.pid || current.listener !== 'present')
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
    {
      port: binding.port,
      pid: binding.pid,
      birth: binding.birth,
      launcherPid: binding.launcherPid,
      launcherBirth: binding.launcherBirth,
      instanceId: binding.instanceId,
    },
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
