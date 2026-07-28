import { createBuildLaunchPlan } from './build-adapter.js';
import { hasNodeLoaderOption, hasUnsupportedNodeOption, parseNodeOptions, } from './managed-metro.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertBoundDirectoryCurrent, casBoundDirectoryFiles, closeBoundDirectories, openBoundDirectory, openBoundSubdirectory, openOptionalBoundSubdirectory, readBoundDirectoryFiles, } from './bound-directory.js';
const ADAPTER = '.rn-agent/integration/rn-session-adapter.cjs';
const METRO_ADAPTER = '.rn-agent/integration/rn-session-metro.cjs';
const AUTHORITY_MODULE = '.rn-agent/integration/authority-marker.js';
const METRO_RUNTIME_POLICY = '.rn-agent/integration/metro-runtime-policy.json';
const METRO_RUNTIME_LOADS = '.rn-agent/integration/metro-runtime-loads.jsonl';
const METRO_START = '// rn-dev-agent session integration: begin';
const METRO_END = '// rn-dev-agent session integration: end';
const SENTINELS = {
    ios: `node ${ADAPTER} ios`,
    android: `node ${ADAPTER} android`,
};
export function renderMetroIntegrationAdapter() {
    return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const childProcess = require('node:child_process');
const { execFileSync } = childProcess;
const diagnosticsChannel = require('node:diagnostics_channel');
const moduleApi = require('node:module');
const { registerHooks } = moduleApi;
const { fileURLToPath } = require('node:url');
const { deserialize, serialize } = require('node:v8');
const workerThreads = require('node:worker_threads');
const IntrinsicObject = Object;
const IntrinsicMap = Map;
const IntrinsicProxy = Proxy;
const IntrinsicSet = Set;
const IntrinsicWeakMap = WeakMap;
const IntrinsicWeakSet = WeakSet;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicJsonStringify = JSON.stringify;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicObjectPrototype = Object.prototype;
const intrinsicArrayFilter = Array.prototype.filter;
const intrinsicArrayForEach = Array.prototype.forEach;
const intrinsicArrayMap = Array.prototype.map;
const intrinsicArrayPush = Array.prototype.push;
const intrinsicArraySlice = Array.prototype.slice;
const intrinsicArraySort = Array.prototype.sort;
const intrinsicDefineProperty = Object.defineProperty;
const intrinsicObjectEntries = Object.entries;
const intrinsicObjectFromEntries = Object.fromEntries;
const intrinsicObjectValues = Object.values;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicGetOwnPropertySymbols = Object.getOwnPropertySymbols;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicMapDelete = Map.prototype.delete;
const intrinsicMapForEach = Map.prototype.forEach;
const intrinsicMapGet = Map.prototype.get;
const intrinsicMapHas = Map.prototype.has;
const intrinsicMapSet = Map.prototype.set;
const intrinsicReflectApply = Reflect.apply;
const intrinsicReflectConstruct = Reflect.construct;
const intrinsicReflectGet = Reflect.get;
const intrinsicReflectSet = Reflect.set;
const intrinsicSetAdd = Set.prototype.add;
const intrinsicSetForEach = Set.prototype.forEach;
const intrinsicSetHas = Set.prototype.has;
const intrinsicSymbolToString = Symbol.prototype.toString;
const intrinsicWeakMapDelete = WeakMap.prototype.delete;
const intrinsicWeakMapGet = WeakMap.prototype.get;
const intrinsicWeakMapHas = WeakMap.prototype.has;
const intrinsicWeakMapSet = WeakMap.prototype.set;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetDelete = WeakSet.prototype.delete;
const intrinsicWeakSetHas = WeakSet.prototype.has;
const intrinsicProcessNextTick = process.nextTick;
const intrinsicProcessBinding = process.binding;
const intrinsicUvBinding = intrinsicReflectApply(intrinsicProcessBinding, process, ['uv']);
function isAsynchronousNativeSpawnError(result) {
  return (
    result === intrinsicUvBinding.UV_EACCES ||
    result === intrinsicUvBinding.UV_EAGAIN ||
    result === intrinsicUvBinding.UV_EMFILE ||
    result === intrinsicUvBinding.UV_ENFILE ||
    result === intrinsicUvBinding.UV_ENOENT
  );
}
function privateMapDelete(map, key) {
  return intrinsicReflectApply(intrinsicMapDelete, map, [key]);
}
function privateMapForEach(map, callback) {
  return intrinsicReflectApply(intrinsicMapForEach, map, [callback]);
}
function privateMapGet(map, key) {
  return intrinsicReflectApply(intrinsicMapGet, map, [key]);
}
function privateMapHas(map, key) {
  return intrinsicReflectApply(intrinsicMapHas, map, [key]);
}
function privateMapSet(map, key, value) {
  return intrinsicReflectApply(intrinsicMapSet, map, [key, value]);
}
function privateArrayForEach(array, callback) {
  return intrinsicReflectApply(intrinsicArrayForEach, array, [callback]);
}
function privateArrayFilter(array, callback) {
  return intrinsicReflectApply(intrinsicArrayFilter, array, [callback]);
}
function privateArrayMap(array, callback) {
  return intrinsicReflectApply(intrinsicArrayMap, array, [callback]);
}
function privateArrayPush(array, ...values) {
  return intrinsicReflectApply(intrinsicArrayPush, array, values);
}
function privateArraySlice(array, start, end) {
  return intrinsicReflectApply(
    intrinsicArraySlice,
    array,
    end === undefined ? [start] : [start, end],
  );
}
function privateArraySort(array, compare) {
  return intrinsicReflectApply(
    intrinsicArraySort,
    array,
    compare === undefined ? [] : [compare],
  );
}
function privateGetOwnPropertyDescriptor(value, property) {
  return intrinsicReflectApply(intrinsicGetOwnPropertyDescriptor, IntrinsicObject, [
    value,
    property,
  ]);
}
function privateGetOwnPropertyNames(value) {
  return intrinsicReflectApply(intrinsicGetOwnPropertyNames, IntrinsicObject, [value]);
}
function privateGetOwnPropertySymbols(value) {
  return intrinsicReflectApply(intrinsicGetOwnPropertySymbols, IntrinsicObject, [value]);
}
function privateGetPrototypeOf(value) {
  return intrinsicReflectApply(intrinsicGetPrototypeOf, IntrinsicObject, [value]);
}
function privateObjectEntries(value) {
  return intrinsicReflectApply(intrinsicObjectEntries, IntrinsicObject, [value]);
}
function privateObjectFromEntries(entries) {
  return intrinsicReflectApply(intrinsicObjectFromEntries, IntrinsicObject, [entries]);
}
function privateObjectValues(value) {
  return intrinsicReflectApply(intrinsicObjectValues, IntrinsicObject, [value]);
}
function privateSetAdd(set, value) {
  return intrinsicReflectApply(intrinsicSetAdd, set, [value]);
}
function privateSetForEach(set, callback) {
  return intrinsicReflectApply(intrinsicSetForEach, set, [callback]);
}
function privateSetHas(set, value) {
  return intrinsicReflectApply(intrinsicSetHas, set, [value]);
}
function privateSetValues(set) {
  const values = [];
  privateSetForEach(set, (value) => privateArrayPush(values, value));
  return values;
}
function privateWeakMapDelete(map, key) {
  return intrinsicReflectApply(intrinsicWeakMapDelete, map, [key]);
}
function privateWeakMapGet(map, key) {
  return intrinsicReflectApply(intrinsicWeakMapGet, map, [key]);
}
function privateWeakMapHas(map, key) {
  return intrinsicReflectApply(intrinsicWeakMapHas, map, [key]);
}
function privateWeakMapSet(map, key, value) {
  return intrinsicReflectApply(intrinsicWeakMapSet, map, [key, value]);
}
function privateWeakSetAdd(set, value) {
  return intrinsicReflectApply(intrinsicWeakSetAdd, set, [value]);
}
function privateWeakSetDelete(set, value) {
  return intrinsicReflectApply(intrinsicWeakSetDelete, set, [value]);
}
function privateWeakSetHas(set, value) {
  return intrinsicReflectApply(intrinsicWeakSetHas, set, [value]);
}
function canonicalAuthorityJson(value) {
  const active = new IntrinsicWeakSet();
  const encode = (candidate) => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') {
      return intrinsicReflectApply(intrinsicJsonStringify, null, [candidate]);
    }
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate === 'number') {
      return intrinsicNumberIsFinite(candidate)
        ? intrinsicReflectApply(intrinsicJsonStringify, null, [candidate])
        : 'null';
    }
    if (typeof candidate !== 'object') throw descendantError();
    if (privateWeakSetHas(active, candidate)) throw descendantError();
    privateWeakSetAdd(active, candidate);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized = '[';
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) serialized += ',';
          const descriptor = privateGetOwnPropertyDescriptor(candidate, String(index));
          if (!descriptor || !('value' in descriptor)) throw descendantError();
          serialized += encode(descriptor.value);
        }
        return serialized + ']';
      }
      const prototype = privateGetPrototypeOf(candidate);
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw descendantError();
      }
      const names = privateGetOwnPropertyNames(candidate);
      const enumerable = [];
      for (let index = 0; index < names.length; index += 1) {
        const name = names[index];
        const descriptor = privateGetOwnPropertyDescriptor(candidate, name);
        if (descriptor?.enumerable) privateArrayPush(enumerable, name);
      }
      privateArraySort(enumerable);
      let serialized = '{';
      for (let index = 0; index < enumerable.length; index += 1) {
        if (index > 0) serialized += ',';
        const name = enumerable[index];
        const descriptor = privateGetOwnPropertyDescriptor(candidate, name);
        if (!descriptor || !('value' in descriptor)) throw descendantError();
        serialized +=
          intrinsicReflectApply(intrinsicJsonStringify, null, [name]) +
          ':' +
          encode(descriptor.value);
      }
      return serialized + '}';
    } finally {
      privateWeakSetDelete(active, candidate);
    }
  };
  return encode(value);
}
${parseNodeOptions.toString()}
${hasNodeLoaderOption.toString()}
${hasUnsupportedNodeOption.toString()}
const accumulatedRuntimeInputs = new IntrinsicSet();
const accumulatedViolations = new IntrinsicSet();
const observedLoaderDigests = new IntrinsicMap();
const metroPolicyCapability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const usesExternalEvidenceOwner = Boolean(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD);
const authorityEnvironment = privateArrayFilter(privateObjectEntries(process.env),
  ([key]) =>
    (key === 'NODE_OPTIONS' || key.startsWith('RN_DEV_AGENT_')) &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_NONCE' &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_SEMANTICS' &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_PARENT_IDENTITY' &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_PARENT_NONCE' &&
    (!usesExternalEvidenceOwner ||
      (key !== 'RN_DEV_AGENT_METRO_POLICY_CAPABILITY' &&
        key !== 'RN_DEV_AGENT_METRO_RUNTIME_LOADS')),
);
let cachedSourceRoot;
let sourceRootResolved = false;
let lastPolicyPayload;
let initialCacheCaptured = false;
let loaderEpoch = 0;
let runtimeLoadsDescriptor;
let runtimeLoadsDescriptorOwned = false;
const authoritySessionId = process.env.RN_DEV_AGENT_SESSION_ID;
const authorityMetroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
const authorityContentRoot =
  process.env.RN_DEV_AGENT_METRO_CONTENT_ROOT || fs.realpathSync(process.cwd());
const authorityAppRoot =
  process.env.RN_DEV_AGENT_METRO_APP_ROOT || fs.realpathSync(process.cwd());
const authorityRootNonce =
  process.env.RN_DEV_AGENT_METRO_AUTHORITY_ROOT_NONCE ||
  createHash('sha256')
    .update('reported-v1:' + authoritySessionId + ':' + authorityMetroInstanceId)
    .digest('hex')
    .slice(0, 32);
const allowedCodeRootsSource = process.env.RN_DEV_AGENT_METRO_ALLOWED_CODE_ROOTS;
let allowedCodeRoots = [];
if (allowedCodeRootsSource) {
  try {
    const parsed = JSON.parse(allowedCodeRootsSource);
    if (!Array.isArray(parsed) || parsed.length === 0) throw descendantError();
    allowedCodeRoots = privateArraySort(
      privateArrayMap(parsed, (entry) => {
        if (typeof entry !== 'string') throw descendantError();
        return fs.realpathSync(entry);
      }),
    );
  } catch {
    throw descendantError();
  }
}
function isWithinAllowedCodeRoot(candidate) {
  return allowedCodeRoots.length === 0 || allowedCodeRoots.some((root) => {
    const relative = path.relative(root, candidate);
    return relative === '' || (
      relative !== '..' &&
      !relative.startsWith('..' + path.sep) &&
      !path.isAbsolute(relative)
    );
  });
}
function sanitizedNativeAddonBasename(candidate) {
  const value = typeof candidate === 'string' ? candidate : '';
  return path.basename(value || 'unknown.node');
}
function sanitizedNativeAddonPath(candidate) {
  return 'outside:' + sanitizedNativeAddonBasename(candidate);
}
function writeRuntimeLoad(line, loadsPath) {
  if (runtimeLoadsDescriptor === undefined) {
    runtimeLoadsDescriptor =
      typeof loadsPath === 'number' ? loadsPath : fs.openSync(loadsPath, 'a', 0o600);
    runtimeLoadsDescriptorOwned = typeof loadsPath !== 'number';
  }
  const bytes = Buffer.from(line);
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(runtimeLoadsDescriptor, bytes, offset, bytes.length - offset);
  }
}
process.once('exit', () => {
  if (runtimeLoadsDescriptorOwned && runtimeLoadsDescriptor !== undefined) {
    fs.closeSync(runtimeLoadsDescriptor);
  }
});
function persistLoaderObservation(kind, value, digest = null) {
  const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
  const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
  const evidenceDescriptor = Number(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD);
  const loadsPath = process.env.RN_DEV_AGENT_METRO_RUNTIME_LOADS;
  if (!sessionId || !metroInstanceId) return;
  const payload = {
    version: 1,
    runtimeEvidenceAuthority: 'reported-v1',
    sessionId,
    metroInstanceId,
    kind,
    value,
    digest,
  };
  if (Number.isInteger(evidenceDescriptor) && evidenceDescriptor >= 3) {
    writeRuntimeLoad(canonicalAuthorityJson(payload) + '\\n', evidenceDescriptor);
    return;
  }
  if (!metroPolicyCapability || !loadsPath) return;
  const serializedPayload = canonicalAuthorityJson(payload);
  const receipt = {
    ...payload,
    signature: createHmac('sha256', metroPolicyCapability)
      .update(serializedPayload)
      .digest('hex'),
  };
  writeRuntimeLoad(canonicalAuthorityJson(receipt) + '\\n', loadsPath);
}
const effectiveBaseNodeOptions = parseNodeOptions(
  process.env.RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS || '',
);
persistLoaderObservation(
  'semantics',
  canonicalAuthorityJson({ mode: 'metro', nodeOptions: effectiveBaseNodeOptions }),
);
function recordLoaderViolation(value) {
  if (privateSetHas(accumulatedViolations, value)) return;
  privateSetAdd(accumulatedViolations, value);
  loaderEpoch += 1;
  persistLoaderObservation('violation', value);
}
const nativeChannelContexts = new IntrinsicWeakMap();
const nativeProcessContexts = new IntrinsicWeakMap();
const nativeProcessHandles = new IntrinsicWeakSet();
const fencedNativeHandlePrototypes = new IntrinsicWeakSet();
const nativeChannelControlNames = new IntrinsicSet([
  'close',
  'hasRef',
  'readStart',
  'readStop',
  'ref',
  'setBlocking',
  'unref',
]);
const nativeProcessControlNames = new IntrinsicSet(['close', 'hasRef', 'ref', 'unref']);
const descendantNonce = process.env.RN_DEV_AGENT_METRO_DESCENDANT_NONCE;
const descendantParentIdentity =
  process.env.RN_DEV_AGENT_METRO_DESCENDANT_PARENT_IDENTITY;
