import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
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
import { canonicalAuthorityJson } from './authority-json.js';

export type MetroRuntimeEvidenceAuthority = 'reported-v1' | 'broker-v2';

export interface ManagedMetroBinding extends MetroBinding {
  mode: 'managed';
  launcherPid: number;
  launcherBirth: string;
  managementProof: string;
  runtimeEvidenceAuthority: MetroRuntimeEvidenceAuthority;
  runtimeEvidencePath: string;
  runtimeEvidenceSocket: string;
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
  removeEvidenceSocket?: (path: string) => void;
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
const { createHmac } = require('node:crypto');
const { chmodSync, closeSync, openSync, rmSync, writeSync } = require('node:fs');
const { createServer } = require('node:net');
const intrinsicJsonStringify = JSON.stringify;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicArraySort = Array.prototype.sort;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicReflectApply = Reflect.apply;
const intrinsicObjectPrototype = Object.prototype;
const IntrinsicObject = Object;
const IntrinsicWeakSet = WeakSet;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetDelete = WeakSet.prototype.delete;
const intrinsicWeakSetHas = WeakSet.prototype.has;
function canonicalAuthorityJson(value) {
  const active = new IntrinsicWeakSet();
  const encode = (candidate) => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') {
      return intrinsicReflectApply(intrinsicJsonStringify, JSON, [candidate]);
    }
    if (typeof candidate === 'number') {
      return intrinsicNumberIsFinite(candidate)
        ? intrinsicReflectApply(intrinsicJsonStringify, JSON, [candidate])
        : 'null';
    }
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate !== 'object') throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_VALUE');
    if (intrinsicReflectApply(intrinsicWeakSetHas, active, [candidate])) {
      throw new TypeError('AUTHORITY_JSON_CYCLE');
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, active, [candidate]);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized = '[';
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) serialized += ',';
          const descriptor = intrinsicReflectApply(
            intrinsicGetOwnPropertyDescriptor,
            IntrinsicObject,
            [candidate, String(index)],
          );
          if (!descriptor || !('value' in descriptor)) throw new TypeError('AUTHORITY_JSON_ACCESSOR');
          serialized += encode(descriptor.value);
        }
        return serialized + ']';
      }
      const prototype = intrinsicReflectApply(
        intrinsicGetPrototypeOf,
        IntrinsicObject,
        [candidate],
      );
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_OBJECT');
      }
      const names = intrinsicReflectApply(
        intrinsicGetOwnPropertyNames,
        IntrinsicObject,
        [candidate],
      );
      const enumerable = [];
      for (let index = 0; index < names.length; index += 1) {
        const descriptor = intrinsicReflectApply(
          intrinsicGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, names[index]],
        );
        if (descriptor?.enumerable) enumerable.push(names[index]);
      }
      intrinsicReflectApply(intrinsicArraySort, enumerable, []);
      let serialized = '{';
      for (let index = 0; index < enumerable.length; index += 1) {
        if (index > 0) serialized += ',';
        const name = enumerable[index];
        const descriptor = intrinsicReflectApply(
          intrinsicGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, name],
        );
        if (!descriptor || !('value' in descriptor)) throw new TypeError('AUTHORITY_JSON_ACCESSOR');
        serialized +=
          intrinsicReflectApply(intrinsicJsonStringify, JSON, [name]) +
          ':' +
          encode(descriptor.value);
      }
      return serialized + '}';
    } finally {
      intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
    }
  };
  return encode(value);
}
const executable = process.env.RN_DEV_AGENT_METRO_EXECUTABLE;
const args = JSON.parse(process.env.RN_DEV_AGENT_METRO_ARGS || '[]');
const evidencePath = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE;
const evidenceSocket = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET;
const capability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
const childNodeOptions = process.env.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS;
if (!executable || !evidencePath || !evidenceSocket || !capability || !sessionId || !metroInstanceId || !childNodeOptions) {
  process.exit(1);
}
const evidenceDescriptor = 9;
const journalDescriptor = openSync(evidencePath, 'w', 0o600);
let sequence = 0;
let previousSignature = null;
let buffered = '';
function appendEvidence(payload) {
  const chainedPayload = {
    ...payload,
    runtimeEvidenceAuthority: 'reported-v1',
    sequence: ++sequence,
    previousSignature,
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(chainedPayload))
    .digest('hex');
  writeSync(
    journalDescriptor,
    canonicalAuthorityJson({ ...chainedPayload, signature }) + '\n',
  );
  previousSignature = signature;
}
function appendViolation(value) {
  appendEvidence({
    version: 1,
    sessionId,
    metroInstanceId,
    kind: 'violation',
    value,
    digest: null,
  });
}
if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
const headConnections = new Set();
const pendingHeads = new Map();
let child;
function closeHeadConnection(connection) {
  headConnections.delete(connection);
  for (const [challenge, pending] of pendingHeads) {
    if (pending === connection) pendingHeads.delete(challenge);
  }
}
function respondWithHead(connection, challenge) {
  const payload = {
    version: 1,
    runtimeEvidenceAuthority: 'reported-v1',
    sessionId,
    metroInstanceId,
    challenge,
    sequence,
    journalSignature: previousSignature,
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(payload))
    .digest('hex');
  connection.end(canonicalAuthorityJson({ ...payload, signature }) + '\n');
}
const headServer = createServer((connection) => {
  headConnections.add(connection);
  let request = '';
  connection.setEncoding('utf8');
  connection.setTimeout(1500, () => connection.destroy());
  connection.once('close', () => closeHeadConnection(connection));
  connection.on('data', (chunk) => {
    request += chunk;
    if (request.length > 256) {
      connection.destroy();
      return;
    }
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    const challenge = request.slice(0, newline);
    if (!/^[a-f0-9]{64}$/.test(challenge)) {
      connection.destroy();
      return;
    }
    if (pendingHeads.has(challenge) || evidenceFinished || !child?.connected) {
      connection.destroy();
      return;
    }
    pendingHeads.set(challenge, connection);
    try {
      child.send({ type: 'rn-dev-agent:evidence-barrier', challenge }, (error) => {
        if (error) connection.destroy();
      });
    } catch {
      connection.destroy();
    }
  });
});
headServer.once('error', () => process.exit(1));
headServer.listen(evidenceSocket, () => {
  if (process.platform !== 'win32') chmodSync(evidenceSocket, 0o600);
});
const childEnvironment = {
  ...process.env,
  NODE_OPTIONS: childNodeOptions,
  RN_DEV_AGENT_METRO_EVIDENCE_FD: String(evidenceDescriptor),
};
delete childEnvironment.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE;
delete childEnvironment.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS;
child = spawn(executable, args, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: ['inherit', 'inherit', 'inherit', 'ipc', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
});
const evidence = child.stdio[evidenceDescriptor];
let childOutcome = null;
let evidenceFinished = false;
let launcherFinished = false;
function finishLauncher() {
  if (launcherFinished || childOutcome === null || !evidenceFinished) return;
  launcherFinished = true;
  if (buffered) appendViolation('Metro runtime evidence record is incomplete');
  for (const connection of headConnections) connection.destroy();
  pendingHeads.clear();
  closeSync(journalDescriptor);
  headServer.close(() => {
    if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
    process.exit(childOutcome.signal ? 1 : childOutcome.code);
  });
}
function finishEvidence() {
  if (evidenceFinished) return;
  if (child.exitCode === null && child.signalCode === null) {
    appendViolation('Metro runtime evidence stream ended before Metro exited');
  }
  evidenceFinished = true;
  finishLauncher();
}
evidence.setEncoding('utf8');
evidence.on('data', (chunk) => {
  buffered += chunk;
  if (buffered.length > 1024 * 1024) {
    appendViolation('Metro runtime evidence record exceeds the limit');
    buffered = '';
    return;
  }
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      const payload = JSON.parse(line);
      if (
        payload.version !== 1 ||
        payload.sessionId !== sessionId ||
        payload.metroInstanceId !== metroInstanceId ||
        ![
          'input',
          'violation',
          'launch',
          'attestation',
          'semantics',
          'pending',
          'completion',
          'barrier',
        ].includes(payload.kind) ||
        typeof payload.value !== 'string' ||
        (payload.kind === 'input'
          ? typeof payload.digest !== 'string'
          : payload.digest !== null)
      ) {
        throw new Error('invalid evidence');
      }
      if (payload.kind === 'barrier') {
        const connection = pendingHeads.get(payload.value);
        if (connection) {
          pendingHeads.delete(payload.value);
          respondWithHead(connection, payload.value);
        }
        continue;
      }
      appendEvidence(payload);
    } catch {
      appendViolation('Metro runtime evidence record is invalid');
    }
  }
});
child.once('error', () => process.exit(1));
evidence.once('end', finishEvidence);
evidence.once('close', finishEvidence);
evidence.once('error', () => {
  appendViolation('Metro runtime evidence stream failed');
  finishEvidence();
});
child.once('exit', (code, signal) => {
  childOutcome = { code: code ?? 1, signal };
  finishLauncher();
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

export function hasUnsupportedNodeOption(value: string): boolean {
  const booleanOptions = new Set([
    '--enable-source-maps',
    '--experimental-strip-types',
    '--experimental-transform-types',
    '--no-deprecation',
    '--no-warnings',
    '--preserve-symlinks',
    '--preserve-symlinks-main',
    '--trace-deprecation',
    '--trace-uncaught',
    '--trace-warnings',
  ]);
  const valueOptions = new Set([
    '--conditions',
    '--dns-result-order',
    '--max-old-space-size',
    '--max-semi-space-size',
    '--stack-trace-limit',
    '--title',
    '--unhandled-rejections',
  ]);
  const tokens = parseNodeOptions(value);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const equals = token.indexOf('=');
    const option = (equals < 0 ? token : token.slice(0, equals)).replaceAll('_', '-');
    if (booleanOptions.has(option)) {
      if (equals >= 0) return true;
      continue;
    }
    if (!valueOptions.has(option)) return true;
    if (equals >= 0) {
      if (token.slice(equals + 1).length === 0) return true;
      continue;
    }
    const optionValue = tokens[index + 1];
    if (!optionValue || optionValue.startsWith('-')) return true;
    index += 1;
  }
  return false;
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
    runtimeEvidencePath: string;
    runtimeEvidenceSocket: string;
    runtimeEvidenceAuthority: MetroRuntimeEvidenceAuthority;
  },
  signerCapability: string,
): string {
  return createHmac('sha256', signerCapability)
    .update(
      canonicalAuthorityJson({
        sessionId,
        port: authority.port,
        pid: authority.pid,
        birth: authority.birth,
        launcherPid: authority.launcherPid,
        launcherBirth: authority.launcherBirth,
        instanceId: authority.instanceId,
        runtimeEvidencePath: authority.runtimeEvidencePath,
        runtimeEvidenceSocket: authority.runtimeEvidenceSocket,
        runtimeEvidenceAuthority: authority.runtimeEvidenceAuthority,
      }),
    )
    .digest('hex');
}

