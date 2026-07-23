import { createBuildLaunchPlan } from './build-adapter.js';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
    if (start < 0 || end < start) {
        throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: Metro integration sentinel is corrupt');
    }
    return `${source.slice(0, start).trimEnd()}\n`;
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
        return { packageJson, manifest: existing };
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
function atomicWrite(path, contents, mode) {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temporary, contents, { encoding: 'utf8', mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
}
function snapshotFiles(paths) {
    return paths.map((path) => ({
        path,
        contents: existsSync(path) ? readFileSync(path) : null,
        mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600,
    }));
}
function restoreSnapshots(snapshots) {
    for (const snapshot of [...snapshots].reverse()) {
        if (snapshot.contents === null) {
            rmSync(snapshot.path, { force: true });
        }
        else {
            atomicWrite(snapshot.path, snapshot.contents.toString('utf8'), snapshot.mode);
        }
    }
}
export function applyPackageIntegration(input) {
    const appRoot = resolve(input.appRoot);
    const packagePath = join(appRoot, 'package.json');
    const integrationRoot = join(appRoot, '.rn-agent', 'integration');
    const manifestPath = join(integrationRoot, 'rn-session-integration.json');
    const adapterPath = join(appRoot, ADAPTER);
    const metroConfigPath = ['metro.config.js', 'metro.config.cjs']
        .map((name) => join(appRoot, name))
        .find((path) => {
        try {
            return lstatSync(path).isFile();
        }
        catch {
            return false;
        }
    });
    if (!metroConfigPath) {
        throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: metro.config.js or metro.config.cjs is required');
    }
    const metroAdapterPath = join(appRoot, METRO_ADAPTER);
    const authorityModulePath = join(appRoot, AUTHORITY_MODULE);
    for (const path of [packagePath, integrationRoot, metroConfigPath]) {
        try {
            if (lstatSync(path).isSymbolicLink()) {
                throw new Error('SESSION_INTEGRATION_PATH_UNSAFE: integration path is symlinked');
            }
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
    const existing = (() => {
        try {
            return JSON.parse(readFileSync(manifestPath, 'utf8'));
        }
        catch {
            return undefined;
        }
    })();
    const preview = previewPackageIntegration(packageJson, existing, input.sessionCli);
    const metroSource = readFileSync(metroConfigPath, 'utf8');
    const nextMetroSource = previewMetroIntegration(metroSource);
    preview.manifest.metroConfig = metroConfigPath.slice(appRoot.length + 1);
    const snapshots = snapshotFiles([
        packagePath,
        manifestPath,
        adapterPath,
        metroAdapterPath,
        authorityModulePath,
        metroConfigPath,
    ]);
    mkdirSync(dirname(adapterPath), { recursive: true, mode: 0o700 });
    try {
        atomicWrite(manifestPath, `${JSON.stringify(preview.manifest, null, 2)}\n`, 0o600);
        atomicWrite(adapterPath, renderProjectAdapter(), 0o755);
        atomicWrite(metroAdapterPath, renderMetroIntegrationAdapter(), 0o644);
        atomicWrite(authorityModulePath, "globalThis.__RN_DEV_AGENT_AUTHORITY__={status:'unavailable',authorityScope:'initial-bundle',sourceFidelity:'not-proven'};\n", 0o600);
        atomicWrite(metroConfigPath, nextMetroSource, 0o644);
        atomicWrite(packagePath, `${JSON.stringify(preview.packageJson, null, 2)}\n`, 0o644);
    }
    catch (error) {
        restoreSnapshots(snapshots);
        throw error;
    }
    return preview;
}
export function restorePackageIntegrationFiles(input) {
    const appRoot = resolve(input.appRoot);
    const packagePath = join(appRoot, 'package.json');
    const manifestPath = join(appRoot, '.rn-agent', 'integration', 'rn-session-integration.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const metroConfigPath = join(appRoot, manifest.metroConfig ?? 'metro.config.js');
    const generated = [
        manifestPath,
        join(appRoot, ADAPTER),
        join(appRoot, METRO_ADAPTER),
        join(appRoot, AUTHORITY_MODULE),
    ];
    const snapshots = snapshotFiles([packagePath, metroConfigPath, ...generated]);
    try {
        const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
        atomicWrite(packagePath, `${JSON.stringify(restorePackageIntegration(packageJson, manifest), null, 2)}\n`, 0o644);
        atomicWrite(metroConfigPath, restoreMetroIntegration(readFileSync(metroConfigPath, 'utf8')), 0o644);
        for (const path of generated)
            rmSync(path, { force: true });
    }
    catch (error) {
        restoreSnapshots(snapshots);
        throw error;
    }
}