const descendantParentNonce =
  process.env.RN_DEV_AGENT_METRO_DESCENDANT_PARENT_NONCE;
const currentIdentity = workerThreads.isMainThread
  ? 'process:' + process.pid
  : 'worker:' + workerThreads.threadId;
const currentAuthorityNonce = descendantNonce || authorityRootNonce;
function descendantExecutionRecord(nonce, identity, semantics, parentIdentity, parentNonce) {
  return canonicalAuthorityJson({
    version: 1,
    nonce,
    identity,
    parent: {
      identity: parentIdentity,
      nonce: parentNonce,
    },
    semantics,
    authority: {
      sessionId: authoritySessionId,
      metroInstanceId: authorityMetroInstanceId,
      contentRoot: authorityContentRoot,
      appRoot: authorityAppRoot,
    },
  });
}
const descendantMessageContext = descendantNonce
  ? {
      mode: workerThreads.isMainThread ? 'fork-message' : 'worker-message',
      recipient: 'parent:' + descendantNonce,
      sequence: 0,
      sendDepth: 0,
      nativeWriteDepth: 0,
      nativeControlDepth: 0,
      nativeControlContext: lifecycleContext(
        'native-channel',
        'parent:' + descendantNonce,
      ),
    }
  : undefined;
if (descendantNonce) {
  const descendantSemantics = process.env.RN_DEV_AGENT_METRO_DESCENDANT_SEMANTICS;
  const semanticsAvailable = /^[a-f0-9]{64}$/.test(descendantSemantics || '');
  const parentIdentityAvailable = /^(?:process|worker):\\d+$/.test(
    descendantParentIdentity || '',
  );
  const parentNonceAvailable = /^[a-f0-9]{32}$/.test(descendantParentNonce || '');
  const parentAvailable = parentIdentityAvailable && parentNonceAvailable;
  if (semanticsAvailable && parentAvailable) {
    persistLoaderObservation(
      'attestation',
      descendantExecutionRecord(
        descendantNonce,
        currentIdentity,
        descendantSemantics,
        descendantParentIdentity,
        descendantParentNonce,
      ),
    );
  } else if (!semanticsAvailable) {
    recordLoaderViolation('Metro descendant execution semantics are unavailable');
  } else if (!parentIdentityAvailable) {
    recordLoaderViolation('Metro descendant parent identity is unavailable');
  } else {
    recordLoaderViolation('Metro descendant parent nonce is unavailable');
  }
  if (workerThreads.isMainThread) {
    const descendantLifecycleContext = lifecycleContext(
      'descendant-lifecycle',
      descendantNonce,
    );
    const processDisconnectImplementation =
      typeof process.disconnect === 'function' ? process.disconnect : undefined;
    if (processDisconnectImplementation) {
      const processDisconnectDelegate = process._disconnect;
      const processHandleQueue = process._handleQueue;
      const processChannel = requireNativeChannelHandle(process);
      const processChannelHandleSymbol = processChannel.symbol;
      const processChannelHandle = processChannel.handle;
      const processChannelClose = processChannelHandle?.close;
      if (
        typeof processDisconnectDelegate !== 'function' ||
        processHandleQueue ||
        typeof processChannelClose !== 'function'
      ) {
        throw descendantError();
      }
      const authenticatedChannelClose = () =>
        authenticatedLifecycleResult(
          descendantLifecycleContext,
          'channel-close',
          undefined,
          () =>
            withNativeChannelControl(descendantMessageContext, () =>
              intrinsicReflectApply(processChannelClose, processChannelHandle, []),
            ),
        );
      Object.defineProperty(processChannelHandle, 'close', {
        configurable: false,
        enumerable: false,
        value: authenticatedChannelClose,
        writable: false,
      });
      Object.defineProperty(process, '_disconnect', {
        configurable: false,
        enumerable: false,
        value() {
          if (descendantLifecycleContext.disconnectDepth > 0) {
            return withNativeChannelControl(descendantMessageContext, () =>
              intrinsicReflectApply(processDisconnectDelegate, process, []),
            );
          }
          return authenticatedLifecycleResult(
            descendantLifecycleContext,
            'disconnect',
            undefined,
            () => {
              descendantLifecycleContext.disconnectDepth += 1;
              try {
                process.connected = false;
                return withNativeChannelControl(descendantMessageContext, () =>
                  intrinsicReflectApply(processDisconnectDelegate, process, []),
                );
              } finally {
                descendantLifecycleContext.disconnectDepth -= 1;
              }
            },
          );
        },
        writable: false,
      });
      Object.defineProperty(process, '_handleQueue', {
        configurable: false,
        enumerable: false,
        value: processHandleQueue,
        writable: false,
      });
      Object.defineProperty(process, 'disconnect', {
        configurable: false,
        enumerable: true,
        value() {
          return authenticatedLifecycleResult(
            descendantLifecycleContext,
            'disconnect',
            undefined,
            () => {
              descendantLifecycleContext.disconnectDepth += 1;
              try {
                return intrinsicReflectApply(
                  processDisconnectImplementation,
                  process,
                  [],
                );
              } finally {
                descendantLifecycleContext.disconnectDepth -= 1;
              }
            },
          );
        },
        writable: false,
      });
      fenceNativeChannel(
        processChannelHandle,
        descendantMessageContext,
        new IntrinsicSet(['close']),
      );
      process[processChannelHandleSymbol] = nativeHandleFacade(
        processChannelHandle,
        'onread',
      );
    } else {
      Object.defineProperty(process, 'disconnect', {
        configurable: false,
        enumerable: true,
        value: undefined,
        writable: false,
      });
    }
    if (typeof process._send === 'function') {
      const processSendPrimitive = process._send;
      Object.defineProperty(process, '_send', {
        configurable: false,
        enumerable: false,
        value(message, sendHandle, options, callback) {
          return authenticatedIpcSend(
            processSendPrimitive,
            process,
            descendantMessageContext,
            message,
            sendHandle,
            options,
            callback,
            true,
          );
        },
        writable: false,
      });
    }
  }
  delete process.env.RN_DEV_AGENT_METRO_DESCENDANT_NONCE;
  delete process.env.RN_DEV_AGENT_METRO_DESCENDANT_SEMANTICS;
  delete process.env.RN_DEV_AGENT_METRO_DESCENDANT_PARENT_IDENTITY;
  delete process.env.RN_DEV_AGENT_METRO_DESCENDANT_PARENT_NONCE;
}
if (workerThreads.isMainThread && typeof process.send === 'function') {
  process.on('message', (message) => {
    if (
      message?.type === 'rn-dev-agent:evidence-barrier' &&
      typeof message.challenge === 'string' &&
      /^[a-f0-9]{64}$/.test(message.challenge)
    ) {
      persistLoaderObservation('barrier', message.challenge);
    }
  });
  process.channel?.unref();
}
if (metroPolicyCapability) delete process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
function normalizedInvocationEnvironment(environment) {
  const entries = [];
  privateArrayForEach(privateObjectEntries(environment || process.env), ([key, value]) => {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'NODE_OPTIONS' || normalizedKey.startsWith('RN_DEV_AGENT_')) return;
    privateArrayPush(entries, [key, value]);
  });
  return privateArraySort(entries, ([left], [right]) => left.localeCompare(right));
}
function authenticatedChildEnvironment(entries, nonce, semantics) {
  const nextEnvironment = privateObjectFromEntries(entries);
  privateArrayForEach(authorityEnvironment, ([key, value]) => {
    nextEnvironment[key] = value;
  });
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_NONCE = nonce;
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_SEMANTICS = semantics;
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_PARENT_IDENTITY = currentIdentity;
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_PARENT_NONCE = currentAuthorityNonce;
  return nextEnvironment;
}
function snapshotInvocation(value) {
  let bytes;
  try {
    bytes = serialize(value);
  } catch {
    throw descendantError();
  }
  if (bytes.byteLength > 1024 * 1024) throw descendantError();
  const cloned = deserialize(bytes);
  const pending = [cloned];
  const seen = new IntrinsicWeakSet();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate instanceof SharedArrayBuffer) throw descendantError();
    if (!candidate || typeof candidate !== 'object' || privateWeakSetHas(seen, candidate)) {
      continue;
    }
    privateWeakSetAdd(seen, candidate);
    if (candidate instanceof IntrinsicMap) {
      privateMapForEach(candidate, (entry, key) =>
        privateArrayPush(pending, key, entry)
      );
      continue;
    }
    if (candidate instanceof IntrinsicSet) {
      privateSetForEach(candidate, (entry) => privateArrayPush(pending, entry));
      continue;
    }
    privateArrayPush(pending, ...privateObjectValues(candidate));
  }
  return {
    digest: createHash('sha256').update(bytes).digest('hex'),
    value: cloned,
  };
}
function digestInvocation(value) {
  return snapshotInvocation(value).digest;
}
const childMessageContexts = new IntrinsicWeakMap();
const childSendImplementations = new IntrinsicWeakMap();
const childSendPrimitiveImplementations = new IntrinsicWeakMap();
const childDisconnectImplementations = new IntrinsicWeakMap();
const childLifecycleContexts = new IntrinsicWeakMap();
const childLifecycleTargets = new IntrinsicWeakMap();
const childNativeProcessHandles = new IntrinsicWeakMap();
const nativeProcessHandleSlots = new IntrinsicWeakMap();
const workerMessageContexts = new IntrinsicWeakMap();
const workerLifecycleContexts = new IntrinsicWeakMap();
const portMessageContexts = new IntrinsicWeakMap();
const processLifecycleTargets = new IntrinsicMap();
const authorizedChildSpawns = new IntrinsicWeakMap();
const authorizedNativeProcessSpawns = new IntrinsicWeakMap();
const fencedNativeProcessPrototypes = new IntrinsicWeakSet();
let activeChildSpawnAuthorization;
function authenticatedMessage(context, value) {
  const snapshot = snapshotInvocation(value);
  context.sequence += 1;
  persistLoaderObservation(
    'semantics',
    canonicalAuthorityJson({
      mode: context.mode,
      recipient: context.recipient,
      sequence: context.sequence,
      invocationDigest: snapshot.digest,
    }),
  );
  return snapshot.value;
}
function authenticatedPostMessage(original, receiver, context, message, transferList) {
  if (!context || context.blocked) throw descendantError();
  if (transferList !== undefined) {
    if (!Array.isArray(transferList) || transferList.length > 0) throw descendantError();
  }
  return intrinsicReflectApply(original, receiver, [
    authenticatedMessage(context, message),
  ]);
}
function authenticatedIpcSend(
  original,
  receiver,
  context,
  message,
  sendHandle,
  options,
  callback,
  primitive = false,
) {
  if (!context) throw descendantError();
  if (context.sendDepth > 0) {
    if (!primitive) throw descendantError();
    context.nativeWriteDepth += 1;
    try {
      return intrinsicReflectApply(original, receiver, [
        message,
        sendHandle,
        options,
        callback,
      ]);
    } finally {
      context.nativeWriteDepth -= 1;
    }
  }
  let nextCallback = callback;
  let nextOptions = options;
  if (typeof sendHandle === 'function') {
    nextCallback = sendHandle;
    sendHandle = undefined;
    nextOptions = undefined;
  } else if (typeof options === 'function') {
    nextCallback = options;
    nextOptions = undefined;
  }
  if (sendHandle !== undefined && sendHandle !== null) throw descendantError();
  if (primitive && nextCallback === undefined && nextOptions?.swallowErrors !== false) {
    throw descendantError();
  }
  const authenticated = authenticatedMessage(context, { message, options: nextOptions });
  const completionId = randomBytes(16).toString('hex');
  persistLoaderObservation('pending', completionId);
  let completionRecorded = false;
  const recordCompletion = (callbackArgs) => {
    if (completionRecorded) throw descendantError();
    const normalizedCallbackArgs = privateArrayMap(callbackArgs, (entry) => {
      if (!(entry instanceof Error)) return snapshotInvocation(entry).value;
      const normalized = {};
      const errorFields = ['name', 'message', 'code', 'errno', 'syscall', 'path', 'dest'];
      for (let index = 0; index < errorFields.length; index += 1) {
        const name = errorFields[index];
        const descriptor = privateGetOwnPropertyDescriptor(entry, name);
        if (descriptor && 'value' in descriptor) normalized[name] = descriptor.value;
      }
      return normalized;
    });
    authenticatedMessage(context, {
      status: 'completed',
      callbackArgs: normalizedCallbackArgs,
    });
    persistLoaderObservation('completion', completionId);
    completionRecorded = true;
  };
  const completionCallback =
    nextCallback === undefined || typeof nextCallback === 'function'
      ? function (...callbackArgs) {
          recordCompletion(callbackArgs);
          if (typeof nextCallback === 'function') {
            return intrinsicReflectApply(nextCallback, this, callbackArgs);
          }
          if (callbackArgs[0] !== null && callbackArgs[0] !== undefined) {
            return receiver.emit('error', callbackArgs[0]);
          }
        }
      : nextCallback;
  context.sendDepth += 1;
  try {
    if (primitive) context.nativeWriteDepth += 1;
    let result;
    try {
      result = intrinsicReflectApply(original, receiver, [
        authenticated.message,
        undefined,
        authenticated.options,
        completionCallback,
      ]);
    } finally {
      if (primitive) context.nativeWriteDepth -= 1;
    }
    return authenticatedMessage(context, {
      status: 'fulfilled',
      result,
    }).result;
  } catch (error) {
    if (!completionRecorded) {
      recordCompletion([error]);
    }
    authenticatedMessage(context, {
      status: 'rejected',
      error,
    });
    throw error;
  } finally {
    context.sendDepth -= 1;
  }
}
function withNativeChannelControl(context, run) {
  if (!context) throw descendantError();
  context.nativeControlDepth += 1;
  try {
    return run();
  } finally {
    context.nativeControlDepth -= 1;
  }
}
function nativeHandleFacade(handle, hiddenCallback, hiddenCallbackDelegate) {
  const blockedCallback = function () {
    throw descendantError();
  };
  return new IntrinsicProxy(new IntrinsicObject(), {
    defineProperty() {
      throw descendantError();
    },
    deleteProperty() {
      throw descendantError();
    },
    get(_target, property) {
      if (property === hiddenCallback) {
        return hiddenCallbackDelegate || blockedCallback;
      }
      const value = intrinsicReflectGet(handle, property, handle);
      if (typeof value !== 'function') return value;
      return function (...args) {
        return intrinsicReflectApply(value, handle, args);
      };
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = privateGetOwnPropertyDescriptor(handle, property);
      if (!descriptor) return undefined;
      if (property !== hiddenCallback) {
        return {
          configurable: true,
          enumerable: descriptor.enumerable,
          value: intrinsicReflectGet(handle, property, handle),
          writable: false,
        };
      }
      return {
        configurable: true,
        enumerable: descriptor.enumerable,
        value: blockedCallback,
        writable: false,
      };
    },
    getPrototypeOf() {
      return null;
    },
    preventExtensions() {
      throw descendantError();
    },
    set() {
      throw descendantError();
    },
    setPrototypeOf() {
      throw descendantError();
    },
  });
}
function exposeNativeProcessHandle(child, handle) {
  const originalOnExit = handle.onexit;
  if (typeof originalOnExit !== 'function') throw descendantError();
  const slot = {
    deliveringSpawnError: false,
    exitDepth: 0,
    exposed: undefined,
    invokeOnExit: undefined,
    pendingSpawnError: undefined,
    spawnDepth: 0,
  };
  const invokeOnExit = (...args) => {
    slot.exitDepth += 1;
    try {
      return intrinsicReflectApply(originalOnExit, handle, args);
    } finally {
      slot.exitDepth -= 1;
    }
  };
  slot.invokeOnExit = invokeOnExit;
  intrinsicDefineProperty(handle, 'onexit', {
    configurable: false,
    enumerable: true,
    value: invokeOnExit,
    writable: false,
  });
  slot.exposed = nativeHandleFacade(handle, 'onexit');
  privateWeakMapSet(nativeProcessHandleSlots, handle, slot);
  intrinsicDefineProperty(child, '_handle', {
    configurable: false,
    enumerable: true,
    get() {
      return slot.exposed;
    },
    set(value) {
      if (
        value !== null ||
        (slot.exitDepth <= 0 && slot.spawnDepth <= 0)
      ) {
        throw descendantError();
      }
      if (slot.deliveringSpawnError && slot.pendingSpawnError !== undefined) {
        const deliveredSpawnError = slot.pendingSpawnError;
        slot.exposed = nativeHandleFacade(handle, 'onexit', (...args) => {
          if (args.length !== 1 || args[0] !== deliveredSpawnError) {
            throw descendantError();
          }
          slot.exposed = null;
        });
      } else {
        slot.exposed = null;
      }
    },
  });
}
function requireNativeChannelHandle(owner) {
  const candidates = [];
  privateArrayForEach(privateGetOwnPropertySymbols(owner), (symbol) => {
    if (
      intrinsicReflectApply(intrinsicSymbolToString, symbol, []) ===
      'Symbol(kChannelHandle)'
    ) {
      privateArrayPush(candidates, symbol);
    }
  });
  if (candidates.length !== 1) throw descendantError();
  const symbol = candidates[0];
  const descriptor = privateGetOwnPropertyDescriptor(owner, symbol);
  if (!descriptor || !descriptor.value || typeof descriptor.value !== 'object') {
    throw descendantError();
  }
  return { handle: descriptor.value, symbol };
}
function fenceNativeReadCallback(handle, descriptor) {
  const blockedRead = function () {
    throw descendantError();
  };
  intrinsicDefineProperty(handle, 'onread', {
    configurable: false,
    enumerable: descriptor.enumerable,
    get() {
      return blockedRead;
    },
    set(value) {
      if (typeof value !== 'function') throw descendantError();
    },
  });
}
function fenceNativeHandleOwner(owner, handle, allowedOwnControls) {
  if (privateWeakSetHas(fencedNativeHandlePrototypes, owner)) return;
  privateWeakSetAdd(fencedNativeHandlePrototypes, owner);
  const names = privateGetOwnPropertyNames(owner);
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (
      name === 'constructor' ||
      (owner === handle && privateSetHas(allowedOwnControls, name))
    ) {
      continue;
    }
    const descriptor = privateGetOwnPropertyDescriptor(owner, name);
    if (typeof descriptor?.value !== 'function') continue;
    const implementation = descriptor.value;
    const isWrite = name.startsWith('write');
    intrinsicDefineProperty(owner, name, {
      configurable: false,
      enumerable: false,
      value(...args) {
        if (privateWeakSetHas(nativeProcessHandles, this)) {
          const processContext = privateWeakMapGet(nativeProcessContexts, this);
          if (!processContext || !privateSetHas(nativeProcessControlNames, name)) {
            throw descendantError();
          }
          return authenticatedLifecycleResult(
            processContext,
            name,
            { args },
            (authenticated) =>
              intrinsicReflectApply(implementation, this, authenticated.args),
          );
        }
        const channelContext = privateWeakMapGet(nativeChannelContexts, this);
        if (channelContext && isWrite && channelContext.nativeWriteDepth <= 0) {
          throw descendantError();
        }
        if (channelContext && !isWrite && channelContext.nativeControlDepth <= 0) {
          if (!privateSetHas(nativeChannelControlNames, name)) throw descendantError();
          return authenticatedLifecycleResult(
            channelContext.nativeControlContext,
            name,
            { args },
            (authenticated) =>
              intrinsicReflectApply(implementation, this, authenticated.args),
          );
        }
        return intrinsicReflectApply(implementation, this, args);
      },
      writable: false,
    });
  }
}
function fenceNativeChannel(
  handle,
  context,
  allowedOwnControls = new IntrinsicSet(),
) {
  if (!handle || !context) throw descendantError();
  privateWeakMapSet(nativeChannelContexts, handle, context);
  const readDescriptor = privateGetOwnPropertyDescriptor(handle, 'onread');
  const readCallback = handle.onread;
  if (typeof readCallback === 'function') {
    if (readDescriptor && !readDescriptor.configurable) throw descendantError();
    fenceNativeReadCallback(handle, {
      enumerable: readDescriptor?.enumerable ?? false,
      value: readCallback,
    });
  }
  for (
    let owner = handle;
    owner && owner !== Object.prototype;
    owner = privateGetPrototypeOf(owner)
  ) {
    fenceNativeHandleOwner(owner, handle, allowedOwnControls);
  }
}
function fenceNativeProcessHandle(handle, context) {
  if (!handle) throw descendantError();
  privateWeakSetAdd(nativeProcessHandles, handle);
  if (context) privateWeakMapSet(nativeProcessContexts, handle, context);
  const prototype = privateGetPrototypeOf(handle);
  if (!privateWeakSetHas(fencedNativeProcessPrototypes, prototype)) {
    const spawn = privateGetOwnPropertyDescriptor(prototype, 'spawn')?.value;
    if (typeof spawn !== 'function') throw descendantError();
    privateWeakSetAdd(fencedNativeProcessPrototypes, prototype);
    intrinsicDefineProperty(prototype, 'spawn', {
      configurable: false,
      enumerable: false,
      value(...args) {
        const authorizedOptions = privateWeakMapGet(authorizedNativeProcessSpawns, this);
        if (
          authorizedOptions === undefined ||
          args.length !== 1 ||
          args[0] !== authorizedOptions
        ) {
          throw descendantError();
        }
        privateWeakMapDelete(authorizedNativeProcessSpawns, this);
        const result = intrinsicReflectApply(spawn, this, args);
        const slot = privateWeakMapGet(nativeProcessHandleSlots, this);
        if (slot && isAsynchronousNativeSpawnError(result)) {
          slot.pendingSpawnError = result;
          intrinsicReflectApply(intrinsicProcessNextTick, process, [
            () => {
              if (slot.pendingSpawnError !== result) throw descendantError();
              slot.deliveringSpawnError = true;
              try {
                slot.invokeOnExit(result);
              } finally {
                slot.deliveringSpawnError = false;
                slot.pendingSpawnError = undefined;
              }
            },
          ]);
        } else if (slot) {
          slot.pendingSpawnError = undefined;
        }
        return result;
      },
      writable: false,
    });
    intrinsicDefineProperty(prototype, 'kill', {
      configurable: false,
      enumerable: false,
      value() {
        throw descendantError();
      },
      writable: false,
    });
    intrinsicDefineProperty(prototype, 'constructor', {
      configurable: false,
      enumerable: false,
      value: function FencedNativeProcess() {
        throw descendantError();
      },
      writable: false,
    });
  }
  for (
    let owner = privateGetPrototypeOf(prototype);
    owner && owner !== Object.prototype;
    owner = privateGetPrototypeOf(owner)
  ) {
    fenceNativeHandleOwner(owner, handle, new IntrinsicSet());
  }
}
function invocationCwd(cwd) {
  try {
    return fs.realpathSync(cwd || process.cwd());
  } catch {
    throw descendantError();
  }
}
function authenticatedChildArguments(
  args,
  optionsIndex,
  options,
  environmentEntries,
  nonce,
  semantics,
) {
  const nextArgs = [...args];
  const candidate = nextArgs[optionsIndex];
  const authenticatedOptions = {
    ...options,
    env: authenticatedChildEnvironment(environmentEntries, nonce, semantics),
  };
  if (typeof candidate === 'function') {
    nextArgs.splice(optionsIndex, 0, authenticatedOptions);
  } else {
    nextArgs[optionsIndex] = authenticatedOptions;
  }
  return nextArgs;
}
function authenticatedChildStdio(stdio, mode, silent, input) {
  const evidenceDescriptor = Number(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD);
  const hasEvidenceDescriptor =
    Number.isInteger(evidenceDescriptor) && evidenceDescriptor >= 3;
  const normalized =
    Array.isArray(stdio)
      ? [...stdio]
      : stdio === 'inherit'
        ? ['inherit', 'inherit', 'inherit']
        : stdio === 'ignore'
          ? ['ignore', 'ignore', 'ignore']
          : mode === 'fork' && !silent
            ? ['ignore', 'inherit', 'inherit']
            : [mode === 'sync' ? 'pipe' : 'ignore', 'pipe', 'pipe'];
  if (mode === 'sync') {
    if (normalized[0] !== 'pipe' && normalized[0] !== 'ignore') throw descendantError();
    if (input !== undefined && normalized[0] !== 'pipe') throw descendantError();
  } else if (normalized[0] !== 'ignore') {
    throw descendantError();
  }
  if (hasEvidenceDescriptor) {
    while (normalized.length <= evidenceDescriptor) privateArrayPush(normalized, 'ignore');
  }
  for (let index = 3; index < normalized.length; index += 1) {
    const value = normalized[index];
    if (hasEvidenceDescriptor && index === evidenceDescriptor) continue;
    if (mode === 'fork' && index === 3 && value === 'ipc') continue;
    if (value !== undefined && value !== null && value !== 'ignore') throw descendantError();
  }
  if (mode === 'fork') normalized[3] = 'ipc';
  if (hasEvidenceDescriptor) normalized[evidenceDescriptor] = evidenceDescriptor;
  return normalized;
}
function descendantError() {
  const error = new Error('RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION');
  error.code = 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION';
  return error;
}
if (typeof process.execve === 'function') {
  Object.defineProperty(process, 'execve', {
    configurable: false,
    enumerable: true,
    value() {
      throw descendantError();
    },
    writable: false,
  });
}
const nodeExecutable = fs.realpathSync(process.execPath);
function requireNodeExecutable(command, options) {
  if (options.shell) throw descendantError();
  try {
    if (typeof command !== 'string' || fs.realpathSync(command) !== nodeExecutable) {
      throw descendantError();
    }
  } catch (error) {
    if (error && error.code === 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error;
    throw descendantError();
  }
}
function isInlineNodeOption(value) {
  if (typeof value !== 'string') return false;
  const option = value.replaceAll('_', '-');
  return (
    /^-(?:e|p).*/.test(option) ||
    option === '--eval' ||
    option.startsWith('--eval=') ||
    option === '--print' ||
    option.startsWith('--print=') ||
    option === '--input-type' ||
    option.startsWith('--input-type=')
  );
}
const safeBooleanNodeOptions = new IntrinsicSet([
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
const safeValueNodeOptions = new IntrinsicSet(['--conditions', '--title']);
function normalizeSafeNodeOption(args, index) {
  const argument = args[index];
  if (typeof argument !== 'string' || isInlineNodeOption(argument)) throw descendantError();
  const equals = argument.indexOf('=');
  const option = (equals < 0 ? argument : argument.slice(0, equals)).replaceAll('_', '-');
  if (privateSetHas(safeBooleanNodeOptions, option)) {
    if (equals >= 0) throw descendantError();
    return { index, value: option };
  }
  if (!privateSetHas(safeValueNodeOptions, option)) throw descendantError();
  if (equals >= 0) {
    const value = argument.slice(equals + 1);
    if (value.length === 0) throw descendantError();
    return { index, value: option + '=' + value };
  }
  const value = args[index + 1];
  if (typeof value !== 'string' || value.length === 0) throw descendantError();
  return { index: index + 1, value: option + '=' + value };
}
function requireFileBackedNodeArguments(args, cwd) {
  if (!Array.isArray(args)) throw descendantError();
  let entrypoint;
  let entrypointIndex = -1;
  const execArgv = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== 'string' || isInlineNodeOption(argument)) throw descendantError();
    if (argument === '--') {
      entrypoint = args[index + 1];
      entrypointIndex = index + 1;
      break;
    }
    if (!argument.startsWith('-')) {
      entrypoint = argument;
      entrypointIndex = index;
      break;
    }
    const normalized = normalizeSafeNodeOption(args, index);
    privateArrayPush(execArgv, normalized.value);
    index = normalized.index;
  }
  return {
    entrypoint: requireFileBackedEntrypoint(entrypoint, cwd),
    execArgv,
    applicationArgs: privateArrayMap(
      privateArraySlice(args, entrypointIndex + 1),
      (value) => {
      if (typeof value !== 'string') throw descendantError();
      return value;
      },
    ),
  };
}
function requireFileBackedEntrypoint(entrypoint, cwd) {
  if (typeof entrypoint !== 'string' || entrypoint === '-' || entrypoint.startsWith('-')) {
    throw descendantError();
  }
  try {
    const candidate = path.resolve(cwd || process.cwd(), entrypoint);
    const canonical = fs.realpathSync(candidate);
    if (!fs.statSync(canonical).isFile()) throw descendantError();
    if (!isWithinAllowedCodeRoot(canonical)) {
      throw descendantError();
    }
    return canonical;
  } catch (error) {
    if (error && error.code === 'RN_DEV_AGENT_UNSUPPORTED_DESCENDANT_EXECUTION') throw error;
    throw descendantError();
  }
}
function requireSafeExecArgv(execArgv) {
  if (!Array.isArray(execArgv)) throw descendantError();
  const normalized = [];
  for (let index = 0; index < execArgv.length; index += 1) {
    const option = normalizeSafeNodeOption(execArgv, index);
    privateArrayPush(normalized, option.value);
    index = option.index;
  }
  return normalized;
}
function executionSemantics(mode, entrypoint, execArgv, invocation) {
  const value = canonicalAuthorityJson({
    mode,
    entrypoint,
    entrypointDigest: digestRuntimeFile(entrypoint),
    execArgv,
    invocationDigest: digestInvocation(invocation),
    allowedCodeRoots,
    authority: {
      sessionId: authoritySessionId,
      metroInstanceId: authorityMetroInstanceId,
      contentRoot: authorityContentRoot,
      appRoot: authorityAppRoot,
      parentIdentity: currentIdentity,
      parentNonce: currentAuthorityNonce,
    },
  });
  persistLoaderObservation('semantics', value);
  return createHash('sha256').update(value).digest('hex');
}
function recordChildLaunch(nonce, child, semantics) {
  if (!child || typeof child.pid !== 'number') return;
  persistLoaderObservation(
    'launch',
    descendantExecutionRecord(
      nonce,
      'process:' + child.pid,
      semantics,
      currentIdentity,
      currentAuthorityNonce,
    ),
  );
}
function lifecycleContext(mode, recipient) {
  return { mode, recipient, sequence: 0, disconnectDepth: 0 };
}
function authenticatedLifecycle(context, action, value) {
  if (!context) throw descendantError();
  return authenticatedMessage(context, { action, value });
}
function authenticatedLifecycleResult(context, action, value, run) {
  const authenticated = authenticatedLifecycle(context, action, value);
  try {
    const result = run(authenticated.value);
    return authenticatedMessage(context, {
      action,
      status: 'fulfilled',
      result,
    }).result;
  } catch (error) {
    authenticatedMessage(context, {
      action,
      status: 'rejected',
      error,
    });
    throw error;
  }
}
function authenticatedLifecyclePromise(context, action, value, run) {
  const authenticated = authenticatedLifecycle(context, action, value);
  let result;
  try {
    result = run(authenticated.value);
  } catch (error) {
    authenticatedMessage(context, {
      action,
      status: 'rejected',
      error,
    });
    throw error;
  }
  return Promise.resolve(result).then(
    (resolved) =>
      authenticatedMessage(context, {
        action,
        status: 'fulfilled',
        result: resolved,
      }).result,
    (error) => {
      authenticatedMessage(context, {
        action,
        status: 'rejected',
        error,
      });
      throw error;
    },
  );
}
function installMessageFences() {
  const childPrototype = childProcess.ChildProcess.prototype;
  const originalChildSpawn = childPrototype.spawn;
  const childProcessChannel = diagnosticsChannel.channel('child_process');
  if (childProcessChannel.hasSubscribers) throw descendantError();
  const channelPrototype = privateGetPrototypeOf(childProcessChannel);
  const channelSubscribe = channelPrototype.subscribe;
  intrinsicReflectApply(channelSubscribe, childProcessChannel, [({ process: spawnedProcess }) => {
    const authorization = activeChildSpawnAuthorization;
    const nativeHandle = spawnedProcess._handle;
    fenceNativeProcessHandle(nativeHandle, authorization?.lifecycleContext);
    privateWeakMapSet(childNativeProcessHandles, spawnedProcess, nativeHandle);
    exposeNativeProcessHandle(spawnedProcess, nativeHandle);
    if (!authorization || authorization.receiver) return;
    authorization.receiver = spawnedProcess;
    privateWeakMapSet(authorizedChildSpawns, spawnedProcess, authorization);
    intrinsicDefineProperty(spawnedProcess, 'spawn', {
      configurable: false,
      enumerable: true,
      value(options) {
        return intrinsicReflectApply(childPrototype.spawn, spawnedProcess, [options]);
      },
      writable: false,
    });
  }]);
  Object.defineProperty(childPrototype, 'spawn', {
    configurable: false,
    enumerable: true,
    value(options) {
      const authorization = privateWeakMapGet(authorizedChildSpawns, this);
      if (
        !authorization ||
        authorization.environment !== options?.env ||
        authorization.receiver !== this
      ) {
        throw descendantError();
      }
      privateWeakMapDelete(authorizedChildSpawns, this);
      const nativeHandle = privateWeakMapGet(childNativeProcessHandles, this);
      if (!nativeHandle) throw descendantError();
      const slot = privateWeakMapGet(nativeProcessHandleSlots, nativeHandle);
      if (!slot) throw descendantError();
      privateWeakMapSet(authorizedNativeProcessSpawns, nativeHandle, options);
      slot.spawnDepth += 1;
      try {
        return intrinsicReflectApply(originalChildSpawn, this, [options]);
      } finally {
        slot.spawnDepth -= 1;
        privateWeakMapDelete(authorizedNativeProcessSpawns, nativeHandle);
      }
    },
    writable: false,
  });
  const authenticatedChildSend = function (message, sendHandle, options, callback) {
    const implementation = privateWeakMapGet(childSendImplementations, this);
    if (!implementation || !privateWeakMapHas(childMessageContexts, this)) {
      throw descendantError();
    }
    return authenticatedIpcSend(
      implementation,
      this,
      privateWeakMapGet(childMessageContexts, this),
      message,
      sendHandle,
      options,
      callback,
    );
  };
  Object.defineProperty(childPrototype, 'send', {
    configurable: false,
    enumerable: true,
    get() {
      if (
        this !== childPrototype &&
        (!privateWeakMapHas(childSendImplementations, this) ||
          !privateWeakMapHas(childMessageContexts, this))
      ) {
        return undefined;
      }
      return authenticatedChildSend;
    },
    set(value) {
      if (
        typeof value !== 'function' ||
        privateWeakMapHas(childSendImplementations, this)
      ) {
        throw descendantError();
      }
      privateWeakMapSet(childSendImplementations, this, value);
    },
  });
  const authenticatedChildSendPrimitive = function (message, sendHandle, options, callback) {
    return authenticatedIpcSend(
      privateWeakMapGet(childSendPrimitiveImplementations, this),
      this,
      privateWeakMapGet(childMessageContexts, this),
      message,
      sendHandle,
      options,
      callback,
      true,
    );
  };
  Object.defineProperty(childPrototype, '_send', {
    configurable: false,
    enumerable: false,
    get() {
      if (
        this !== childPrototype &&
        (!privateWeakMapHas(childSendPrimitiveImplementations, this) ||
          !privateWeakMapHas(childMessageContexts, this))
      ) {
        return undefined;
      }
      return authenticatedChildSendPrimitive;
    },
    set(value) {
      if (
        typeof value !== 'function' ||
        privateWeakMapHas(childSendPrimitiveImplementations, this)
      ) {
        throw descendantError();
      }
      privateWeakMapSet(childSendPrimitiveImplementations, this, value);
    },
  });
  const workerPrototype = workerThreads.Worker.prototype;
  const originalWorkerPostMessage = workerPrototype.postMessage;
  const originalWorkerTerminate = workerPrototype.terminate;
  Object.defineProperty(workerPrototype, 'postMessage', {
    configurable: false,
    enumerable: true,
    value(message, transferList) {
      return authenticatedPostMessage(
        originalWorkerPostMessage,
        this,
        privateWeakMapGet(workerMessageContexts, this),
        message,
        transferList,
      );
    },
    writable: false,
  });
  Object.defineProperty(workerPrototype, 'terminate', {
    configurable: false,
    enumerable: true,
    value() {
      return authenticatedLifecyclePromise(
        privateWeakMapGet(workerLifecycleContexts, this),
        'terminate',
        undefined,
        () => intrinsicReflectApply(originalWorkerTerminate, this, []),
      );
    },
    writable: false,
  });
  const originalChildKill = childPrototype.kill;
  const originalProcessKill = process.kill;
  const normalizeChildSignal = (signal) => {
    let normalizedSignal;
    intrinsicReflectApply(
      originalChildKill,
      {
        _handle: {
          kill(value) {
            normalizedSignal = value;
            return 0;
          },
        },
        killed: false,
      },
      [signal],
    );
    return normalizedSignal;
  };
  Object.defineProperty(childPrototype, 'kill', {
    configurable: false,
    enumerable: true,
    value(signal) {
      const target = privateWeakMapGet(childLifecycleTargets, this);
      return authenticatedLifecycleResult(
        target?.context,
        'kill',
        signal,
        (authenticatedSignal) => {
          const normalizedSignal = normalizeChildSignal(authenticatedSignal);
          if (target.pid === undefined) return false;
          if (privateMapGet(processLifecycleTargets, target.pid) !== target) return false;
          try {
            const result = intrinsicReflectApply(originalProcessKill, process, [
              target.pid,
              normalizedSignal,
            ]);
            if (result) this.killed = true;
            return result;
          } catch (error) {
            if (error?.code === 'ESRCH') return false;
            if (error?.code === 'EINVAL' || error?.code === 'ENOSYS') throw error;
            if (error?.code) {
              this.emit('error', error);
              return false;
            }
            throw error;
          }
        },
      );
    },
    writable: false,
  });
  const authenticatedChildDisconnect = function () {
    return authenticatedLifecycleResult(
      privateWeakMapGet(childLifecycleContexts, this),
      'disconnect',
      undefined,
      () =>
        withNativeChannelControl(privateWeakMapGet(childMessageContexts, this), () =>
          intrinsicReflectApply(
            privateWeakMapGet(childDisconnectImplementations, this),
            this,
            [],
          ),
        ),
    );
  };
  Object.defineProperty(childPrototype, 'disconnect', {
    configurable: false,
    enumerable: true,
    get() {
      if (
        this !== childPrototype &&
        (!privateWeakMapHas(childDisconnectImplementations, this) ||
          !privateWeakMapHas(childLifecycleContexts, this))
      ) {
        return undefined;
      }
      return authenticatedChildDisconnect;
    },
    set(value) {
      if (typeof value !== 'function') throw descendantError();
      privateWeakMapSet(childDisconnectImplementations, this, value);
    },
  });
  Object.defineProperty(process, 'kill', {
    configurable: false,
    enumerable: true,
    value(pid, signal) {
      const target = privateMapGet(processLifecycleTargets, pid);
      if (!target) throw descendantError();
      return authenticatedLifecycleResult(
        target.context,
        'kill',
        { pid, signal },
        (authenticated) =>
          intrinsicReflectApply(originalProcessKill, process, [
            authenticated.pid,
            authenticated.signal,
          ]),
      );
    },
    writable: false,
  });
  const portPrototype = workerThreads.MessagePort.prototype;
  const originalPortPostMessage = portPrototype.postMessage;
  Object.defineProperty(portPrototype, 'postMessage', {
    configurable: false,
    enumerable: true,
    value(message, transferList) {
      const context = privateWeakMapGet(portMessageContexts, this);
      if (!context) {
        return intrinsicReflectApply(originalPortPostMessage, this, [
          message,
          transferList,
        ]);
      }
      return authenticatedPostMessage(
        originalPortPostMessage,
        this,
        context,
        message,
        transferList,
      );
    },
    writable: false,
  });
  const OriginalMessageChannel = workerThreads.MessageChannel;
  class FencedMessageChannel extends OriginalMessageChannel {
    constructor() {
      super();
      privateWeakMapSet(portMessageContexts, this.port1, { blocked: true });
      privateWeakMapSet(portMessageContexts, this.port2, { blocked: true });
    }
  }
  Object.defineProperty(workerThreads, 'MessageChannel', {
    configurable: false,
    enumerable: true,
    value: FencedMessageChannel,
    writable: false,
  });
  if (typeof workerThreads.postMessageToThread === 'function') {
    Object.defineProperty(workerThreads, 'postMessageToThread', {
      configurable: false,
      enumerable: true,
      value() {
        throw descendantError();
      },
      writable: false,
    });
  }
  Object.defineProperty(workerThreads, 'setEnvironmentData', {
    configurable: false,
    enumerable: true,
    value() {
      throw descendantError();
    },
    writable: false,
  });
  if (workerThreads.BroadcastChannel) {
    class FencedBroadcastChannel {
      constructor() {
        throw descendantError();
      }
    }
    Object.defineProperty(workerThreads, 'BroadcastChannel', {
      configurable: false,
      enumerable: true,
      value: FencedBroadcastChannel,
      writable: false,
    });
    if (globalThis.BroadcastChannel) {
      Object.defineProperty(globalThis, 'BroadcastChannel', {
        configurable: false,
        enumerable: true,
        value: FencedBroadcastChannel,
        writable: false,
      });
    }
  }
}
function fenceChildProcessMethod(name, optionsIndex, mode) {
  const original = childProcess[name];
  Object.defineProperty(childProcess, name, {
    configurable: false,
    enumerable: true,
    value(...receivedArgs) {
      const args = [...receivedArgs];
      if (Array.isArray(args[1])) args[1] = [...args[1]];
      const index = typeof optionsIndex === 'function' ? optionsIndex(args) : optionsIndex;
      const nonce = randomBytes(16).toString('hex');
      const candidate = args[index];
      const rawOptions = candidate && typeof candidate === 'object' ? { ...candidate } : {};
      if (candidate && typeof candidate === 'object') args[index] = rawOptions;
      if (rawOptions.signal !== undefined) throw descendantError();
      const cwd = invocationCwd(rawOptions.cwd);
      const environmentEntries = snapshotInvocation(
        normalizedInvocationEnvironment(rawOptions.env),
      ).value;
      const stdio = authenticatedChildStdio(
        rawOptions.stdio,
        mode,
        rawOptions.silent,
        rawOptions.input,
      );
      let entrypoint;
      let execArgv;
      let applicationArgs;
      if (mode === 'node' || mode === 'sync') {
        requireNodeExecutable(args[0], rawOptions);
        const invocation = requireFileBackedNodeArguments(args[1], cwd);
        entrypoint = invocation.entrypoint;
        execArgv = invocation.execArgv;
        applicationArgs = invocation.applicationArgs;
      }
      if (mode === 'fork') {
        if (rawOptions.execPath) requireNodeExecutable(rawOptions.execPath, rawOptions);
        entrypoint = requireFileBackedEntrypoint(args[0], cwd);
        execArgv = requireSafeExecArgv(
          Array.isArray(rawOptions.execArgv) ? rawOptions.execArgv : process.execArgv,
        );
        applicationArgs = Array.isArray(args[1]) ? [...args[1]] : [];
        if (applicationArgs.some((value) => typeof value !== 'string')) throw descendantError();
      }
      const authenticatedOptions = snapshotInvocation({
        ...rawOptions,
        cwd,
        env: privateObjectFromEntries(environmentEntries),
        stdio,
      }).value;
      const semantics = executionSemantics(mode, entrypoint, execArgv, {
        applicationArgs,
        options: authenticatedOptions,
      });
      const authenticatedArgs = authenticatedChildArguments(
        args,
        index,
        authenticatedOptions,
        environmentEntries,
        nonce,
        semantics,
      );
      const options = authenticatedArgs[index];
      if (mode === 'fork') {
        options.execPath = nodeExecutable;
      }
      if (mode !== 'sync' && activeChildSpawnAuthorization) throw descendantError();
      const spawnAuthorization =
        mode === 'sync'
          ? undefined
          : {
              environment: options.env,
              lifecycleContext: lifecycleContext('child-lifecycle', nonce),
              receiver: undefined,
            };
      if (spawnAuthorization) {
        activeChildSpawnAuthorization = spawnAuthorization;
      }
      let child;
      try {
        child = intrinsicReflectApply(original, this, authenticatedArgs);
      } finally {
        if (spawnAuthorization) {
          activeChildSpawnAuthorization = undefined;
          if (spawnAuthorization.receiver) {
            privateWeakMapDelete(authorizedChildSpawns, spawnAuthorization.receiver);
          }
        }
      }
      if (mode === 'sync') {
        recordChildLaunch(nonce, child, semantics);
      } else if (typeof child?.once === 'function') {
        child.once('spawn', () => recordChildLaunch(nonce, child, semantics));
      }
      if (mode !== 'sync') {
        const context = spawnAuthorization.lifecycleContext;
        const target = {
          pid: typeof child?.pid === 'number' ? child.pid : undefined,
          context,
        };
        privateWeakMapSet(childLifecycleContexts, child, context);
        privateWeakMapSet(childLifecycleTargets, child, target);
        if (target.pid !== undefined) {
          const pid = target.pid;
          privateMapSet(processLifecycleTargets, pid, target);
          child.once?.('exit', () => {
            if (privateMapGet(processLifecycleTargets, pid) === target) {
              privateMapDelete(processLifecycleTargets, pid);
            }
          });
        }
      }
      if (mode === 'fork') {
        const messageContext = {
          mode: 'fork-message',
          recipient: nonce,
          sequence: 0,
          sendDepth: 0,
          nativeWriteDepth: 0,
          nativeControlDepth: 0,
          nativeControlContext: lifecycleContext('native-channel', nonce),
        };
        privateWeakMapSet(childMessageContexts, child, messageContext);
        let channel;
        try {
          channel = requireNativeChannelHandle(child);
        } catch (error) {
          child.kill();
          throw error;
        }
        fenceNativeChannel(channel.handle, messageContext);
        child[channel.symbol] = nativeHandleFacade(channel.handle, 'onread');
      }
      return child;
    },
    writable: false,
  });
}
function rejectChildProcessMethod(name) {
  Object.defineProperty(childProcess, name, {
    configurable: false,
    enumerable: true,
    value() {
      throw descendantError();
    },
    writable: false,
  });
}
function fenceNativeProcessLaunchBindings() {
  const originalBinding = process.binding;
  Object.defineProperty(process, 'binding', {
    configurable: false,
    enumerable: false,
    value(name) {
      if (name === 'process_wrap' || name === 'spawn_sync') {
        throw descendantError();
      }
      return intrinsicReflectApply(originalBinding, process, [name]);
    },
    writable: false,
  });
}
function fenceWorkers() {
  const OriginalWorker = workerThreads.Worker;
  const authorityPreload = process.env.RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD;
  function AuthenticatedWorker(filename, options = {}) {
    if (!new.target) throw descendantError();
    const capturedOptions = { ...options };
    if (
      capturedOptions.eval ||
      (typeof filename === 'string' && filename.startsWith('data:')) ||
      (filename instanceof URL && filename.protocol === 'data:')
    ) {
      throw descendantError();
    }
    const nonce = randomBytes(16).toString('hex');
    const requestedExecArgv = Array.isArray(capturedOptions.execArgv)
      ? [...capturedOptions.execArgv]
      : [...process.execArgv];
    const normalizedExecArgv = requireSafeExecArgv(requestedExecArgv);
    if (Array.isArray(capturedOptions.transferList) && capturedOptions.transferList.length > 0) {
      throw descendantError();
    }
    if (capturedOptions.stdin || capturedOptions.signal !== undefined) throw descendantError();
    const entrypoint = requireFileBackedEntrypoint(
      filename instanceof URL ? fileURLToPath(filename) : filename,
    );
    const invocationOptions = { ...capturedOptions };
    delete invocationOptions.execArgv;
    delete invocationOptions.transferList;
    const environmentEntries = snapshotInvocation(
      normalizedInvocationEnvironment(capturedOptions.env),
    ).value;
    invocationOptions.env = privateObjectFromEntries(environmentEntries);
    const authenticatedInvocationOptions = snapshotInvocation(invocationOptions).value;
    const semantics = executionSemantics(
      'worker',
      entrypoint,
      normalizedExecArgv,
      {
        options: authenticatedInvocationOptions,
      },
    );
    const workerNewTarget =
      new.target === AuthenticatedWorker ? OriginalWorker : new.target;
    const worker = intrinsicReflectConstruct(
      OriginalWorker,
      [
        entrypoint,
        {
          ...authenticatedInvocationOptions,
          env: authenticatedChildEnvironment(
            environmentEntries,
            nonce,
            semantics,
          ),
          execArgv: ['--require', authorityPreload, ...requestedExecArgv],
        },
      ],
      workerNewTarget,
    );
    privateWeakMapSet(workerMessageContexts, worker, {
      mode: 'worker-message',
      recipient: nonce,
      sequence: 0,
    });
    privateWeakMapSet(
      workerLifecycleContexts,
      worker,
      lifecycleContext('worker-lifecycle', nonce),
    );
    persistLoaderObservation(
      'launch',
      descendantExecutionRecord(
        nonce,
        'worker:' + worker.threadId,
        semantics,
        currentIdentity,
        currentAuthorityNonce,
      ),
    );
    return worker;
  }
  Object.defineProperty(AuthenticatedWorker, 'prototype', {
    configurable: false,
    value: OriginalWorker.prototype,
    writable: false,
  });
  Object.setPrototypeOf(AuthenticatedWorker, Function.prototype);
  Object.defineProperty(OriginalWorker.prototype, 'constructor', {
    configurable: false,
    enumerable: false,
    value: AuthenticatedWorker,
    writable: false,
  });
  Object.defineProperty(workerThreads, 'Worker', {
    configurable: false,
    enumerable: true,
    value: AuthenticatedWorker,
    writable: false,
  });
}
const optionalArgsIndex = (args) => (Array.isArray(args[1]) ? 2 : 1);
const canAuthenticateChildProcesses =
  Boolean(process.env.NODE_OPTIONS) &&
  Boolean(process.env.RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD) &&
  (Boolean(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD) ||
    (Boolean(metroPolicyCapability) && Boolean(process.env.RN_DEV_AGENT_METRO_RUNTIME_LOADS)));
if (canAuthenticateChildProcesses) {
  fenceNativeProcessLaunchBindings();
  installMessageFences();
  if (descendantNonce) {
    if (typeof process.send === 'function') {
      const originalSend = process.send;
      Object.defineProperty(process, 'send', {
        configurable: false,
        enumerable: true,
        value(message, sendHandle, options, callback) {
          return authenticatedIpcSend(
            originalSend,
            process,
            descendantMessageContext,
            message,
            sendHandle,
            options,
            callback,
          );
        },
        writable: false,
      });
    }
    if (workerThreads.parentPort) {
      privateWeakMapSet(
        portMessageContexts,
        workerThreads.parentPort,
        descendantMessageContext,
      );
    }
  }
  fenceChildProcessMethod('spawn', optionalArgsIndex, 'node');
  fenceChildProcessMethod('spawnSync', optionalArgsIndex, 'sync');
  fenceChildProcessMethod('fork', optionalArgsIndex, 'fork');
  rejectChildProcessMethod('exec');
  rejectChildProcessMethod('execFile');
  rejectChildProcessMethod('execFileSync');
  rejectChildProcessMethod('execSync');
  fenceWorkers();
}
function digestRuntimeFile(file) {
  const refusal = (message) => {
    const error = new Error('METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' + message);
    error.code = 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE';
    return error;
  };
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const initial = fs.fstatSync(descriptor);
    if (!initial.isFile()) {
      throw refusal('native addon is not a regular file');
    }
    if (initial.size > 128 * 1024 * 1024) {
      throw refusal('native addon exceeds the 128 MiB evidence limit');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < initial.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, initial.size - position),
        position,
      );
      if (bytesRead === 0 || position + bytesRead > 128 * 1024 * 1024) {
        throw refusal('native addon changed while reading evidence');
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (fs.readSync(descriptor, buffer, 0, 1, position) !== 0) {
      throw refusal('native addon changed while reading evidence');
    }
    const final = fs.fstatSync(descriptor);
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      throw refusal('native addon changed while reading evidence');
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}
function waitForNativeAddonAcknowledgment(requestId, digest) {
  const refusal = (message) => {
    const error = new Error('METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' + message);
    error.code = 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE';
    return error;
  };
  const acknowledgmentRoot = process.env.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT;
  if (!usesExternalEvidenceOwner) return null;
  if (!acknowledgmentRoot || !/^[a-f0-9]{32}$/.test(requestId)) {
    throw refusal('launcher acknowledgment channel is unavailable');
  }
  const acknowledgmentPath = path.join(acknowledgmentRoot, requestId + '.json');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const acknowledgment = JSON.parse(fs.readFileSync(acknowledgmentPath, 'utf8'));
      if (
        acknowledgment.version !== 1 ||
        acknowledgment.requestId !== requestId ||
        acknowledgment.digest !== digest ||
        acknowledgment.accepted !== true ||
        typeof acknowledgment.path !== 'string'
      ) {
        throw refusal(
          typeof acknowledgment.reason === 'string'
            ? acknowledgment.reason
            : 'launcher rejected the requested bytes',
        );
      }
      return acknowledgment.path;
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  throw refusal('launcher acknowledgment timed out');
}
function nativeAddonEvidenceStageError(stage, caught) {
  if (
    caught &&
    (caught.code === 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON' ||
      caught.code === 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE')
  ) {
    return caught;
  }
  const code =
    caught && typeof caught.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(caught.code)
      ? caught.code
      : 'UNKNOWN';
  const error = new Error(
    'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' + stage + ' failed (' + code + ')',
  );
  error.code = 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE';
  return error;
}
function prepareNativeAddonLoad(file) {
  const requestedPath = path.resolve(String(file));
  let resolved;
  try {
    resolved = fs.realpathSync(requestedPath);
  } catch (caught) {
    if (caught && (caught.code === 'ENOENT' || caught.code === 'ENOTDIR')) {
      const error = new Error(
        'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' + sanitizedNativeAddonPath(file),
      );
      error.code = 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON';
      throw error;
    }
    throw nativeAddonEvidenceStageError('canonical-path', caught);
  }
  let regularFile;
  try {
    regularFile = fs.statSync(resolved).isFile();
  } catch (caught) {
    throw nativeAddonEvidenceStageError('file-metadata', caught);
  }
  if (!regularFile) {
    const error = new Error(
      'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: not-regular:' +
        sanitizedNativeAddonBasename(resolved),
    );
    error.code = 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON';
    throw error;
  }
  let withinAllowedRoot;
  try {
    withinAllowedRoot = isWithinAllowedCodeRoot(resolved);
  } catch (caught) {
    throw nativeAddonEvidenceStageError('root-containment', caught);
  }
  if (!withinAllowedRoot) {
    const error = new Error(
      'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' + sanitizedNativeAddonPath(file),
    );
    error.code = 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON';
    throw error;
  }
  let digest;
  try {
    digest = digestRuntimeFile(resolved);
  } catch (caught) {
    throw nativeAddonEvidenceStageError('pre-load-digest', caught);
  }
  let requestId;
  try {
    requestId = randomBytes(16).toString('hex');
  } catch (caught) {
    throw nativeAddonEvidenceStageError('request-id', caught);
  }
  if (usesExternalEvidenceOwner) {
    try {
      persistLoaderObservation(
        'native-addon-request',
        canonicalAuthorityJson({ requestId, path: resolved, digest }),
      );
    } catch (caught) {
      throw nativeAddonEvidenceStageError('request-publish', caught);
    }
    let acknowledgedPath;
    try {
      acknowledgedPath = waitForNativeAddonAcknowledgment(requestId, digest);
    } catch (caught) {
      throw nativeAddonEvidenceStageError('acknowledgment-read', caught);
    }
    if (acknowledgedPath !== resolved) {
      throw new Error('native addon acknowledgment path changed');
    }
  } else {
    persistLoaderObservation('input', resolved, digest);
  }
  if (privateMapGet(observedLoaderDigests, resolved) !== digest) {
    privateMapSet(observedLoaderDigests, resolved, digest);
    privateSetAdd(accumulatedRuntimeInputs, resolved);
    loaderEpoch += 1;
  }
  return { requestId, resolved, digest };
}
function recordRuntimeFileInput(file) {
  const resolved = fs.realpathSync(file);
  if (!fs.statSync(resolved).isFile() || !isWithinAllowedCodeRoot(resolved)) {
    const error = new Error(
      'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' + sanitizedNativeAddonPath(file),
    );
    error.code = 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON';
    throw error;
  }
  const digest = digestRuntimeFile(resolved);
  if (privateMapGet(observedLoaderDigests, resolved) !== digest) {
    privateMapSet(observedLoaderDigests, resolved, digest);
    privateSetAdd(accumulatedRuntimeInputs, resolved);
    loaderEpoch += 1;
    persistLoaderObservation('input', resolved, digest);
  }
  return resolved;
}
const originalDlopen = process.dlopen;
function reportNativeAddonCompletion(prepared, outcome, digest) {
  if (usesExternalEvidenceOwner) {
    persistLoaderObservation(
      'native-addon-completion',
      canonicalAuthorityJson({
        requestId: prepared.requestId,
        path: prepared.resolved,
        digest,
        outcome,
      }),
    );
  } else if (outcome === 'success') {
    persistLoaderObservation('stability', prepared.resolved, digest);
  } else {
    recordLoaderViolation(
      'METRO_NATIVE_ADDON_LOAD_FAILED: ' + sanitizedNativeAddonBasename(prepared.resolved),
    );
  }
}
const attestNativeAddonLoad = function(module, file) {
  let prepared;
  try {
    prepared = prepareNativeAddonLoad(file);
  } catch (caught) {
    const sanitizedPath = sanitizedNativeAddonPath(file);
    const preparationCode =
      caught && typeof caught.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(caught.code)
        ? caught.code
        : 'UNKNOWN';
    const message =
      caught &&
      (caught.code === 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON' ||
        caught.code === 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE')
        ? caught.message
        : 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: preparation failed (' +
          preparationCode +
          '): ' +
          sanitizedPath;
    recordLoaderViolation(message);
    const error = new Error(message);
    error.code =
      caught && caught.code === 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON'
        ? caught.code
        : 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE';
    throw error;
  }
  const args = privateArraySlice(arguments);
  args[1] = prepared.resolved;
  let result;
  try {
    result = intrinsicReflectApply(originalDlopen, process, args);
  } catch (caught) {
    reportNativeAddonCompletion(prepared, 'failure', prepared.digest);
    throw caught;
  }
  let postLoadDigest;
  try {
    postLoadDigest = digestRuntimeFile(prepared.resolved);
  } catch (caught) {
    const message =
      caught && caught.code === 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE'
        ? caught.message
        : 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: native addon stability could not be verified';
    reportNativeAddonCompletion(prepared, 'failure', prepared.digest);
    recordLoaderViolation(message);
    const error = new Error(message);
    error.code = 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE';
    throw error;
  }
  if (postLoadDigest !== prepared.digest) {
    const message =
      'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: native addon changed during load';
    reportNativeAddonCompletion(prepared, 'failure', postLoadDigest);
    recordLoaderViolation(message);
    const error = new Error(message);
    error.code = 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE';
    throw error;
  }
  reportNativeAddonCompletion(prepared, 'success', postLoadDigest);
  return result;
};
Object.defineProperty(process, 'dlopen', {
  configurable: false,
  enumerable: true,
  value: attestNativeAddonLoad,
  writable: false,
});
function digestRuntimeSource(source) {
  const bytes =
    typeof source === 'string'
      ? Buffer.from(source)
      : Buffer.isBuffer(source)
        ? source
        : source instanceof ArrayBuffer
          ? Buffer.from(source)
          : typeof SharedArrayBuffer !== 'undefined' && source instanceof SharedArrayBuffer
            ? Buffer.from(source)
          : ArrayBuffer.isView(source)
            ? Buffer.from(source.buffer, source.byteOffset, source.byteLength)
            : null;
  if (!bytes || bytes.byteLength > 128 * 1024 * 1024) {
    throw new Error('unsupported runtime module source');
  }
  return createHash('sha256').update(bytes).digest('hex');
}
function recordLoaderResult(url, result) {
  if (url.startsWith('node:')) return;
  if (!url.startsWith('file:')) {
    recordLoaderViolation('Metro runtime module URL scheme is unsupported');
    return;
  }
  if (result && result.format === 'addon') {
    try {
      recordRuntimeFileInput(fileURLToPath(url));
    } catch (caught) {
      const message =
        caught &&
        (caught.code === 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON' ||
          caught.code === 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE')
          ? caught.message
          : 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' +
            sanitizedNativeAddonPath(fileURLToPath(url));
      recordLoaderViolation(message);
    }
    return;
  }
  try {
    const resolved = fs.realpathSync(fileURLToPath(url));
    const digest = digestRuntimeSource(result && result.source);
    if (privateMapGet(observedLoaderDigests, resolved) === digest) return;
    privateMapSet(observedLoaderDigests, resolved, digest);
    privateSetAdd(accumulatedRuntimeInputs, resolved);
    loaderEpoch += 1;
    persistLoaderObservation('input', resolved, digest);
  } catch {
    recordLoaderViolation('Metro runtime module cannot be resolved');
  }
}
if (typeof registerHooks === 'function') {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      recordLoaderResult(url, result);
      return result;
    },
  });
  const rejectHookRegistration = () => {
    recordLoaderViolation('additional Metro runtime loader hooks are unsupported');
    throw new Error('RN_DEV_AGENT_UNSUPPORTED_MODULE_HOOK');
  };
  moduleApi.register = rejectHookRegistration;
  moduleApi.registerHooks = rejectHookRegistration;
  moduleApi.syncBuiltinESMExports();
} else {
  recordLoaderViolation('Metro runtime module loading requires Node.js 22.15 or newer');
}
const preloadPath = fs.realpathSync(__filename);
const preloadDigest = digestRuntimeFile(preloadPath);
privateMapSet(observedLoaderDigests, preloadPath, preloadDigest);
privateSetAdd(accumulatedRuntimeInputs, preloadPath);
loaderEpoch += 1;
persistLoaderObservation('input', preloadPath, preloadDigest);
function sourceRoot() {
  if (sourceRootResolved) return cachedSourceRoot;
  if (process.env.RN_DEV_AGENT_METRO_CONTENT_ROOT) {
    cachedSourceRoot = fs.realpathSync(process.env.RN_DEV_AGENT_METRO_CONTENT_ROOT);
    sourceRootResolved = true;
    return cachedSourceRoot;
  }
  try {
    cachedSourceRoot = fs.realpathSync(execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
    sourceRootResolved = true;
    return cachedSourceRoot;
  } catch (error) {
    if (String(error && error.stderr || '').toLowerCase().includes('not a git repository')) {
      sourceRootResolved = true;
      cachedSourceRoot = null;
      return cachedSourceRoot;
    }
    throw error;
  }
}
function runtimePolicy(config, callbackRuntimeInputs = []) {
  const root = sourceRoot();
  const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
  const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
  if (root === null || !metroPolicyCapability || !sessionId || !metroInstanceId) return;
  const runtimeInputs = new IntrinsicSet();
  const violations = [];
  const excludedRuntimeDirectories = [
    '.gradle',
    '.expo',
    '.cache',
    'ios/Pods',
    'ios/build',
    'ios/DerivedData',
    'android/build',
    'android/app/build',
    'android/app/.cxx',
  ];
  const resolver = config.resolver || {};
  const transformer = config.transformer || {};
  const serializer = config.serializer || {};
  function isContained(candidate) {
    const child = path.relative(root, candidate);
    return child !== '..' && !child.startsWith('..' + path.sep) && !path.isAbsolute(child);
  }
  function isWithin(parent, candidate) {
    const child = path.relative(parent, candidate);
    return child !== '..' && !child.startsWith('..' + path.sep) && !path.isAbsolute(child);
  }
  function isExcluded(candidate) {
    const entry = path.relative(root, candidate).split(path.sep).join('/');
    return excludedRuntimeDirectories.some((excluded) =>
      entry === excluded ||
      entry.startsWith(excluded + '/') ||
      entry.endsWith('/' + excluded) ||
      entry.includes('/' + excluded + '/')
    );
  }
  function addPath(value, field) {
    if (value == null) return;
    if (typeof value !== 'string') {
      privateArrayPush(violations, field + ' must be a path');
      return;
    }
    try {
      privateSetAdd(runtimeInputs, fs.realpathSync(path.resolve(process.cwd(), value)));
    } catch {
      privateArrayPush(violations, field + ' cannot be resolved');
    }
  }
  function addPaths(values, field) {
    if (values == null) return;
    if (!Array.isArray(values)) {
      privateArrayPush(violations, field + ' must contain paths');
      return;
    }
    privateArrayForEach(values, (value) => addPath(value, field));
  }
  function addModule(value, field) {
    if (value == null) return null;
    if (typeof value !== 'string') {
      privateArrayPush(violations, field + ' must identify a module');
      return null;
    }
    try {
      const resolved = fs.realpathSync(require.resolve(value, { paths: [process.cwd()] }));
      privateSetAdd(runtimeInputs, resolved);
      if (!isContained(resolved) || isExcluded(resolved)) {
        privateArrayPush(
          violations,
          field + ' must resolve to Git-authenticated source or a local dependency store',
        );
      }
      return resolved;
    } catch {
      privateArrayPush(violations, field + ' cannot be resolved as an authenticated module');
      return null;
    }
  }
  function canonicalPackageRoot(packageName) {
    const entry = fs.realpathSync(require.resolve(packageName, { paths: [process.cwd()] }));
    let cursor = path.dirname(entry);
    while (true) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(cursor, 'package.json'), 'utf8'));
        if (manifest.name === packageName) return fs.realpathSync(cursor);
      } catch {}
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      cursor = parent;
    }
  }
  function addExecutableModule(value, field, supportedPackages) {
    const resolved = addModule(value, field);
    if (!resolved) return null;
    const packageName =
      supportedPackages.find((candidate) => {
        try {
          const packageRoot = canonicalPackageRoot(candidate);
          return packageRoot !== null && isWithin(packageRoot, resolved);
        } catch {
          return false;
        }
      }) || null;
    if (packageName === null) {
      privateArrayPush(violations, field + ' is not a supported Metro executable module');
    }
    return { resolved, packageName };
  }
  addPath(config.projectRoot, 'projectRoot');
  addPaths(config.watchFolders, 'watchFolders');
  addPaths(resolver.nodeModulesPaths, 'nodeModulesPaths');
  addPaths((process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), 'NODE_PATH');
  privateArrayForEach(callbackRuntimeInputs, (value) =>
    addModule(value, 'Metro callback runtime input')
  );
  if (resolver.extraNodeModules !== undefined) {
    if (!resolver.extraNodeModules || typeof resolver.extraNodeModules !== 'object' || Array.isArray(resolver.extraNodeModules)) {
      privateArrayPush(violations, 'extraNodeModules must be a path map');
    } else {
      privateArrayForEach(privateObjectValues(resolver.extraNodeModules), (value) =>
        addPath(value, 'extraNodeModules')
      );
    }
  }
  if (resolver.resolveRequest != null) {
    privateArrayPush(violations, 'custom Metro resolvers are unsupported');
  }
  const transformerPath = addExecutableModule(
    config.transformerPath,
    'transformerPath',
    ['metro-transform-worker', '@expo/metro-config'],
  );
  const babelTransformerPath = addExecutableModule(
    transformer.babelTransformerPath,
    'babelTransformerPath',
    ['metro-babel-transformer', '@react-native/metro-babel-transformer', '@expo/metro-config'],
  );
  const expoSerializerSupported =
    transformerPath?.packageName === '@expo/metro-config' ||
    babelTransformerPath?.packageName === '@expo/metro-config';
  const expoSerializer =
    typeof serializer.customSerializer === 'function' &&
    ('__originalSerializer' in serializer.customSerializer ||
      serializer.customSerializer.__expoSerializer === true);
  if (serializer.customSerializer != null && (!expoSerializerSupported || !expoSerializer)) {
    privateArrayPush(violations, 'custom Metro serializers are unsupported');
  }
  addExecutableModule(resolver.dependencyExtractor, 'dependencyExtractor', []);
  addExecutableModule(resolver.hasteImplModulePath, 'hasteImplModulePath', []);
  addExecutableModule(resolver.emptyModulePath, 'emptyModulePath', ['metro-runtime']);
  addExecutableModule(transformer.asyncRequireModulePath, 'asyncRequireModulePath', [
    'metro-runtime',
  ]);
  addExecutableModule(transformer.assetRegistryPath, 'assetRegistryPath', [
    '@react-native/assets-registry',
    'expo-asset',
  ]);
  addExecutableModule(transformer.minifierPath, 'minifierPath', ['metro-minify-terser']);
  if (transformer.assetPlugins != null) {
    if (!Array.isArray(transformer.assetPlugins)) {
      privateArrayPush(violations, 'assetPlugins must identify modules');
    } else {
      privateArrayForEach(transformer.assetPlugins, (value) =>
        addExecutableModule(value, 'assetPlugins', ['expo-asset', '@expo/metro-config'])
      );
    }
  }
  if (serializer.polyfillModuleNames != null) {
    if (!Array.isArray(serializer.polyfillModuleNames)) {
      privateArrayPush(violations, 'polyfillModuleNames must identify modules');
    } else {
      privateArrayForEach(serializer.polyfillModuleNames, (value) =>
        addModule(value, 'polyfillModuleNames')
      );
    }
  }
  const authorityPreload = process.env.RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD || '';
  const baseNodeOptions = process.env.RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS || '';
  const expectedNodeOptions = [baseNodeOptions, authorityPreload && '--require=' + canonicalAuthorityJson(authorityPreload)]
    .filter(Boolean)
    .join(' ');
  let authorityPreloadMatches = false;
  try {
    authorityPreloadMatches =
      fs.realpathSync(authorityPreload) === fs.realpathSync(__filename) &&
      (Number.isInteger(Number(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD)) ||
        fs.realpathSync(process.env.RN_DEV_AGENT_METRO_RUNTIME_LOADS) ===
          fs.realpathSync(path.join(process.cwd(), ${JSON.stringify(METRO_RUNTIME_LOADS)})));
  } catch {}
  if (
    !authorityPreload ||
    !authorityPreloadMatches ||
    process.env.NODE_OPTIONS !== expectedNodeOptions ||
    hasNodeLoaderOption(baseNodeOptions) ||
    hasUnsupportedNodeOption(baseNodeOptions)
  ) {
    privateArrayPush(violations, 'NODE_OPTIONS contain unsupported execution inputs');
  }
  if (!initialCacheCaptured) {
    privateArrayForEach(Object.keys(require.cache), (value) =>
      addPath(value, 'loaded Metro config module')
    );
    initialCacheCaptured = true;
  }
  privateSetForEach(runtimeInputs, (value) =>
    privateSetAdd(accumulatedRuntimeInputs, value),
  );
  privateArrayForEach(violations, (value) =>
    privateSetAdd(accumulatedViolations, value)
  );
  const payload = {
    version: 1,
    runtimeEvidenceAuthority: 'reported-v1',
    sessionId,
    metroInstanceId,
    contentRoot: root,
    appRoot: fs.realpathSync(process.cwd()),
    runtimeInputs: privateArraySort(privateSetValues(accumulatedRuntimeInputs)),
    violations: privateArraySort(privateSetValues(accumulatedViolations)),
  };
  const serializedPayload = canonicalAuthorityJson(payload);
  if (serializedPayload === lastPolicyPayload) return;
  const receipt = {
    ...payload,
    signature: createHmac('sha256', metroPolicyCapability)
      .update(serializedPayload)
      .digest('hex'),
  };
  const policyPath = path.join(process.cwd(), ${JSON.stringify(METRO_RUNTIME_POLICY)});
  const temporary = policyPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, canonicalAuthorityJson(receipt) + '\\n', { mode: 0o600 });
  fs.renameSync(temporary, policyPath);
  lastPolicyPayload = serializedPayload;
}
function withPolicyRefresh(callback, getConfig, includeReturnedPaths) {
  const wrapped = function (...args) {
    const loaderEpochBefore = loaderEpoch;
    const refresh = (returnedPaths) => {
      if (returnedPaths.length > 0 || loaderEpoch !== loaderEpochBefore) {
        runtimePolicy(getConfig(), returnedPaths);
      }
    };
    const finish = (value) => {
      const returnedPaths = includeReturnedPaths && Array.isArray(value) ? value : [];
      refresh(returnedPaths);
      return typeof value === 'function'
        ? withPolicyRefresh(value, getConfig, false)
        : value;
    };
    const fail = (error) => {
      refresh([]);
      throw error;
    };
    try {
      const result = callback.apply(this, args);
      return result && typeof result.then === 'function' ? result.then(finish, fail) : finish(result);
    } catch (error) {
      return fail(error);
    }
  };
  return Object.assign(wrapped, callback);
}
function withPolicyCallbacks(config, names, getConfig) {
  const callbacks = {};
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (typeof config[name] === 'function') {
      callbacks[name] = withPolicyRefresh(config[name], getConfig, false);
    }
  }
  return callbacks;
}
module.exports = function withRnDevAgentAuthority(config) {
  if (config && typeof config.then === 'function') {
    return config.then(withRnDevAgentAuthority);
  }
  const current = config || {};
  const resolver = current.resolver || {};
  const transformer = current.transformer || {};
  const serializer = current.serializer || {};
  const original = serializer.getModulesRunBeforeMainModule;
  const marker = path.join(process.cwd(), ${JSON.stringify(AUTHORITY_MODULE)});
  let finalConfig;
  finalConfig = {
    ...current,
    ...(Array.isArray(current.watchFolders) ? { watchFolders: [...current.watchFolders] } : {}),
    resolver: {
      ...resolver,
      ...(Array.isArray(resolver.nodeModulesPaths) ? { nodeModulesPaths: [...resolver.nodeModulesPaths] } : {}),
      ...(resolver.extraNodeModules && typeof resolver.extraNodeModules === 'object'
        ? { extraNodeModules: { ...resolver.extraNodeModules } }
        : {}),
    },
    transformer: {
      ...transformer,
      ...(Array.isArray(transformer.assetPlugins) ? { assetPlugins: [...transformer.assetPlugins] } : {}),
      ...(typeof transformer.getTransformOptions === 'function'
        ? { getTransformOptions: withPolicyRefresh(transformer.getTransformOptions, () => finalConfig, false) }
        : {}),
    },
    serializer: {
      ...serializer,
      ...(typeof serializer.customSerializer === 'function'
        ? { customSerializer: withPolicyRefresh(serializer.customSerializer, () => finalConfig, false) }
        : {}),
      ...withPolicyCallbacks(
        serializer,
        [
          'createModuleIdFactory',
          'processModuleFilter',
          'getRunModuleStatement',
          'isThirdPartyModule',
          'experimentalSerializerHook',
        ],
        () => finalConfig,
      ),
      ...(typeof serializer.getPolyfills === 'function'
        ? { getPolyfills: withPolicyRefresh(serializer.getPolyfills, () => finalConfig, true) }
        : {}),
      getModulesRunBeforeMainModule(entryFile) {
        const result = [marker, ...(typeof original === 'function' ? original(entryFile) : [])];
        runtimePolicy(finalConfig, result);
        return result;
      },
    },
  };
  runtimePolicy(finalConfig);
  return finalConfig;
};
`;
}
export function previewMetroIntegration(source) {
    const hasStart = source.includes(METRO_START);
    const hasEnd = source.includes(METRO_END);
    if (hasStart !== hasEnd) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
    }
    if (hasStart)
        return source;
    return `${source.trimEnd()}

