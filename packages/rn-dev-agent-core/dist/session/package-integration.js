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
const moduleApi = require('node:module');
const { registerHooks } = moduleApi;
const { fileURLToPath } = require('node:url');
const { deserialize, serialize } = require('node:v8');
const workerThreads = require('node:worker_threads');
${parseNodeOptions.toString()}
${hasNodeLoaderOption.toString()}
${hasUnsupportedNodeOption.toString()}
const accumulatedRuntimeInputs = new Set();
const accumulatedViolations = new Set();
const observedLoaderDigests = new Map();
const metroPolicyCapability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const usesExternalEvidenceOwner = Boolean(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD);
const authorityEnvironment = Object.entries(process.env).filter(
  ([key]) =>
    (key === 'NODE_OPTIONS' || key.startsWith('RN_DEV_AGENT_')) &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_NONCE' &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_SEMANTICS' &&
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
  const payload = { version: 1, sessionId, metroInstanceId, kind, value, digest };
  if (Number.isInteger(evidenceDescriptor) && evidenceDescriptor >= 3) {
    writeRuntimeLoad(JSON.stringify(payload) + '\\n', evidenceDescriptor);
    return;
  }
  if (!metroPolicyCapability || !loadsPath) return;
  const serializedPayload = JSON.stringify(payload);
  const receipt = {
    ...payload,
    signature: createHmac('sha256', metroPolicyCapability)
      .update(serializedPayload)
      .digest('hex'),
  };
  writeRuntimeLoad(JSON.stringify(receipt) + '\\n', loadsPath);
}
const effectiveBaseNodeOptions = parseNodeOptions(
  process.env.RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS || '',
);
persistLoaderObservation(
  'semantics',
  JSON.stringify({ mode: 'metro', nodeOptions: effectiveBaseNodeOptions }),
);
function recordLoaderViolation(value) {
  if (accumulatedViolations.has(value)) return;
  accumulatedViolations.add(value);
  loaderEpoch += 1;
  persistLoaderObservation('violation', value);
}
const nativeChannelContexts = new WeakMap();
const fencedNativeChannelPrototypes = new WeakSet();
const descendantNonce = process.env.RN_DEV_AGENT_METRO_DESCENDANT_NONCE;
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
  const identity = workerThreads.isMainThread
    ? 'process:' + process.pid
    : 'worker:' + workerThreads.threadId;
  if (descendantSemantics && /^[a-f0-9]{64}$/.test(descendantSemantics)) {
    persistLoaderObservation(
      'attestation',
      descendantNonce + ':' + identity + ':' + descendantSemantics,
    );
  } else {
    recordLoaderViolation('Metro descendant execution semantics are unavailable');
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
      const processChannelHandleSymbol = Object.getOwnPropertySymbols(process).find(
        (symbol) => symbol.description === 'kChannelHandle',
      );
      const processChannelHandle = process[processChannelHandleSymbol];
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
              Reflect.apply(processChannelClose, processChannelHandle, []),
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
              Reflect.apply(processDisconnectDelegate, process, []),
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
                  Reflect.apply(processDisconnectDelegate, process, []),
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
                return Reflect.apply(processDisconnectImplementation, process, []);
              } finally {
                descendantLifecycleContext.disconnectDepth -= 1;
              }
            },
          );
        },
        writable: false,
      });
      fenceNativeChannel(processChannelHandle, descendantMessageContext, new Set(['close']));
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
  for (const [key, value] of Object.entries(environment || process.env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'NODE_OPTIONS' || normalizedKey.startsWith('RN_DEV_AGENT_')) continue;
    entries.push([key, value]);
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}
function authenticatedChildEnvironment(entries, nonce, semantics) {
  const nextEnvironment = Object.fromEntries(entries);
  for (const [key, value] of authorityEnvironment) nextEnvironment[key] = value;
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_NONCE = nonce;
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_SEMANTICS = semantics;
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
  const seen = new WeakSet();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate instanceof SharedArrayBuffer) throw descendantError();
    if (!candidate || typeof candidate !== 'object' || seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof Map) {
      for (const [key, entry] of candidate) pending.push(key, entry);
      continue;
    }
    if (candidate instanceof Set) {
      pending.push(...candidate);
      continue;
    }
    pending.push(...Object.values(candidate));
  }
  return {
    digest: createHash('sha256').update(bytes).digest('hex'),
    value: cloned,
  };
}
function digestInvocation(value) {
  return snapshotInvocation(value).digest;
}
const childMessageContexts = new WeakMap();
const childSendImplementations = new WeakMap();
const childSendPrimitiveImplementations = new WeakMap();
const childDisconnectImplementations = new WeakMap();
const childLifecycleContexts = new WeakMap();
const childLifecycleTargets = new WeakMap();
const workerMessageContexts = new WeakMap();
const workerLifecycleContexts = new WeakMap();
const portMessageContexts = new WeakMap();
const processLifecycleTargets = new Map();
let childSpawnDepth = 0;
function authenticatedMessage(context, value) {
  const snapshot = snapshotInvocation(value);
  context.sequence += 1;
  persistLoaderObservation(
    'semantics',
    JSON.stringify({
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
  return Reflect.apply(original, receiver, [authenticatedMessage(context, message)]);
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
      return Reflect.apply(original, receiver, [message, sendHandle, options, callback]);
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
  const authenticated = authenticatedMessage(context, { message, options: nextOptions });
  const completionCallback =
    nextCallback === undefined || typeof nextCallback === 'function'
      ? function (...callbackArgs) {
          const authenticatedCompletion = authenticatedMessage(context, {
            status: 'completed',
            callbackArgs,
          });
          if (typeof nextCallback === 'function') {
            return Reflect.apply(nextCallback, this, authenticatedCompletion.callbackArgs);
          }
        }
      : nextCallback;
  context.sendDepth += 1;
  try {
    if (primitive) context.nativeWriteDepth += 1;
    let result;
    try {
      result = Reflect.apply(original, receiver, [
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
function fenceNativeChannel(handle, context, allowedOwnControls = new Set()) {
  if (!handle || !context) throw descendantError();
  nativeChannelContexts.set(handle, context);
  for (
    let owner = handle;
    owner && owner !== Object.prototype;
    owner = Object.getPrototypeOf(owner)
  ) {
    if (fencedNativeChannelPrototypes.has(owner)) continue;
    fencedNativeChannelPrototypes.add(owner);
    for (const name of Object.getOwnPropertyNames(owner)) {
      const isWrite = name.startsWith('write');
      const isControl = ['close', 'readStart', 'readStop', 'shutdown'].includes(name);
      if ((!isWrite && !isControl) || (owner === handle && allowedOwnControls.has(name))) {
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (typeof descriptor?.value !== 'function') continue;
      const implementation = descriptor.value;
      Object.defineProperty(owner, name, {
        configurable: false,
        enumerable: false,
        value(...args) {
          const channelContext = nativeChannelContexts.get(this);
          if (channelContext && isWrite && channelContext.nativeWriteDepth <= 0) {
            throw descendantError();
          }
          if (channelContext && isControl && channelContext.nativeControlDepth <= 0) {
            if (name === 'shutdown') throw descendantError();
            return authenticatedLifecycleResult(
              channelContext.nativeControlContext,
              name,
              undefined,
              () => Reflect.apply(implementation, this, args),
            );
          }
          return Reflect.apply(implementation, this, args);
        },
        writable: false,
      });
    }
  }
}
function invocationCwd(cwd) {
  try {
    return fs.realpathSync(cwd || process.cwd());
  } catch {
    throw descendantError();
  }
}
function authenticatedChildArguments(args, optionsIndex, options, nonce, semantics) {
  const nextArgs = [...args];
  const candidate = nextArgs[optionsIndex];
  const authenticatedOptions = {
    ...options,
    env: authenticatedChildEnvironment(Object.entries(options.env), nonce, semantics),
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
    while (normalized.length <= evidenceDescriptor) normalized.push('ignore');
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
const safeBooleanNodeOptions = new Set([
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
const safeValueNodeOptions = new Set(['--conditions', '--title']);
function normalizeSafeNodeOption(args, index) {
  const argument = args[index];
  if (typeof argument !== 'string' || isInlineNodeOption(argument)) throw descendantError();
  const equals = argument.indexOf('=');
  const option = (equals < 0 ? argument : argument.slice(0, equals)).replaceAll('_', '-');
  if (safeBooleanNodeOptions.has(option)) {
    if (equals >= 0) throw descendantError();
    return { index, value: option };
  }
  if (!safeValueNodeOptions.has(option)) throw descendantError();
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
    execArgv.push(normalized.value);
    index = normalized.index;
  }
  return {
    entrypoint: requireFileBackedEntrypoint(entrypoint, cwd),
    execArgv,
    applicationArgs: args.slice(entrypointIndex + 1).map((value) => {
      if (typeof value !== 'string') throw descendantError();
      return value;
    }),
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
    normalized.push(option.value);
    index = option.index;
  }
  return normalized;
}
function executionSemantics(mode, entrypoint, execArgv, invocation) {
  const value = JSON.stringify({
    mode,
    entrypoint,
    execArgv,
    invocationDigest: digestInvocation(invocation),
  });
  persistLoaderObservation('semantics', value);
  return createHash('sha256').update(value).digest('hex');
}
function recordChildLaunch(nonce, child, semantics) {
  if (!child || typeof child.pid !== 'number') return;
  persistLoaderObservation('launch', nonce + ':process:' + child.pid + ':' + semantics);
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
  Object.defineProperty(childPrototype, 'spawn', {
    configurable: false,
    enumerable: true,
    value(options) {
      if (childSpawnDepth <= 0) throw descendantError();
      return Reflect.apply(originalChildSpawn, this, [options]);
    },
    writable: false,
  });
  const authenticatedChildSend = function (message, sendHandle, options, callback) {
    const implementation = childSendImplementations.get(this);
    if (!implementation || !childMessageContexts.has(this)) throw descendantError();
    return authenticatedIpcSend(
      implementation,
      this,
      childMessageContexts.get(this),
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
        (!childSendImplementations.has(this) || !childMessageContexts.has(this))
      ) {
        return undefined;
      }
      return authenticatedChildSend;
    },
    set(value) {
      if (typeof value !== 'function' || childSendImplementations.has(this)) {
        throw descendantError();
      }
      childSendImplementations.set(this, value);
    },
  });
  const authenticatedChildSendPrimitive = function (message, sendHandle, options, callback) {
    return authenticatedIpcSend(
      childSendPrimitiveImplementations.get(this),
      this,
      childMessageContexts.get(this),
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
        (!childSendPrimitiveImplementations.has(this) || !childMessageContexts.has(this))
      ) {
        return undefined;
      }
      return authenticatedChildSendPrimitive;
    },
    set(value) {
      if (typeof value !== 'function' || childSendPrimitiveImplementations.has(this)) {
        throw descendantError();
      }
      childSendPrimitiveImplementations.set(this, value);
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
        workerMessageContexts.get(this),
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
        workerLifecycleContexts.get(this),
        'terminate',
        undefined,
        () => Reflect.apply(originalWorkerTerminate, this, []),
      );
    },
    writable: false,
  });
  const originalChildKill = childPrototype.kill;
  const originalProcessKill = process.kill;
  const normalizeChildSignal = (signal) => {
    let normalizedSignal;
    Reflect.apply(
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
      const target = childLifecycleTargets.get(this);
      return authenticatedLifecycleResult(
        target?.context,
        'kill',
        signal,
        (authenticatedSignal) => {
          const normalizedSignal = normalizeChildSignal(authenticatedSignal);
          if (target.pid === undefined) return false;
          if (processLifecycleTargets.get(target.pid) !== target) return false;
          try {
            const result = Reflect.apply(originalProcessKill, process, [
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
      childLifecycleContexts.get(this),
      'disconnect',
      undefined,
      () =>
        withNativeChannelControl(childMessageContexts.get(this), () =>
          Reflect.apply(childDisconnectImplementations.get(this), this, []),
        ),
    );
  };
  Object.defineProperty(childPrototype, 'disconnect', {
    configurable: false,
    enumerable: true,
    get() {
      if (
        this !== childPrototype &&
        (!childDisconnectImplementations.has(this) || !childLifecycleContexts.has(this))
      ) {
        return undefined;
      }
      return authenticatedChildDisconnect;
    },
    set(value) {
      if (typeof value !== 'function') throw descendantError();
      childDisconnectImplementations.set(this, value);
    },
  });
  Object.defineProperty(process, 'kill', {
    configurable: false,
    enumerable: true,
    value(pid, signal) {
      const target = processLifecycleTargets.get(pid);
      if (!target) throw descendantError();
      return authenticatedLifecycleResult(
        target.context,
        'kill',
        { pid, signal },
        (authenticated) =>
          Reflect.apply(originalProcessKill, process, [
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
      const context = portMessageContexts.get(this);
      if (!context) {
        return Reflect.apply(originalPortPostMessage, this, [message, transferList]);
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
      portMessageContexts.set(this.port1, { blocked: true });
      portMessageContexts.set(this.port2, { blocked: true });
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
        env: Object.fromEntries(environmentEntries),
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
        nonce,
        semantics,
      );
      const options = authenticatedArgs[index];
      if (mode === 'fork') {
        options.execPath = nodeExecutable;
      }
      childSpawnDepth += 1;
      let child;
      try {
        child = Reflect.apply(original, this, authenticatedArgs);
      } finally {
        childSpawnDepth -= 1;
      }
      if (mode === 'sync') {
        recordChildLaunch(nonce, child, semantics);
      } else if (typeof child?.once === 'function') {
        child.once('spawn', () => recordChildLaunch(nonce, child, semantics));
      }
      if (mode !== 'sync') {
        const context = lifecycleContext('child-lifecycle', nonce);
        const target = {
          pid: typeof child?.pid === 'number' ? child.pid : undefined,
          context,
        };
        childLifecycleContexts.set(child, context);
        childLifecycleTargets.set(child, target);
        if (target.pid !== undefined) {
          const pid = target.pid;
          processLifecycleTargets.set(pid, target);
          child.once?.('exit', () => {
            if (processLifecycleTargets.get(pid) === target) {
              processLifecycleTargets.delete(pid);
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
        childMessageContexts.set(child, messageContext);
        const channelHandleSymbol = Object.getOwnPropertySymbols(child).find(
          (symbol) => symbol.description === 'kChannelHandle',
        );
        fenceNativeChannel(child[channelHandleSymbol], messageContext);
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
    invocationOptions.env = Object.fromEntries(
      snapshotInvocation(normalizedInvocationEnvironment(capturedOptions.env)).value,
    );
    const authenticatedInvocationOptions = snapshotInvocation(invocationOptions).value;
    const semantics = executionSemantics(
      'worker',
      entrypoint,
      normalizedExecArgv,
      {
        options: authenticatedInvocationOptions,
      },
    );
    const worker = Reflect.construct(OriginalWorker, [
      entrypoint,
      {
        ...authenticatedInvocationOptions,
        env: authenticatedChildEnvironment(
          Object.entries(authenticatedInvocationOptions.env),
          nonce,
          semantics,
        ),
        execArgv: ['--require', authorityPreload, ...requestedExecArgv],
      },
    ]);
    workerMessageContexts.set(worker, {
      mode: 'worker-message',
      recipient: nonce,
      sequence: 0,
    });
    workerLifecycleContexts.set(worker, lifecycleContext('worker-lifecycle', nonce));
    persistLoaderObservation(
      'launch',
      nonce + ':worker:' + worker.threadId + ':' + semantics,
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
      portMessageContexts.set(workerThreads.parentPort, descendantMessageContext);
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
const rejectNativeAddonLoad = () => {
  recordLoaderViolation('Metro runtime native addons are unsupported for strict proof');
  const error = new Error('RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON');
  error.code = 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON';
  throw error;
};
Object.defineProperty(process, 'dlopen', {
  configurable: false,
  enumerable: true,
  value: rejectNativeAddonLoad,
  writable: false,
});
function digestRuntimeFile(file) {
  const descriptor = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 128 * 1024 * 1024) {
      throw new Error('unsupported runtime module file');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    while ((bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(descriptor);
  }
}
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
    recordLoaderViolation('Metro runtime native addons are unsupported for strict proof');
    return;
  }
  try {
    const resolved = fs.realpathSync(fileURLToPath(url));
    const digest = digestRuntimeSource(result && result.source);
    if (observedLoaderDigests.get(resolved) === digest) return;
    observedLoaderDigests.set(resolved, digest);
    accumulatedRuntimeInputs.add(resolved);
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
observedLoaderDigests.set(preloadPath, preloadDigest);
accumulatedRuntimeInputs.add(preloadPath);
loaderEpoch += 1;
persistLoaderObservation('input', preloadPath, preloadDigest);
function sourceRoot() {
  if (sourceRootResolved) return cachedSourceRoot;
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
  const runtimeInputs = new Set();
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
      violations.push(field + ' must be a path');
      return;
    }
    try {
      runtimeInputs.add(fs.realpathSync(path.resolve(process.cwd(), value)));
    } catch {
      violations.push(field + ' cannot be resolved');
    }
  }
  function addPaths(values, field) {
    if (values == null) return;
    if (!Array.isArray(values)) {
      violations.push(field + ' must contain paths');
      return;
    }
    values.forEach((value) => addPath(value, field));
  }
  function addModule(value, field) {
    if (value == null) return null;
    if (typeof value !== 'string') {
      violations.push(field + ' must identify a module');
      return null;
    }
    try {
      const resolved = fs.realpathSync(require.resolve(value, { paths: [process.cwd()] }));
      runtimeInputs.add(resolved);
      if (!isContained(resolved) || isExcluded(resolved)) {
        violations.push(field + ' must resolve to Git-authenticated source or a local dependency store');
      }
      return resolved;
    } catch {
      violations.push(field + ' cannot be resolved as an authenticated module');
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
      violations.push(field + ' is not a supported Metro executable module');
    }
    return { resolved, packageName };
  }
  addPath(config.projectRoot, 'projectRoot');
  addPaths(config.watchFolders, 'watchFolders');
  addPaths(resolver.nodeModulesPaths, 'nodeModulesPaths');
  addPaths((process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean), 'NODE_PATH');
  callbackRuntimeInputs.forEach((value) => addModule(value, 'Metro callback runtime input'));
  if (resolver.extraNodeModules !== undefined) {
    if (!resolver.extraNodeModules || typeof resolver.extraNodeModules !== 'object' || Array.isArray(resolver.extraNodeModules)) {
      violations.push('extraNodeModules must be a path map');
    } else {
      Object.values(resolver.extraNodeModules).forEach((value) => addPath(value, 'extraNodeModules'));
    }
  }
  if (resolver.resolveRequest != null) {
    violations.push('custom Metro resolvers are unsupported');
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
    violations.push('custom Metro serializers are unsupported');
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
      violations.push('assetPlugins must identify modules');
    } else {
      transformer.assetPlugins.forEach((value) =>
        addExecutableModule(value, 'assetPlugins', ['expo-asset', '@expo/metro-config'])
      );
    }
  }
  if (serializer.polyfillModuleNames != null) {
    if (!Array.isArray(serializer.polyfillModuleNames)) {
      violations.push('polyfillModuleNames must identify modules');
    } else {
      serializer.polyfillModuleNames.forEach((value) => addModule(value, 'polyfillModuleNames'));
    }
  }
  const authorityPreload = process.env.RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD || '';
  const baseNodeOptions = process.env.RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS || '';
  const expectedNodeOptions = [baseNodeOptions, authorityPreload && '--require=' + JSON.stringify(authorityPreload)]
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
    violations.push('NODE_OPTIONS contain unsupported execution inputs');
  }
  if (!initialCacheCaptured) {
    Object.keys(require.cache).forEach((value) => addPath(value, 'loaded Metro config module'));
    initialCacheCaptured = true;
  }
  runtimeInputs.forEach((value) => accumulatedRuntimeInputs.add(value));
  violations.forEach((value) => accumulatedViolations.add(value));
  const payload = {
    version: 1,
    sessionId,
    metroInstanceId,
    contentRoot: root,
    appRoot: fs.realpathSync(process.cwd()),
    runtimeInputs: [...accumulatedRuntimeInputs].sort(),
    violations: [...accumulatedViolations].sort(),
  };
  const serializedPayload = JSON.stringify(payload);
  if (serializedPayload === lastPolicyPayload) return;
  const receipt = {
    ...payload,
    signature: createHmac('sha256', metroPolicyCapability)
      .update(serializedPayload)
      .digest('hex'),
  };
  const policyPath = path.join(process.cwd(), ${JSON.stringify(METRO_RUNTIME_POLICY)});
  const temporary = policyPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt) + '\\n', { mode: 0o600 });
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
  return Object.fromEntries(names.flatMap((name) =>
    typeof config[name] === 'function'
      ? [[name, withPolicyRefresh(config[name], getConfig, false)]]
      : []
  ));
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
function rollbackWrites(writes) {
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
            ]);
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
        ]);
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
        ]);
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
        const rollbackErrors = rollbackWrites(applied);
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
