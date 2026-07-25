import { createBuildLaunchPlan } from './build-adapter.js';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertBoundDirectoryCurrent,
  casBoundDirectoryFiles,
  closeBoundDirectories,
  openBoundDirectory,
  openBoundSubdirectory,
  openOptionalBoundSubdirectory,
  readBoundDirectoryFiles,
  type BoundCasResult,
  type BoundDirectory,
  type BoundOperationDependencies,
} from './bound-directory.js';

const ADAPTER = '.rn-agent/integration/rn-session-adapter.cjs';
const METRO_ADAPTER = '.rn-agent/integration/rn-session-metro.cjs';
const AUTHORITY_MODULE = '.rn-agent/integration/authority-marker.js';
const METRO_RUNTIME_POLICY = '.rn-agent/integration/metro-runtime-policy.json';
const METRO_START = '// rn-dev-agent session integration: begin';
const METRO_END = '// rn-dev-agent session integration: end';
const SENTINELS = {
  ios: `node ${ADAPTER} ios`,
  android: `node ${ADAPTER} android`,
} as const;

interface PackageJson {
  scripts?: Record<string, string>;
  [key: string]: unknown;
}

export interface PackageIntegrationManifest {
  version: 1;
  adapter: string;
  sessionCli?: string;
  originalScripts: {
    ios: string[];
    android: string[];
  };
  metroConfig?: string;
}

export function renderMetroIntegrationAdapter(): string {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { execFileSync } = require('node:child_process');
function sourceRoot() {
  try {
    return fs.realpathSync(execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim());
  } catch (error) {
    if (String(error && error.stderr || '').toLowerCase().includes('not a git repository')) return null;
    throw error;
  }
}
function runtimePolicy(config, callbackRuntimeInputs = []) {
  const root = sourceRoot();
  const capability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
  const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
  const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
  if (root === null || !capability || !sessionId || !metroInstanceId) return;
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
    if (value === undefined) return;
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
    if (values === undefined) return;
    if (!Array.isArray(values)) {
      violations.push(field + ' must contain paths');
      return;
    }
    values.forEach((value) => addPath(value, field));
  }
  function addModule(value, field) {
    if (value === undefined) return;
    if (typeof value !== 'string') {
      violations.push(field + ' must identify a module');
      return;
    }
    try {
      const resolved = fs.realpathSync(require.resolve(value, { paths: [process.cwd()] }));
      runtimeInputs.add(resolved);
      if (!isContained(resolved) || isExcluded(resolved)) {
        violations.push(field + ' must resolve to Git-authenticated source or a local dependency store');
      }
    } catch {
      violations.push(field + ' cannot be resolved as an authenticated module');
    }
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
  if (resolver.resolveRequest !== undefined) {
    violations.push('custom Metro resolvers are unsupported');
  }
  if (serializer.customSerializer !== undefined || serializer.experimentalSerializerHook !== undefined) {
    violations.push('custom Metro serializers are unsupported');
  }
  addModule(resolver.dependencyExtractor, 'dependencyExtractor');
  addModule(resolver.hasteImplModulePath, 'hasteImplModulePath');
  addModule(resolver.emptyModulePath, 'emptyModulePath');
  addModule(transformer.asyncRequireModulePath, 'asyncRequireModulePath');
  addModule(transformer.babelTransformerPath, 'babelTransformerPath');
  addModule(transformer.minifierPath, 'minifierPath');
  if (transformer.assetPlugins !== undefined) {
    if (!Array.isArray(transformer.assetPlugins)) {
      violations.push('assetPlugins must identify modules');
    } else {
      transformer.assetPlugins.forEach((value) => addModule(value, 'assetPlugins'));
    }
  }
  if (/(?:^|\\s)(?:--(?:require|import|loader|experimental-loader)\\b|-r\\b)/.test(process.env.NODE_OPTIONS || '')) {
    violations.push('NODE_OPTIONS loaders are unsupported');
  }
  Object.keys(require.cache).forEach((value) => addPath(value, 'loaded Metro config module'));
  const payload = {
    version: 1,
    sessionId,
    metroInstanceId,
    contentRoot: root,
    appRoot: fs.realpathSync(process.cwd()),
    runtimeInputs: [...runtimeInputs].sort(),
    violations: [...new Set(violations)].sort(),
  };
  const receipt = {
    ...payload,
    signature: createHmac('sha256', capability).update(JSON.stringify(payload)).digest('hex'),
  };
  const policyPath = path.join(process.cwd(), ${JSON.stringify(METRO_RUNTIME_POLICY)});
  const temporary = policyPath + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(receipt) + '\\n', { mode: 0o600 });
  fs.renameSync(temporary, policyPath);
}
function withPolicyRefresh(callback, getConfig, includeReturnedPaths) {
  return function (...args) {
    const finish = (value) => {
      runtimePolicy(getConfig(), includeReturnedPaths && Array.isArray(value) ? value : []);
      return value;
    };
    const result = callback.apply(this, args);
    return result && typeof result.then === 'function' ? result.then(finish) : finish(result);
  };
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

export function previewMetroIntegration(source: string): string {
  const hasStart = source.includes(METRO_START);
  const hasEnd = source.includes(METRO_END);
  if (hasStart !== hasEnd) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
  }
  if (hasStart) return source;
  return `${source.trimEnd()}

${METRO_START}
module.exports = require('./${METRO_ADAPTER}')(module.exports);
${METRO_END}
`;
}