${METRO_START}
module.exports = require('./${METRO_ADAPTER}')(module.exports);
${METRO_END}
`;
}
export function restoreMetroIntegration(source) {
    const start = source.indexOf(METRO_START);
    const end = source.indexOf(METRO_END);
    if (start < 0 && end < 0)
        return source;
    if (start < 0 ||
        end < start ||
        source.indexOf(METRO_START, start + METRO_START.length) >= 0 ||
        source.indexOf(METRO_END, end + METRO_END.length) >= 0) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
    }
    const blockEnd = end + METRO_END.length;
    const prefix = source.slice(0, start).trimEnd();
    const suffix = source.slice(blockEnd).replace(/^(?:\r?\n)+/, '');
    return suffix ? `${prefix}\n${suffix}` : `${prefix}\n`;
}
function parseSupportedScript(script, platform) {
    if (/[;&|`$<>()\\'"]/.test(script)) {
        throw new Error('SESSION_BUILD_COMMAND_UNSUPPORTED: shell syntax cannot be wrapped safely');
    }
    const command = script.trim().split(/\s+/).filter(Boolean);
    createBuildLaunchPlan({
        platform,
        command,
        session: {
            platform,
            deviceId: 'preview-device',
            metroPort: 8081,
            sessionId: 'preview-session',
        },
    });
    return command;
}
export function previewPackageIntegration(packageJson, existing, sessionCli) {
    if (existing &&
        packageJson.scripts?.ios === SENTINELS.ios &&
        packageJson.scripts?.android === SENTINELS.android) {
        return {
            packageJson,
            manifest: sessionCli ? { ...existing, sessionCli: resolve(sessionCli) } : existing,
        };
    }
    const ios = packageJson.scripts?.ios;
    const android = packageJson.scripts?.android;
    if (typeof ios !== 'string' || typeof android !== 'string') {
        throw new Error('SESSION_BUILD_COMMAND_UNSUPPORTED: ios and android scripts are required');
    }
    const manifest = {
        version: 1,
        adapter: ADAPTER,
        ...(sessionCli ? { sessionCli: resolve(sessionCli) } : {}),
        originalScripts: {
            ios: parseSupportedScript(ios, 'ios'),
            android: parseSupportedScript(android, 'android'),
        },
    };
    return {
        packageJson: {
            ...packageJson,
            scripts: { ...packageJson.scripts, ...SENTINELS },
        },
        manifest,
    };
}
export function restorePackageIntegration(packageJson, manifest) {
    if (packageJson.scripts?.ios !== SENTINELS.ios ||
        packageJson.scripts?.android !== SENTINELS.android) {
        throw new Error('SESSION_INTEGRATION_CONFLICT: package scripts changed after integration was installed');
    }
    return {
        ...packageJson,
        scripts: {
            ...packageJson.scripts,
            ios: manifest.originalScripts.ios.join(' '),
            android: manifest.originalScripts.android.join(' '),
        },
    };
}
export function renderProjectAdapter() {
    return String.raw `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const platform = process.argv[2];
if (platform !== 'ios' && platform !== 'android') {
  process.stderr.write('SESSION_BUILD_COMMAND_UNSUPPORTED: expected ios or android\n');
  process.exit(2);
}
const manifestPath = path.join(process.cwd(), '.rn-agent', 'integration', 'rn-session-integration.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const original = manifest.originalScripts && manifest.originalScripts[platform];
if (!Array.isArray(original) || original.length === 0 || original.some((part) => typeof part !== 'string')) {
  process.stderr.write('SESSION_BUILD_COMMAND_UNSUPPORTED: integration manifest is invalid\n');
  process.exit(2);
}
const command = [...original, ...process.argv.slice(3)];
let session = null;
let sessionCli = null;
if (typeof manifest.sessionCli === 'string' && !fs.existsSync(manifest.sessionCli)) {
  process.stderr.write('SESSION_AUTHORITY_REQUIRED: integrated rn-session CLI is unavailable; reapply integration\n');
  process.exit(2);
}
if (typeof manifest.sessionCli === 'string') {
  sessionCli = manifest.sessionCli;
  const [major, minor] = process.versions.node.split('.').map(Number);
  const sqliteFlag = (major === 22 && minor >= 5) || (major === 23 && minor < 6)
    ? ['--experimental-sqlite']
    : [];
  let probe = spawnSync(process.execPath, [...sqliteFlag, manifest.sessionCli, 'prepare-build', platform], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
  });
  if (probe.status !== 0 && String(probe.stderr).includes('live Metro binding')) {
    const metro = spawnSync(process.execPath, [...sqliteFlag, manifest.sessionCli, 'ensure-metro'], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    if (metro.status !== 0) {
      process.stderr.write(String(metro.stderr) || 'METRO_START_UNAVAILABLE: managed Metro failed\n');
      process.exit(2);
    }
    probe = spawnSync(process.execPath, [...sqliteFlag, manifest.sessionCli, 'prepare-build', platform], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
  }
  if (probe.status === 0) {
    try {
      session = JSON.parse(probe.stdout);
    } catch {
      process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: rn-session returned invalid JSON\n');
      process.exit(2);
    }
  } else if (!String(probe.stderr).includes('no live session matches this canonical worktree')) {
    process.stderr.write(String(probe.stderr) || 'SESSION_AUTHORITY_REQUIRED: rn-session lookup failed\n');
    process.exit(2);
  }
}
function ensureValue(flag, value) {
  const index = command.indexOf(flag);
  if (index >= 0) {
    if (command[index + 1] !== value) {
      process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: ' + flag + ' contradicts the active session\n');
      process.exit(2);
    }
    return;
  }
  command.push(flag, value);
}
function ensureFlag(flag) {
  if (!command.includes(flag)) command.push(flag);
}

if (session) {
  if (session.platform !== platform || typeof session.deviceId !== 'string' || typeof session.appId !== 'string' || !Number.isInteger(session.metroPort) || typeof session.sessionId !== 'string' || typeof session.buildToken !== 'string') {
    process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: session binding is incomplete\n');
    process.exit(2);
  }
  if (!sessionCli) {
    process.stderr.write('SESSION_AUTHORITY_REQUIRED: session build completion requires the package-local rn-session CLI\n');
    process.exit(2);
  }
  const offset = command[0] === 'npx' ? 1 : 0;
  const executable = command[offset];
  const subcommand = command[offset + 1];
  if (executable === 'expo' && subcommand === 'run:' + platform) {
    ensureValue('--device', session.deviceId);
    ensureValue('--port', String(session.metroPort));
    ensureFlag('--no-bundler');
  } else if (executable === 'react-native' && platform === 'ios' && subcommand === 'run-ios') {
    ensureValue('--udid', session.deviceId);
    ensureValue('--port', String(session.metroPort));
    ensureFlag('--no-packager');
  } else if (executable === 'react-native' && platform === 'android' && subcommand === 'run-android') {
    ensureValue('--deviceId', session.deviceId);
    ensureValue('--port', String(session.metroPort));
    ensureFlag('--no-packager');
  } else {
    process.stderr.write('SESSION_BUILD_COMMAND_UNSUPPORTED: command shape is not recognized\n');
    process.exit(2);
  }
}

const child = spawnSync(command[0], command.slice(1), {
  cwd: process.cwd(),
  env: session ? {
    ...process.env,
    RCT_METRO_PORT: String(session.metroPort),
    RN_DEV_AGENT_SESSION_ID: session.sessionId,
  } : process.env,
  stdio: 'inherit',
});
if (child.error) {
  process.stderr.write('rn-session-adapter: ' + child.error.message + '\n');
  process.exit(1);
}
if (child.status !== 0) process.exit(child.status === null ? 1 : child.status);
if (session) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const sqliteFlag = (major === 22 && minor >= 5) || (major === 23 && minor < 6)
    ? ['--experimental-sqlite']
    : [];
  const complete = spawnSync(process.execPath, [...sqliteFlag, sessionCli, 'complete-build', platform, session.buildToken], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      RN_DEV_AGENT_SESSION_ID: session.sessionId,
    },
    encoding: 'utf8',
  });
  if (complete.status !== 0) {
    process.stderr.write(String(complete.stderr) || 'APP_INSTALL_IDENTITY_CHANGED: build receipt could not be recorded\n');
    process.exit(2);
  }
  process.stdout.write(String(complete.stdout));
}
process.exit(0);
`;
}
function snapshotBoundFiles(directory, directoryPath, names) {
    return readBoundDirectoryFiles(directory, names).map((snapshot) => ({
        ...snapshot,
        path: join(directoryPath, snapshot.name),
    }));
}
function casReplaceBoundBatch(directory, writes, dependencies = {}) {
    return casBoundDirectoryFiles(directory, writes.map((write) => ({
        expected: write.expected,
        expectedMode: write.expectedMode ?? write.snapshot.mode,
        mode: write.mode,
        name: write.snapshot.name,
        replacement: write.replacement,
    })), dependencies);
}
function assertBoundCleanup(result) {
    if (result.cleanupPending) {
        const transaction = result.cleanupObligation?.transactionId ?? 'unknown transaction';
        throw new Error(`SESSION_INTEGRATION_PATH_UNSAFE: committed cleanup remains pending: ${transaction}: ${result.cleanupError ?? 'cleanup unavailable'}`);
    }
}
export function assertNoSymlinkPath(root, candidate) {
    const child = relative(root, candidate);
    if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration path escapes the app root');
    }
    let current = root;
    for (const component of [root, ...child.split(sep).filter(Boolean)]) {
        current = component === root ? root : join(current, component);
        try {
            if (lstatSync(current).isSymbolicLink()) {
                throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration path is symlinked');
            }
        }
        catch (error) {
            if (error.code === 'ENOENT')
                break;
            throw error;
        }
    }
}
function regularFileIdentity(root, candidate) {
    assertNoSymlinkPath(root, candidate);
    const identity = lstatSync(candidate, { bigint: true });
    if (!identity.isFile()) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration input is not a regular file');
    }
    return { dev: identity.dev, ino: identity.ino };
}
function readRegularFile(root, candidate) {
    const before = regularFileIdentity(root, candidate);
    const descriptor = openSync(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = fstatSync(descriptor, { bigint: true });
        const after = regularFileIdentity(root, candidate);
        if (!opened.isFile() ||
            before.dev !== opened.dev ||
            before.ino !== opened.ino ||
            after.dev !== opened.dev ||
            after.ino !== opened.ino) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration input changed while opening');
        }
        return readFileSync(descriptor, 'utf8');
    }
    finally {
        closeSync(descriptor);
    }
}
function readOptionalRegularFile(root, candidate) {
    try {
        return readRegularFile(root, candidate);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return undefined;
        throw error;
    }
}
export function readRegularFileNoFollow(root, candidate) {
    return readRegularFile(root, candidate);
}
export function readOptionalRegularFileNoFollow(root, candidate) {
    return readOptionalRegularFile(root, candidate);
}
export function readPackageIntegrationInputs(appRootInput, dependencies = {}) {
    const appRoot = resolve(appRootInput);
    const app = openBoundDirectory(appRoot);
    let agent = null;
    let integration = null;
    let primaryError;
    try {
        const [packageSnapshot, metroJsSnapshot, metroCjsSnapshot] = readBoundDirectoryFiles(app, [
            'package.json',
            'metro.config.js',
            'metro.config.cjs',
        ]);
        if (!packageSnapshot?.contents) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: package.json is unavailable');
        }
        const metroSnapshot = metroJsSnapshot?.contents ? metroJsSnapshot : metroCjsSnapshot;
        if (!metroSnapshot?.contents) {
            throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required');
        }
        dependencies.afterAppRead?.();
        agent = openOptionalBoundSubdirectory(app, '.rn-agent');
        if (agent) {
            integration = openOptionalBoundSubdirectory(agent, 'integration');
        }
        const manifest = integration
            ? readBoundDirectoryFiles(integration, ['rn-session-integration.json'])[0]?.contents
            : null;
        return {
            packageJson: packageSnapshot.contents.toString('utf8'),
            metroConfig: {
                contents: metroSnapshot.contents.toString('utf8'),
                path: join(appRoot, metroSnapshot.name),
            },
            ...(manifest ? { manifest: manifest.toString('utf8') } : {}),
        };
    }
    catch (error) {
        primaryError = error;
        throw error;
    }
    finally {
        closeBoundDirectories([integration, agent, app], primaryError);
    }
}
function openIntegrationDirectories(appRoot) {
    const app = openBoundDirectory(appRoot);
    try {
        const agent = openBoundSubdirectory(app, '.rn-agent', { create: true });
        try {
            const integration = openBoundSubdirectory(agent, 'integration', { create: true });
            return { app, agent, integration };
        }
        catch (error) {
            closeBoundDirectories([agent], error);
            throw error;
        }
    }
    catch (error) {
        closeBoundDirectories([app], error);
        throw error;
    }
}
function rollbackWrites(writes, dependencies) {
    const errors = [];
    for (const write of [...writes].reverse()) {
        try {
            const result = casReplaceBoundBatch(write.directory, [
                {
                    snapshot: write.snapshot,
                    expected: write.written,
                    expectedMode: write.writtenMode,
                    replacement: write.snapshot.contents,
                    mode: write.snapshot.mode,
                },
            ], dependencies);
            assertBoundCleanup(result);
        }
        catch (error) {
            errors.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    return errors;
}
export function applyPackageIntegration(input, dependencies = {}) {
    const appRoot = resolve(input.appRoot);
    const packagePath = join(appRoot, 'package.json');
    let metroConfigPath;
    for (const path of ['metro.config.js', 'metro.config.cjs'].map((name) => join(appRoot, name))) {
        if (readOptionalRegularFileNoFollow(appRoot, path) !== undefined) {
            metroConfigPath = path;
            break;
        }
    }
    if (!metroConfigPath) {
        throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required');
    }
    const directories = openIntegrationDirectories(appRoot);
    const generatedNames = [
        'rn-session-integration.json',
        'rn-session-adapter.cjs',
        'rn-session-metro.cjs',
        'authority-marker.js',
        'metro-runtime-policy.json',
        basename(METRO_RUNTIME_LOADS),
    ];
    const applied = [];
    let primaryError;
    try {
        const [packageSnapshot, metroSnapshot] = snapshotBoundFiles(directories.app, appRoot, [
            basename(packagePath),
            basename(metroConfigPath),
        ]);
        const generated = snapshotBoundFiles(directories.integration, directories.integration.path, generatedNames);
        if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
            throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
        }
        const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8'));
        let existing;
        if (generated[0]?.contents) {
            try {
                existing = JSON.parse(generated[0].contents.toString('utf8'));
            }
            catch (error) {
                if (!(error instanceof SyntaxError))
                    throw error;
            }
        }
        const preview = previewPackageIntegration(packageJson, existing, input.sessionCli);
        const nextMetroSource = previewMetroIntegration(metroSnapshot.contents.toString('utf8'));
        preview.manifest.metroConfig = metroConfigPath.slice(appRoot.length + 1);
        dependencies.beforeCommit?.();
        const outputs = [
            {
                snapshot: generated[0],
                contents: Buffer.from(`${JSON.stringify(preview.manifest, null, 2)}\n`),
                mode: 0o600,
            },
            { snapshot: generated[1], contents: Buffer.from(renderProjectAdapter()), mode: 0o755 },
            {
                snapshot: generated[2],
                contents: Buffer.from(renderMetroIntegrationAdapter()),
                mode: 0o644,
            },
            {
                snapshot: generated[3],
                contents: Buffer.from("globalThis.__RN_DEV_AGENT_AUTHORITY__={status:'unavailable',authorityScope:'initial-bundle',sourceFidelity:'not-proven'};\n"),
                mode: 0o600,
            },
        ];
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
        const generatedResult = casReplaceBoundBatch(directories.integration, outputs.map((output) => ({
            snapshot: output.snapshot,
            expected: output.snapshot.contents,
            replacement: output.contents,
            mode: output.mode,
        })), dependencies.boundOperationDependencies);
        for (const output of outputs) {
            applied.push({
                snapshot: output.snapshot,
                written: output.contents,
                writtenMode: output.mode,
                directory: directories.integration,
            });
            dependencies.afterWrite?.(output.snapshot.path);
        }
        assertBoundCleanup(generatedResult);
        const metroOutput = Buffer.from(nextMetroSource);
        const metroResult = casReplaceBoundBatch(directories.app, [
            {
                snapshot: metroSnapshot,
                expected: metroSnapshot.contents,
                replacement: metroOutput,
                mode: metroSnapshot.mode,
            },
        ], dependencies.boundOperationDependencies);
        applied.push({
            snapshot: metroSnapshot,
            written: metroOutput,
            writtenMode: metroSnapshot.mode,
            directory: directories.app,
        });
        dependencies.afterWrite?.(metroConfigPath);
        assertBoundCleanup(metroResult);
        const packageOutput = Buffer.from(`${JSON.stringify(preview.packageJson, null, 2)}\n`);
        const packageResult = casReplaceBoundBatch(directories.app, [
            {
                snapshot: packageSnapshot,
                expected: packageSnapshot.contents,
                replacement: packageOutput,
                mode: packageSnapshot.mode,
            },
        ], dependencies.boundOperationDependencies);
        applied.push({
            snapshot: packageSnapshot,
            written: packageOutput,
            writtenMode: packageSnapshot.mode,
            directory: directories.app,
        });
        dependencies.afterWrite?.(packagePath);
        assertBoundCleanup(packageResult);
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
        return preview;
    }
    catch (error) {
        const rollbackErrors = rollbackWrites(applied, dependencies.boundOperationDependencies);
        primaryError =
            rollbackErrors.length > 0 ? new AggregateError([error, ...rollbackErrors]) : error;
        throw primaryError;
    }
    finally {
        closeBoundDirectories([directories.integration, directories.agent, directories.app], primaryError);
    }
}
export function restorePackageIntegrationFiles(input, dependencies = {}) {
    const appRoot = resolve(input.appRoot);
    const packagePath = join(appRoot, 'package.json');
    const directories = openIntegrationDirectories(appRoot);
    const generatedNames = [
        'rn-session-integration.json',
        'rn-session-adapter.cjs',
        'rn-session-metro.cjs',
        'authority-marker.js',
        'metro-runtime-policy.json',
        basename(METRO_RUNTIME_LOADS),
    ];
    const applied = [];
    let primaryError;
    try {
        const generatedSnapshots = snapshotBoundFiles(directories.integration, directories.integration.path, generatedNames);
        if (!generatedSnapshots[0]?.contents) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration manifest is missing');
        }
        const manifest = JSON.parse(generatedSnapshots[0].contents.toString('utf8'));
        const metroConfig = manifest.metroConfig === undefined ? 'metro.config.js' : manifest.metroConfig;
        if (metroConfig !== 'metro.config.js' && metroConfig !== 'metro.config.cjs') {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: manifest Metro config is not an expected app-root config');
        }
        const metroConfigPath = join(appRoot, metroConfig);
        const [packageSnapshot, metroSnapshot] = snapshotBoundFiles(directories.app, appRoot, [
            basename(packagePath),
            basename(metroConfigPath),
        ]);
        if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
            throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
        }
        const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8'));
        const metroSource = metroSnapshot.contents.toString('utf8');
        dependencies.beforeCommit?.();
        const packageOutput = Buffer.from(`${JSON.stringify(restorePackageIntegration(packageJson, manifest), null, 2)}\n`);
        const packageResult = casReplaceBoundBatch(directories.app, [
            {
                snapshot: packageSnapshot,
                expected: packageSnapshot.contents,
                replacement: packageOutput,
                mode: packageSnapshot.mode,
            },
        ]);
        applied.push({
            snapshot: packageSnapshot,
            written: packageOutput,
            writtenMode: packageSnapshot.mode,
            directory: directories.app,
        });
        dependencies.afterWrite?.(packagePath);
        assertBoundCleanup(packageResult);
        const metroOutput = Buffer.from(restoreMetroIntegration(metroSource));
        const metroResult = casReplaceBoundBatch(directories.app, [
            {
                snapshot: metroSnapshot,
                expected: metroSnapshot.contents,
                replacement: metroOutput,
                mode: metroSnapshot.mode,
            },
        ]);
        applied.push({
            snapshot: metroSnapshot,
            written: metroOutput,
            writtenMode: metroSnapshot.mode,
            directory: directories.app,
        });
        dependencies.afterWrite?.(metroConfigPath);
        assertBoundCleanup(metroResult);
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
        const generatedResult = casReplaceBoundBatch(directories.integration, generatedSnapshots.map((snapshot) => ({
            snapshot,
            expected: snapshot.contents,
            replacement: null,
            mode: snapshot.mode,
        })), dependencies.boundOperationDependencies);
        for (const snapshot of generatedSnapshots) {
            applied.push({
                snapshot,
                written: null,
                directory: directories.integration,
            });
        }
        assertBoundCleanup(generatedResult);
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
    }
    catch (error) {
        const rollbackErrors = rollbackWrites(applied);
        primaryError =
            rollbackErrors.length > 0 ? new AggregateError([error, ...rollbackErrors]) : error;
        throw primaryError;
    }
    finally {
        closeBoundDirectories([directories.integration, directories.agent, directories.app], primaryError);
    }
}
