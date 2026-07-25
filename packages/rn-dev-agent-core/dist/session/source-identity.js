import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
function digest(parts) {
    const hash = createHash('sha256');
    for (const part of parts) {
        hash.update(part);
        hash.update('\0');
    }
    return hash.digest('hex');
}
function framedDigest(parts) {
    const hash = createHash('sha256');
    for (const part of parts) {
        const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
        hash.update(`${bytes.byteLength}:`);
        hash.update(bytes);
    }
    return hash.digest('hex');
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
        const commonDirectory = canonicalize(isAbsolute(commonRaw) ? commonRaw : join(contentRoot, commonRaw));
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
    const dirtyParts = ['git-dirty-v2', diff];
    for (const [classification, entry] of [
        ...untracked.map((entry) => ['untracked', entry]),
        ...ignored.map((entry) => ['ignored', entry]),
    ]) {
        const file = resolve(identity.contentRoot, entry);
        assertContained(identity.contentRoot, file, 'STRICT_PROOF_PATH_ESCAPE');
        const stat = lstatSync(file);
        if (stat.isFile()) {
            dirtyParts.push(classification, entry, 'file', readFileSync(file));
            continue;
        }
        if (stat.isSymbolicLink()) {
            const target = realpathSync(file);
            assertContained(identity.contentRoot, target, 'STRICT_PROOF_PATH_ESCAPE');
            dirtyParts.push(classification, entry, 'symlink', readlinkSync(file));
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
        dirtyDigest: framedDigest(dirtyParts),
    };
}