function legacyManagementProof(
  sessionId: string,
  authority: Omit<
    Parameters<typeof managementProof>[1],
    'runtimeEvidenceAuthority'
  >,
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
        authority.runtimeEvidencePath,
        authority.runtimeEvidenceSocket,
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
  if (hasNodeLoaderOption(baseNodeOptions) || hasUnsupportedNodeOption(baseNodeOptions)) {
    throw new Error('METRO_START_UNAVAILABLE: NODE_OPTIONS contain unsupported execution inputs');
  }
  const authorityPreload = join(input.appRoot, '.rn-agent', 'integration', 'rn-session-metro.cjs');
  const runtimeEvidencePath = join(input.runtimeRoot, 'metro-runtime-evidence.jsonl');
  const runtimeEvidenceEndpointId = createHmac('sha256', input.signerCapability)
    .update(`metro-runtime-evidence\0${instanceId}`)
    .digest('hex')
    .slice(0, 32);
  const runtimeEvidenceSocket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\rn-dev-agent-${runtimeEvidenceEndpointId}`
      : `/tmp/rn-dev-agent-${runtimeEvidenceEndpointId}.sock`;
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
        RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE: runtimeEvidencePath,
        RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET: runtimeEvidenceSocket,
        RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS: authorityNodeOptions,
        NODE_OPTIONS: baseNodeOptions,
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
    if (!removeManagedMetroEvidenceSocketSafely(runtimeEvidenceSocket, dependencies)) {
      throw new Error('METRO_START_CLEANUP_UNPROVEN: Metro evidence socket cleanup failed');
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
          runtimeEvidencePath,
          runtimeEvidenceSocket,
          runtimeEvidenceAuthority: 'reported-v1',
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
  if (!removeManagedMetroEvidenceSocketSafely(runtimeEvidenceSocket, dependencies)) {
    throw new Error('METRO_START_CLEANUP_UNPROVEN: Metro evidence socket cleanup failed');
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

function removeManagedMetroEvidenceSocket(path: string): void {
  if (process.platform === 'win32') return;
  if (!/^\/tmp\/rn-dev-agent-[a-f0-9]{32}\.sock$/.test(path)) {
    throw new Error('METRO_EVIDENCE_SOCKET_INVALID');
  }
  rmSync(path, { force: true });
}

function removeManagedMetroEvidenceSocketSafely(
  path: string,
  dependencies: Pick<ManagedMetroDependencies, 'removeEvidenceSocket'>,
): boolean {
  try {
    (dependencies.removeEvidenceSocket ?? removeManagedMetroEvidenceSocket)(path);
    return true;
  } catch {
    return false;
  }
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
    'probeBirth' | 'probeListener' | 'removeEvidenceSocket' | 'signalTree' | 'wait'
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
    typeof binding.runtimeEvidencePath !== 'string' ||
    typeof binding.runtimeEvidenceSocket !== 'string' ||
    (binding.runtimeEvidenceAuthority !== undefined &&
      binding.runtimeEvidenceAuthority !== 'reported-v1' &&
      binding.runtimeEvidenceAuthority !== 'broker-v2') ||
    typeof binding.managementProof !== 'string'
  ) {
    return false;
  }
  const legacyAuthority = {
    port: binding.port,
    pid: binding.pid,
    birth: binding.birth,
    launcherPid: binding.launcherPid,
    launcherBirth: binding.launcherBirth,
    instanceId: binding.instanceId,
    runtimeEvidencePath: binding.runtimeEvidencePath,
    runtimeEvidenceSocket: binding.runtimeEvidenceSocket,
  };
  const expected =
    binding.runtimeEvidenceAuthority === undefined
      ? legacyManagementProof(input.sessionId, legacyAuthority, input.signerCapability)
      : managementProof(
          input.sessionId,
          {
            ...legacyAuthority,
            runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
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
  const stopped = await stopManagedMetroProcesses(
    {
      port: binding.port,
      launcher: { pid: binding.launcherPid, birth: binding.launcherBirth },
      listener: { pid: binding.pid, birth: binding.birth },
    },
    dependencies,
  );
  if (!stopped) return false;
  return removeManagedMetroEvidenceSocketSafely(binding.runtimeEvidenceSocket, dependencies);
}
