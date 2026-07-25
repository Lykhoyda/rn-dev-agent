import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, } from 'node:fs';
import { delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
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
const MAX_STRICT_PROOF_DEPENDENCY_FILES = 50_000;
const MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES = 128 * 1024 * 1024;
const MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES = 512 * 1024 * 1024;
const STRICT_PROOF_READ_BUFFER_BYTES = 64 * 1024;
const DEPENDENCY_STORE_PATHS = [
    ':(top,glob)**/node_modules/**',
    ':(top,glob)**/.yarn/cache/**',
    ':(top,glob)**/.yarn/unplugged/**',
];
const IGNORED_RUNTIME_INPUT_PATHS = [
    ':(top,glob)**',
    ':(top,exclude,glob)**/node_modules/**',
    ':(top,exclude,glob)**/.yarn/cache/**',
    ':(top,exclude,glob)**/.yarn/unplugged/**',
    ':(top,exclude,glob)**/.gradle/**',
    ':(top,exclude,glob)**/.expo/**',
    ':(top,exclude,glob)**/.cache/**',
    ':(top,exclude,glob)**/ios/Pods/**',
    ':(top,exclude,glob)**/ios/build/**',
    ':(top,exclude,glob)**/ios/DerivedData/**',
    ':(top,exclude,glob)**/android/build/**',
    ':(top,exclude,glob)**/android/app/build/**',
    ':(top,exclude,glob)**/android/app/.cxx/**',
];
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
    const stat = lstatSync(path);
    updateFramed(hash, label);
    updateFramed(hash, String(stat.mode & 0o777));
    if (stat.isSymbolicLink()) {
        const link = readlinkSync(path);
        const target = realpathSync(path);
        state.totalBytes += Buffer.byteLength(link);
        if (state.totalBytes > MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES) {
            throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency bytes exceed the total limit');
        }
        updateFramed(hash, 'symlink');
        updateFramed(hash, link);
        updateFramed(hash, target);
        updateDependencyPath(hash, target, `target:${target}`, state);
        return;
    }
    if (stat.isDirectory()) {
        const canonical = realpathSync(path);
        if (state.visitedDirectories.has(canonical)) {
            updateFramed(hash, 'directory-reference');
            updateFramed(hash, canonical);
            return;
        }
        state.visitedDirectories.add(canonical);
        updateFramed(hash, 'directory');
        for (const entry of readdirSync(path).sort()) {
            updateDependencyPath(hash, join(path, entry), `${label}/${entry}`, state);
        }
        return;
    }
    if (!stat.isFile()) {
        throw new Error(`STRICT_PROOF_UNSUPPORTED_DEPENDENCY: ${label} is not a regular file, directory, or symlink`);
    }
    state.files += 1;
    if (state.files > MAX_STRICT_PROOF_DEPENDENCY_FILES) {
        throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency file count exceeds the limit');
    }
    if (stat.size > MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES) {
        throw new Error(`STRICT_PROOF_DEPENDENCY_LIMIT: ${label} exceeds the per-file limit`);
    }
    state.totalBytes += stat.size;
    if (state.totalBytes > MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES) {
        throw new Error('STRICT_PROOF_DEPENDENCY_LIMIT: dependency bytes exceed the total limit');
    }
    updateFramed(hash, 'file');
    updateFramedFile(hash, path, stat.size);
}
function isContained(root, candidate) {
    const child = relative(root, candidate);
    return (child !== '..' &&
        !child.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
        !isAbsolute(child));
}
function dependencyStoreRoots(identity, git) {
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
        if (existsSync(candidate))
            entries.push(relative(identity.contentRoot, candidate));
    }
    const pnpLoaders = ['.pnp.cjs', '.pnp.loader.mjs'].filter((entry) => existsSync(join(identity.contentRoot, entry)));
    if (pnpLoaders.length > 0) {
        throw new Error('STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: Plug’n’Play dependency resolution is unsupported');
    }
    for (const configuredPath of (process.env.NODE_PATH ?? '').split(delimiter).filter(Boolean)) {
        const candidate = realpathSync(resolve(configuredPath));
        if (!isContained(identity.contentRoot, candidate)) {
            throw new Error('STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: NODE_PATH resolves outside the content root');
        }
        entries.push(relative(identity.contentRoot, candidate));
    }
    let ancestor = dirname(identity.contentRoot);
    while (ancestor !== dirname(ancestor)) {
        if (existsSync(join(ancestor, 'node_modules'))) {
            throw new Error('STRICT_PROOF_UNVERIFIED_DEPENDENCY_LAYOUT: ancestor node_modules resolves outside the content root');
        }
        ancestor = dirname(ancestor);
    }
    const roots = [...new Set(entries.map((entry) => resolve(identity.contentRoot, entry)))].sort();
    for (const root of roots) {
        assertContained(identity.contentRoot, root, 'STRICT_PROOF_DEPENDENCY_PATH_ESCAPE');
    }
    return roots.filter((candidate) => !roots.some((parent) => parent !== candidate && isContained(parent, candidate)));
}
function updateDependencyStores(hash, identity, git) {
    const roots = dependencyStoreRoots(identity, git);
    const state = {
        files: 0,
        totalBytes: 0,
        visitedDirectories: new Set(),
    };
    updateFramed(hash, 'dependency-stores-v1');
    for (const root of roots) {
        if (!existsSync(root))
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
    updateDependencyStores(dirtyHash, identity, git);
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
    return {
        kind: 'git-strict-proof',
        sourceKey: identity.sourceKey,
        worktreeKey: identity.worktreeKey,
        appRootKey: identity.appRootKey,
        head,
        dirtyDigest: dirtyHash.digest('hex'),
    };
}
