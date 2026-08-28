import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  captureMetroBinding,
  metroListenerPid,
  probeMetroListener,
  type MetroBinding,
  type MetroListenerExecutableDependencies,
  type MetroListenerProbe,
} from './metro-binding.js';
import {
  resolveTrustedSystemExecutable,
  type TrustedSystemExecutableDependencies,
} from '../util/trusted-system-executable.js';
import {
  probeProcessBirth,
  readProcessBirth,
  type ProcessBirth,
  type ProcessBirthProbe,
} from './process-birth.js';
import { canonicalAuthorityJson } from './authority-json.js';
import {
  prepareManagedMetroEnforcement,
  runManagedMetroEnforcementPreflight,
  type ManagedMetroEnforcement,
  type ManagedMetroEnforcementPlan,
  type ManagedMetroEnforcementReceipt,
} from './managed-metro-enforcement.js';

export type MetroRuntimeEvidenceAuthority = 'reported-v1' | 'managed-sandbox-v1';

export interface ManagedMetroBinding extends MetroBinding {
  mode: 'managed';
  launcherPid: number;
  launcherBirth: string;
  managementProof: string;
  runtimeEvidenceAuthority: MetroRuntimeEvidenceAuthority;
  runtimeEvidenceProtocol: 2;
  runtimeEvidencePath: string;
  runtimeEvidenceSocket: string;
}

