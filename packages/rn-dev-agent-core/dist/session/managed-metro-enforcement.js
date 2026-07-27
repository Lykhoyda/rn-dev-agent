import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeSync, } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalAuthorityJson } from './authority-json.js';
const DARWIN_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
const DARWIN_CODESIGN_EXECUTABLE = '/usr/bin/codesign';
function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}
function defaultRun(command, args) {
    const result = spawnSync(command, [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
    });
    return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? result.error?.message ?? '',
    };
}
function field(details, name) {
    const prefix = `${name}=`;
    return (details
        .split('\n')
        .find((line) => line.startsWith(prefix))
        ?.slice(prefix.length)
        .trim() ?? null);
}
function verifiedSandboxExecutable(dependencies) {
    const exists = dependencies.exists ?? existsSync;
    const canonicalize = dependencies.canonicalize ?? realpathSync;
    const stat = dependencies.stat ?? statSync;
    const readBytes = dependencies.readBytes ?? readFileSync;
    const run = dependencies.run ?? defaultRun;
    try {
        if (!exists(DARWIN_SANDBOX_EXECUTABLE))
            return null;
        if (canonicalize(DARWIN_SANDBOX_EXECUTABLE) !== DARWIN_SANDBOX_EXECUTABLE)
            return null;
        const metadata = stat(DARWIN_SANDBOX_EXECUTABLE);
        if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0)
            return null;
        const verification = run(DARWIN_CODESIGN_EXECUTABLE, [
            '--verify',
            '--strict',
            DARWIN_SANDBOX_EXECUTABLE,
        ]);
        if (verification.status !== 0)
            return null;
        const details = run(DARWIN_CODESIGN_EXECUTABLE, [
            '-dv',
            '--verbose=4',
            DARWIN_SANDBOX_EXECUTABLE,
        ]);
        const authorities = details.stderr.split('\n').filter((line) => line.startsWith('Authority='));
        const cdHash = field(details.stderr, 'CDHash');
        if (details.status !== 0 ||
            field(details.stderr, 'Identifier') !== 'com.apple.sandbox-exec' ||
            !/^\d+$/.test(field(details.stderr, 'Platform identifier') ?? '') ||
            !/^[a-f0-9]{40,64}$/.test(cdHash ?? '') ||
            !authorities.includes('Authority=Software Signing') ||
            !authorities.includes('Authority=Apple Code Signing Certification Authority') ||
            !authorities.includes('Authority=Apple Root CA')) {
            return null;
        }
        return {
            path: DARWIN_SANDBOX_EXECUTABLE,
            sha256: sha256(readBytes(DARWIN_SANDBOX_EXECUTABLE)),
            cdHash: cdHash,
        };
    }
    catch {
        return null;
    }
}
function signingIdentity(path, run) {
    const verification = run(DARWIN_CODESIGN_EXECUTABLE, ['--verify', '--strict', path]);
    if (verification.status !== 0)
        return null;
    const details = run(DARWIN_CODESIGN_EXECUTABLE, ['-dv', '--verbose=4', path]);
    const identifier = field(details.stderr, 'Identifier');
    const cdHash = field(details.stderr, 'CDHash');
    if (details.status !== 0 || !identifier || !/^[a-f0-9]{40,64}$/.test(cdHash ?? '')) {
        return null;
    }
    return {
        identifier,
        cdHash: cdHash,
        authorities: details.stderr
            .split('\n')
            .filter((line) => line.startsWith('Authority='))
            .map((line) => line.slice('Authority='.length))
            .sort(),
    };
}
function defaultRuntimeVersion(nodeExecutable, run) {
    const result = run(nodeExecutable, ['--version']);
    if (result.status !== 0)
        throw new Error('node version unavailable');
    return result.stdout.trim();
}
function defaultRuntimeFiles(nodeExecutable, run) {
    const result = run('/usr/bin/otool', ['-L', nodeExecutable]);
    if (result.status !== 0)
        throw new Error('node runtime dependencies unavailable');
    return result.stdout
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+\(/, 1)[0])
        .filter((path) => path.startsWith('/'));
}
function defaultRuntimeCache(exists) {
    const architecture = process.arch === 'arm64' ? 'arm64e' : process.arch;
    return ([
        `/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_${architecture}`,
        `/System/Library/dyld/dyld_shared_cache_${architecture}`,
    ].find(exists) ?? null);
}
function attestRuntimeFile(path, dependencies) {
    const canonicalize = dependencies.canonicalize ?? realpathSync;
    const stat = dependencies.stat ?? statSync;
    const readBytes = dependencies.readBytes ?? readFileSync;
    const run = dependencies.run ?? defaultRun;
    const canonical = canonicalize(path);
    if (!stat(canonical).isFile())
        throw new Error('runtime input is not a file');
    return {
        path: canonical,
        sha256: sha256(readBytes(canonical)),
        signingIdentity: signingIdentity(canonical, run),
    };
}
function attestNodeRuntime(input, executableMappings, dependencies) {
    const run = dependencies.run ?? defaultRun;
    const exists = dependencies.exists ?? existsSync;
    const runtimeVersion = dependencies.runtimeVersion?.(input.nodeExecutable) ??
        defaultRuntimeVersion(input.nodeExecutable, run);
    if (runtimeVersion !== input.nodeVersion)
        return null;
    try {
        const executable = attestRuntimeFile(input.nodeExecutable, dependencies);
        const linkedRuntimePaths = [
            ...new Set(dependencies.runtimeFiles?.(executable.path) ?? defaultRuntimeFiles(executable.path, run)),
        ].sort();
        if (linkedRuntimePaths.length === 0)
            return null;
        const missingRuntimePaths = linkedRuntimePaths.filter((path) => !exists(path));
        if (missingRuntimePaths.some((path) => !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'))) {
            return null;
        }
        const runtimeCachePath = missingRuntimePaths.length > 0
            ? (dependencies.runtimeCache?.() ?? defaultRuntimeCache(exists))
            : null;
        if (missingRuntimePaths.length > 0 && !runtimeCachePath)
            return null;
        const loadedRuntimeFiles = [executable.path, ...linkedRuntimePaths.filter(exists)]
            .sort()
            .map((path) => attestRuntimeFile(path, dependencies));
        const mappings = [...new Set(executableMappings)]
            .sort()
            .map((path) => attestRuntimeFile(path, dependencies));
        return {
            version: 1,
            executable,
            runtimeVersion,
            linkedRuntimePaths,
            loadedRuntimeFiles,
            sharedRuntimeCache: runtimeCachePath
                ? attestRuntimeFile(runtimeCachePath, dependencies)
                : null,
            executableMappings: mappings,
        };
    }
    catch {
        return null;
    }
}
function sandboxString(value) {
    if (value.includes('\0'))
        throw new Error('METRO_RUNTIME_ENFORCEMENT_PATH_INVALID');
    return JSON.stringify(value);
}
function canonicalPath(path, canonicalize) {
    try {
        return canonicalize(path);
    }
    catch {
        return resolve(path);
    }
}
function pathFilters(paths) {
    return paths
        .flatMap((path) => [
        `    (literal ${sandboxString(path)})`,
        `    (subpath ${sandboxString(path)})`,
    ])
        .join('\n');
}
function managedMetroSandboxProfile(input) {
    const readRoots = [...new Set(input.readRoots)].sort();
    const writeRoots = [...new Set(input.writeRoots)].sort();
    const executablePaths = [...new Set(input.executablePaths)].sort();
    const executableMapPaths = [...new Set(input.executableMapPaths)].sort();
    const executableMapDenyRoots = [...new Set(input.executableMapDenyRoots)].sort();
    const pathAncestors = [...new Set([...readRoots, ...writeRoots])].sort();
    return `(version 1)
(deny default)
(import "system.sb")
(allow process-fork)
(deny network-outbound)
(deny file-map-executable
${pathFilters(executableMapDenyRoots)})
(allow file-map-executable
${executableMapPaths.map((path) => `    (literal ${sandboxString(path)})`).join('\n')})
(allow process-exec
${executablePaths.map((path) => `    (literal ${sandboxString(path)})`).join('\n')})
(allow file-read* file-test-existence
${pathFilters(readRoots)})
(allow file-read-metadata file-test-existence
${pathAncestors.map((path) => `    (path-ancestors ${sandboxString(path)})`).join('\n')})
(allow file-write* file-test-existence
${pathFilters(writeRoots)})
(allow network-bind
    (local tcp ${sandboxString(`*:${input.port}`)}))
(allow network-inbound
    (local tcp ${sandboxString(`*:${input.port}`)}))
`;
}
export function prepareManagedMetroEnforcement(input, dependencies = {}) {
    if (input.platform !== 'darwin') {
        return { status: 'unsupported', reason: 'host-enforcement-unavailable' };
    }
    const sandbox = verifiedSandboxExecutable(dependencies);
    if (!sandbox) {
        return { status: 'unsupported', reason: 'sandbox-executable-unverified' };
    }
    const canonicalize = dependencies.canonicalize ?? realpathSync;
    const sourceRoot = canonicalPath(input.sourceRoot, canonicalize);
    const appRoot = canonicalPath(input.appRoot, canonicalize);
    const runtimeRoot = canonicalPath(input.runtimeRoot, canonicalize);
    const nodeExecutable = canonicalPath(input.nodeExecutable, canonicalize);
    const commandExecutable = canonicalPath(input.commandExecutable, canonicalize);
    const runtimeInputs = input.runtimeInputs.map((path) => canonicalPath(path, canonicalize));
    const expoStateRoot = resolve(appRoot, '.expo');
    const readRoots = [
        sourceRoot,
        appRoot,
        runtimeRoot,
        nodeExecutable,
        commandExecutable,
        ...runtimeInputs,
    ];
    const executablePaths = [nodeExecutable, commandExecutable, '/usr/bin/env'];
    const nodeRuntimeAttestation = attestNodeRuntime({
        ...input,
        nodeExecutable,
        commandExecutable,
        runtimeInputs,
    }, executablePaths, dependencies);
    if (!nodeRuntimeAttestation) {
        return { status: 'unsupported', reason: 'node-runtime-unverified' };
    }
    const profile = managedMetroSandboxProfile({
        readRoots,
        writeRoots: [runtimeRoot, expoStateRoot],
        executablePaths,
        executableMapPaths: [
            ...nodeRuntimeAttestation.loadedRuntimeFiles.map((entry) => entry.path),
            ...nodeRuntimeAttestation.executableMappings.map((entry) => entry.path),
        ],
        executableMapDenyRoots: [sourceRoot, appRoot, ...runtimeInputs],
        port: input.port,
    });
    const canaryId = sha256(`${input.instanceId}\0${input.port}`).slice(0, 32);
    return {
        status: 'enforced',
        kind: 'darwin-seatbelt-v2',
        sandboxExecutable: sandbox.path,
        sandboxExecutableSha256: sandbox.sha256,
        sandboxExecutableCdHash: sandbox.cdHash,
        profile,
        profileSha256: sha256(profile),
        canaryPath: `/private/tmp/rn-dev-agent-metro-${canaryId}.canary`,
        descendantCanaryPath: resolve(runtimeRoot, `descendant-${canaryId}.cjs`),
        symlinkCanaryPath: resolve(runtimeRoot, `enforcement-${canaryId}.canary`),
        port: input.port,
        unallocatedPort: 0,
        nodeExecutable,
        nodeRuntimeAttestation,
    };
}
const PREFLIGHT_SOURCE = String.raw `
const { spawnSync } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const { createConnection, createServer } = require('node:net');
const input = JSON.parse(process.argv[1]);
const denied = (run) => {
  try {
    run();
    return false;
  } catch (error) {
    return error && (error.code === 'EPERM' || error.code === 'EACCES');
  }
};
const descendantResult = spawnSync(process.execPath, [input.descendantCanaryPath]);
const descendantCreationAllowed = descendantResult.status === 0;
const unauthorizedResult = spawnSync('/usr/bin/true', []);
const unauthorizedExecutableDenied =
  unauthorizedResult.status === null &&
  unauthorizedResult.error &&
  (unauthorizedResult.error.code === 'EPERM' || unauthorizedResult.error.code === 'EACCES');
const unmanifestedReadDenied = denied(() => readFileSync(input.canaryPath));
const unmanifestedWriteDenied = denied(() => writeFileSync(input.canaryPath, 'forged'));
const symlinkEscapeDenied = denied(() => readFileSync(input.symlinkCanaryPath));
const listen = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => resolve({ ok: !error, code: error && error.code })),
    );
  });
(async () => {
  const allocated = await listen(input.port);
  const unallocated = await listen(input.unallocatedPort);
  const networkOutboundDenied = await new Promise((resolve) => {
    const connection = createConnection(input.port, '127.0.0.1');
    connection.once('connect', () => {
      connection.destroy();
      resolve(false);
    });
    connection.once('error', (error) =>
      resolve(error.code === 'EPERM' || error.code === 'EACCES'),
    );
  });
  const receipt = {
    descendantCreationAllowed,
    unauthorizedExecutableDenied: Boolean(unauthorizedExecutableDenied),
    unmanifestedReadDenied,
    unmanifestedWriteDenied,
    symlinkEscapeDenied,
    unallocatedListenerDenied:
      !unallocated.ok && (unallocated.code === 'EPERM' || unallocated.code === 'EACCES'),
    allocatedListenerAllowed: allocated.ok,
    networkOutboundDenied,
  };
  process.stdout.write(JSON.stringify(receipt));
  process.exit(Object.values(receipt).every(Boolean) ? 0 : 1);
})().catch(() => process.exit(1));
`;
export function runManagedMetroEnforcementPreflight(plan, dependencies = {}) {
    const writeCanary = dependencies.writeCanary ??
        ((path, contents) => {
            const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
            try {
                writeSync(descriptor, contents);
            }
            finally {
                closeSync(descriptor);
            }
        });
    const removeCanary = dependencies.removeCanary ?? ((path) => rmSync(path, { force: true }));
    const run = dependencies.run ?? defaultRun;
    let canaryCreated = false;
    let descendantCanaryCreated = false;
    let symlinkCreated = false;
    try {
        writeCanary(plan.canaryPath, 'rn-dev-agent sandbox canary');
        canaryCreated = true;
        mkdirSync(dirname(plan.descendantCanaryPath), { recursive: true });
        writeCanary(plan.descendantCanaryPath, 'process.exit(0);');
        descendantCanaryCreated = true;
        mkdirSync(dirname(plan.symlinkCanaryPath), { recursive: true });
        rmSync(plan.symlinkCanaryPath, { force: true });
        symlinkSync(plan.canaryPath, plan.symlinkCanaryPath);
        symlinkCreated = true;
        const result = run(plan.sandboxExecutable, [
            '-p',
            plan.profile,
            plan.nodeExecutable,
            '-e',
            PREFLIGHT_SOURCE,
            JSON.stringify({
                canaryPath: plan.canaryPath,
                descendantCanaryPath: plan.descendantCanaryPath,
                symlinkCanaryPath: plan.symlinkCanaryPath,
                port: plan.port,
                unallocatedPort: plan.unallocatedPort,
            }),
        ]);
        if (result.status !== 0) {
            throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed');
        }
        const observed = JSON.parse(result.stdout);
        if (observed.descendantCreationAllowed !== true ||
            observed.unauthorizedExecutableDenied !== true ||
            observed.unmanifestedReadDenied !== true ||
            observed.unmanifestedWriteDenied !== true ||
            observed.symlinkEscapeDenied !== true ||
            observed.unallocatedListenerDenied !== true ||
            observed.allocatedListenerAllowed !== true ||
            observed.networkOutboundDenied !== true) {
            throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is incomplete');
        }
        return {
            version: 2,
            kind: plan.kind,
            profileSha256: plan.profileSha256,
            sandboxExecutableSha256: plan.sandboxExecutableSha256,
            sandboxExecutableCdHash: plan.sandboxExecutableCdHash,
            descendantCreationAllowed: true,
            unauthorizedExecutableDenied: true,
            unmanifestedReadDenied: true,
            unmanifestedWriteDenied: true,
            symlinkEscapeDenied: true,
            unallocatedListenerDenied: true,
            allocatedListenerAllowed: true,
            networkOutboundDenied: true,
            nodeRuntimeAttestation: plan.nodeRuntimeAttestation,
        };
    }
    catch (error) {
        if (error instanceof Error && error.message.startsWith('METRO_RUNTIME_ENFORCEMENT_')) {
            throw error;
        }
        throw new Error('METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is invalid', {
            cause: error,
        });
    }
    finally {
        if (symlinkCreated)
            rmSync(plan.symlinkCanaryPath, { force: true });
        if (descendantCanaryCreated)
            removeCanary(plan.descendantCanaryPath);
        if (canaryCreated)
            removeCanary(plan.canaryPath);
    }
}
export function verifyManagedMetroEnforcementReceipt(input, receipt, dependencies = {}) {
    if (!receipt || typeof receipt !== 'object')
        return false;
    const observed = receipt;
    const plan = prepareManagedMetroEnforcement(input, dependencies);
    return (plan.status === 'enforced' &&
        observed.version === 2 &&
        observed.kind === plan.kind &&
        observed.profileSha256 === plan.profileSha256 &&
        observed.sandboxExecutableSha256 === plan.sandboxExecutableSha256 &&
        observed.sandboxExecutableCdHash === plan.sandboxExecutableCdHash &&
        observed.descendantCreationAllowed === true &&
        observed.unauthorizedExecutableDenied === true &&
        observed.unmanifestedReadDenied === true &&
        observed.unmanifestedWriteDenied === true &&
        observed.symlinkEscapeDenied === true &&
        observed.unallocatedListenerDenied === true &&
        observed.allocatedListenerAllowed === true &&
        observed.networkOutboundDenied === true &&
        canonicalAuthorityJson(observed.nodeRuntimeAttestation) ===
            canonicalAuthorityJson(plan.nodeRuntimeAttestation));
}
