import { execFileSync, spawn } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureMetroBinding, metroListenerPid, probeMetroListener, } from './metro-binding.js';
import { probeProcessBirth, readProcessBirth, } from './process-birth.js';
const METRO_LAUNCHER_SOURCE = String.raw `
const { spawn } = require('node:child_process');
const { createHmac } = require('node:crypto');
const { closeSync, openSync, rmSync, writeSync } = require('node:fs');
const { createServer } = require('node:net');
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
  const chainedPayload = { ...payload, sequence: ++sequence, previousSignature };
  const signature = createHmac('sha256', capability)
    .update(JSON.stringify(chainedPayload))
    .digest('hex');
  writeSync(journalDescriptor, JSON.stringify({ ...chainedPayload, signature }) + '\n');
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
const headServer = createServer((connection) => {
  let request = '';
  connection.setEncoding('utf8');
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
    const payload = {
      version: 1,
      sessionId,
      metroInstanceId,
      challenge,
      sequence,
      journalSignature: previousSignature,
    };
    const signature = createHmac('sha256', capability)
      .update(JSON.stringify(payload))
      .digest('hex');
    connection.end(JSON.stringify({ ...payload, signature }) + '\n');
  });
});
headServer.once('error', () => process.exit(1));
headServer.listen(evidenceSocket);
const childEnvironment = {
  ...process.env,
  NODE_OPTIONS: childNodeOptions,
  RN_DEV_AGENT_METRO_EVIDENCE_FD: String(evidenceDescriptor),
};
delete childEnvironment.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE;
delete childEnvironment.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS;
const child = spawn(executable, args, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: ['inherit', 'inherit', 'inherit', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'pipe'],
});
const evidence = child.stdio[evidenceDescriptor];
let childOutcome = null;
let evidenceFinished = false;
let launcherFinished = false;
function finishLauncher() {
  if (launcherFinished || childOutcome === null || !evidenceFinished) return;
  launcherFinished = true;
  if (buffered) appendViolation('Metro runtime evidence record is incomplete');
  closeSync(journalDescriptor);
  headServer.close(() => {
    if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
    process.exit(childOutcome.signal ? 1 : childOutcome.code);
  });
}
function finishEvidence() {
  if (evidenceFinished) return;
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
        !['input', 'violation', 'launch', 'attestation'].includes(payload.kind) ||
        typeof payload.value !== 'string' ||
        (payload.kind === 'input'
          ? typeof payload.digest !== 'string'
          : payload.digest !== null)
      ) {
        throw new Error('invalid evidence');
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
export function parseNodeOptions(value) {
    const tokens = [];
    let token = '';
    let quoted = false;
    for (let index = 0; index < value.length; index += 1) {
        let character = value[index];
        if (character === '\\' && quoted) {
            if (index + 1 === value.length)
                return tokens;
            character = value[(index += 1)];
        }
        else if (character === ' ' && !quoted) {
            if (token)
                tokens.push(token);
            token = '';
            continue;
        }
        else if (character === '"') {
            quoted = !quoted;
            continue;
        }
        token += character;
    }
    if (token)
        tokens.push(token);
    return tokens;
}
export function hasNodeLoaderOption(value) {
    return parseNodeOptions(value).some((token) => {
        const equals = token.indexOf('=');
        const option = equals < 0 ? token : token.slice(0, equals);
        return ['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(option.replaceAll('_', '-'));
    });
}
function parentPid(pid) {
    try {
        const output = process.platform === 'win32'
            ? execFileSync('powershell.exe', [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
            ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 })
            : execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2_000,
            });
        const parsed = Number(output.trim());
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
    catch {
        return null;
    }
}
function listenerOwnedByLauncher(listenerPid, launcherPid) {
    let current = listenerPid;
    const visited = new Set();
    while (current && !visited.has(current)) {
        if (current === launcherPid)
            return true;
        visited.add(current);
        current = parentPid(current);
    }
    return false;
}
export function managedMetroListenerPid(port, platform = process.platform, execute = execFileSync) {
    return metroListenerPid(port, platform, execute);
}
export function probeManagedMetroListener(port, platform = process.platform, execute = execFileSync) {
    return probeMetroListener(port, platform, execute);
}
export function resolveManagedMetroCommand(appRoot, dependencies = {}) {
    const exists = dependencies.exists ?? existsSync;
    const readText = dependencies.readText ?? ((path) => readFileSync(path, 'utf8'));
    const packageJson = JSON.parse(readText(join(appRoot, 'package.json')));
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
function managementProof(sessionId, authority, signerCapability) {
    return createHmac('sha256', signerCapability)
        .update([
        sessionId,
        authority.port,
        authority.pid,
        authority.birth,
        authority.launcherPid,
        authority.launcherBirth,
        authority.instanceId,
        authority.runtimeEvidencePath,
        authority.runtimeEvidenceSocket,
    ].join('\0'))
        .digest('hex');
}
async function stopSpawnedProcessGroup(input, dependencies) {
    const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
    const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
    const signalTree = dependencies.signalTree ?? signalProcessTree;
    const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    let signalFailed = false;
    try {
        signalTree({
            launcherPid: input.launcherPid,
            listenerPid: input.launcherPid,
            launcherPresent: true,
            signal: 'SIGTERM',
        });
    }
    catch {
        signalFailed = true;
    }
    const deadline = Date.now() + 2_000;
    while (true) {
        const launcher = probeBirth(input.launcherPid);
        const port = probeListener(input.port);
        if (launcher.status === 'unknown' || port.status === 'unknown')
            return false;
        if (launcher.status === 'absent' && port.status === 'absent')
            return true;
        if (signalFailed)
            return false;
        if (Date.now() >= deadline)
            return false;
        await wait(25);
    }
}
export async function startManagedMetro(input, dependencies = {}) {
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
    const runtimeEvidencePath = join(input.runtimeRoot, 'metro-runtime-evidence.jsonl');
    const runtimeEvidenceSocket = process.platform === 'win32'
        ? `\\\\.\\pipe\\rn-dev-agent-${instanceId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
        : join(input.runtimeRoot, 'metro-runtime-evidence.sock');
    const authorityNodeOptions = [baseNodeOptions, `--require=${JSON.stringify(authorityPreload)}`]
        .filter(Boolean)
        .join(' ');
    const log = openSync(join(input.runtimeRoot, 'metro.log'), 'a', 0o600);
    const child = (dependencies.spawnProcess ?? spawn)(process.execPath, ['-e', METRO_LAUNCHER_SOURCE], {
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
    });
    closeSync(log);
    if (!child.pid) {
        throw new Error('METRO_START_UNAVAILABLE: package-local Metro process did not start');
    }
    const readBirth = dependencies.readBirth ?? readProcessBirth;
    const launcherBirth = readBirth(child.pid);
    if (!launcherBirth) {
        const cleanupProven = await stopSpawnedProcessGroup({ launcherPid: child.pid, port: input.port }, dependencies);
        if (!cleanupProven) {
            throw new Error('METRO_START_CLEANUP_UNPROVEN: Metro launcher birth and cleanup could not be proven');
        }
        throw new Error('PROCESS_BIRTH_UNAVAILABLE: Metro launcher birth could not be proven');
    }
    child.unref();
    const listenerPid = dependencies.listenerPid ?? managedMetroListenerPid;
    const ownsListener = dependencies.listenerOwnedByLauncher ?? listenerOwnedByLauncher;
    const capture = dependencies.capture ?? captureMetroBinding;
    const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
    const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + 20_000;
    let lastError = null;
    let listenerIdentity = null;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode != null)
            break;
        const pid = listenerPid(input.port);
        if (pid && ownsListener(pid, child.pid)) {
            const listenerBirth = probeBirth(pid);
            if (listenerBirth.status === 'present') {
                listenerIdentity = { pid, birth: listenerBirth.birth.token };
            }
            try {
                const binding = await capture({
                    port: input.port,
                    pid,
                    instanceId,
                    sourceRoot: input.sourceRoot,
                    buildGeneration: input.buildGeneration,
                }, { servingRoot: () => input.sourceRoot });
                const authority = {
                    ...binding,
                    mode: 'managed',
                    launcherPid: child.pid,
                    launcherBirth: launcherBirth.token,
                    runtimeEvidencePath,
                    runtimeEvidenceSocket,
                };
                return {
                    ...authority,
                    managementProof: managementProof(input.sessionId, authority, input.signerCapability),
                };
            }
            catch (error) {
                lastError = error;
            }
        }
        await wait(100);
    }
    const cleanupProven = await stopManagedMetroProcesses({
        port: input.port,
        launcher: { pid: child.pid, birth: launcherBirth.token },
        listener: listenerIdentity,
    }, dependencies);
    if (!cleanupProven) {
        throw new Error('METRO_START_CLEANUP_UNPROVEN: failed Metro startup left process or listener state ambiguous');
    }
    throw new Error(`METRO_START_UNAVAILABLE: allocated Metro did not become authoritative${lastError instanceof Error ? ` (${lastError.message})` : ''}`);
}
function signalProcessTree(input) {
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
function exactProcessState(expected, probe) {
    if (probe.status === 'unknown')
        return 'unknown';
    if (probe.status === 'absent')
        return 'stopped';
    return probe.birth.token === expected.birth ? 'present' : 'stopped';
}
async function stopManagedMetroProcesses(input, dependencies) {
    const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
    const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
    const signalTree = dependencies.signalTree ?? signalProcessTree;
    const wait = dependencies.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const inspect = () => {
        const launcher = exactProcessState(input.launcher, probeBirth(input.launcher.pid));
        const listener = input.listener
            ? exactProcessState(input.listener, probeBirth(input.listener.pid))
            : 'stopped';
        const port = probeListener(input.port);
        return { launcher, listener, port };
    };
    const initial = inspect();
    if (initial.launcher === 'unknown' ||
        initial.listener === 'unknown' ||
        initial.port.status === 'unknown') {
        return false;
    }
    if (initial.port.status === 'listening' &&
        (input.listener
            ? initial.port.pid !== input.listener.pid || initial.listener !== 'present'
            : initial.launcher !== 'present')) {
        return false;
    }
    if (initial.launcher === 'stopped' &&
        initial.listener === 'stopped' &&
        initial.port.status === 'absent') {
        return true;
    }
    try {
        signalTree({
            launcherPid: input.launcher.pid,
            listenerPid: input.listener?.pid ?? input.launcher.pid,
            launcherPresent: initial.launcher === 'present',
            signal: 'SIGTERM',
        });
    }
    catch {
        return false;
    }
    const deadline = Date.now() + 2_000;
    while (true) {
        const current = inspect();
        if (current.launcher === 'unknown' ||
            current.listener === 'unknown' ||
            current.port.status === 'unknown') {
            return false;
        }
        if (current.launcher === 'stopped' &&
            current.listener === 'stopped' &&
            current.port.status === 'absent') {
            return true;
        }
        if (current.port.status === 'listening' &&
            input.listener &&
            (current.port.pid !== input.listener.pid || current.listener !== 'present')) {
            return false;
        }
        if (Date.now() >= deadline)
            return false;
        await wait(25);
    }
}
export async function stopManagedMetro(binding, input, dependencies = {}) {
    if (binding?.mode !== 'managed' ||
        typeof binding.port !== 'number' ||
        typeof binding.pid !== 'number' ||
        typeof binding.birth !== 'string' ||
        typeof binding.launcherPid !== 'number' ||
        typeof binding.launcherBirth !== 'string' ||
        typeof binding.instanceId !== 'string' ||
        typeof binding.runtimeEvidencePath !== 'string' ||
        typeof binding.runtimeEvidenceSocket !== 'string' ||
        typeof binding.managementProof !== 'string') {
        return false;
    }
    const expected = managementProof(input.sessionId, {
        port: binding.port,
        pid: binding.pid,
        birth: binding.birth,
        launcherPid: binding.launcherPid,
        launcherBirth: binding.launcherBirth,
        instanceId: binding.instanceId,
        runtimeEvidencePath: binding.runtimeEvidencePath,
        runtimeEvidenceSocket: binding.runtimeEvidenceSocket,
    }, input.signerCapability);
    const expectedBuffer = Buffer.from(expected, 'hex');
    const observedBuffer = Buffer.from(binding.managementProof, 'hex');
    if (expectedBuffer.length !== observedBuffer.length ||
        !timingSafeEqual(expectedBuffer, observedBuffer)) {
        return false;
    }
    return stopManagedMetroProcesses({
        port: binding.port,
        launcher: { pid: binding.launcherPid, birth: binding.launcherBirth },
        listener: { pid: binding.pid, birth: binding.birth },
    }, dependencies);
}