interface ManagedMetroDependencies {
  environment?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  platform?: NodeJS.Platform;
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
  authorizeEvidenceSocketRemoval?: (path: string) => boolean;
  verifyRuntimeAdmission?: (
    path: string,
    capability: string,
    expected: ManagedMetroRuntimeAdmissionExpectation,
  ) => boolean;
  prepareEnforcement?: typeof prepareManagedMetroEnforcement;
  preflightEnforcement?: typeof runManagedMetroEnforcementPreflight;
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

interface ManagedMetroRuntimeAdmissionExpectation {
  sessionId: string;
  metroInstanceId: string;
  contentRoot: string;
  appRoot: string;
  runtimeManifest: Record<string, unknown>;
  enforcementReceipt: ManagedMetroEnforcementReceipt;
}

const METRO_LAUNCHER_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createHash, createHmac } = require('node:crypto');
const { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } = require('node:fs');
const { createServer } = require('node:net');
const { basename, dirname, isAbsolute, relative, sep } = require('node:path');
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
const launcherDiagnosticPath = process.env.RN_DEV_AGENT_METRO_LAUNCHER_DIAGNOSTIC;
function failLauncher(code, stage, detail) {
  const diagnostic = { version: 1, code, stage, detail };
  if (launcherDiagnosticPath) {
    try {
      writeFileSync(launcherDiagnosticPath, intrinsicJsonStringify(diagnostic), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {}
  }
  try {
    process.stderr.write(code + ': stage=' + stage + '; detail=' + detail + '\n');
  } catch {}
  process.exit(1);
}
const executable = process.env.RN_DEV_AGENT_METRO_EXECUTABLE;
let args;
try {
  args = JSON.parse(process.env.RN_DEV_AGENT_METRO_ARGS || '[]');
} catch {
  failLauncher('METRO_LAUNCHER_ENVIRONMENT_INVALID', 'environment', 'arguments-invalid');
}
const evidencePath = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE;
const evidenceSocket = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET;
const policyPath = process.env.RN_DEV_AGENT_METRO_RUNTIME_POLICY;
const capability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
const childNodeOptions = process.env.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS;
const contentRoot = process.env.RN_DEV_AGENT_METRO_CONTENT_ROOT;
const appRoot = process.env.RN_DEV_AGENT_METRO_APP_ROOT;
const childEnvironmentSource = process.env.RN_DEV_AGENT_METRO_CHILD_ENVIRONMENT;
const runtimeManifestSource = process.env.RN_DEV_AGENT_METRO_RUNTIME_MANIFEST;
const runtimeEnforcementSource = process.env.RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT;
const nativeAddonAcknowledgmentRoot = process.env.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT;
const requiredEnvironment = [
  [launcherDiagnosticPath, 'diagnostic-path-missing'],
  [executable, 'executable-missing'],
  [evidencePath, 'evidence-path-missing'],
  [evidenceSocket, 'evidence-socket-missing'],
  [policyPath, 'policy-path-missing'],
  [capability, 'policy-capability-missing'],
  [sessionId, 'session-id-missing'],
  [metroInstanceId, 'metro-instance-id-missing'],
  [childNodeOptions, 'child-node-options-missing'],
  [contentRoot, 'content-root-missing'],
  [appRoot, 'app-root-missing'],
  [childEnvironmentSource, 'child-environment-missing'],
  [runtimeManifestSource, 'runtime-manifest-missing'],
  [runtimeEnforcementSource, 'runtime-enforcement-missing'],
  [nativeAddonAcknowledgmentRoot, 'native-addon-ack-root-missing'],
];
const missingEnvironment = requiredEnvironment.find(([value]) => !value);
if (missingEnvironment) {
  failLauncher(
    'METRO_LAUNCHER_ENVIRONMENT_INVALID',
    'environment',
    missingEnvironment[1],
  );
}
const policyDirectoryPath = dirname(policyPath);
const policyName = basename(policyPath);
const launcherWorkingDirectory = process.cwd();
let policyDirectoryDescriptor;
let policyDescriptor;
let policyDirectoryIdentity;
let policyIdentity;
try {
  policyDirectoryDescriptor = openSync(
    policyDirectoryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  policyDirectoryIdentity = fstatSync(policyDirectoryDescriptor, { bigint: true });
  if (!policyDirectoryIdentity.isDirectory()) throw new Error('policy-directory-not-regular');
  process.chdir(policyDirectoryPath);
  const boundDirectory = statSync('.', { bigint: true });
  if (
    boundDirectory.dev !== policyDirectoryIdentity.dev ||
    boundDirectory.ino !== policyDirectoryIdentity.ino
  ) {
    throw new Error('policy-directory-identity-mismatch');
  }
  policyDescriptor = openSync(
    policyName,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  policyIdentity = fstatSync(policyDescriptor, { bigint: true });
  const publishedPolicy = lstatSync(policyPath, { bigint: true });
  if (
    !policyIdentity.isFile() ||
    policyIdentity.nlink !== 1n ||
    publishedPolicy.dev !== policyIdentity.dev ||
    publishedPolicy.ino !== policyIdentity.ino
  ) {
    throw new Error('policy-file-identity-mismatch');
  }
  fchmodSync(policyDescriptor, 0o600);
  process.chdir(launcherWorkingDirectory);
} catch (error) {
  try {
    process.chdir(launcherWorkingDirectory);
  } catch {}
  const detail =
    error instanceof Error && /^policy-[a-z-]+$/.test(error.message)
      ? error.message
      : 'policy-binding-failed';
  failLauncher(
    'METRO_LAUNCHER_POLICY_UNAVAILABLE',
    'policy-binding',
    detail,
  );
}
function assertPolicyIdentity() {
  const retainedDirectory = fstatSync(policyDirectoryDescriptor, { bigint: true });
  const retainedPolicy = fstatSync(policyDescriptor, { bigint: true });
  const publishedPolicy = lstatSync(policyPath, { bigint: true });
  if (
    !retainedDirectory.isDirectory() ||
    retainedDirectory.dev !== policyDirectoryIdentity.dev ||
    retainedDirectory.ino !== policyDirectoryIdentity.ino ||
    !retainedPolicy.isFile() ||
    retainedPolicy.nlink !== 1n ||
    retainedPolicy.dev !== policyIdentity.dev ||
    retainedPolicy.ino !== policyIdentity.ino ||
    publishedPolicy.dev !== policyIdentity.dev ||
    publishedPolicy.ino !== policyIdentity.ino
  ) {
    throw new Error('policy-publication-identity-mismatch');
  }
}
let runtimeManifest;
let runtimeEnforcement;
try {
  runtimeManifest = JSON.parse(runtimeManifestSource);
  runtimeEnforcement = JSON.parse(runtimeEnforcementSource);
} catch {
  failLauncher('METRO_LAUNCHER_ENVIRONMENT_INVALID', 'environment', 'manifest-invalid');
}
const logicalArgumentPrefix = 'rn-dev-agent-logical-path:';
const enforcementReceipt = runtimeEnforcement.receipt;
const snapshotAttestedFiles = (entries, arguments_, firstDescriptor) => {
  if (!Array.isArray(entries)) throw new Error('invalid command-chain attestation');
  const snapshots = [];
  const paths = new Map();
  const argumentPaths = new Set(
    arguments_.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : argument,
    ),
  );
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('invalid command-chain attestation');
    }
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(descriptor).size;
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, contents, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    closeSync(descriptor);
    const snapshot = contents.subarray(0, offset);
    if (createHash('sha256').update(snapshot).digest('hex') !== entry.sha256) {
      throw new Error('command-chain identity mismatch');
    }
    if (!argumentPaths.has(entry.path)) continue;
    paths.set(entry.path, '/dev/fd/' + (firstDescriptor + snapshots.length));
    snapshots.push(snapshot);
  }
  return { snapshots, paths };
};
const liveCodeIdentityMatches = (pid, identity) => {
  if (
    !Number.isSafeInteger(pid) ||
    !identity ||
    typeof identity.identifier !== 'string' ||
    typeof identity.cdHash !== 'string'
  ) {
    return false;
  }
  const verification = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '+' + pid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verification.status !== 0) return false;
  const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', '+' + pid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (details.status !== 0) return false;
  const fields = new Map(
    details.stderr
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
  return (
    fields.get('Identifier') === identity.identifier &&
    fields.get('CDHash') === identity.cdHash
  );
};
const waitForLiveCodeIdentity = (pid, identity) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (liveCodeIdentityMatches(pid, identity)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return false;
};
let child;
let commandChainSnapshot = null;
try {
  commandChainSnapshot = snapshotAttestedFiles(
    enforcementReceipt?.commandChainAttestation ?? [],
    args,
    10,
  );
} catch {
  commandChainSnapshot = null;
}
let managedSandbox =
  runtimeEnforcement.status === 'enforced' &&
  runtimeEnforcement.kind === 'darwin-seatbelt-v2' &&
  runtimeEnforcement.sandboxExecutable === '/usr/bin/sandbox-exec' &&
  typeof runtimeEnforcement.profile === 'string' &&
  /^[a-f0-9]{64}$/.test(runtimeEnforcement.profileSha256 || '') &&
  createHash('sha256').update(runtimeEnforcement.profile).digest('hex') ===
    runtimeEnforcement.profileSha256 &&
  enforcementReceipt?.version === 2 &&
  enforcementReceipt.kind === runtimeEnforcement.kind &&
  enforcementReceipt.profileSha256 === runtimeEnforcement.profileSha256 &&
  enforcementReceipt.sandboxExecutableSha256 ===
    runtimeEnforcement.sandboxExecutableSha256 &&
  enforcementReceipt.sandboxExecutableCdHash ===
    runtimeEnforcement.sandboxExecutableCdHash &&
  enforcementReceipt.commandLaunchSha256 === runtimeEnforcement.commandLaunchSha256 &&
  enforcementReceipt.resolvedCommandSha256 === runtimeEnforcement.resolvedCommandSha256 &&
  enforcementReceipt.descendantCreationAllowed === true &&
  enforcementReceipt.unauthorizedExecutableDenied === true &&
  enforcementReceipt.unmanifestedReadDenied === true &&
  enforcementReceipt.unmanifestedWriteDenied === true &&
  enforcementReceipt.symlinkEscapeDenied === true &&
  enforcementReceipt.unallocatedListenerDenied === true &&
  enforcementReceipt.allocatedListenerAllowed === true &&
  enforcementReceipt.networkOutboundDenied === true &&
  enforcementReceipt.resolvedCommandAllowed === true &&
  enforcementReceipt.commandCleanupConfirmed === true &&
  enforcementReceipt.commandChainStable === true &&
  commandChainSnapshot !== null &&
  canonicalAuthorityJson(enforcementReceipt.nodeRuntimeAttestation) ===
    canonicalAuthorityJson(runtimeEnforcement.nodeRuntimeAttestation) &&
  canonicalAuthorityJson(enforcementReceipt.commandChainAttestation) ===
    canonicalAuthorityJson(runtimeEnforcement.commandChainAttestation);
let runtimeEvidenceAuthority = managedSandbox ? 'managed-sandbox-v1' : 'reported-v1';
const evidenceDescriptor = 9;
let journalDescriptor;
try {
  journalDescriptor = openSync(evidencePath, 'w', 0o600);
} catch {
  failLauncher('METRO_LAUNCHER_EVIDENCE_UNAVAILABLE', 'evidence-journal', 'journal-open-failed');
}
let sequence = 0;
let previousSignature = null;
let buffered = '';
function appendEvidence(payload) {
  const chainedPayload = {
    ...payload,
    runtimeEvidenceAuthority,
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
const violations = [];
function publishPolicy() {
  const payload = {
    version: 1,
    runtimeEvidenceAuthority,
    sessionId,
    metroInstanceId,
    contentRoot,
    appRoot,
    runtimeEnforcement: managedSandbox ? 'os-enforced-v1' : 'unsupported',
    runtimeEnforcementReceipt: managedSandbox ? enforcementReceipt : null,
    runtimeManifest,
    runtimeInputs: runtimeManifest.runtimeInputs,
    violations: [...violations],
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(payload))
    .digest('hex');
  const publication = Buffer.from(
    canonicalAuthorityJson({ ...payload, signature }) + '\n',
    'utf8',
  );
  assertPolicyIdentity();
  ftruncateSync(policyDescriptor, 0);
  let offset = 0;
  while (offset < publication.length) {
    offset += writeSync(
      policyDescriptor,
      publication,
      offset,
      publication.length - offset,
      offset,
    );
  }
  fsyncSync(policyDescriptor);
  assertPolicyIdentity();
}
function appendViolation(value) {
  if (!violations.includes(value)) violations.push(value);
  publishPolicy();
  appendEvidence({
    version: 1,
    sessionId,
    metroInstanceId,
    kind: 'violation',
    value,
    digest: null,
  });
}
function publishNativeAddonAcknowledgment(requestId, acknowledgment) {
  writeFileSync(
    nativeAddonAcknowledgmentRoot + '/' + requestId + '.json',
    canonicalAuthorityJson({ version: 1, requestId, ...acknowledgment }),
    { encoding: 'utf8', flag: 'wx', mode: 0o400 },
  );
}
const pendingNativeAddons = new Map();
function digestNativeAddon(candidate) {
  const sourceDescriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(sourceDescriptor);
    if (!initial.isFile()) {
      const error = new Error('native addon is not a regular file');
      error.code = 'NATIVE_ADDON_NOT_REGULAR';
      throw error;
    }
    if (initial.size > 128 * 1024 * 1024) {
      const error = new Error('native addon exceeds the 128 MiB evidence limit');
      error.code = 'NATIVE_ADDON_TOO_LARGE';
      throw error;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < initial.size) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, initial.size - position),
        position,
      );
      if (bytesRead === 0 || position + bytesRead > 128 * 1024 * 1024) {
        const error = new Error('native addon changed while reading evidence');
        error.code = 'NATIVE_ADDON_CHANGED';
        throw error;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, position) !== 0) {
      const error = new Error('native addon changed while reading evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    const final = fstatSync(sourceDescriptor);
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      const error = new Error('native addon changed while reading evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    return hash.digest('hex');
  } finally {
    closeSync(sourceDescriptor);
  }
}
function runtimeInputWithinRoot(candidate, root) {
  const nested = relative(root, candidate);
  return nested === '' || (
    nested !== '..' &&
    !nested.startsWith('..' + sep) &&
    !isAbsolute(nested)
  );
}
function handleNativeAddonRequest(payload) {
  let request;
  try {
    request = JSON.parse(payload.value);
    if (
      !request ||
      !/^[a-f0-9]{32}$/.test(request.requestId || '') ||
      typeof request.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.digest || '')
    ) {
      throw new Error('invalid request');
    }
    const candidate = realpathSync(request.path);
    const allowedRoots = runtimeManifest.nativeAddonRoots;
    if (
      !Array.isArray(allowedRoots) ||
      !allowedRoots.some(
        (root) => typeof root === 'string' && runtimeInputWithinRoot(candidate, root),
      )
    ) {
      const error = new Error('outside:' + basename(request.path));
      error.code = 'NATIVE_ADDON_OUTSIDE_ROOTS';
      throw error;
    }
    const digest = digestNativeAddon(candidate);
    if (digest !== request.digest) {
      const error = new Error('native addon changed before signed evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    appendEvidence({
      version: 1,
      sessionId,
      metroInstanceId,
      kind: 'input',
      value: candidate,
      digest,
    });
    fsyncSync(journalDescriptor);
    pendingNativeAddons.set(request.requestId, { path: candidate, digest });
    publishNativeAddonAcknowledgment(request.requestId, {
      accepted: true,
      digest,
      path: candidate,
      reason: null,
    });
  } catch (error) {
    const reason =
      error?.code === 'NATIVE_ADDON_OUTSIDE_ROOTS'
        ? 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' + error.message
        : 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' +
          (error instanceof Error ? error.message : 'native addon bytes could not be verified');
    appendViolation(reason);
    if (request && /^[a-f0-9]{32}$/.test(request.requestId || '')) {
      try {
        publishNativeAddonAcknowledgment(request.requestId, {
          accepted: false,
          digest: typeof request.digest === 'string' ? request.digest : null,
          path: null,
          reason,
        });
      } catch {}
    }
  }
}
function handleNativeAddonCompletion(payload) {
  let completion;
  try {
    completion = JSON.parse(payload.value);
    if (
      !completion ||
      !/^[a-f0-9]{32}$/.test(completion.requestId || '') ||
      typeof completion.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(completion.digest || '') ||
      !['success', 'failure'].includes(completion.outcome)
    ) {
      throw new Error('completion record is invalid');
    }
    const pending = pendingNativeAddons.get(completion.requestId);
    if (
      !pending ||
      pending.path !== completion.path ||
      pending.digest !== completion.digest ||
      digestNativeAddon(pending.path) !== pending.digest
    ) {
      throw new Error('native addon changed during load');
    }
    pendingNativeAddons.delete(completion.requestId);
    rmSync(nativeAddonAcknowledgmentRoot + '/' + completion.requestId + '.json', {
      force: true,
    });
    if (completion.outcome === 'success') {
      appendEvidence({
        version: 1,
        sessionId,
        metroInstanceId,
        kind: 'stability',
        value: pending.path,
        digest: pending.digest,
      });
    } else {
      appendViolation('METRO_NATIVE_ADDON_LOAD_FAILED: ' + basename(pending.path));
    }
  } catch (error) {
    if (completion && /^[a-f0-9]{32}$/.test(completion.requestId || '')) {
      pendingNativeAddons.delete(completion.requestId);
      rmSync(nativeAddonAcknowledgmentRoot + '/' + completion.requestId + '.json', {
        force: true,
      });
    }
    appendViolation(
      'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' +
        (error instanceof Error ? error.message : 'native addon stability could not be verified'),
    );
  }
}
if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
const headConnections = new Set();
const pendingHeads = new Map();
function closeHeadConnection(connection) {
  headConnections.delete(connection);
  for (const [challenge, pending] of pendingHeads) {
    if (pending === connection) pendingHeads.delete(challenge);
  }
}
function respondWithHead(connection, challenge) {
  if (pendingNativeAddons.size > 0) {
    connection.destroy();
    return;
  }
  const payload = {
    version: 1,
    runtimeEvidenceAuthority,
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
headServer.once('error', () =>
  failLauncher(
    'METRO_LAUNCHER_EVIDENCE_UNAVAILABLE',
    'evidence-listener',
    'evidence-listener-error',
  ),
);
headServer.listen(evidenceSocket, () => {
  if (process.platform !== 'win32') chmodSync(evidenceSocket, 0o600);
});
const childEnvironment = JSON.parse(childEnvironmentSource);
const environmentDigest = createHash('sha256')
  .update(canonicalAuthorityJson(childEnvironment))
  .digest('hex');
if (environmentDigest !== runtimeManifest.environmentDigest) {
  failLauncher(
    'METRO_LAUNCHER_ENVIRONMENT_INVALID',
    'environment-digest',
    'child-environment-mismatch',
  );
}
if (runtimeEnforcement.status === 'enforced' && !managedSandbox) {
  failLauncher(
    'METRO_LAUNCHER_ENFORCEMENT_REFUSED',
    'enforcement',
    'sandbox-admission-invalid',
  );
}
const sandboxExecutable = runtimeEnforcement.sandboxExecutable;
const boundArgs = args.map((argument) =>
  argument.startsWith(logicalArgumentPrefix)
    ? argument.slice(logicalArgumentPrefix.length)
    : commandChainSnapshot?.paths.get(argument) ?? argument,
);
const sandboxArgs = managedSandbox
  ? ['-p', runtimeEnforcement.profile, executable, ...boundArgs]
  : boundArgs;
child = spawn(managedSandbox ? sandboxExecutable : executable, sandboxArgs, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: [
    'inherit',
    'inherit',
    'inherit',
    'ipc',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'pipe',
    'pipe',
    ...(commandChainSnapshot?.snapshots.map(() => 'pipe') ?? []),
  ],
});
if (!Number.isSafeInteger(child.pid)) {
  failLauncher(
    'METRO_LAUNCHER_CHILD_SPAWN_FAILED',
    'child-spawn',
    'child-pid-unavailable',
  );
}
for (let index = 0; index < (commandChainSnapshot?.snapshots.length ?? 0); index += 1) {
  child.stdio[10 + index].end(commandChainSnapshot.snapshots[index]);
}
if (
  managedSandbox &&
  !waitForLiveCodeIdentity(
    child.pid,
    enforcementReceipt.commandChainAttestation?.find(
      (entry) => entry.path === executable,
    )?.signingIdentity,
  )
) {
  managedSandbox = false;
  runtimeEvidenceAuthority = 'reported-v1';
  appendViolation('Metro command executable kernel identity did not match attestation');
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  failLauncher(
    'METRO_LAUNCHER_ENFORCEMENT_REFUSED',
    'child-admission',
    'command-identity-mismatch',
  );
}
child.stdio[8].end('admitted\n');
runtimeManifest.descendantAuthority.rootIdentity = 'process:' + child.pid;
appendEvidence({
  version: 1,
  sessionId,
  metroInstanceId,
  kind: 'semantics',
  value: canonicalAuthorityJson(runtimeManifest),
  digest: null,
});
publishPolicy();
const evidence = child.stdio[evidenceDescriptor];
let childOutcome = null;
let evidenceFinished = false;
let launcherFinished = false;
function finishLauncher() {
  if (launcherFinished || childOutcome === null || !evidenceFinished) return;
  launcherFinished = true;
  if (buffered) appendViolation('Metro runtime evidence record is incomplete');
  for (const requestId of pendingNativeAddons.keys()) {
    pendingNativeAddons.delete(requestId);
    rmSync(nativeAddonAcknowledgmentRoot + '/' + requestId + '.json', { force: true });
    appendViolation('METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: stability receipt is missing');
  }
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
          'native-addon-request',
          'native-addon-completion',
          'stability',
          'unattested-utility',
        ].includes(payload.kind) ||
        typeof payload.value !== 'string' ||
        (payload.kind === 'input' || payload.kind === 'stability'
          ? typeof payload.digest !== 'string'
          : payload.digest !== null)
      ) {
        throw new Error('invalid evidence');
      }
      if (payload.kind === 'native-addon-request') {
        handleNativeAddonRequest(payload);
        continue;
      }
      if (payload.kind === 'native-addon-completion') {
        handleNativeAddonCompletion(payload);
        continue;
      }
      if (payload.kind === 'barrier') {
        const connection = pendingHeads.get(payload.value);
        if (connection) {
          pendingHeads.delete(payload.value);
          respondWithHead(connection, payload.value);
        }
        continue;
      }
      if (payload.kind === 'violation') {
        appendViolation(payload.value);
        continue;
      }
      if (payload.kind === 'input') {
        let candidate;
        let digest;
        try {
          candidate = realpathSync(payload.value);
          digest = candidate.toLowerCase().endsWith('.node')
            ? digestNativeAddon(candidate)
            : createHash('sha256').update(readFileSync(candidate)).digest('hex');
        } catch {
          appendViolation('Metro runtime input could not be observed by the managed sandbox');
          continue;
        }
        const allowedRoots = [
          runtimeManifest.contentRoot,
          runtimeManifest.appRoot,
          ...runtimeManifest.runtimeInputs,
        ];
        const withinManifest = allowedRoots.some(
          (root) =>
            typeof root === 'string' && runtimeInputWithinRoot(candidate, root),
        );
        if (!withinManifest || digest !== payload.digest) {
          appendViolation('Metro runtime input is outside the managed sandbox manifest');
          continue;
        }
        appendEvidence({ ...payload, value: candidate });
        continue;
      }
      appendEvidence(payload);
    } catch {
      appendViolation('Metro runtime evidence record is invalid');
    }
  }
});
child.once('error', () =>
  failLauncher(
    'METRO_LAUNCHER_CHILD_SPAWN_FAILED',
    'child-spawn',
    'child-process-error',
  ),
);
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

