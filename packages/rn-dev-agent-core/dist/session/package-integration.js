import { createBuildLaunchPlan } from './build-adapter.js';
import { hasNodeLoaderOption, parseNodeOptions } from './managed-metro.js';
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
const workerThreads = require('node:worker_threads');
${parseNodeOptions.toString()}
${hasNodeLoaderOption.toString()}
const accumulatedRuntimeInputs = new Set();
const accumulatedViolations = new Set();
const observedLoaderDigests = new Map();
const metroPolicyCapability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const usesExternalEvidenceOwner = Boolean(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD);
const authorityEnvironment = Object.entries(process.env).filter(
  ([key]) =>
    (key === 'NODE_OPTIONS' || key.startsWith('RN_DEV_AGENT_')) &&
    key !== 'RN_DEV_AGENT_METRO_DESCENDANT_NONCE' &&
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
function writeRuntimeLoad(line, loadsPath) {
  runtimeLoadsDescriptor ??=
    typeof loadsPath === 'number' ? loadsPath : fs.openSync(loadsPath, 'a', 0o600);
  const bytes = Buffer.from(line);
  let offset = 0;
  while (offset < bytes.length) {
    offset += fs.writeSync(runtimeLoadsDescriptor, bytes, offset, bytes.length - offset);
  }
}
process.once('exit', () => {
  if (runtimeLoadsDescriptor !== undefined) fs.closeSync(runtimeLoadsDescriptor);
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
function recordLoaderViolation(value) {
  if (accumulatedViolations.has(value)) return;
  accumulatedViolations.add(value);
  loaderEpoch += 1;
  persistLoaderObservation('violation', value);
}
const descendantNonce = process.env.RN_DEV_AGENT_METRO_DESCENDANT_NONCE;
if (descendantNonce) {
  const identity = workerThreads.isMainThread
    ? 'process:' + process.pid
    : 'worker:' + workerThreads.threadId;
  persistLoaderObservation('attestation', descendantNonce + ':' + identity);
  delete process.env.RN_DEV_AGENT_METRO_DESCENDANT_NONCE;
}
if (metroPolicyCapability) delete process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
function authenticatedChildEnvironment(environment, nonce) {
  const nextEnvironment = {};
  for (const [key, value] of Object.entries(environment || process.env)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === 'NODE_OPTIONS' || normalizedKey.startsWith('RN_DEV_AGENT_')) continue;
    nextEnvironment[key] = value;
  }
  for (const [key, value] of authorityEnvironment) nextEnvironment[key] = value;
  nextEnvironment.RN_DEV_AGENT_METRO_DESCENDANT_NONCE = nonce;
  return nextEnvironment;
}
function authenticatedChildArguments(args, optionsIndex, nonce) {
  const nextArgs = [...args];
  const candidate = nextArgs[optionsIndex];
  const options = candidate && typeof candidate === 'object' ? candidate : {};
  const authenticatedOptions = {
    ...options,
    env: authenticatedChildEnvironment(options.env, nonce),
    stdio: authenticatedChildStdio(options.stdio),
  };
  if (typeof candidate === 'function') {
    nextArgs.splice(optionsIndex, 0, authenticatedOptions);
  } else {
    nextArgs[optionsIndex] = authenticatedOptions;
  }
  return nextArgs;
}
function authenticatedChildStdio(stdio) {
  const evidenceDescriptor = Number(process.env.RN_DEV_AGENT_METRO_EVIDENCE_FD);
  if (!Number.isInteger(evidenceDescriptor) || evidenceDescriptor < 3) return stdio;
  const normalized =
    Array.isArray(stdio)
      ? [...stdio]
      : stdio === 'inherit'
        ? ['inherit', 'inherit', 'inherit']
        : stdio === 'ignore'
          ? ['ignore', 'ignore', 'ignore']
          : ['pipe', 'pipe', 'pipe'];
  while (normalized.length <= evidenceDescriptor) normalized.push('ignore');
  normalized[evidenceDescriptor] = evidenceDescriptor;
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
  const option = value.split('=', 1)[0].replaceAll('_', '-');
  return (
    option === '-e' ||
    option.startsWith('-e') ||
    option === '-p' ||
    option.startsWith('-p') ||
    ['--eval', '--print', '--input-type'].includes(option)
  );
}
function requireFileBackedNodeArguments(args) {
  if (!Array.isArray(args) || args.length === 0 || args[0] === '-') throw descendantError();
  if (args.some(isInlineNodeOption)) throw descendantError();
}
function requireSafeWorkerExecArgv(execArgv) {
  if (execArgv.some(isInlineNodeOption)) throw descendantError();
  for (const argument of execArgv) {
    const option = typeof argument === 'string' ? argument.split('=', 1)[0] : '';
    if (
      ['--require', '-r', '--import', '--loader', '--experimental-loader'].includes(
        option.replaceAll('_', '-'),
      )
    ) {
      throw descendantError();
    }
  }
}
function recordChildLaunch(nonce, child) {
  if (!child || typeof child.pid !== 'number') return;
  persistLoaderObservation('launch', nonce + ':process:' + child.pid);
}
function fenceChildProcessMethod(name, optionsIndex, mode) {
  const original = childProcess[name];
  Object.defineProperty(childProcess, name, {
    configurable: false,
    enumerable: true,
    value(...args) {
      const index = typeof optionsIndex === 'function' ? optionsIndex(args) : optionsIndex;
      const nonce = randomBytes(16).toString('hex');
      const authenticatedArgs = authenticatedChildArguments(args, index, nonce);
      const options = authenticatedArgs[index];
      if (mode === 'node' || mode === 'sync') {
        requireNodeExecutable(args[0], options);
        requireFileBackedNodeArguments(args[1]);
      }
      if (mode === 'fork') {
        if (options.execPath) requireNodeExecutable(options.execPath, options);
        options.execPath = nodeExecutable;
        if (Array.isArray(options.stdio) && !options.stdio.includes('ipc')) {
          options.stdio[3] = 'ipc';
        }
      }
      const child = Reflect.apply(original, this, authenticatedArgs);
      if (mode === 'sync') {
        recordChildLaunch(nonce, child);
      } else if (typeof child?.once === 'function') {
        child.once('spawn', () => recordChildLaunch(nonce, child));
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
  class AuthenticatedWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      if (
        options.eval ||
        (typeof filename === 'string' && filename.startsWith('data:')) ||
        (filename instanceof URL && filename.protocol === 'data:')
      ) {
        throw descendantError();
      }
      const nonce = randomBytes(16).toString('hex');
      const requestedExecArgv = Array.isArray(options.execArgv)
        ? [...options.execArgv]
        : [...process.execArgv];
      requireSafeWorkerExecArgv(requestedExecArgv);
      super(filename, {
        ...options,
        env: authenticatedChildEnvironment(options.env, nonce),
        execArgv: ['--require', authorityPreload, ...requestedExecArgv],
      });
      persistLoaderObservation('launch', nonce + ':worker:' + this.threadId);
    }
  }
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
  fenceChildProcessMethod('spawn', optionalArgsIndex, 'node');
  fenceChildProcessMethod('spawnSync', optionalArgsIndex, 'sync');
  fenceChildProcessMethod('execFile', optionalArgsIndex, 'node');
  fenceChildProcessMethod('fork', optionalArgsIndex, 'fork');
  rejectChildProcessMethod('exec');
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
    hasNodeLoaderOption(baseNodeOptions)
  ) {
    violations.push('NODE_OPTIONS loaders are unsupported');
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
