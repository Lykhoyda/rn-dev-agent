import { createBuildLaunchPlan } from './build-adapter.js';
import { randomUUID } from 'node:crypto';
import { chmodSync, closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { assertBoundDirectoryCurrent, casBoundDirectoryFiles, closeBoundDirectory, ensureBoundSubdirectory, openBoundDirectory, readBoundDirectoryFiles, } from './bound-directory.js';
const ADAPTER = '.rn-agent/integration/rn-session-adapter.cjs';
const METRO_ADAPTER = '.rn-agent/integration/rn-session-metro.cjs';
const AUTHORITY_MODULE = '.rn-agent/integration/authority-marker.js';
const METRO_START = '// rn-dev-agent session integration: begin';
const METRO_END = '// rn-dev-agent session integration: end';
const SENTINELS = {
    ios: `node ${ADAPTER} ios`,
    android: `node ${ADAPTER} android`,
};
export function renderMetroIntegrationAdapter() {
    return `'use strict';
const path = require('node:path');
module.exports = function withRnDevAgentAuthority(config) {
  if (config && typeof config.then === 'function') {
    return config.then(withRnDevAgentAuthority);
  }
  const current = config || {};
  const serializer = current.serializer || {};
  const original = serializer.getModulesRunBeforeMainModule;
  const marker = path.join(process.cwd(), ${JSON.stringify(AUTHORITY_MODULE)});
  return {
    ...current,
    serializer: {
      ...serializer,
      getModulesRunBeforeMainModule(entryFile) {
        return [marker, ...(typeof original === 'function' ? original(entryFile) : [])];
      },
    },
  };
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
const rawSession = process.env.RN_DEV_AGENT_SESSION_BUILD_JSON;
let session = null;
let sessionCli = null;
if (rawSession) {
  try {
    session = JSON.parse(rawSession);
  } catch {
    process.stderr.write('SESSION_BUILD_IDENTITY_CONFLICT: session binding is invalid\n');
    process.exit(2);
  }
}
if (!session && typeof manifest.sessionCli === 'string' && fs.existsSync(manifest.sessionCli)) {
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
if (session && !sessionCli && typeof manifest.sessionCli === 'string' && fs.existsSync(manifest.sessionCli)) {
  sessionCli = manifest.sessionCli;
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
function snapshotFiles(root, paths) {
    return paths.map((path) => {
        const contents = readOptionalRegularFile(root, path);
        return {
            path,
            contents: contents === undefined ? null : Buffer.from(contents),
            mode: contents === undefined ? 0o600 : statSync(path).mode & 0o777,
        };
    });
}
function casReplace(root, snapshot, expected, next, mode) {
    const temporary = join(dirname(snapshot.path), `.${randomUUID()}.tmp`);
    const captured = join(dirname(snapshot.path), `.${randomUUID()}.captured`);
    if (next) {
        writeFileSync(temporary, next, { flag: 'wx', mode });
        chmodSync(temporary, mode);
    }
    try {
        if (expected === null) {
            if (readOptionalRegularFile(root, snapshot.path) !== undefined) {
                throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
            }
        }
        else {
            renameSync(snapshot.path, captured);
            const observed = readRegularFile(root, captured);
            if (!expected.equals(Buffer.from(observed))) {
                linkSync(captured, snapshot.path);
                throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
            }
        }
        if (next) {
            linkSync(temporary, snapshot.path);
        }
        if (expected !== null)
            rmSync(captured, { force: true });
    }
    finally {
        rmSync(temporary, { force: true });
        if (existsSync(captured)) {
            if (!existsSync(snapshot.path))
                linkSync(captured, snapshot.path);
            rmSync(captured, { force: true });
        }
    }
}
function snapshotIntegrationFiles(directory, integrationPath, names) {
    return readBoundDirectoryFiles(directory, names).map((snapshot) => ({
        ...snapshot,
        path: join(integrationPath, snapshot.name),
    }));
}
function casReplaceIntegrationBatch(directory, writes) {
    casBoundDirectoryFiles(directory, writes.map((write) => ({
        expected: write.expected,
        expectedMode: write.snapshot.mode,
        mode: write.mode,
        name: write.snapshot.name,
        replacement: write.replacement,
    })));
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
function openIntegrationDirectories(appRoot) {
    const agentRoot = join(appRoot, '.rn-agent');
    try {
        mkdirSync(agentRoot, { mode: 0o700 });
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const agent = openBoundDirectory(agentRoot);
    const integrationPath = join(agentRoot, 'integration');
    try {
        ensureBoundSubdirectory(agent, 'integration');
        const integration = openBoundDirectory(integrationPath);
        return { agent, integration };
    }
    catch (error) {
        closeBoundDirectory(agent);
        throw error;
    }
}
function rollbackWrites(writes) {
    const errors = [];
    for (const write of [...writes].reverse()) {
        try {
            if (write.directory) {
                casReplaceIntegrationBatch(write.directory, [
                    {
                        snapshot: write.snapshot,
                        expected: write.written,
                        replacement: write.snapshot.contents,
                        mode: write.snapshot.mode,
                    },
                ]);
            }
            else {
                casReplace(write.root, write.snapshot, write.written, write.snapshot.contents, write.snapshot.mode);
            }
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
    ];
    const applied = [];
    try {
        const [packageSnapshot, metroSnapshot] = snapshotFiles(appRoot, [packagePath, metroConfigPath]);
        const generated = snapshotIntegrationFiles(directories.integration, directories.integration.path, generatedNames);
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
        casReplaceIntegrationBatch(directories.integration, outputs.map((output) => ({
            snapshot: output.snapshot,
            expected: output.snapshot.contents,
            replacement: output.contents,
            mode: output.mode,
        })));
        for (const output of outputs) {
            applied.push({
                root: directories.integration.path,
                snapshot: output.snapshot,
                written: output.contents,
                directory: directories.integration,
            });
            dependencies.afterWrite?.(output.snapshot.path);
        }
        const metroOutput = Buffer.from(nextMetroSource);
        casReplace(appRoot, metroSnapshot, metroSnapshot.contents, metroOutput, 0o644);
        applied.push({ root: appRoot, snapshot: metroSnapshot, written: metroOutput });
        dependencies.afterWrite?.(metroConfigPath);
        const packageOutput = Buffer.from(`${JSON.stringify(preview.packageJson, null, 2)}\n`);
        casReplace(appRoot, packageSnapshot, packageSnapshot.contents, packageOutput, 0o644);
        applied.push({ root: appRoot, snapshot: packageSnapshot, written: packageOutput });
        dependencies.afterWrite?.(packagePath);
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
        return preview;
    }
    catch (error) {
        const rollbackErrors = rollbackWrites(applied);
        if (rollbackErrors.length > 0)
            throw new AggregateError([error, ...rollbackErrors]);
        throw error;
    }
    finally {
        closeBoundDirectory(directories.integration);
        closeBoundDirectory(directories.agent);
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
    ];
    const applied = [];
    try {
        const generatedSnapshots = snapshotIntegrationFiles(directories.integration, directories.integration.path, generatedNames);
        if (!generatedSnapshots[0]?.contents) {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration manifest is missing');
        }
        const manifest = JSON.parse(generatedSnapshots[0].contents.toString('utf8'));
        const metroConfig = manifest.metroConfig === undefined ? 'metro.config.js' : manifest.metroConfig;
        if (metroConfig !== 'metro.config.js' && metroConfig !== 'metro.config.cjs') {
            throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: manifest Metro config is not an expected app-root config');
        }
        const metroConfigPath = join(appRoot, metroConfig);
        const [packageSnapshot, metroSnapshot] = snapshotFiles(appRoot, [packagePath, metroConfigPath]);
        if (!packageSnapshot?.contents || !metroSnapshot?.contents) {
            throw new Error('SESSION_INTEGRATION_CONFLICT: integration input changed before commit');
        }
        const packageJson = JSON.parse(packageSnapshot.contents.toString('utf8'));
        const metroSource = metroSnapshot.contents.toString('utf8');
        dependencies.beforeCommit?.();
        const packageOutput = Buffer.from(`${JSON.stringify(restorePackageIntegration(packageJson, manifest), null, 2)}\n`);
        casReplace(appRoot, packageSnapshot, packageSnapshot.contents, packageOutput, 0o644);
        applied.push({ root: appRoot, snapshot: packageSnapshot, written: packageOutput });
        dependencies.afterWrite?.(packagePath);
        const metroOutput = Buffer.from(restoreMetroIntegration(metroSource));
        casReplace(appRoot, metroSnapshot, metroSnapshot.contents, metroOutput, 0o644);
        applied.push({ root: appRoot, snapshot: metroSnapshot, written: metroOutput });
        dependencies.afterWrite?.(metroConfigPath);
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
        casReplaceIntegrationBatch(directories.integration, generatedSnapshots.map((snapshot) => ({
            snapshot,
            expected: snapshot.contents,
            replacement: null,
            mode: snapshot.mode,
        })));
        for (const snapshot of generatedSnapshots) {
            applied.push({
                root: directories.integration.path,
                snapshot,
                written: null,
                directory: directories.integration,
            });
        }
        assertBoundDirectoryCurrent(directories.agent);
        assertBoundDirectoryCurrent(directories.integration);
    }
    catch (error) {
        const rollbackErrors = rollbackWrites(applied);
        if (rollbackErrors.length > 0)
            throw new AggregateError([error, ...rollbackErrors]);
        throw error;
    }
    finally {
        closeBoundDirectory(directories.integration);
        closeBoundDirectory(directories.agent);
    }
}