export function managedMetroParentPid(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  execute: typeof execFileSync = execFileSync,
  executableDependencies: TrustedSystemExecutableDependencies = {},
): number | null {
  const executable = resolveTrustedSystemExecutable(
    platform === 'win32' ? 'powershell' : 'ps',
    platform,
    executableDependencies,
  );
  if (!executable) return null;
  try {
    const output =
      platform === 'win32'
        ? execute(
            executable,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
            ],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 },
          )
        : execute(executable, ['-p', String(pid), '-o', 'ppid='], {
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
    current = managedMetroParentPid(current);
  }
  return false;
}

export function managedMetroListenerPid(
  port: number,
  platform: NodeJS.Platform = process.platform,
  execute: typeof execFileSync = execFileSync,
  executableDependencies: MetroListenerExecutableDependencies = {},
): number | null {
  return metroListenerPid(port, platform, execute, executableDependencies);
}

export type ManagedMetroListenerProbe = MetroListenerProbe;

export function probeManagedMetroListener(
  port: number,
  platform: NodeJS.Platform = process.platform,
  execute: typeof execFileSync = execFileSync,
  executableDependencies: MetroListenerExecutableDependencies = {},
): ManagedMetroListenerProbe {
  return probeMetroListener(port, platform, execute, executableDependencies);
}

