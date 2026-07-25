import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
function digest(parts) {
    const hash = createHash('sha256');
    for (const part of parts) {
        hash.update(part);
        hash.update('\0');
    }
    return hash.digest('hex');
}
const MAX_STRICT_PROOF_FILES = 4_096;
const MAX_STRICT_PROOF_FILE_BYTES = 16 * 1024 * 1024;
const MAX_STRICT_PROOF_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_STRICT_PROOF_DEPENDENCY_ENTRIES = 50_000;
const MAX_STRICT_PROOF_DEPENDENCY_DEPTH = 128;
const MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES = 512 * 1024 * 1024;
const STRICT_PROOF_READ_BUFFER_BYTES = 64 * 1024;
const DEPENDENCY_STORE_PATHS = [
    ':(top,glob)**/node_modules/**',
    ':(top,glob)**/.yarn/cache/**',
    ':(top,glob)**/.yarn/unplugged/**',
];
const EXCLUDED_RUNTIME_DIRECTORIES = [
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
const IGNORED_RUNTIME_INPUT_PATHS = [
    ':(top,glob)**',
    ':(top,exclude,glob)**/node_modules/**',
    ':(top,exclude,glob)**/.yarn/cache/**',
    ':(top,exclude,glob)**/.yarn/unplugged/**',
    ...EXCLUDED_RUNTIME_DIRECTORIES.map((entry) => `:(top,exclude,glob)**/${entry}/**`),
];
const METRO_INTEGRATION_START = '// rn-dev-agent session integration: begin';
const METRO_INTEGRATION_END = '// rn-dev-agent session integration: end';
const METRO_INTEGRATION_BLOCK = `${METRO_INTEGRATION_START}
module.exports = require('./.rn-agent/integration/rn-session-metro.cjs')(module.exports);
${METRO_INTEGRATION_END}`;
const METRO_RUNTIME_POLICY = '.rn-agent/integration/metro-runtime-policy.json';
const METRO_RUNTIME_LOADS = '.rn-agent/integration/metro-runtime-loads.jsonl';
function updateFramed(hash, part) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    hash.update(`${bytes.byteLength}:`);
    hash.update(bytes);
}
function updateFramedFile(hash, path, size) {
    hash.update(`${size}:`);
    const descriptor = openSync(path, 'r');
    const buffer = Buffer.allocUnsafe(Math.min(STRICT_PROOF_READ_BUFFER_BYTES, Math.max(size, 1)));
    try {
        let offset = 0;
        while (offset < size) {
            const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
            if (bytesRead === 0) {
                throw new Error('STRICT_PROOF_SOURCE_READ_FAILED: source file changed while hashing');
            }
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
    }
    finally {
        closeSync(descriptor);
    }
}
function updateDependencyPath(hash, path, label, state) {
    const pending = [{ path, label, depth: 0 }];
    while (pending.length > 0) {
        const current = pending.pop();
        state.entries += 1;
        if (state.entries > MAX_STRICT_PROOF_DEPENDENCY_ENTRIES) {
            throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency entry count exceeds the limit');
        }
        if (current.depth > MAX_STRICT_PROOF_DEPENDENCY_DEPTH) {
            throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency depth exceeds the limit');
        }
        const stat = lstatSync(current.path);
        updateFramed(hash, current.label);
        updateFramed(hash, String(stat.mode & 0o777));
        if (stat.isSymbolicLink()) {
            const link = readlinkSync(current.path);
            const target = realpathSync(current.path);
            state.totalBytes += Buffer.byteLength(link);
            if (state.totalBytes > MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES) {
                throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency bytes exceed the total limit');
            }
            updateFramed(hash, 'symlink');
            updateFramed(hash, link);
            updateFramed(hash, target);
            pending.push({
                path: target,
                label: `target:${target}`,
                depth: current.depth + 1,
            });
            continue;
        }
        if (stat.isDirectory()) {
            const canonical = realpathSync(current.path);
            if (state.visitedDirectories.has(canonical)) {
                updateFramed(hash, 'directory-reference');
                updateFramed(hash, canonical);
                continue;
            }
            state.visitedDirectories.add(canonical);
            updateFramed(hash, 'directory');
            for (const entry of readdirSync(current.path).sort().reverse()) {
                pending.push({
                    path: join(current.path, entry),
                    label: `${current.label}/${entry}`,
                    depth: current.depth + 1,
                });
            }
            continue;
        }
        if (!stat.isFile()) {
            throw new Error(`STRICT_PROOF_UNSUPPORTED_DEPENDENCY: ${current.label} is not a regular file, directory, or symlink`);
        }
        if (stat.size > MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES) {
            throw new Error(`STRICT_PROOF_DEPENDENCY_LIMIT: ${current.label} exceeds the per-file limit`);
        }
        state.totalBytes += stat.size;
        if (state.totalBytes > MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES) {
            throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency bytes exceed the total limit');
        }
        updateFramed(hash, 'file');
        updateFramedFile(hash, current.path, stat.size);
    }
}
function isContained(root, candidate) {
    const child = relative(root, candidate);
    return (child !== '..' &&
        !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(child));
}
function isExcludedRuntimePath(root, candidate) {
    const entry = relative(root, candidate).split('\\').join('/');
    return EXCLUDED_RUNTIME_DIRECTORIES.some((excluded) => entry === excluded ||
        entry.startsWith(`${excluded}/`) ||
        entry.endsWith(`/${excluded}`) ||
        entry.includes(`/${excluded}/`));
}
function assertFinalMetroIntegration(identity) {
    const candidates = ['metro.config.js', 'metro.config.cjs']
        .map((entry) => join(identity.appRoot, entry))
        .filter(existsSync);
    if (candidates.length === 0)
        return;
    const source = readFileSync(candidates[0], 'utf8');
    const start = source.indexOf(METRO_INTEGRATION_START);
    const end = source.indexOf(METRO_INTEGRATION_END);
    if (start < 0 ||
        end < start ||
        source.indexOf(METRO_INTEGRATION_START, start + METRO_INTEGRATION_START.length) >= 0 ||
        source.indexOf(METRO_INTEGRATION_END, end + METRO_INTEGRATION_END.length) >= 0 ||
        source.slice(start, end + METRO_INTEGRATION_END.length) !== METRO_INTEGRATION_BLOCK ||
        source.slice(end + METRO_INTEGRATION_END.length).trim()) {
        throw new Error('STRICT_PROOF_UNVERIFIED_METRO_CONFIG: session integration must be one exact terminal block');
    }
}
function metroRuntimeInputs(identity, authority) {
    if (!authority)
        return [];
    const raw = readFileSync(join(identity.appRoot, METRO_RUNTIME_POLICY), 'utf8');
    const receipt = JSON.parse(raw);
    const payload = {
        version: receipt.version,
        sessionId: receipt.sessionId,
        metroInstanceId: receipt.metroInstanceId,
        contentRoot: receipt.contentRoot,
        appRoot: receipt.appRoot,
        runtimeInputs: receipt.runtimeInputs,
        violations: receipt.violations,
    };
    const expected = createHmac('sha256', authority.capability)
        .update(JSON.stringify(payload))
        .digest();
    const observed = typeof receipt.signature === 'string' ? Buffer.from(receipt.signature, 'hex') : Buffer.alloc(0);
    if (receipt.version !== 1 ||
        receipt.sessionId !== authority.sessionId ||
        receipt.metroInstanceId !== authority.metroInstanceId ||
        receipt.contentRoot !== identity.contentRoot ||
        receipt.appRoot !== identity.appRoot ||
        !Array.isArray(receipt.runtimeInputs) ||
        receipt.runtimeInputs.some((entry) => typeof entry !== 'string') ||
        !Array.isArray(receipt.violations) ||
        receipt.violations.some((entry) => typeof entry !== 'string') ||
        observed.length !== expected.length ||
        !timingSafeEqual(observed, expected)) {
        throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime policy receipt is invalid');
    }
    if (receipt.violations.length > 0) {
        throw new Error(`STRICT_PROOF_UNVERIFIED_METRO_POLICY: ${receipt.violations[0]}`);
    }
    const runtimeInputs = new Set(receipt.runtimeInputs);
    const runtimeLoadsPath = join(identity.appRoot, METRO_RUNTIME_LOADS);
    let runtimeLoadsRaw;
    try {
        const runtimeLoadsStat = lstatSync(runtimeLoadsPath);
        if (!runtimeLoadsStat.isFile() || runtimeLoadsStat.size > MAX_STRICT_PROOF_FILE_BYTES) {
            throw new Error('runtime load evidence is not a bounded regular file');
        }
        runtimeLoadsRaw = readFileSync(runtimeLoadsPath, 'utf8');
    }
    catch (error) {
        throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid', {
            cause: error,
        });
    }
    const runtimeLoads = runtimeLoadsRaw.split('\n').filter(Boolean);
    if (runtimeLoads.length > MAX_STRICT_PROOF_DEPENDENCY_ENTRIES) {
        throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is unbounded');
    }
    for (const rawLoad of runtimeLoads) {
        let load;
        try {
            load = JSON.parse(rawLoad);
        }
        catch (error) {
            throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid', {
                cause: error,
            });
        }
        const loadPayload = {
            version: load.version,
            sessionId: load.sessionId,
            metroInstanceId: load.metroInstanceId,
            kind: load.kind,
            value: load.value,
        };
        const expectedLoad = createHmac('sha256', authority.capability)
            .update(JSON.stringify(loadPayload))
            .digest();
        const observedLoad = typeof load.signature === 'string' ? Buffer.from(load.signature, 'hex') : Buffer.alloc(0);
        if (load.version !== 1 ||
            load.sessionId !== authority.sessionId ||
            load.metroInstanceId !== authority.metroInstanceId ||
            (load.kind !== 'input' && load.kind !== 'violation') ||
            typeof load.value !== 'string' ||
            observedLoad.length !== expectedLoad.length ||
            !timingSafeEqual(observedLoad, expectedLoad)) {
            throw new Error('STRICT_PROOF_UNVERIFIED_METRO_POLICY: runtime load evidence is invalid');
        }
        if (load.kind === 'violation') {
            throw new Error(`STRICT_PROOF_UNVERIFIED_METRO_POLICY: ${load.value}`);
        }
        runtimeInputs.add(load.value);
    }
    return [...runtimeInputs].sort().flatMap((entry) => {
        const candidate = realpathSync(entry);
        return !isContained(identity.contentRoot, candidate) ||
            isExcludedRuntimePath(identity.contentRoot, candidate)
            ? [candidate]
            : [];
    });
}
function dependencyStoreRoots(identity, git, pathExists) {
    const entries = git(identity.contentRoot, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '--directory',
        '-z',
        '--',
        ...DEPENDENCY_STORE_PATHS,
    ])
        .split('\0')
        .filter(Boolean);
    for (const candidate of [
        join(identity.contentRoot, 'node_modules'),
        join(identity.appRoot, 'node_modules'),
    ]) {
        if (pathExists(candidate))
            entries.push(relative(identity.contentRoot, candidate));
    }
    const pnpRoots = [];
    let pnpRoot = identity.appRoot;
    while (true) {
        pnpRoots.push(pnpRoot);
        if (pnpRoot === identity.contentRoot)
            break;
        const parent = dirname(pnpRoot);
        if (parent === pnpRoot || !isContained(identity.contentRoot, parent))
            break;
        pnpRoot = parent;
    }
    const pnpLoaders = [...new Set(pnpRoots)].flatMap((root) => ['.pnp.js', '.pnp.cjs', '.pnp.loader.mjs'].map((entry) => join(root, entry)).filter(pathExists));
    if (pnpLoaders.length > 0) {
        throw new Error('STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: Plug’n’Play dependency resolution is unsupported');
    }
    let ancestor = dirname(identity.contentRoot);
    while (true) {
        if (pathExists(join(ancestor, 'node_modules'))) {
            throw new Error('STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: ancestor node_modules resolves outside the content root');
        }
        const parent = dirname(ancestor);
        if (parent === ancestor)
            break;
        ancestor = parent;
    }
    const roots = [...new Set(entries.map((entry) => resolve(identity.contentRoot, entry)))].sort();
    for (const root of roots) {
        assertContained(identity.contentRoot, root, 'STRICT_PROOF_DEPENDENCY_PATH_ESCAPE');
    }
    return roots.filter((candidate) => !roots.some((parent) => parent !== candidate && isContained(parent, candidate)));
}
function updateDependencyStores(hash, identity, git, pathExists, runtimeInputs) {
    const roots = dependencyStoreRoots(identity, git, pathExists);
    const state = {
        entries: 0,
        totalBytes: 0,
        visitedDirectories: new Set(),
    };
    updateFramed(hash, 'dependency-stores-v1');
    for (const root of [...new Set([...roots, ...runtimeInputs])].sort()) {
        if (!pathExists(root))
            continue;
        updateDependencyPath(hash, root, relative(identity.contentRoot, root), state);
    }
}
function defaultGit(root, args) {
    return execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
        maxBuffer: 64 * 1024 * 1024,
    }).trim();
}
function isDefinitiveNonGitError(error) {
    if (!(error instanceof Error))
        return false;
    const stderr = 'stderr' in error && typeof error.stderr === 'string'
        ? error.stderr
        : 'stderr' in error && Buffer.isBuffer(error.stderr)
            ? error.stderr.toString('utf8')
            : '';
    return `${error.message}\n${stderr}`.toLowerCase().includes('not a git repository');
}
function assertContained(root, candidate, code) {
    const child = relative(root, candidate);
    if (child === '..' ||
        child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(child)) {
        throw new Error(`${code}: path is outside the declared content root`);
    }
}
function resolveDeclaredIdentity(appRoot, dependencies, canonicalize) {
    if (!dependencies.declaredRoot || !dependencies.declaredManifests?.length) {
        throw new Error('NON_GIT_MANIFEST_REQUIRED: non-Git authority needs an explicit root and manifest list');
    }
    const contentRoot = canonicalize(resolve(dependencies.declaredRoot));
    assertContained(contentRoot, appRoot, 'NON_GIT_ROOT_MISMATCH');
    const manifestParts = [];
    for (const entry of [...dependencies.declaredManifests].sort()) {
        const manifest = canonicalize(resolve(contentRoot, entry));
        assertContained(contentRoot, manifest, 'NON_GIT_MANIFEST_OUTSIDE_ROOT');
        manifestParts.push(relative(contentRoot, manifest), readFileSync(manifest));
    }
    const manifestDigest = digest(manifestParts);
    const appRelative = relative(contentRoot, appRoot) || '.';
    return {
        kind: 'declared-root',
        contentRoot,
        appRoot,
        sourceKey: digest(['declared-source', contentRoot, manifestDigest]),
        worktreeKey: digest(['declared-root', contentRoot]),
        appRootKey: digest(['declared-app', appRelative]),
        manifestDigest,
        declaredManifests: [...dependencies.declaredManifests],
    };
}
export function resolveSourceIdentity(inputRoot, dependencies = {}) {
    const canonicalize = dependencies.canonicalize ?? realpathSync;
    const appRoot = canonicalize(resolve(inputRoot));
    const git = dependencies.git ?? defaultGit;
    try {
        const contentRoot = canonicalize(git(appRoot, ['rev-parse', '--show-toplevel']));
        assertContained(contentRoot, appRoot, 'APP_ROOT_OUTSIDE_WORKTREE');
        const commonRaw = git(appRoot, ['rev-parse', '--git-common-dir']);
        const commonDirectory = canonicalize(isAbsolute(commonRaw) ? commonRaw : join(appRoot, commonRaw));
        const head = git(appRoot, ['rev-parse', 'HEAD']);
        const appRelative = relative(contentRoot, appRoot) || '.';
        return {
            kind: 'git',
            contentRoot,
            appRoot,
            sourceKey: digest(['git-source', commonDirectory]),
            worktreeKey: digest(['git-worktree', contentRoot]),
            appRootKey: digest(['git-app', appRelative]),
            head,
        };
    }
    catch (error) {
        if (error instanceof Error &&
            (error.message.startsWith('APP_ROOT_OUTSIDE_WORKTREE') ||
                error.message.startsWith('NON_GIT_'))) {
            throw error;
        }
        if (!isDefinitiveNonGitError(error))
            throw error;
        return resolveDeclaredIdentity(appRoot, dependencies, canonicalize);
    }
}
export function strictProofSourceIdentity(identity, dependencies = {}) {
    if (identity.kind !== 'git') {
        throw new Error('STRICT_PROOF_GIT_REQUIRED: accepted strict proof requires a Git worktree');
    }
    const git = dependencies.git ?? defaultGit;
    const pathExists = dependencies.exists ?? existsSync;
    assertFinalMetroIntegration(identity);
    const runtimeInputs = metroRuntimeInputs(identity, dependencies.metroRuntimePolicy);
    const head = git(identity.contentRoot, ['rev-parse', 'HEAD']);
    const diff = git(identity.contentRoot, ['diff', '--binary', '--no-ext-diff', head, '--']);
    const untracked = git(identity.contentRoot, ['ls-files', '--others', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
        .sort();
    const ignored = git(identity.contentRoot, [
        'ls-files',
        '--others',
        '--ignored',
        '--exclude-standard',
        '-z',
        '--',
        ...IGNORED_RUNTIME_INPUT_PATHS,
    ])
        .split('\0')
        .filter(Boolean)
        .sort();
    const gitlinks = git(identity.contentRoot, ['ls-files', '--stage', '-z'])
        .split('\0')
        .flatMap((entry) => {
        const match = /^160000 [0-9a-f]+ \d+\t(.+)$/i.exec(entry);
        return match?.[1] ? [match[1]] : [];
    });
    for (const entry of gitlinks) {
        const submodule = resolve(identity.contentRoot, entry);
        assertContained(identity.contentRoot, submodule, 'STRICT_PROOF_PATH_ESCAPE');
        const status = git(submodule, [
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignore-submodules=none',
        ]);
        if (status) {
            throw new Error(`STRICT_PROOF_DIRTY_SUBMODULE: ${entry} contains source changes outside the parent digest`);
        }
    }
    const dirtyHash = createHash('sha256');
    updateFramed(dirtyHash, 'git-dirty-v3');
    updateFramed(dirtyHash, diff);
    updateDependencyStores(dirtyHash, identity, git, pathExists, runtimeInputs);
    const sourceEntries = [
        ...untracked.map((entry) => ['untracked', entry]),
        ...ignored.map((entry) => ['ignored-runtime', entry]),
    ];
    if (sourceEntries.length > MAX_STRICT_PROOF_FILES) {
        throw new Error('STRICT_PROOF_RUNTIME_INPUT_LIMIT: too many untracked runtime inputs');
    }
    let totalBytes = 0;
    for (const [classification, entry] of [...sourceEntries]) {
        const file = resolve(identity.contentRoot, entry);
        assertContained(identity.contentRoot, file, 'STRICT_PROOF_PATH_ESCAPE');
        const stat = lstatSync(file);
        updateFramed(dirtyHash, classification);
        updateFramed(dirtyHash, entry);
        if (stat.isFile()) {
            if (stat.size > MAX_STRICT_PROOF_FILE_BYTES) {
                throw new Error(`STRICT_PROOF_RUNTIME_INPUT_LIMIT: ${entry} exceeds the per-file limit`);
            }
            totalBytes += stat.size;
            if (totalBytes > MAX_STRICT_PROOF_TOTAL_BYTES) {
                throw new Error('STRICT_PROOF_RUNTIME_INPUT_LIMIT: runtime inputs exceed the total limit');
            }
            updateFramed(dirtyHash, 'file');
            updateFramedFile(dirtyHash, file, stat.size);
            continue;
        }
        if (stat.isSymbolicLink()) {
            const target = realpathSync(file);
            assertContained(identity.contentRoot, target, 'STRICT_PROOF_PATH_ESCAPE');
            const link = readlinkSync(file);
            const targetStat = lstatSync(target);
            if (!targetStat.isFile()) {
                throw new Error('STRICT_PROOF_UNSUPPORTED_FILE: untracked symlink target is not a regular file');
            }
            if (targetStat.size > MAX_STRICT_PROOF_FILE_BYTES) {
                throw new Error(`STRICT_PROOF_RUNTIME_INPUT_LIMIT: ${entry} exceeds the per-file limit`);
            }
            totalBytes += Buffer.byteLength(link) + targetStat.size;
            if (totalBytes > MAX_STRICT_PROOF_TOTAL_BYTES) {
                throw new Error('STRICT_PROOF_RUNTIME_INPUT_LIMIT: runtime inputs exceed the total limit');
            }
            updateFramed(dirtyHash, 'symlink');
            updateFramed(dirtyHash, link);
            updateFramedFile(dirtyHash, target, targetStat.size);
            continue;
        }
        throw new Error('STRICT_PROOF_UNSUPPORTED_FILE: untracked source is neither a regular file nor a symlink');
    }
    const runtimeInputsAfter = metroRuntimeInputs(identity, dependencies.metroRuntimePolicy);
    if (JSON.stringify(runtimeInputsAfter) !== JSON.stringify(runtimeInputs)) {
        throw new Error('STRICT_PROOF_SOURCE_READ_FAILED: Metro runtime inputs changed while hashing');
    }
    return {
        kind: 'git-strict-proof',
        sourceKey: identity.sourceKey,
        worktreeKey: identity.worktreeKey,
        appRootKey: identity.appRootKey,
        head,
        dirtyDigest: dirtyHash.digest('hex'),
    };
}