export function restoreMetroIntegration(source: string): string {
  const start = source.indexOf(METRO_START);
  const end = source.indexOf(METRO_END);
  if (start < 0 && end < 0) return source;
  if (
    start < 0 ||
    end < start ||
    source.indexOf(METRO_START, start + METRO_START.length) >= 0 ||
    source.indexOf(METRO_END, end + METRO_END.length) >= 0
  ) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
  }
  const blockEnd = end + METRO_END.length;
  const prefix = source.slice(0, start).trimEnd();
  const suffix = source.slice(blockEnd).replace(/^(?:\r?\n)+/, '');
  return suffix ? `${prefix}\n${suffix}` : `${prefix}\n`;
}

interface PackageIntegrationPreview {
  packageJson: PackageJson;
  manifest: PackageIntegrationManifest;
}

function parseSupportedScript(script: string, platform: 'ios' | 'android'): string[] {
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

export function previewPackageIntegration(
  packageJson: PackageJson,
  existing?: PackageIntegrationManifest,
  sessionCli?: string,
): PackageIntegrationPreview {
  if (
    existing &&
    packageJson.scripts?.ios === SENTINELS.ios &&
    packageJson.scripts?.android === SENTINELS.android
  ) {
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

  const manifest: PackageIntegrationManifest = {
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

export function restorePackageIntegration(
  packageJson: PackageJson,
  manifest: PackageIntegrationManifest,
): PackageJson {
  if (
    packageJson.scripts?.ios !== SENTINELS.ios ||
    packageJson.scripts?.android !== SENTINELS.android
  ) {
    throw new Error(
      'SESSION_INTEGRATION_CONFLICT: package scripts changed after integration was installed',
    );
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

export function renderProjectAdapter(): string {
  return String.raw`#!/usr/bin/env node
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

interface DescriptorFileSnapshot {
  path: string;
  contents: Buffer | null;
  mode: number;
  name: string;
}

function snapshotBoundFiles(
  directory: BoundDirectory,
  directoryPath: string,
  names: readonly string[],
): DescriptorFileSnapshot[] {
  return readBoundDirectoryFiles(directory, names).map((snapshot) => ({
    ...snapshot,
    path: join(directoryPath, snapshot.name),
  }));
}

function casReplaceBoundBatch(
  directory: BoundDirectory,
  writes: ReadonlyArray<{
    snapshot: DescriptorFileSnapshot;
    expected: Buffer | null;
    expectedMode?: number;
    replacement: Buffer | null;
    mode: number;
  }>,
  dependencies: BoundOperationDependencies = {},
): BoundCasResult {
  return casBoundDirectoryFiles(
    directory,
    writes.map((write) => ({
      expected: write.expected,
      expectedMode: write.expectedMode ?? write.snapshot.mode,
      mode: write.mode,
      name: write.snapshot.name,
      replacement: write.replacement,
    })),
    dependencies,
  );
}

function assertBoundCleanup(result: BoundCasResult): void {
  if (result.cleanupPending) {
    const transaction = result.cleanupObligation?.transactionId ?? 'unknown transaction';
    throw new Error(
      `SESSION_INTEGRATION_PATH_UNSAFE: committed cleanup remains pending: ${transaction}: ${result.cleanupError ?? 'cleanup unavailable'}`,
    );
  }
}

export function assertNoSymlinkPath(root: string, candidate: string): void {
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
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function regularFileIdentity(
  root: string,
  candidate: string,
): {
  dev: bigint;
  ino: bigint;
} {
  assertNoSymlinkPath(root, candidate);
  const identity = lstatSync(candidate, { bigint: true });
  if (!identity.isFile()) {
    throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration input is not a regular file');
  }
  return { dev: identity.dev, ino: identity.ino };
}

function readRegularFile(root: string, candidate: string): string {
  const before = regularFileIdentity(root, candidate);
  const descriptor = openSync(
    candidate,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    const after = regularFileIdentity(root, candidate);
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration input changed while opening');
    }
    return readFileSync(descriptor, 'utf8');
  } finally {
    closeSync(descriptor);
  }
}

function readOptionalRegularFile(root: string, candidate: string): string | undefined {
  try {
    return readRegularFile(root, candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function readRegularFileNoFollow(root: string, candidate: string): string {
  return readRegularFile(root, candidate);
}

export function readOptionalRegularFileNoFollow(
  root: string,
  candidate: string,
): string | undefined {
  return readOptionalRegularFile(root, candidate);
}

export function readPackageIntegrationInputs(
  appRootInput: string,
  dependencies: { afterAppRead?: () => void } = {},
): {
  packageJson: string;
  metroConfig: { contents: string; path: string };
  manifest?: string;
} {
  const appRoot = resolve(appRootInput);
  const app = openBoundDirectory(appRoot);
  let agent: BoundDirectory | null = null;
  let integration: BoundDirectory | null = null;
  let primaryError: unknown;
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
      throw new Error(
        'BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required',
      );
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
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    closeBoundDirectories([integration, agent, app], primaryError);
  }
}

function openIntegrationDirectories(appRoot: string): {
  app: BoundDirectory;
  agent: BoundDirectory;
  integration: BoundDirectory;
} {
  const app = openBoundDirectory(appRoot);
  try {
    const agent = openBoundSubdirectory(app, '.rn-agent', { create: true });
    try {
      const integration = openBoundSubdirectory(agent, 'integration', { create: true });
      return { app, agent, integration };
    } catch (error) {
      closeBoundDirectories([agent], error);
      throw error;
    }
  } catch (error) {
    closeBoundDirectories([app], error);
    throw error;
  }
}

interface PackageIntegrationDependencies {
  beforeCommit?: () => void;
  afterWrite?: (path: string) => void;
  boundOperationDependencies?: BoundOperationDependencies;
}

interface AppliedWrite {
  snapshot: DescriptorFileSnapshot;
  written: Buffer | null;
  writtenMode?: number;
  directory: BoundDirectory;
}

function rollbackWrites(writes: readonly AppliedWrite[]): Error[] {
  const errors: Error[] = [];
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
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

export function applyPackageIntegration(
  input: {
    appRoot: string;
    sessionCli: string;
  },
  dependencies: PackageIntegrationDependencies = {},
): PackageIntegrationPreview {
  const appRoot = resolve(input.appRoot);
  const packagePath = join(appRoot, 'package.json');
  let metroConfigPath: string | undefined;
  for (const path of ['metro.config.js', 'metro.config.cjs'].map((name) => join(appRoot, name))) {
    if (readOptionalRegularFileNoFollow(appRoot, path) !== undefined) {
      metroConfigPath = path;
      break;
    }
  }
  if (!metroConfigPath) {
    throw new Error(
      'BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required',
    );
  }
  const directories = openIntegrationDirectories(appRoot);
  const generatedNames = [
    'rn-session-integration.json',
    'rn-session-adapter.cjs',
    'rn-session-metro.cjs',
    'authority-marker.js',
    'metro-runtime-policy.json',
  ] as const;
  const applied: AppliedWrite[] = [];
  let primaryError: unknown;
  try {
    const [packageSnapshot, metroSnapshot] = snapshotBoundFiles(directories.app, appRoot, [
      basename(packagePath),
      basename(metroConfigPath),
    ]);
    const generated = snapshotBoundFiles(
      directories.integration,
      directories.integration.path,
      generatedNames,
    );
    if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
      throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
    }
    const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8')) as PackageJson;
    let existing: PackageIntegrationManifest | undefined;
    if (generated[0]?.contents) {
      try {
        existing = JSON.parse(generated[0].contents.toString('utf8')) as PackageIntegrationManifest;
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
    }
    const preview = previewPackageIntegration(packageJson, existing, input.sessionCli);
    const nextMetroSource = previewMetroIntegration(metroSnapshot.contents.toString('utf8'));
    preview.manifest.metroConfig = metroConfigPath.slice(appRoot.length + 1);
    dependencies.beforeCommit?.();
    const outputs: Array<{
      snapshot: DescriptorFileSnapshot;
      contents: Buffer;
      mode: number;
    }> = [
      {
        snapshot: generated[0]!,
        contents: Buffer.from(`${JSON.stringify(preview.manifest, null, 2)}\n`),
        mode: 0o600,
      },
      { snapshot: generated[1]!, contents: Buffer.from(renderProjectAdapter()), mode: 0o755 },
      {
        snapshot: generated[2]!,
        contents: Buffer.from(renderMetroIntegrationAdapter()),
        mode: 0o644,
      },
      {
        snapshot: generated[3]!,
        contents: Buffer.from(
          "globalThis.__RN_DEV_AGENT_AUTHORITY__={status:'unavailable',authorityScope:'initial-bundle',sourceFidelity:'not-proven'};\n",
        ),
        mode: 0o600,
      },
    ];
    assertBoundDirectoryCurrent(directories.agent);
    assertBoundDirectoryCurrent(directories.integration);
    const generatedResult = casReplaceBoundBatch(
      directories.integration,
      outputs.map((output) => ({
        snapshot: output.snapshot,
        expected: output.snapshot.contents,
        replacement: output.contents,
        mode: output.mode,
      })),
      dependencies.boundOperationDependencies,
    );
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
  } catch (error) {
    const rollbackErrors = rollbackWrites(applied);
    primaryError =
      rollbackErrors.length > 0 ? new AggregateError([error, ...rollbackErrors]) : error;
    throw primaryError;
  } finally {
    closeBoundDirectories(
      [directories.integration, directories.agent, directories.app],
      primaryError,
    );
  }
}

export function restorePackageIntegrationFiles(
  input: { appRoot: string },
  dependencies: PackageIntegrationDependencies = {},
): void {
  const appRoot = resolve(input.appRoot);
  const packagePath = join(appRoot, 'package.json');
  const directories = openIntegrationDirectories(appRoot);
  const generatedNames = [
    'rn-session-integration.json',
    'rn-session-adapter.cjs',
    'rn-session-metro.cjs',
    'authority-marker.js',
    'metro-runtime-policy.json',
  ] as const;
  const applied: AppliedWrite[] = [];
  let primaryError: unknown;
  try {
    const generatedSnapshots = snapshotBoundFiles(
      directories.integration,
      directories.integration.path,
      generatedNames,
    );
    if (!generatedSnapshots[0]?.contents) {
      throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration manifest is missing');
    }
    const manifest = JSON.parse(
      generatedSnapshots[0].contents.toString('utf8'),
    ) as PackageIntegrationManifest;
    const metroConfig =
      manifest.metroConfig === undefined ? 'metro.config.js' : manifest.metroConfig;
    if (metroConfig !== 'metro.config.js' && metroConfig !== 'metro.config.cjs') {
      throw new Error(
        'SESSION_INTEGRATION_PATH_UNSAFE: manifest Metro config is not an expected app-root config',
      );
    }
    const metroConfigPath = join(appRoot, metroConfig);
    const [packageSnapshot, metroSnapshot] = snapshotBoundFiles(directories.app, appRoot, [
      basename(packagePath),
      basename(metroConfigPath),
    ]);
    if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
      throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
    }
    const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8')) as PackageJson;
    const metroSource = metroSnapshot.contents.toString('utf8');
    dependencies.beforeCommit?.();
    const packageOutput = Buffer.from(
      `${JSON.stringify(restorePackageIntegration(packageJson, manifest), null, 2)}\n`,
    );
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
    const generatedResult = casReplaceBoundBatch(
      directories.integration,
      generatedSnapshots.map((snapshot) => ({
        snapshot,
        expected: snapshot.contents,
        replacement: null,
        mode: snapshot.mode,
      })),
      dependencies.boundOperationDependencies,
    );
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
  } catch (error) {
    const rollbackErrors = rollbackWrites(applied);
    primaryError =
      rollbackErrors.length > 0 ? new AggregateError([error, ...rollbackErrors]) : error;
    throw primaryError;
  } finally {
    closeBoundDirectories(
      [directories.integration, directories.agent, directories.app],
      primaryError,
    );
  }
}