export function resolveManagedMetroCommand(
  appRoot: string,
  dependencies: Pick<ManagedMetroDependencies, 'exists' | 'platform' | 'readText'> = {},
): { executable: string; args: string[] } {
  const exists = dependencies.exists ?? existsSync;
  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const platform = dependencies.platform ?? process.platform;
  const packageJson = JSON.parse(readText(join(appRoot, 'package.json'))) as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const all = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (all.expo) {
    if (platform === 'win32') {
      return resolveWindowsPackageCommand(appRoot, 'expo', 'expo', ['start', '--dev-client'], {
        exists,
        readText,
      });
    }
    const executable = join(appRoot, 'node_modules', '.bin', 'expo');
    if (!exists(executable)) {
      throw new Error('METRO_START_UNAVAILABLE: package-local Expo CLI is unavailable');
    }
    return { executable, args: ['start', '--dev-client'] };
  }
  if (all['react-native']) {
    if (platform === 'win32') {
      return resolveWindowsPackageCommand(appRoot, 'react-native', 'react-native', ['start'], {
        exists,
        readText,
      });
    }
    const executable = join(appRoot, 'node_modules', '.bin', 'react-native');
    if (!exists(executable)) {
      throw new Error('METRO_START_UNAVAILABLE: package-local React Native CLI is unavailable');
    }
    return { executable, args: ['start'] };
  }
  throw new Error('METRO_START_UNAVAILABLE: project is neither Expo nor bare React Native');
}

function resolveWindowsPackageCommand(
  appRoot: string,
  packageName: string,
  commandName: string,
  args: string[],
  dependencies: Required<Pick<ManagedMetroDependencies, 'exists' | 'readText'>>,
): { executable: string; args: string[] } {
  const packageRoot = resolve(appRoot, 'node_modules', packageName);
  const manifest = JSON.parse(dependencies.readText(join(packageRoot, 'package.json'))) as {
    bin?: string | Record<string, unknown>;
  };
  const bin =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : typeof manifest.bin?.[commandName] === 'string'
        ? manifest.bin[commandName]
        : null;
  if (!bin) {
    throw new Error(`METRO_START_UNAVAILABLE: package-local ${commandName} CLI is unavailable`);
  }
  const executable = resolve(packageRoot, bin);
  const relativeExecutable = relative(packageRoot, executable);
  if (
    !relativeExecutable ||
    relativeExecutable === '..' ||
    relativeExecutable.startsWith('../') ||
    relativeExecutable.startsWith('..\\') ||
    isAbsolute(relativeExecutable) ||
    !dependencies.exists(executable)
  ) {
    throw new Error(`METRO_START_UNAVAILABLE: package-local ${commandName} CLI is unavailable`);
  }
  return { executable, args };
}

export interface ManagedMetroLaunchCommand {
  sourceExecutable: string;
  executable: string;
  nodeExecutable: string;
  args: string[];
  probeArgs: string[];
  executableMappings: string[];
  chainInputs: string[];
  protectedRuntimeRoots: string[];
  binPath?: string;
}

function resolveManagedMetroLaunchCommand(
  command: { executable: string; args: string[] },
  dependencies: Pick<ManagedMetroDependencies, 'exists' | 'platform' | 'readText'>,
): ManagedMetroLaunchCommand {
  const exists = dependencies.exists ?? existsSync;
  const readText = dependencies.readText ?? ((path: string) => readFileSync(path, 'utf8'));
  const platform = dependencies.platform ?? process.platform;
  let firstLine = '';
  try {
    firstLine = readText(command.executable).split(/\r?\n/, 1)[0] ?? '';
  } catch {
    return {
      sourceExecutable: command.executable,
      executable: command.executable,
      nodeExecutable: process.execPath,
      args: command.args,
      probeArgs: ['--version'],
      executableMappings: [],
      chainInputs: [command.executable],
      protectedRuntimeRoots: [],
    };
  }
  if (/^#!\s*\/usr\/bin\/env\s+node(?:\s|$)/.test(firstLine)) {
    return {
      sourceExecutable: command.executable,
      executable: process.execPath,
      nodeExecutable: process.execPath,
      args: [command.executable, ...command.args],
      probeArgs: [command.executable, '--version'],
      executableMappings: [],
      chainInputs: [command.executable, process.execPath],
      protectedRuntimeRoots: [],
    };
  }
  if (
    platform !== 'win32' &&
    /^#!\s*(?:\/bin\/sh|\/usr\/bin\/env\s+sh|\/bin\/bash)(?:\s|$)/.test(firstLine)
  ) {
    const shellSelector = exists('/private/var/select/sh') ? '/private/var/select/sh' : '/bin/sh';
    const shellExecutable = canonicalRuntimeInput(shellSelector);
    const shellHelpers = ['/usr/bin/dirname', '/usr/bin/sed', '/usr/bin/uname']
      .filter(exists)
      .map(canonicalRuntimeInput);
    return {
      sourceExecutable: command.executable,
      executable: shellExecutable,
      nodeExecutable: process.execPath,
      args: [
        '-c',
        'read -r rn_dev_agent_admission <&8; script=$1; shift; . "$script"',
        `rn-dev-agent-logical-path:${command.executable}`,
        command.executable,
        ...command.args,
      ],
      probeArgs: [
        '-c',
        'script=$1; shift; . "$script"',
        `rn-dev-agent-logical-path:${command.executable}`,
        command.executable,
        '--version',
      ],
      executableMappings: [process.execPath, ...shellHelpers],
      chainInputs: [command.executable, shellExecutable, process.execPath, ...shellHelpers],
      protectedRuntimeRoots: [],
    };
  }
  return {
    sourceExecutable: command.executable,
    executable: command.executable,
    nodeExecutable: process.execPath,
    args: command.args,
    probeArgs: ['--version'],
    executableMappings: [],
    chainInputs: [command.executable],
    protectedRuntimeRoots: [],
  };
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
    runtimeEvidenceProtocol: 2;
    servingRoot: string;
    buildGeneration: number;
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
        runtimeEvidenceProtocol: authority.runtimeEvidenceProtocol,
        servingRoot: authority.servingRoot,
        buildGeneration: authority.buildGeneration,
      }),
    )
    .digest('hex');
}

export function managedMetroChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) => value !== undefined && name !== 'CI' && !name.startsWith('RN_DEV_AGENT_'),
    ),
  );
}

function verifyManagedMetroRuntimeAdmission(
  path: string,
  capability: string,
  expected: ManagedMetroRuntimeAdmissionExpectation,
): boolean {
  try {
    const admission = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const signature = admission.signature;
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
    const payload = { ...admission };
    delete payload.signature;
    const computed = createHmac('sha256', capability)
      .update(canonicalAuthorityJson(payload))
      .digest('hex');
    const computedBytes = Buffer.from(computed, 'hex');
    const signatureBytes = Buffer.from(signature, 'hex');
    const observedManifest = structuredClone(payload.runtimeManifest) as Record<string, unknown>;
    const expectedManifest = structuredClone(expected.runtimeManifest);
    const observedDescendantAuthority = observedManifest.descendantAuthority as
      | Record<string, unknown>
      | undefined;
    const expectedDescendantAuthority = expectedManifest.descendantAuthority as
      | Record<string, unknown>
      | undefined;
    if (
      !observedDescendantAuthority ||
      !expectedDescendantAuthority ||
      typeof observedDescendantAuthority.rootIdentity !== 'string' ||
      !/^process:\d+$/.test(observedDescendantAuthority.rootIdentity)
    ) {
      return false;
    }
    delete observedDescendantAuthority.rootIdentity;
    delete expectedDescendantAuthority.rootIdentity;
    return (
      computedBytes.length === signatureBytes.length &&
      timingSafeEqual(computedBytes, signatureBytes) &&
      payload.runtimeEvidenceAuthority === 'managed-sandbox-v1' &&
      payload.runtimeEnforcement === 'os-enforced-v1' &&
      payload.sessionId === expected.sessionId &&
      payload.metroInstanceId === expected.metroInstanceId &&
      payload.contentRoot === expected.contentRoot &&
      payload.appRoot === expected.appRoot &&
      Array.isArray(payload.violations) &&
      payload.violations.length === 0 &&
      canonicalAuthorityJson(observedManifest) === canonicalAuthorityJson(expectedManifest) &&
      canonicalAuthorityJson(payload.runtimeEnforcementReceipt) ===
        canonicalAuthorityJson(expected.enforcementReceipt)
    );
  } catch {
    return false;
  }
}

export function verifyManagedMetroManagementProof(
  binding: Record<string, unknown>,
  input: { sessionId: string; signerCapability: string },
): binding is Record<string, unknown> & ManagedMetroBinding {
  if (
    binding.mode !== 'managed' ||
    typeof binding.port !== 'number' ||
    typeof binding.pid !== 'number' ||
    typeof binding.birth !== 'string' ||
    typeof binding.launcherPid !== 'number' ||
    typeof binding.launcherBirth !== 'string' ||
    typeof binding.instanceId !== 'string' ||
    typeof binding.runtimeEvidencePath !== 'string' ||
    typeof binding.runtimeEvidenceSocket !== 'string' ||
    typeof binding.servingRoot !== 'string' ||
    !Number.isSafeInteger(binding.buildGeneration) ||
    (binding.buildGeneration as number) < 0 ||
    (binding.runtimeEvidenceAuthority !== 'managed-sandbox-v1' &&
      binding.runtimeEvidenceAuthority !== 'reported-v1') ||
    binding.runtimeEvidenceProtocol !== 2 ||
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
      runtimeEvidencePath: binding.runtimeEvidencePath,
      runtimeEvidenceSocket: binding.runtimeEvidenceSocket,
      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
      runtimeEvidenceProtocol: binding.runtimeEvidenceProtocol,
      servingRoot: binding.servingRoot,
      buildGeneration: binding.buildGeneration as number,
    },
    input.signerCapability,
  );
  const expectedBuffer = Buffer.from(expected, 'hex');
  const observedBuffer = Buffer.from(binding.managementProof, 'hex');
  return (
    expectedBuffer.length === observedBuffer.length &&
    timingSafeEqual(expectedBuffer, observedBuffer)
  );
}

export type ManagedMetroLifecycleInspection =
  | { status: 'live' }
  | {
      status: 'lost';
      code:
        | 'METRO_MANAGEMENT_PROOF_INVALID'
        | 'METRO_LAUNCHER_EXITED'
        | 'METRO_LAUNCHER_IDENTITY_CHANGED'
        | 'METRO_LAUNCHER_UNVERIFIABLE'
        | 'METRO_LISTENER_EXITED'
        | 'METRO_LISTENER_IDENTITY_CHANGED'
        | 'METRO_LISTENER_UNVERIFIABLE'
        | 'METRO_PORT_RELEASED'
        | 'METRO_PORT_OWNER_CHANGED'
        | 'METRO_PORT_UNVERIFIABLE'
        | 'METRO_EVIDENCE_SOCKET_MISSING';
      reason: string;
      attribution?: string;
    };

export function managedMetroExitAttribution(
  binding: { runtimeEvidencePath: string; instanceId: string },
  input: { sessionId: string; signerCapability: string },
): string | null {
  const runtimeRoot = dirname(binding.runtimeEvidencePath);
  const runtimePolicyCapability = createHmac('sha256', input.signerCapability)
    .update('metro-runtime-policy')
    .digest('base64url');
  const violation = latestSignedRuntimeViolation(
    binding.runtimeEvidencePath,
    runtimePolicyCapability,
    { sessionId: input.sessionId, metroInstanceId: binding.instanceId },
  );
  const diagnostic = readManagedMetroLauncherDiagnostic(
    join(runtimeRoot, 'metro-launcher-diagnostic.json'),
  );
  const logCauses = managedMetroFirstPartyLogCauses(join(runtimeRoot, 'metro.log'));
  const redactions = [
    runtimeRoot,
    input.sessionId,
    binding.instanceId,
    input.signerCapability,
    runtimePolicyCapability,
  ];
  const details = [
    diagnostic
      ? sanitizeManagedMetroStartupDetailValue(`stage ${diagnostic.stage}`, redactions)
      : null,
    diagnostic?.detail
      ? sanitizeManagedMetroStartupDetailValue(diagnostic.detail, redactions)
      : null,
    violation
      ? sanitizeManagedMetroStartupDetailValue(`runtime violation: ${violation}`, redactions).slice(
          0,
          2_048,
        )
      : null,
  ].filter((detail): detail is string => Boolean(detail));
  if (logCauses) {
    const prefix = 'Metro log causes: ';
    const used = details.join('; ').length;
    const available = 4_096 - used - (used > 0 ? 2 : 0) - prefix.length;
    if (available > 0) details.push(`${prefix}${logCauses.slice(0, available)}`);
  }
  if (details.length === 0) return null;
  return details.join('; ');
}

function exactManagedProcessInspection(
  role: 'launcher' | 'listener',
  pid: number,
  birth: string,
  probe: ProcessBirthProbe,
): ManagedMetroLifecycleInspection | null {
  const prefix = role === 'launcher' ? 'METRO_LAUNCHER' : 'METRO_LISTENER';
  if (probe.status === 'absent') {
    return {
      status: 'lost',
      code: `${prefix}_EXITED`,
      reason: `authenticated managed Metro ${role} exited`,
    };
  }
  if (probe.status === 'unknown') {
    return {
      status: 'lost',
      code: `${prefix}_UNVERIFIABLE`,
      reason: `authenticated managed Metro ${role} process identity is unavailable`,
    };
  }
  if (probe.birth.pid !== pid || probe.birth.token !== birth) {
    return {
      status: 'lost',
      code: `${prefix}_IDENTITY_CHANGED`,
      reason: `authenticated managed Metro ${role} process identity changed`,
    };
  }
  return null;
}

export function inspectManagedMetroLifecycle(
  binding: Record<string, unknown>,
  input: { sessionId: string; signerCapability: string },
  dependencies: Pick<ManagedMetroDependencies, 'exists' | 'probeBirth' | 'probeListener'> = {},
): ManagedMetroLifecycleInspection {
  if (!verifyManagedMetroManagementProof(binding, input)) {
    return {
      status: 'lost',
      code: 'METRO_MANAGEMENT_PROOF_INVALID',
      reason: 'managed Metro lifecycle evidence is not authenticated by this session',
    };
  }
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const attributed = (inspection: ManagedMetroLifecycleInspection) => {
    if (inspection.status === 'live' || !inspection.code.endsWith('_EXITED')) return inspection;
    const attribution = managedMetroExitAttribution(binding, input);
    return attribution ? { ...inspection, attribution } : inspection;
  };
  const launcher = exactManagedProcessInspection(
    'launcher',
    binding.launcherPid,
    binding.launcherBirth,
    probeBirth(binding.launcherPid),
  );
  if (launcher) return attributed(launcher);
  const listener = exactManagedProcessInspection(
    'listener',
    binding.pid,
    binding.birth,
    probeBirth(binding.pid),
  );
  if (listener) return attributed(listener);
  const port = (dependencies.probeListener ?? probeManagedMetroListener)(binding.port);
  if (port.status === 'absent') {
    return {
      status: 'lost',
      code: 'METRO_PORT_RELEASED',
      reason: 'authenticated managed Metro no longer owns its allocated listener port',
    };
  }
  if (port.status === 'unknown') {
    return {
      status: 'lost',
      code: 'METRO_PORT_UNVERIFIABLE',
      reason: 'managed Metro listener port ownership is unavailable',
    };
  }
  if (port.pid !== binding.pid) {
    return {
      status: 'lost',
      code: 'METRO_PORT_OWNER_CHANGED',
      reason: 'allocated managed Metro port is owned by a different process',
    };
  }
  if (!(dependencies.exists ?? existsSync)(binding.runtimeEvidenceSocket)) {
    return {
      status: 'lost',
      code: 'METRO_EVIDENCE_SOCKET_MISSING',
      reason: 'managed Metro runtime evidence socket is missing',
    };
  }
  return { status: 'live' };
}

export function refreshManagedMetroBuildGeneration(
  binding: ManagedMetroBinding,
  input: { sessionId: string; buildGeneration: number; signerCapability: string },
): ManagedMetroBinding {
  if (
    !Number.isSafeInteger(input.buildGeneration) ||
    input.buildGeneration < binding.buildGeneration ||
    !verifyManagedMetroManagementProof(binding as unknown as Record<string, unknown>, input)
  ) {
    throw new Error(
      'METRO_AUTHORITY_MISMATCH: managed Metro build generation cannot rotate from unverified authority',
    );
  }
  const refreshed = { ...binding, buildGeneration: input.buildGeneration };
  return {
    ...refreshed,
    managementProof: managementProof(input.sessionId, refreshed, input.signerCapability),
  };
}

function legacyManagementProof(
  sessionId: string,
  authority: Omit<
    Parameters<typeof managementProof>[1],
    'runtimeEvidenceAuthority' | 'runtimeEvidenceProtocol' | 'servingRoot' | 'buildGeneration'
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

function managedSandboxManagementProofV1(
  sessionId: string,
  authority: Omit<Parameters<typeof managementProof>[1], 'servingRoot' | 'buildGeneration'>,
  signerCapability: string,
): string {
  return createHmac('sha256', signerCapability)
    .update(
      canonicalAuthorityJson({
        sessionId,
        ...authority,
      }),
    )
    .digest('hex');
}

function dependencyRoots(
  appRoot: string,
  sourceRoot: string,
  exists: (path: string) => boolean,
): string[] {
  const roots = new Set<string>();
  for (const start of [resolve(appRoot), resolve(sourceRoot)]) {
    let current = start;
    while (true) {
      const candidate = join(current, 'node_modules');
      if (exists(candidate)) roots.add(candidate);
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  for (const candidate of [
    join(sourceRoot, '.yarn', 'cache'),
    join(sourceRoot, '.yarn', 'unplugged'),
    join(sourceRoot, '.pnpm'),
  ]) {
    if (exists(candidate)) roots.add(resolve(candidate));
  }
  return [...roots].sort();
}

function canonicalRuntimeInput(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function latestSignedRuntimeViolation(
  path: string,
  capability: string,
  expected: { sessionId: string; metroInstanceId: string },
): string | null {
  try {
    const bytes = readFileSync(path);
    if (bytes.byteLength > 2 * 1024 * 1024) return null;
    let previousSignature: string | null = null;
    let sequence = 0;
    let latest: string | null = null;
    for (const line of bytes.toString('utf8').split('\n').filter(Boolean)) {
      const observed = JSON.parse(line) as Record<string, unknown>;
      const signature = observed.signature;
      if (typeof signature !== 'string') return null;
      const { signature: _signature, ...payload } = observed;
      const expectedSignature = createHmac('sha256', capability)
        .update(canonicalAuthorityJson(payload))
        .digest('hex');
      const actualBytes = Buffer.from(signature, 'hex');
      const expectedBytes = Buffer.from(expectedSignature, 'hex');
      if (
        actualBytes.length !== expectedBytes.length ||
        !timingSafeEqual(actualBytes, expectedBytes) ||
        payload.sessionId !== expected.sessionId ||
        payload.metroInstanceId !== expected.metroInstanceId ||
        payload.sequence !== sequence + 1 ||
        payload.previousSignature !== previousSignature
      ) {
        return null;
      }
      sequence += 1;
      previousSignature = signature;
      if (payload.kind === 'violation' && typeof payload.value === 'string') {
        latest = payload.value;
      }
    }
    return latest;
  } catch {
    return null;
  }
}

function boundedMetroLogTail(path: string, maxBytes = 4_096): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, 'r');
    const size = fstatSync(descriptor).size;
    const length = Math.min(size, maxBytes);
    if (length === 0) return null;
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    const tail = buffer
      .toString('utf8')
      .replace(/[^\t\n\r\x20-\x7e]/g, '?')
      .trim();
    return tail || null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface ManagedMetroLauncherDiagnostic {
  version: 1;
  code: string;
  stage: string;
  detail: string;
}

const MANAGED_METRO_SENSITIVE_ENVIRONMENT_NAME =
  /(?:access[_-]?key|token|secret|password|passwd|pwd|credential|api[_-]?key|authorization|auth|cookie|private[_-]?key)/i;

function readManagedMetroLauncherDiagnostic(path: string): ManagedMetroLauncherDiagnostic | null {
  try {
    const source = readFileSync(path, 'utf8');
    if (Buffer.byteLength(source) > 4_096) return null;
    const diagnostic = JSON.parse(source) as Record<string, unknown>;
    if (
      diagnostic.version !== 1 ||
      typeof diagnostic.code !== 'string' ||
      !/^METRO_LAUNCHER_[A-Z0-9_]+$/.test(diagnostic.code) ||
      typeof diagnostic.stage !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(diagnostic.stage) ||
      typeof diagnostic.detail !== 'string' ||
      !/^[a-z0-9-]{1,96}$/.test(diagnostic.detail)
    ) {
      return null;
    }
    return diagnostic as unknown as ManagedMetroLauncherDiagnostic;
  } catch {
    return null;
  }
}

// NOTE: exit attribution runs in a later process than the start, so it has no credentialRedactions
// to sanitize metro.log with; it publishes only fixed-vocabulary tokens that cannot carry a secret.
const MANAGED_METRO_FIRST_PARTY_LOG_CAUSE =
  /\bRN_DEV_AGENT_[A-Z0-9_]+\b|\bNode\.js v\d+\.\d+\.\d+\b|\bJavaScript heap out of memory\b|\b(?:EADDRINUSE|EADDRNOTAVAIL|EACCES|EMFILE|ENFILE|ENOMEM|ENOSPC|EPIPE)\b/g;

function managedMetroFirstPartyLogCauses(path: string): string | null {
  // Wider window than the startup reader: only matched tokens are published, so a fatal that
  // bundle chatter has scrolled past stays attributable.
  const tail = boundedMetroLogTail(path, 65_536);
  if (!tail) return null;
  const causes = [...new Set(tail.match(MANAGED_METRO_FIRST_PARTY_LOG_CAUSE) ?? [])].slice(0, 16);
  return causes.length > 0 ? causes.join(', ') : null;
}

function sanitizeManagedMetroStartupDetailValue(
  value: string,
  redactions: readonly string[],
): string {
  let sanitized = value.replace(/[^\t\n\r\x20-\x7e]/g, '?');
  for (const redaction of [...redactions].sort((left, right) => right.length - left.length)) {
    if (redaction) sanitized = sanitized.replaceAll(redaction, '<redacted>');
  }
  return sanitized
    .replace(/\b(?:Basic|Bearer)\s+\S+/gi, '<redacted-authorization>')
    .replace(
      /(\b[A-Za-z_][A-Za-z0-9_.-]*(?:access[-_]?key|token|secret|password|passwd|pwd|credential|api[-_]?key|authorization|auth|cookie|private[-_]?key)[A-Za-z0-9_.-]*\b["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi,
      '$1<redacted>',
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1<redacted>@')
    .replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, '<path>')
    .replace(/(?:\/[A-Za-z0-9._@%+~=-]+){2,}/g, '<path>')
    .trim();
}

function sanitizeManagedMetroStartupDetail(value: string, redactions: readonly string[]): string {
  return sanitizeManagedMetroStartupDetailValue(value, redactions).slice(-4_096);
}

function boundedManagedMetroStartupMessage(
  code: string,
  details: readonly (string | null | undefined)[],
): string {
  const compactDetails = details.filter((detail): detail is string => Boolean(detail));
  const suffix = compactDetails.length > 0 ? ` (${compactDetails.join('; ')})` : '';
  return `${code}: managed Metro launcher failed before runtime evidence${suffix}`.slice(0, 4_096);
}

function managedMetroStartupError(input: {
  runtimeEvidencePath: string;
  runtimePolicyCapability: string;
  launcherDiagnosticPath: string;
  logPath: string;
  appRoot: string;
  sourceRoot: string;
  runtimeRoot: string;
  sessionId: string;
  metroInstanceId: string;
  signerCapability: string;
  credentialRedactions: readonly string[];
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  lastError: unknown;
}): Error {
  const violation = latestSignedRuntimeViolation(
    input.runtimeEvidencePath,
    input.runtimePolicyCapability,
    {
      sessionId: input.sessionId,
      metroInstanceId: input.metroInstanceId,
    },
  );
  const childOutcome =
    input.exitCode !== null
      ? `launcher exit ${input.exitCode}`
      : input.signalCode
        ? `launcher signal ${input.signalCode}`
        : null;
  const launcherDiagnostic = readManagedMetroLauncherDiagnostic(input.launcherDiagnosticPath);
  const redactions = [
    input.appRoot,
    input.sourceRoot,
    input.runtimeRoot,
    input.sessionId,
    input.metroInstanceId,
    input.signerCapability,
    input.runtimePolicyCapability,
    ...input.credentialRedactions,
  ];
  const lastError =
    input.lastError instanceof Error
      ? sanitizeManagedMetroStartupDetail(input.lastError.message, redactions)
      : null;
  const logTailSource = boundedMetroLogTail(input.logPath);
  const logTail = logTailSource
    ? sanitizeManagedMetroStartupDetail(logTailSource, redactions)
    : null;
  const details = [
    launcherDiagnostic ? `stage ${launcherDiagnostic.stage}` : null,
    childOutcome,
    launcherDiagnostic?.detail,
    lastError,
    logTail ? `Metro log tail:\n${logTail}` : null,
  ].filter((detail): detail is string => Boolean(detail));
  if (launcherDiagnostic) {
    return new Error(boundedManagedMetroStartupMessage(launcherDiagnostic.code, details));
  }
  if (violation && /^[A-Z][A-Z0-9_]+:/.test(violation)) {
    return new Error(
      `${sanitizeManagedMetroStartupDetail(violation, redactions)}${
        details.length > 0 ? `; ${details.join('; ')}` : ''
      }`.slice(0, 4_096),
    );
  }
  let runtimeEvidenceInitialized = false;
  let runtimeEvidenceDescriptor: number | null = null;
  try {
    runtimeEvidenceDescriptor = openSync(input.runtimeEvidencePath, 'r');
    runtimeEvidenceInitialized = fstatSync(runtimeEvidenceDescriptor).size > 0;
  } catch {
  } finally {
    if (runtimeEvidenceDescriptor !== null) closeSync(runtimeEvidenceDescriptor);
  }
  if (!runtimeEvidenceInitialized) {
    return new Error(
      boundedManagedMetroStartupMessage('METRO_LAUNCHER_PRE_EVIDENCE_FAILED', [
        'stage node-startup',
        ...details,
      ]),
    );
  }
  return new Error(
    `METRO_START_UNAVAILABLE: allocated Metro did not become authoritative${
      details.length > 0 ? ` (${details.join('; ')})` : ''
    }`.slice(0, 4_096),
  );
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
  const resolvedLaunchCommand = resolveManagedMetroLaunchCommand(command, dependencies);
  const launchCommand = resolvedLaunchCommand;
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
  const launcherDiagnosticPath = join(input.runtimeRoot, 'metro-launcher-diagnostic.json');
  const nativeAddonAcknowledgmentRoot = join(input.runtimeRoot, 'native-addon-acknowledgments');
  const runtimePolicyPath = join(
    input.appRoot,
    '.rn-agent',
    'integration',
    'metro-runtime-policy.json',
  );
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
  const exists = dependencies.exists ?? existsSync;
  const resolvedDependencyRoots = dependencyRoots(input.appRoot, input.sourceRoot, exists).map(
    canonicalRuntimeInput,
  );
  const allowedCodeRoots = [
    canonicalRuntimeInput(input.sourceRoot),
    canonicalRuntimeInput(input.appRoot),
    ...resolvedDependencyRoots,
  ].filter((value, index, entries) => entries.indexOf(value) === index);
  const authorityRootNonce = createHmac('sha256', input.signerCapability)
    .update(`metro-descendant-root\0${instanceId}`)
    .digest('hex')
    .slice(0, 32);
  const metroArgs = [...launchCommand.args, '--port', String(input.port)];
  const metroHome = join(input.runtimeRoot, 'metro-home');
  const metroTemporaryRoot = join(input.runtimeRoot, 'metro-tmp');
  const metroCacheRoot = join(input.runtimeRoot, 'metro-cache');
  for (const path of [
    metroHome,
    metroTemporaryRoot,
    metroCacheRoot,
    join(input.appRoot, '.expo'),
    nativeAddonAcknowledgmentRoot,
  ]) {
    if (!exists(path)) mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  const metroEnvironment = managedMetroChildEnvironment({
    ...(dependencies.environment ?? process.env),
    HOME: metroHome,
    TMPDIR: metroTemporaryRoot,
    TMP: metroTemporaryRoot,
    TEMP: metroTemporaryRoot,
    XDG_CACHE_HOME: metroCacheRoot,
    EXPO_OFFLINE: '1',
    EXPO_UNSTABLE_HEADLESS: '1',
    RCT_METRO_PORT: String(input.port),
  });
  const childEnvironment = {
    ...metroEnvironment,
    ...(launchCommand.binPath
      ? {
          PATH: [launchCommand.binPath, metroEnvironment.PATH].filter(Boolean).join(':'),
        }
      : {}),
    NODE_OPTIONS: authorityNodeOptions,
    RN_DEV_AGENT_METRO_EVIDENCE_FD: '9',
    RN_DEV_AGENT_SESSION_ID: input.sessionId,
    RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
    RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD: authorityPreload,
    RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS: baseNodeOptions,
    RN_DEV_AGENT_METRO_CONTENT_ROOT: canonicalRuntimeInput(input.sourceRoot),
    RN_DEV_AGENT_METRO_APP_ROOT: canonicalRuntimeInput(input.appRoot),
    RN_DEV_AGENT_METRO_ALLOWED_CODE_ROOTS: canonicalAuthorityJson(allowedCodeRoots),
    RN_DEV_AGENT_METRO_AUTHORITY_ROOT_NONCE: authorityRootNonce,
    RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT: nativeAddonAcknowledgmentRoot,
  };
  const packageInputs = [canonicalRuntimeInput(join(input.appRoot, 'package.json'))];
  const metroConfigInputs = ['metro.config.js', 'metro.config.cjs']
    .map((name) => join(input.appRoot, name))
    .filter(exists)
    .map(canonicalRuntimeInput);
  const runtimeInputs = [
    canonicalRuntimeInput(launchCommand.sourceExecutable),
    canonicalRuntimeInput(authorityPreload),
    ...packageInputs,
    ...metroConfigInputs,
    ...resolvedDependencyRoots,
  ].filter((value, index, entries) => entries.indexOf(value) === index);
  const commandChainInputs = [...launchCommand.chainInputs, authorityPreload].filter(
    (value, index, entries) => entries.indexOf(value) === index,
  );
  const runtimeManifest = {
    version: 1,
    executable: canonicalRuntimeInput(launchCommand.executable),
    sourceExecutable: canonicalRuntimeInput(launchCommand.sourceExecutable),
    commandProbeArguments: launchCommand.probeArgs,
    commandExecutableMappings: launchCommand.executableMappings.map(canonicalRuntimeInput),
    commandChainInputs: commandChainInputs.map(canonicalRuntimeInput),
    protectedRuntimeRoots: [...launchCommand.protectedRuntimeRoots, nativeAddonAcknowledgmentRoot]
      .map(canonicalRuntimeInput)
      .filter((value, index, entries) => entries.indexOf(value) === index),
    nativeAddonRoots: allowedCodeRoots,
    nodeExecutable: canonicalRuntimeInput(launchCommand.nodeExecutable),
    nodeVersion: process.version,
    port: input.port,
    args: metroArgs,
    nodeOptions: authorityNodeOptions,
    environmentDigest: createHash('sha256')
      .update(canonicalAuthorityJson(childEnvironment))
      .digest('hex'),
    contentRoot: resolve(input.sourceRoot),
    appRoot: resolve(input.appRoot),
    servingRoot: resolve(input.sourceRoot),
    buildGeneration: input.buildGeneration,
    packageInputs,
    metroConfigInputs,
    dependencyRoots: resolvedDependencyRoots,
    runtimeInputs,
    descendantAuthority: {
      version: 1,
      rootNonce: authorityRootNonce,
      allowedCodeRoots,
    },
  };
  const prepareEnforcement = dependencies.prepareEnforcement ?? prepareManagedMetroEnforcement;
  const preflightEnforcement =
    dependencies.preflightEnforcement ?? runManagedMetroEnforcementPreflight;
  const preparedEnforcement = prepareEnforcement({
    platform: process.platform,
    appRoot: input.appRoot,
    sourceRoot: input.sourceRoot,
    runtimeRoot: input.runtimeRoot,
    nodeExecutable: launchCommand.nodeExecutable,
    nodeVersion: process.version,
    commandExecutable: launchCommand.executable,
    commandArguments: metroArgs,
    commandProbeArguments: launchCommand.probeArgs,
    baseNodeOptions,
    commandExecutableMappings: launchCommand.executableMappings,
    commandChainInputs,
    protectedRuntimeRoots: runtimeManifest.protectedRuntimeRoots,
    nativeAddonRoots: allowedCodeRoots,
    port: input.port,
    instanceId,
    runtimeInputs,
  });
  let runtimeEnforcement:
    | ManagedMetroEnforcement
    | (ManagedMetroEnforcementPlan & { receipt: ManagedMetroEnforcementReceipt }) =
    preparedEnforcement;
  if (preparedEnforcement.status === 'enforced') {
    try {
      runtimeEnforcement = {
        ...preparedEnforcement,
        receipt: preflightEnforcement(preparedEnforcement, { environment: childEnvironment }),
      };
    } catch {
      runtimeEnforcement = {
        status: 'unsupported',
        reason: 'sandbox-preflight-failed',
      };
    }
  }
  const runtimeEvidenceAuthority: MetroRuntimeEvidenceAuthority =
    runtimeEnforcement.status === 'enforced' ? 'managed-sandbox-v1' : 'reported-v1';
  const requiresSandboxAdmission = runtimeEnforcement.status === 'enforced';
  const enforcementReceiptForAdmission =
    runtimeEnforcement.status === 'enforced' && 'receipt' in runtimeEnforcement
      ? runtimeEnforcement.receipt
      : null;
  const logPath = join(input.runtimeRoot, 'metro.log');
  rmSync(launcherDiagnosticPath, { force: true });
  const log = openSync(logPath, 'a', 0o600);
  const child = (dependencies.spawnProcess ?? spawn)(
    launchCommand.nodeExecutable,
    ['-e', METRO_LAUNCHER_SOURCE],
    {
      cwd: input.appRoot,
      env: {
        ...metroEnvironment,
        RN_DEV_AGENT_METRO_EXECUTABLE: launchCommand.executable,
        RN_DEV_AGENT_METRO_ARGS: JSON.stringify(metroArgs),
        RN_DEV_AGENT_SESSION_ID: input.sessionId,
        RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
        RN_DEV_AGENT_METRO_POLICY_CAPABILITY: runtimePolicyCapability,
        RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD: authorityPreload,
        RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS: baseNodeOptions,
        RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE: runtimeEvidencePath,
        RN_DEV_AGENT_METRO_LAUNCHER_DIAGNOSTIC: launcherDiagnosticPath,
        RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET: runtimeEvidenceSocket,
        RN_DEV_AGENT_METRO_RUNTIME_POLICY: runtimePolicyPath,
        RN_DEV_AGENT_METRO_CONTENT_ROOT: input.sourceRoot,
        RN_DEV_AGENT_METRO_APP_ROOT: input.appRoot,
        RN_DEV_AGENT_METRO_CHILD_ENVIRONMENT: JSON.stringify(childEnvironment),
        RN_DEV_AGENT_METRO_RUNTIME_MANIFEST: canonicalAuthorityJson(runtimeManifest),
        RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT: canonicalAuthorityJson(runtimeEnforcement),
        RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS: authorityNodeOptions,
        RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT: nativeAddonAcknowledgmentRoot,
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
        if (
          requiresSandboxAdmission &&
          (!enforcementReceiptForAdmission ||
            !(dependencies.verifyRuntimeAdmission ?? verifyManagedMetroRuntimeAdmission)(
              runtimePolicyPath,
              runtimePolicyCapability,
              {
                sessionId: input.sessionId,
                metroInstanceId: instanceId,
                contentRoot: resolve(input.sourceRoot),
                appRoot: resolve(input.appRoot),
                runtimeManifest,
                enforcementReceipt: enforcementReceiptForAdmission,
              },
            ))
        ) {
          throw new Error(
            'METRO_RUNTIME_ADMISSION_UNAVAILABLE: launcher did not admit managed sandbox',
          );
        }
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
          runtimeEvidenceAuthority,
          runtimeEvidenceProtocol: 2,
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
  throw managedMetroStartupError({
    runtimeEvidencePath,
    runtimePolicyCapability,
    launcherDiagnosticPath,
    logPath,
    appRoot: input.appRoot,
    sourceRoot: input.sourceRoot,
    runtimeRoot: input.runtimeRoot,
    sessionId: input.sessionId,
    metroInstanceId: instanceId,
    signerCapability: input.signerCapability,
    credentialRedactions: Object.entries(childEnvironment)
      .filter(
        ([name, value]) =>
          value !== undefined &&
          (MANAGED_METRO_SENSITIVE_ENVIRONMENT_NAME.test(name) ||
            /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(value)),
      )
      .map(([, value]) => value as string),
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    lastError,
  });
}

export function signalManagedMetroProcessTree(
  input: ManagedMetroSignal,
  platform: NodeJS.Platform = process.platform,
  execute: typeof execFileSync = execFileSync,
  executableDependencies: TrustedSystemExecutableDependencies = {},
): void {
  if (platform === 'win32') {
    const executable = resolveTrustedSystemExecutable('taskkill', platform, executableDependencies);
    if (!executable) throw new Error('METRO_CLEANUP_EXECUTABLE_UNAVAILABLE');
    const pid = input.launcherPresent ? input.launcherPid : input.listenerPid;
    execute(executable, ['/PID', String(pid), '/T'], {
      stdio: 'ignore',
      timeout: 2_000,
    });
    return;
  }
  process.kill(-input.launcherPid, input.signal);
}

const signalProcessTree = signalManagedMetroProcessTree;
const MANAGED_METRO_STOP_TIMEOUT_MS = 5_000;

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
  if (
    (process.platform === 'win32' && !/^\\\\\.\\pipe\\rn-dev-agent-[a-f0-9]{32}$/.test(path)) ||
    (process.platform !== 'win32' && !/^\/tmp\/rn-dev-agent-[a-f0-9]{32}\.sock$/.test(path))
  ) {
    return false;
  }
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

export type ManagedMetroCleanupPresence = 'absent' | 'present' | 'unknown' | 'not-applicable';

export interface ManagedMetroCleanupEvidence {
  complete: boolean;
  launcher: ManagedMetroCleanupPresence;
  listener: ManagedMetroCleanupPresence;
  port: ManagedMetroListenerProbe;
  evidenceSocket: ManagedMetroCleanupPresence;
}

export interface ManagedMetroCleanupResult {
  authenticated: boolean;
  stopped: boolean;
  evidence: ManagedMetroCleanupEvidence;
}

function cleanupProcessPresence(
  pid: unknown,
  birth: unknown,
  probeBirth: (pid: number) => ProcessBirthProbe,
): ManagedMetroCleanupPresence {
  if (typeof pid !== 'number' || typeof birth !== 'string') return 'unknown';
  const state = exactProcessState({ pid, birth }, probeBirth(pid));
  return state === 'stopped' ? 'absent' : state;
}

function cleanupSocketPresence(
  path: unknown,
  exists: (path: string) => boolean,
): ManagedMetroCleanupPresence {
  if (typeof path !== 'string') return 'unknown';
  try {
    return exists(path) ? 'present' : 'absent';
  } catch {
    return 'unknown';
  }
}

export function inspectManagedMetroCleanupEvidence(
  binding: Record<string, unknown>,
  dependencies: Pick<ManagedMetroDependencies, 'exists' | 'probeBirth' | 'probeListener'> = {},
): ManagedMetroCleanupEvidence {
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
  const managed = binding.mode === 'managed';
  const launcher = managed
    ? cleanupProcessPresence(binding.launcherPid, binding.launcherBirth, probeBirth)
    : 'not-applicable';
  const listener = cleanupProcessPresence(binding.pid, binding.birth, probeBirth);
  let port: ManagedMetroListenerProbe = { status: 'unknown' };
  if (typeof binding.port === 'number') {
    try {
      port = probeListener(binding.port);
    } catch {}
  }
  const evidenceSocket = managed
    ? cleanupSocketPresence(binding.runtimeEvidenceSocket, dependencies.exists ?? existsSync)
    : 'not-applicable';
  const complete =
    launcher !== 'present' &&
    launcher !== 'unknown' &&
    listener === 'absent' &&
    port.status === 'absent' &&
    evidenceSocket !== 'present' &&
    evidenceSocket !== 'unknown';
  return { complete, launcher, listener, port, evidenceSocket };
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
  const deadline = Date.now() + MANAGED_METRO_STOP_TIMEOUT_MS;
  while (true) {
    const current = inspect();
    const uncertain =
      current.launcher === 'unknown' ||
      current.listener === 'unknown' ||
      current.port.status === 'unknown';
    if (!uncertain) {
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
      binding.runtimeEvidenceAuthority !== 'managed-sandbox-v1') ||
    (binding.runtimeEvidenceAuthority === 'managed-sandbox-v1' &&
      binding.runtimeEvidenceProtocol !== 2) ||
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
  const observedBuffer = Buffer.from(binding.managementProof, 'hex');
  const expectedProofs =
    binding.runtimeEvidenceAuthority === undefined
      ? [legacyManagementProof(input.sessionId, legacyAuthority, input.signerCapability)]
      : binding.runtimeEvidenceAuthority === 'reported-v1'
        ? [
            createHmac('sha256', input.signerCapability)
              .update(
                canonicalAuthorityJson({
                  sessionId: input.sessionId,
                  ...legacyAuthority,
                  runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
                }),
              )
              .digest('hex'),
            ...(binding.runtimeEvidenceProtocol === 2 &&
            typeof binding.servingRoot === 'string' &&
            Number.isSafeInteger(binding.buildGeneration) &&
            (binding.buildGeneration as number) >= 0
              ? [
                  managementProof(
                    input.sessionId,
                    {
                      ...legacyAuthority,
                      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
                      runtimeEvidenceProtocol: 2,
                      servingRoot: binding.servingRoot,
                      buildGeneration: binding.buildGeneration as number,
                    },
                    input.signerCapability,
                  ),
                ]
              : []),
          ]
        : [
            managedSandboxManagementProofV1(
              input.sessionId,
              {
                ...legacyAuthority,
                runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
                runtimeEvidenceProtocol: 2,
              },
              input.signerCapability,
            ),
            ...(typeof binding.servingRoot === 'string' &&
            Number.isSafeInteger(binding.buildGeneration) &&
            (binding.buildGeneration as number) >= 0
              ? [
                  managementProof(
                    input.sessionId,
                    {
                      ...legacyAuthority,
                      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
                      runtimeEvidenceProtocol: 2,
                      servingRoot: binding.servingRoot,
                      buildGeneration: binding.buildGeneration as number,
                    },
                    input.signerCapability,
                  ),
                ]
              : []),
          ];
  if (
    !expectedProofs.some((expected) => {
      const expectedBuffer = Buffer.from(expected, 'hex');
      return (
        expectedBuffer.length === observedBuffer.length &&
        timingSafeEqual(expectedBuffer, observedBuffer)
      );
    })
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

export async function stopManagedMetroWithEvidence(
  binding: Partial<ManagedMetroBinding> | null | undefined,
  input: { sessionId: string; signerCapability: string },
  dependencies: Pick<
    ManagedMetroDependencies,
    | 'authorizeEvidenceSocketRemoval'
    | 'exists'
    | 'probeBirth'
    | 'probeListener'
    | 'removeEvidenceSocket'
    | 'signalTree'
    | 'wait'
  > = {},
): Promise<ManagedMetroCleanupResult> {
  const proofAuthenticated =
    binding !== null &&
    binding !== undefined &&
    verifyManagedMetroManagementProof(binding as Record<string, unknown>, input);
  const stopped = await stopManagedMetro(binding, input, dependencies);
  const authenticated = proofAuthenticated || stopped;
  let evidence = inspectManagedMetroCleanupEvidence(
    (binding ?? {}) as Record<string, unknown>,
    dependencies,
  );
  let recoveryAuthorized = false;
  if (!authenticated && typeof binding?.runtimeEvidenceSocket === 'string') {
    try {
      recoveryAuthorized =
        dependencies.authorizeEvidenceSocketRemoval?.(binding.runtimeEvidenceSocket) === true;
    } catch {}
  }
  if (
    (authenticated || recoveryAuthorized) &&
    evidence.launcher === 'absent' &&
    evidence.listener === 'absent' &&
    evidence.port.status === 'absent' &&
    evidence.evidenceSocket === 'present' &&
    typeof binding?.runtimeEvidenceSocket === 'string'
  ) {
    removeManagedMetroEvidenceSocketSafely(binding.runtimeEvidenceSocket, dependencies);
    evidence = inspectManagedMetroCleanupEvidence(binding as Record<string, unknown>, dependencies);
  }
  return {
    authenticated,
    stopped: stopped && evidence.complete,
    evidence,
  };
}
