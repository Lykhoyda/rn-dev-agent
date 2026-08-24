import { spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { LEGACY_ROOT_REPAIR_REQUIRED, legacyRootRepairRemedy } from './worktree-repair-remedy.js';
// The only `.rn-agent` subpath proven shareable across linked worktrees.
// Derivation and the exclusion evidence live in templates/rn-agent/README.md.
export const SHAREABLE_RESOURCES = [
    {
        id: 'rn-agent-actions',
        label: 'learned action corpus (.rn-agent/actions)',
        type: 'directory',
        anchor: 'app',
        path: '.rn-agent/actions',
        parent: '.rn-agent',
        hosts: ['claude', 'codex'],
    },
];
const repositoryIdentityEvidence = Symbol('repositoryIdentityEvidence');
const GIT_ENV_OVERRIDES = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_NAMESPACE',
];
function gitEnvironment() {
    const env = { ...process.env };
    for (const key of GIT_ENV_OVERRIDES)
        delete env[key];
    return env;
}
function git(cwd, args) {
    const result = spawnSync('git', args, {
        cwd,
        encoding: 'utf8',
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error || result.status !== 0)
        return { ok: false, stdout: '' };
    return { ok: true, stdout: (result.stdout ?? '').replace(/\n$/, '') };
}
function canonical(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
function contained(parent, child) {
    if (parent === child)
        return true;
    const rel = relative(parent, child);
    return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel);
}
function toPosix(path) {
    return sep === '/' ? path : path.split(sep).join('/');
}
/** Same RN-project predicate as nav-graph/storage.ts — dependency-declared, never inferred. */
export function isRnAppRoot(directory) {
    const manifest = join(directory, 'package.json');
    try {
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        const deps = { ...parsed.dependencies, ...parsed.devDependencies };
        return Boolean(deps['react-native'] || deps['expo']);
    }
    catch {
        return false;
    }
}
export function parseWorktreeRecords(porcelain) {
    const records = [];
    let current = null;
    for (const line of porcelain.split('\n')) {
        if (line.startsWith('worktree ')) {
            if (current)
                records.push(current);
            current = { path: line.slice('worktree '.length), bare: false, prunable: false };
            continue;
        }
        if (!current)
            continue;
        if (line === 'bare')
            current.bare = true;
        if (line === 'prunable' || line.startsWith('prunable '))
            current.prunable = true;
    }
    if (current)
        records.push(current);
    return records;
}
function parseFirstWorktreeRecord(porcelain) {
    // Git guarantees the main worktree is first; verify only that record and fail closed.
    const separator = porcelain.indexOf('\n\n');
    const block = separator === -1 ? porcelain : porcelain.slice(0, separator);
    const lines = block.split('\n');
    const header = lines[0];
    if (!header?.startsWith('worktree '))
        return null;
    const path = header.slice('worktree '.length);
    if (!path)
        return null;
    return {
        path,
        bare: lines.slice(1).includes('bare'),
        prunable: lines.slice(1).some((line) => line === 'prunable' || line.startsWith('prunable ')),
    };
}
function verifiedPrimary(worktreeRoot, commonDir) {
    const listing = git(worktreeRoot, ['worktree', 'list', '--porcelain']);
    if (!listing.ok)
        return null;
    const main = parseFirstWorktreeRecord(listing.stdout);
    if (!main || main.bare || main.prunable)
        return null;
    const candidate = canonical(main.path);
    if (!candidate)
        return null;
    const topLevelBefore = captureDirectoryIdentity(candidate);
    const commonDirBefore = captureDirectoryIdentity(commonDir);
    if (!topLevelBefore || !commonDirBefore)
        return null;
    const top = git(candidate, ['rev-parse', '--show-toplevel']);
    if (!top.ok || canonical(top.stdout) !== candidate)
        return null;
    const candidateGitDir = git(candidate, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const candidateCommon = git(candidate, [
        'rev-parse',
        '--path-format=absolute',
        '--git-common-dir',
    ]);
    if (!candidateGitDir.ok || !candidateCommon.ok)
        return null;
    const resolvedGitDir = canonical(candidateGitDir.stdout);
    const resolvedCommon = canonical(candidateCommon.stdout);
    if (!resolvedGitDir || !resolvedCommon)
        return null;
    if (resolvedCommon !== commonDir || resolvedGitDir !== resolvedCommon)
        return null;
    const topLevelAfter = captureDirectoryIdentity(candidate);
    const commonDirAfter = captureDirectoryIdentity(commonDir);
    if (!topLevelAfter ||
        !commonDirAfter ||
        topLevelBefore.identity.dev !== topLevelAfter.identity.dev ||
        topLevelBefore.identity.ino !== topLevelAfter.identity.ino ||
        commonDirBefore.identity.dev !== commonDirAfter.identity.dev ||
        commonDirBefore.identity.ino !== commonDirAfter.identity.ino) {
        return null;
    }
    return {
        root: candidate,
        identity: { topLevel: topLevelAfter, commonDir: commonDirAfter },
    };
}
export function resolveWorktreeLayout(input) {
    const cwd = canonical(input.cwd);
    if (!cwd)
        return { refusal: 'NOT_GIT' };
    const insideWorkTree = git(cwd, ['rev-parse', '--is-inside-work-tree']);
    if (!insideWorkTree.ok) {
        const bare = git(cwd, ['rev-parse', '--is-bare-repository']);
        if (bare.ok && bare.stdout === 'true')
            return { refusal: 'BARE' };
        return { refusal: 'NOT_GIT' };
    }
    if (insideWorkTree.stdout !== 'true')
        return { refusal: 'BARE' };
    const top = git(cwd, ['rev-parse', '--show-toplevel']);
    const gitDirRaw = git(cwd, ['rev-parse', '--path-format=absolute', '--git-dir']);
    const commonRaw = git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!top.ok || !gitDirRaw.ok || !commonRaw.ok)
        return { refusal: 'GIT_UNAVAILABLE' };
    const worktreeRoot = canonical(top.stdout);
    const gitDir = canonical(gitDirRaw.stdout);
    const commonDir = canonical(commonRaw.stdout);
    if (!worktreeRoot || !gitDir || !commonDir)
        return { refusal: 'GIT_UNAVAILABLE' };
    const appRootInput = canonical(input.appRoot ? resolve(input.appRoot) : cwd);
    if (!appRootInput)
        return { refusal: 'NOT_RN_APP' };
    if (!contained(worktreeRoot, appRootInput))
        return { refusal: 'APP_OUTSIDE_WORKTREE' };
    if (!input.allowNonRnApp && !isRnAppRoot(appRootInput))
        return { refusal: 'NOT_RN_APP' };
    const appRelative = worktreeRoot === appRootInput ? '.' : toPosix(relative(worktreeRoot, appRootInput));
    const base = {
        kind: gitDir === commonDir ? 'primary' : 'linked',
        worktreeRoot,
        commonDir,
        gitDir,
        appRoot: appRootInput,
        appRelative,
    };
    if (base.kind === 'primary')
        return base;
    const primary = verifiedPrimary(worktreeRoot, commonDir);
    if (!primary)
        return { ...base, refusal: 'NO_PRIMARY' };
    const primaryRoot = primary.root;
    const primaryAppRoot = appRelative === '.' ? primaryRoot : join(primaryRoot, appRelative);
    if (!contained(primaryRoot, primaryAppRoot))
        return { ...base, refusal: 'PRIMARY_APP_MISSING' };
    let primaryAppReal = null;
    try {
        if (lstatSync(primaryAppRoot).isDirectory())
            primaryAppReal = canonical(primaryAppRoot);
    }
    catch {
        primaryAppReal = null;
    }
    if (!primaryAppReal || !contained(primaryRoot, primaryAppReal)) {
        return { ...base, refusal: 'PRIMARY_APP_MISSING' };
    }
    const linked = { ...base, primaryRoot, primaryAppRoot };
    Object.defineProperty(linked, repositoryIdentityEvidence, { value: primary.identity });
    return linked;
}
function classifySource(path, type, boundary) {
    const rel = relative(boundary, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { state: 'WRONG_TYPE' };
    }
    const paths = [boundary];
    let cursor = boundary;
    for (const component of rel.split(sep).filter(Boolean)) {
        cursor = join(cursor, component);
        paths.push(cursor);
    }
    const inspect = () => {
        const evidence = [];
        for (let index = 0; index < paths.length; index += 1) {
            let node;
            try {
                node = lstatSync(paths[index], { bigint: true });
            }
            catch (error) {
                const code = error.code;
                if (code === 'EACCES' || code === 'EPERM')
                    return { state: 'PERMISSION_DENIED' };
                return { state: 'MISSING' };
            }
            if (node.isSymbolicLink())
                return { state: 'WRONG_TYPE' };
            const isLeaf = index === paths.length - 1;
            const typeOk = isLeaf
                ? type === 'directory'
                    ? node.isDirectory()
                    : node.isFile()
                : node.isDirectory();
            if (!typeOk)
                return { state: 'WRONG_TYPE' };
            evidence.push({ dev: String(node.dev), ino: String(node.ino) });
        }
        const resolved = canonical(path);
        if (!resolved || !contained(boundary, resolved))
            return { state: 'WRONG_TYPE' };
        return { state: 'AVAILABLE', evidence };
    };
    const before = inspect();
    if (before.state !== 'AVAILABLE')
        return before;
    const after = inspect();
    if (after.state !== 'AVAILABLE' || !sameSourceEvidence(before.evidence, after.evidence)) {
        return { state: 'WRONG_TYPE' };
    }
    return after;
}
function sameSourceEvidence(left, right) {
    if (!left || !right)
        return left === right;
    return (left.length === right.length &&
        left.every((identity, index) => {
            const candidate = right[index];
            return identity.dev === candidate.dev && identity.ino === candidate.ino;
        }));
}
function sourceLeafMatchesIdentity(evidence, identity) {
    const leaf = evidence?.at(-1);
    return leaf?.dev === identity.dev && leaf.ino === identity.ino;
}
function repositoryIdentityUnchanged(identity) {
    return (currentIdentityMatches(identity.topLevel.path, identity.topLevel.identity, 'directory') &&
        currentIdentityMatches(identity.commonDir.path, identity.commonDir.identity, 'directory') &&
        canonical(identity.topLevel.path) === identity.topLevel.path &&
        canonical(identity.commonDir.path) === identity.commonDir.path);
}
function classifyDestination(path, sourcePath, type) {
    let link;
    try {
        link = lstatSync(path, { bigint: true });
    }
    catch (error) {
        const code = error.code;
        if (code === 'EACCES' || code === 'EPERM')
            return { state: 'PERMISSION_DENIED' };
        return { state: 'MISSING' };
    }
    if (!link.isSymbolicLink()) {
        if (link.isDirectory())
            return { state: 'DIRECTORY' };
        return { state: 'FILE' };
    }
    const evidence = { dev: String(link.dev), ino: String(link.ino) };
    const resolved = canonical(path);
    if (!resolved)
        return { state: 'LINK_STALE', evidence };
    const expected = sourcePath ? canonical(sourcePath) : null;
    if (!expected || resolved !== expected)
        return { state: 'LINK_FOREIGN', evidence };
    try {
        const stats = statSync(resolved);
        const typeOk = type === 'directory' ? stats.isDirectory() : stats.isFile();
        return { state: typeOk ? 'LINK_VALID' : 'LINK_FOREIGN', evidence };
    }
    catch {
        return { state: 'LINK_STALE', evidence };
    }
}
function identityOf(stat) {
    return { dev: String(stat.dev), ino: String(stat.ino) };
}
function lstatIfPresent(path) {
    try {
        return lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function refuseCorpus(reason) {
    return { status: 'refused', reason };
}
function refuseForeignActions(actionsDir) {
    return refuseCorpus(`Refusing foreign learned-action corpus symlink at ${actionsDir}.`);
}
function refuseReplacedActions(actionsDir) {
    return refuseCorpus(`Refusing replaced learned-action corpus symlink at ${actionsDir}.`);
}
function refuseDanglingActions(actionsDir) {
    return refuseCorpus(`Refusing dangling learned-action corpus symlink at ${actionsDir}.`);
}
function directoryIdentityUnchanged(path, expected) {
    const current = lstatIfPresent(path);
    return Boolean(current &&
        !current.isSymbolicLink() &&
        current.isDirectory() &&
        String(current.dev) === expected.dev &&
        String(current.ino) === expected.ino);
}
function openUnfollowedDirectory(path, expected) {
    let fd;
    try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    }
    catch {
        return false;
    }
    try {
        const opened = fstatSync(fd, { bigint: true });
        return (opened.isDirectory() &&
            String(opened.dev) === expected.dev &&
            String(opened.ino) === expected.ino);
    }
    finally {
        closeSync(fd);
    }
}
export function resolveReadableActionCorpus(projectRoot, dependencies = {}) {
    const root = canonical(projectRoot) ?? resolve(projectRoot);
    const projectRootEntry = captureDirectoryIdentity(root);
    if (!projectRootEntry)
        return { status: 'absent' };
    const projectRootIdentity = projectRootEntry.identity;
    const rnAgentDir = join(root, '.rn-agent');
    const actionsDir = join(rnAgentDir, 'actions');
    const rnAgentStat = lstatIfPresent(rnAgentDir);
    if (!rnAgentStat)
        return { status: 'absent' };
    if (rnAgentStat.isSymbolicLink() || !rnAgentStat.isDirectory()) {
        return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
    }
    const rnAgentIdentity = identityOf(rnAgentStat);
    if (!openUnfollowedDirectory(rnAgentDir, rnAgentIdentity)) {
        return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
    }
    const actionsStat = lstatIfPresent(actionsDir);
    if (!directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
        return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
    }
    if (!actionsStat)
        return { status: 'absent' };
    if (!actionsStat.isSymbolicLink()) {
        if (!actionsStat.isDirectory())
            return { status: 'absent' };
        const identity = identityOf(actionsStat);
        if (!openUnfollowedDirectory(actionsDir, identity)) {
            return refuseReplacedActions(actionsDir);
        }
        if (!directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
            return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
        }
        if (!directoryIdentityUnchanged(actionsDir, identity)) {
            return refuseReplacedActions(actionsDir);
        }
        if (!directoryIdentityUnchanged(root, projectRootIdentity)) {
            return refuseReplacedActions(actionsDir);
        }
        return {
            status: 'owned-directory',
            projectRoot: root,
            projectRootIdentity,
            rnAgentDir,
            rnAgentIdentity,
            actionsDir,
            identity,
        };
    }
    const layout = resolveWorktreeLayout({ cwd: root, appRoot: root });
    if (!('kind' in layout) ||
        layout.kind !== 'linked' ||
        layout.refusal ||
        !layout.primaryRoot ||
        !layout.primaryAppRoot) {
        return refuseForeignActions(actionsDir);
    }
    const primaryIdentity = layout[repositoryIdentityEvidence];
    if (!primaryIdentity)
        return refuseReplacedActions(actionsDir);
    const linkedIdentity = captureLinkedRepositoryIdentity(layout);
    if (!linkedIdentity)
        return refuseReplacedActions(actionsDir);
    const primaryRnAgentDir = join(layout.primaryAppRoot, '.rn-agent');
    const primaryActionsDir = join(primaryRnAgentDir, 'actions');
    const planned = planResource(layout, SHAREABLE_RESOURCES[0]);
    if (planned.destinationState === 'LINK_STALE')
        return refuseDanglingActions(actionsDir);
    if (planned.state !== 'LINK_VALID_SAFE' || !planned.evidence) {
        return refuseCorpus(`Refusing learned-action corpus at ${actionsDir}; setup classified it as ${planned.state}.`);
    }
    if (planned.sourceState !== 'AVAILABLE' || !planned.sourceEvidence) {
        return refuseForeignActions(actionsDir);
    }
    dependencies.beforeTargetOpen?.();
    const targetDir = canonical(primaryActionsDir);
    if (!targetDir)
        return refuseForeignActions(actionsDir);
    const targetStat = lstatIfPresent(targetDir);
    if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        return refuseForeignActions(actionsDir);
    }
    const targetIdentity = identityOf(targetStat);
    if (!openUnfollowedDirectory(targetDir, targetIdentity)) {
        return refuseReplacedActions(actionsDir);
    }
    dependencies.afterTargetOpen?.();
    const plannedAfter = planResource(layout, SHAREABLE_RESOURCES[0]);
    if (plannedAfter.state !== 'LINK_VALID_SAFE' ||
        !plannedAfter.evidence ||
        plannedAfter.evidence.dev !== planned.evidence.dev ||
        plannedAfter.evidence.ino !== planned.evidence.ino ||
        plannedAfter.sourceState !== 'AVAILABLE' ||
        !sameSourceEvidence(planned.sourceEvidence, plannedAfter.sourceEvidence) ||
        !sourceLeafMatchesIdentity(planned.sourceEvidence, targetIdentity) ||
        !sourceLeafMatchesIdentity(plannedAfter.sourceEvidence, targetIdentity) ||
        !directoryIdentityUnchanged(root, projectRootIdentity) ||
        !directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity) ||
        !linkedRepositoryIdentityUnchanged(linkedIdentity) ||
        !repositoryIdentityUnchanged(primaryIdentity)) {
        return refuseReplacedActions(actionsDir);
    }
    return {
        status: 'approved-inherited',
        projectRoot: root,
        projectRootIdentity,
        rnAgentDir,
        rnAgentIdentity,
        actionsDir,
        targetDir,
        linkIdentity: planned.evidence,
        targetIdentity,
        primaryRoot: layout.primaryRoot,
        commonDir: layout.commonDir,
        primaryIdentity,
        linkedIdentity,
    };
}
export function sameReadableActionCorpus(left, right) {
    if (left.status !== right.status)
        return false;
    if (left.status === 'absent')
        return true;
    if (left.status === 'refused') {
        return right.status === 'refused' && left.reason === right.reason;
    }
    if (left.status === 'owned-directory' && right.status === 'owned-directory') {
        return (left.actionsDir === right.actionsDir &&
            left.projectRootIdentity.dev === right.projectRootIdentity.dev &&
            left.projectRootIdentity.ino === right.projectRootIdentity.ino &&
            left.rnAgentIdentity.dev === right.rnAgentIdentity.dev &&
            left.rnAgentIdentity.ino === right.rnAgentIdentity.ino &&
            left.identity.dev === right.identity.dev &&
            left.identity.ino === right.identity.ino);
    }
    return (left.status === 'approved-inherited' &&
        right.status === 'approved-inherited' &&
        left.actionsDir === right.actionsDir &&
        left.projectRootIdentity.dev === right.projectRootIdentity.dev &&
        left.projectRootIdentity.ino === right.projectRootIdentity.ino &&
        left.rnAgentIdentity.dev === right.rnAgentIdentity.dev &&
        left.rnAgentIdentity.ino === right.rnAgentIdentity.ino &&
        left.targetDir === right.targetDir &&
        left.linkIdentity.dev === right.linkIdentity.dev &&
        left.linkIdentity.ino === right.linkIdentity.ino &&
        left.targetIdentity.dev === right.targetIdentity.dev &&
        left.targetIdentity.ino === right.targetIdentity.ino &&
        left.linkedIdentity.worktreeRoot.identity.dev ===
            right.linkedIdentity.worktreeRoot.identity.dev &&
        left.linkedIdentity.worktreeRoot.identity.ino ===
            right.linkedIdentity.worktreeRoot.identity.ino &&
        left.linkedIdentity.gitEntry.identity.dev === right.linkedIdentity.gitEntry.identity.dev &&
        left.linkedIdentity.gitEntry.identity.ino === right.linkedIdentity.gitEntry.identity.ino &&
        left.linkedIdentity.gitDir.identity.dev === right.linkedIdentity.gitDir.identity.dev &&
        left.linkedIdentity.gitDir.identity.ino === right.linkedIdentity.gitDir.identity.ino &&
        left.primaryRoot === right.primaryRoot &&
        left.commonDir === right.commonDir &&
        left.primaryIdentity.topLevel.identity.dev === right.primaryIdentity.topLevel.identity.dev &&
        left.primaryIdentity.topLevel.identity.ino === right.primaryIdentity.topLevel.identity.ino &&
        left.primaryIdentity.commonDir.identity.dev === right.primaryIdentity.commonDir.identity.dev &&
        left.primaryIdentity.commonDir.identity.ino === right.primaryIdentity.commonDir.identity.ino);
}
export function readableActionsDirectory(corpus) {
    if (corpus.status === 'owned-directory')
        return corpus.actionsDir;
    if (corpus.status === 'approved-inherited')
        return corpus.targetDir;
    return null;
}
export function readableActionsSnapshot(corpus) {
    if (corpus.status === 'owned-directory') {
        return { directory: corpus.actionsDir, identity: corpus.identity };
    }
    if (corpus.status === 'approved-inherited') {
        return { directory: corpus.targetDir, identity: corpus.targetIdentity };
    }
    return null;
}
let readableActionOperationSequence = 0;
function freezeIdentity(identity) {
    return Object.freeze({ ...identity });
}
function captureDirectoryIdentity(path) {
    const stat = lstatIfPresent(path);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory())
        return null;
    return Object.freeze({ path, identity: freezeIdentity(identityOf(stat)) });
}
function captureFileIdentity(path) {
    const stat = lstatIfPresent(path);
    if (!stat || stat.isSymbolicLink() || !stat.isFile())
        return null;
    return Object.freeze({ path, identity: freezeIdentity(identityOf(stat)) });
}
function captureLinkedRepositoryIdentity(layout) {
    const worktreeRoot = captureDirectoryIdentity(layout.worktreeRoot);
    const gitEntry = captureFileIdentity(join(layout.worktreeRoot, '.git'));
    const gitDir = captureDirectoryIdentity(layout.gitDir);
    if (!worktreeRoot || !gitEntry || !gitDir)
        return null;
    return { worktreeRoot, gitEntry, gitDir };
}
function linkedRepositoryIdentityUnchanged(identity) {
    return (currentIdentityMatches(identity.worktreeRoot.path, identity.worktreeRoot.identity, 'directory') &&
        currentIdentityMatches(identity.gitEntry.path, identity.gitEntry.identity, 'file') &&
        currentIdentityMatches(identity.gitDir.path, identity.gitDir.identity, 'directory'));
}
export function captureReadableActionOperationSnapshot(corpus) {
    const operationId = `${process.pid}:${++readableActionOperationSequence}`;
    if (corpus.status === 'owned-directory') {
        if (!directoryIdentityUnchanged(corpus.projectRoot, corpus.projectRootIdentity) ||
            !directoryIdentityUnchanged(corpus.rnAgentDir, corpus.rnAgentIdentity)) {
            throw new Error(refuseReplacedActions(corpus.actionsDir).reason);
        }
        return Object.freeze({
            operationId,
            kind: corpus.status,
            projectRoot: corpus.projectRoot,
            projectRootIdentity: freezeIdentity(corpus.projectRootIdentity),
            rnAgentDir: corpus.rnAgentDir,
            rnAgentIdentity: freezeIdentity(corpus.rnAgentIdentity),
            actionsDir: corpus.actionsDir,
            directory: corpus.actionsDir,
            directoryIdentity: freezeIdentity(corpus.identity),
        });
    }
    if (corpus.status === 'approved-inherited') {
        if (!directoryIdentityUnchanged(corpus.projectRoot, corpus.projectRootIdentity) ||
            !directoryIdentityUnchanged(corpus.rnAgentDir, corpus.rnAgentIdentity) ||
            !repositoryIdentityUnchanged(corpus.primaryIdentity)) {
            throw new Error(refuseReplacedActions(corpus.actionsDir).reason);
        }
        return Object.freeze({
            operationId,
            kind: corpus.status,
            projectRoot: corpus.projectRoot,
            projectRootIdentity: freezeIdentity(corpus.projectRootIdentity),
            rnAgentDir: corpus.rnAgentDir,
            rnAgentIdentity: freezeIdentity(corpus.rnAgentIdentity),
            actionsDir: corpus.actionsDir,
            directory: corpus.targetDir,
            directoryIdentity: freezeIdentity(corpus.targetIdentity),
            linkIdentity: freezeIdentity(corpus.linkIdentity),
            linkedIdentity: Object.freeze({
                worktreeRoot: Object.freeze({
                    path: corpus.linkedIdentity.worktreeRoot.path,
                    identity: freezeIdentity(corpus.linkedIdentity.worktreeRoot.identity),
                }),
                gitEntry: Object.freeze({
                    path: corpus.linkedIdentity.gitEntry.path,
                    identity: freezeIdentity(corpus.linkedIdentity.gitEntry.identity),
                }),
                gitDir: Object.freeze({
                    path: corpus.linkedIdentity.gitDir.path,
                    identity: freezeIdentity(corpus.linkedIdentity.gitDir.identity),
                }),
            }),
            primaryIdentity: Object.freeze({
                topLevel: Object.freeze({
                    path: corpus.primaryIdentity.topLevel.path,
                    identity: freezeIdentity(corpus.primaryIdentity.topLevel.identity),
                }),
                commonDir: Object.freeze({
                    path: corpus.primaryIdentity.commonDir.path,
                    identity: freezeIdentity(corpus.primaryIdentity.commonDir.identity),
                }),
            }),
        });
    }
    return null;
}
function currentIdentityMatches(path, expected, kind) {
    const current = lstatIfPresent(path);
    if (!current)
        return false;
    const typeMatches = kind === 'directory'
        ? current.isDirectory()
        : kind === 'file'
            ? current.isFile() && !current.isSymbolicLink()
            : current.isSymbolicLink();
    return (typeMatches && String(current.dev) === expected.dev && String(current.ino) === expected.ino);
}
export function assertReadableActionOperationUnchanged(snapshot) {
    let unchanged = canonical(snapshot.projectRoot) === snapshot.projectRoot &&
        currentIdentityMatches(snapshot.projectRoot, snapshot.projectRootIdentity, 'directory') &&
        currentIdentityMatches(snapshot.rnAgentDir, snapshot.rnAgentIdentity, 'directory');
    if (snapshot.kind === 'owned-directory') {
        unchanged =
            unchanged &&
                currentIdentityMatches(snapshot.actionsDir, snapshot.directoryIdentity, 'directory') &&
                canonical(snapshot.actionsDir) === snapshot.directory;
    }
    else {
        unchanged =
            unchanged &&
                Boolean(snapshot.linkIdentity && snapshot.linkedIdentity && snapshot.primaryIdentity) &&
                currentIdentityMatches(snapshot.actionsDir, snapshot.linkIdentity, 'symlink') &&
                currentIdentityMatches(snapshot.directory, snapshot.directoryIdentity, 'directory') &&
                currentIdentityMatches(snapshot.linkedIdentity.worktreeRoot.path, snapshot.linkedIdentity.worktreeRoot.identity, 'directory') &&
                currentIdentityMatches(snapshot.linkedIdentity.gitEntry.path, snapshot.linkedIdentity.gitEntry.identity, 'file') &&
                currentIdentityMatches(snapshot.linkedIdentity.gitDir.path, snapshot.linkedIdentity.gitDir.identity, 'directory') &&
                currentIdentityMatches(snapshot.primaryIdentity.topLevel.path, snapshot.primaryIdentity.topLevel.identity, 'directory') &&
                currentIdentityMatches(snapshot.primaryIdentity.commonDir.path, snapshot.primaryIdentity.commonDir.identity, 'directory') &&
                canonical(snapshot.actionsDir) === snapshot.directory &&
                canonical(snapshot.directory) === snapshot.directory &&
                canonical(snapshot.primaryIdentity.topLevel.path) ===
                    snapshot.primaryIdentity.topLevel.path &&
                canonical(snapshot.primaryIdentity.commonDir.path) ===
                    snapshot.primaryIdentity.commonDir.path;
    }
    if (!unchanged)
        throw new Error(refuseReplacedActions(snapshot.actionsDir).reason);
}
function isTracked(worktreeRoot, relativePath) {
    const listed = git(worktreeRoot, ['ls-files', '--', relativePath]);
    return listed.ok && listed.stdout.trim().length > 0;
}
function isIgnoreSafe(worktreeRoot, relativePath) {
    const result = spawnSync('git', ['check-ignore', '--no-index', '-q', '--', relativePath], {
        cwd: worktreeRoot,
        encoding: 'utf8',
        env: gitEnvironment(),
        stdio: 'ignore',
    });
    return !result.error && result.status === 0;
}
export function resourcesForHost(host) {
    return SHAREABLE_RESOURCES.filter((resource) => resource.hosts.includes(host));
}
function anchorFor(layout, resource) {
    if (resource.anchor === 'worktree-root') {
        return { local: layout.worktreeRoot, source: layout.primaryRoot ?? '' };
    }
    return { local: layout.appRoot, source: layout.primaryAppRoot ?? '' };
}
function destinationRelative(layout, resource) {
    if (resource.anchor === 'worktree-root')
        return resource.path;
    return layout.appRelative === '.' ? resource.path : `${layout.appRelative}/${resource.path}`;
}
export function planInheritance(input) {
    // A branch without the nested app can still inherit worktree-root resources, so the
    // RN-app gate is relaxed only when every requested resource is root-anchored.
    const rootOnly = input.rootResourcesOnly === true &&
        SHAREABLE_RESOURCES.filter((r) => !input.resources || input.resources.includes(r.id)).every((r) => r.anchor === 'worktree-root');
    const layout = resolveWorktreeLayout({
        cwd: input.cwd,
        appRoot: input.appRoot,
        allowNonRnApp: rootOnly,
    });
    if (!('worktreeRoot' in layout)) {
        return {
            layout: {
                kind: 'primary',
                worktreeRoot: '',
                commonDir: '',
                gitDir: '',
                appRoot: '',
                appRelative: '.',
            },
            host: input.host,
            resources: [],
            refusal: layout.refusal,
        };
    }
    if (layout.refusal || layout.kind === 'primary') {
        return { layout, host: input.host, resources: [], refusal: layout.refusal };
    }
    const selected = resourcesForHost(input.host).filter((resource) => !input.resources || input.resources.includes(resource.id));
    const resources = selected.map((resource) => planResource(layout, resource));
    return { layout, host: input.host, resources };
}
function planResource(layout, resource) {
    const anchor = anchorFor(layout, resource);
    const destination = join(anchor.local, resource.path);
    const destinationRel = destinationRelative(layout, resource);
    const source = anchor.source ? join(anchor.source, resource.path) : undefined;
    const sourceBoundary = layout.primaryRoot;
    const sourceBefore = source && sourceBoundary
        ? classifySource(source, resource.type, sourceBoundary)
        : { state: 'MISSING' };
    const { state: destinationState, evidence } = classifyDestination(destination, sourceBefore.state === 'AVAILABLE' ? source : undefined, resource.type);
    const sourceAfter = source && sourceBoundary
        ? classifySource(source, resource.type, sourceBoundary)
        : { state: 'MISSING' };
    const sourceStable = sourceBefore.state === sourceAfter.state &&
        sameSourceEvidence(sourceBefore.evidence, sourceAfter.evidence);
    const sourceState = sourceStable ? sourceAfter.state : 'WRONG_TYPE';
    const sourceEvidence = sourceStable ? sourceAfter.evidence : undefined;
    const linkedParent = resource.parent !== undefined
        ? classifyLegacyParent(layout, anchor.local, resource.parent)
        : null;
    const parentRelative = resource.parent === undefined
        ? undefined
        : toPosix(layout.appRelative === '.' ? resource.parent : `${layout.appRelative}/${resource.parent}`);
    const ignoreSafe = isIgnoreSafe(layout.worktreeRoot, destinationRel) ||
        (linkedParent !== null &&
            parentRelative !== undefined &&
            (isIgnoreSafe(layout.worktreeRoot, parentRelative) ||
                isIgnoreSafe(layout.worktreeRoot, `${parentRelative}/`)));
    const base = {
        id: resource.id,
        label: resource.label,
        destination: toPosix(destinationRel),
        sourceState,
        destinationState,
        ignoreSafe,
        evidence,
        sourceEvidence,
    };
    const gitManaged = isTracked(layout.worktreeRoot, destinationRel) ||
        (resource.parent !== undefined &&
            isTracked(layout.worktreeRoot, toPosix(layout.appRelative === '.' ? resource.parent : `${layout.appRelative}/${resource.parent}`)));
    if (gitManaged) {
        return {
            ...base,
            regime: 'GIT_MANAGED',
            state: 'TRACKED',
            action: 'none',
            remediation: 'Git owns this path; the tracked/team regime is never replaced or inherited.',
        };
    }
    const regime = sourceState === 'AVAILABLE' ? 'PRIVATE_SOURCE_AVAILABLE' : 'NO_SOURCE';
    if (linkedParent) {
        if (linkedParent !== 'expected') {
            return {
                ...base,
                regime,
                state: 'LINK_FOREIGN',
                action: 'none',
                remediation: `The whole "${resource.parent}" directory is a foreign symlink. Nothing is read from or written through it.`,
            };
        }
        if (sourceState !== 'AVAILABLE') {
            return {
                ...base,
                regime,
                state: sourceState === 'WRONG_TYPE' ? 'SOURCE_WRONG_TYPE' : 'SOURCE_MISSING',
                action: 'none',
                remediation: 'The legacy root link is recognized, but the canonical actions source is unavailable.',
            };
        }
        return {
            ...base,
            regime,
            state: 'LEGACY_ROOT_LINK',
            action: 'none',
            remediation: legacyRootRepairRemedy('A legacy whole-root link was detected; startup and reconnect never mutate it.'),
        };
    }
    if (destinationState === 'PERMISSION_DENIED' || sourceState === 'PERMISSION_DENIED') {
        return {
            ...base,
            regime,
            state: 'PERMISSION_DENIED',
            action: 'none',
            remediation: 'Permission denied while inspecting this path; fix permissions and re-run.',
        };
    }
    if (destinationState === 'FILE') {
        return { ...base, regime, state: 'COLLISION_FILE', action: 'none', remediation: LOCAL_CONTENT };
    }
    if (destinationState === 'DIRECTORY') {
        return {
            ...base,
            regime,
            state: 'COLLISION_DIRECTORY',
            action: 'none',
            remediation: LOCAL_CONTENT,
        };
    }
    if (destinationState === 'LINK_VALID') {
        if (sourceState !== 'AVAILABLE') {
            return {
                ...base,
                regime,
                state: sourceState === 'WRONG_TYPE' ? 'SOURCE_WRONG_TYPE' : 'SOURCE_MISSING',
                action: 'none',
                remediation: 'The existing link no longer has a safe canonical source.',
            };
        }
        return {
            ...base,
            regime,
            state: ignoreSafe ? 'LINK_VALID_SAFE' : 'LINK_VALID_GIT_VISIBLE',
            action: 'none',
            remediation: ignoreSafe ? undefined : ignoreRemediation(base.destination),
        };
    }
    if (destinationState === 'LINK_FOREIGN') {
        return {
            ...base,
            regime,
            state: 'LINK_FOREIGN',
            action: 'none',
            remediation: 'Destination is a symlink to something else; /rn-dev-agent:setup can re-point it after explicit confirmation.',
        };
    }
    if (destinationState === 'LINK_STALE') {
        if (sourceState !== 'AVAILABLE') {
            return {
                ...base,
                regime,
                state: 'LINK_STALE_SOURCE_MISSING',
                action: 'none',
                remediation: 'Destination is a broken symlink and no canonical source is available; restore the source first.',
            };
        }
        return {
            ...base,
            regime,
            state: 'LINK_STALE_SOURCE_AVAILABLE',
            action: 'repair',
            remediation: 'Run /rn-dev-agent:setup to repair the broken link after confirmation.',
        };
    }
    if (sourceState === 'MISSING') {
        return {
            ...base,
            regime,
            state: 'SOURCE_MISSING',
            action: 'none',
            remediation: 'No canonical source in the primary worktree; nothing to inherit.',
        };
    }
    if (sourceState === 'WRONG_TYPE') {
        return {
            ...base,
            regime,
            state: 'SOURCE_WRONG_TYPE',
            action: 'none',
            remediation: `Canonical source is not a ${resource.type}; refusing to link.`,
        };
    }
    if (!ignoreSafe) {
        return {
            ...base,
            regime,
            state: 'IGNORE_UNSAFE',
            action: 'none',
            remediation: ignoreRemediation(base.destination),
        };
    }
    return { ...base, regime, state: 'DEST_MISSING', action: 'link' };
}
const LOCAL_CONTENT = 'Local real content is present; it is never overwritten and is not shared.';
function ignoreRemediation(destination) {
    return `Git would see this path. Add the file-form rule "/${destination}" (no trailing slash) to your own local ignore policy, then re-run.`;
}
function classifyLegacyParent(layout, localAnchor, parent) {
    const localParent = join(localAnchor, parent);
    let stats;
    try {
        stats = lstatSync(localParent);
    }
    catch {
        return null;
    }
    if (!stats.isSymbolicLink())
        return null;
    const resolved = canonical(localParent);
    const expected = layout.primaryAppRoot ? canonical(join(layout.primaryAppRoot, parent)) : null;
    return resolved && expected && resolved === expected ? 'expected' : 'foreign';
}
// The parent must be a real directory inside the local anchor, both before and
// after the link is created — otherwise a swapped parent could redirect the write.
function bindLinkParent(destination, anchor) {
    const parent = destination.slice(0, destination.lastIndexOf(sep));
    if (!parent)
        return null;
    if (!existsSync(parent))
        mkdirSync(parent, { recursive: true, mode: 0o700 });
    try {
        const stats = lstatSync(parent, { bigint: true });
        if (stats.isSymbolicLink() || !stats.isDirectory())
            return null;
        const real = canonical(parent);
        if (!real || !contained(anchor, real))
            return null;
        return { dev: String(stats.dev), ino: String(stats.ino) };
    }
    catch {
        return null;
    }
}
function sameDirectoryIdentity(path, expected) {
    try {
        const stats = lstatSync(path, { bigint: true });
        return (!stats.isSymbolicLink() &&
            stats.isDirectory() &&
            String(stats.dev) === expected.dev &&
            String(stats.ino) === expected.ino);
    }
    catch {
        return false;
    }
}
function pathExistsNoFollow(path) {
    try {
        lstatSync(path);
        return true;
    }
    catch {
        return false;
    }
}
function directoryIdentity(path) {
    try {
        const stats = lstatSync(path, { bigint: true });
        if (stats.isSymbolicLink() || !stats.isDirectory())
            return null;
        return { dev: String(stats.dev), ino: String(stats.ino) };
    }
    catch {
        return null;
    }
}
function sameIdentity(left, right) {
    return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}
function trackedness(worktreeRoot, relativePath) {
    const result = spawnSync('git', ['ls-files', '--error-unmatch', '--', relativePath, `:(glob)${relativePath}/**`], {
        cwd: worktreeRoot,
        encoding: 'utf8',
        env: gitEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (result.error)
        return 'unknown';
    if (result.status === 0)
        return 'tracked';
    if (result.status === 1)
        return 'untracked';
    return 'unknown';
}
function repairReport(status, code, reason, retainedPaths = []) {
    return { status, code, reason, retainedPaths };
}
function expectedLegacyRoot(layout) {
    return layout.primaryAppRoot ? resolve(layout.primaryAppRoot, '.rn-agent') : null;
}
function isVerifiedLegacyRootLink(root, expected) {
    try {
        if (resolve(dirname(root), readlinkSync(root)) !== expected)
            return false;
        const resolvedExpected = canonical(expected);
        return resolvedExpected === null || canonical(root) === resolvedExpected;
    }
    catch {
        return false;
    }
}
export function detectLegacyRootRepair(input) {
    const layout = resolveWorktreeLayout(input);
    if (!('worktreeRoot' in layout) || layout.refusal || layout.kind !== 'linked') {
        return repairReport('unchanged', 'RN_AGENT_LEGACY_ROOT_REPAIR_NOT_NEEDED', 'No linked-worktree legacy root repair applies.');
    }
    if (layout.appRoot !== layout.worktreeRoot) {
        return repairReport('unchanged', 'RN_AGENT_LEGACY_ROOT_REPAIR_NOT_NEEDED', 'Explicit legacy repair is scoped to an app rooted at the current worktree.');
    }
    const root = join(layout.appRoot, '.rn-agent');
    const backup = `${root}.bak`;
    const backupPresent = pathExistsNoFollow(backup);
    let rootStats;
    try {
        rootStats = lstatSync(root);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return backupPresent
                ? repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'A .rn-agent.bak recovery directory exists without its displaced root; preserve it and inspect the partial migration explicitly.', ['.rn-agent.bak'])
                : repairReport('unchanged', 'RN_AGENT_LEGACY_ROOT_REPAIR_NOT_NEEDED', 'No .rn-agent root exists.');
        }
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The .rn-agent root could not be inspected; fix permissions before repair.', backupPresent ? ['.rn-agent', '.rn-agent.bak'] : ['.rn-agent']);
    }
    if (!rootStats.isSymbolicLink()) {
        if (backupPresent) {
            return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'Both a real .rn-agent root and .rn-agent.bak exist; preserve both and resolve the partial migration explicitly.', ['.rn-agent', '.rn-agent.bak']);
        }
        return repairReport('unchanged', 'RN_AGENT_LEGACY_ROOT_REPAIR_NOT_NEEDED', 'The .rn-agent root is already local state, so reconnect leaves it unchanged.');
    }
    const expected = expectedLegacyRoot(layout);
    if (!expected || !isVerifiedLegacyRootLink(root, expected)) {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The .rn-agent root is not the verified primary-worktree link; preserve it and repair manually.', ['.rn-agent']);
    }
    if (!directoryIdentity(backup)) {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The verified legacy root has no real .rn-agent.bak recovery directory; no state was changed.', pathExistsNoFollow(backup) ? ['.rn-agent', '.rn-agent.bak'] : ['.rn-agent']);
    }
    return repairReport('required', LEGACY_ROOT_REPAIR_REQUIRED, legacyRootRepairRemedy('The verified legacy root detached the real .rn-agent.bak integration and local state.'), ['.rn-agent', '.rn-agent.bak']);
}
function inspectRepairActions(backup, source) {
    const actions = join(backup, 'actions');
    const preserved = join(backup, 'actions.pre-repair');
    try {
        const stats = lstatSync(actions);
        if (stats.isSymbolicLink()) {
            const lexicalTarget = resolve(join(actions, '..'), readlinkSync(actions));
            if (lexicalTarget !== source) {
                return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The backup actions link targets another corpus; preserve both paths and resolve it explicitly.', ['.rn-agent', '.rn-agent.bak/actions']);
            }
            return 'shared';
        }
        else if (stats.isDirectory()) {
            const real = canonical(actions);
            if (!real || !contained(backup, real)) {
                return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The backup actions directory crosses the recovery boundary; no state was changed.', ['.rn-agent', '.rn-agent.bak/actions']);
            }
            if (pathExistsNoFollow(preserved)) {
                return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'Both actions and actions.pre-repair exist in the backup; preserve them and resolve the collision explicitly.', ['.rn-agent', '.rn-agent.bak/actions', '.rn-agent.bak/actions.pre-repair']);
            }
            return 'local';
        }
        else {
            return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The backup actions path is neither a directory nor the verified shared link.', ['.rn-agent', '.rn-agent.bak/actions']);
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The backup actions path could not be inspected; no state was changed.', ['.rn-agent', '.rn-agent.bak']);
        }
        return 'missing';
    }
}
function prepareRepairActions(backup, source, state) {
    const actions = join(backup, 'actions');
    const preserved = join(backup, 'actions.pre-repair');
    if (state === 'local') {
        renameSync(actions, preserved);
    }
    if (state !== 'shared') {
        symlinkSync(source, actions, 'dir');
        return {
            createdLink: linkIdentity(actions),
            preserved: state === 'local',
            preservedRelative: state === 'local' ? '.rn-agent/actions.pre-repair' : undefined,
        };
    }
    return { createdLink: null, preserved: false };
}
function rollbackPreparedActions(backup, source, prepared) {
    const actions = join(backup, 'actions');
    const preserved = join(backup, 'actions.pre-repair');
    try {
        if (prepared.createdLink) {
            const current = linkIdentity(actions);
            if (!sameIdentity(current, prepared.createdLink) || readlinkSync(actions) !== source) {
                return false;
            }
            unlinkSync(actions);
        }
        if (prepared.preserved) {
            if (pathExistsNoFollow(actions) || !directoryIdentity(preserved))
                return false;
            renameSync(preserved, actions);
        }
        return true;
    }
    catch {
        return false;
    }
}
function performLegacyRootRepair(layout) {
    const root = join(layout.appRoot, '.rn-agent');
    const backup = `${root}.bak`;
    const source = join(layout.primaryAppRoot, '.rn-agent', 'actions');
    const retained = [];
    for (const relativePath of [
        '.rn-agent',
        '.rn-agent.bak',
        '.rn-agent.bak/actions',
        '.rn-agent.bak/actions.pre-repair',
    ]) {
        const ownership = trackedness(layout.worktreeRoot, relativePath);
        if (ownership !== 'untracked') {
            return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', ownership === 'tracked'
                ? `Git owns ${relativePath}; explicit repair never mutates tracked state.`
                : `Git ownership of ${relativePath} could not be proven; explicit repair fails closed.`, ['.rn-agent', '.rn-agent.bak']);
        }
    }
    const rootIdentity = linkIdentity(root);
    const backupIdentity = directoryIdentity(backup);
    const expected = expectedLegacyRoot(layout);
    if (!rootIdentity || !backupIdentity || !expected || !isVerifiedLegacyRootLink(root, expected)) {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The legacy root or backup changed before repair; no state was changed.', ['.rn-agent', '.rn-agent.bak']);
    }
    const rootTarget = readlinkSync(root);
    const localIdentities = new Map();
    for (const name of ['integration', 'local']) {
        const path = join(backup, name);
        if (!pathExistsNoFollow(path))
            continue;
        const identity = directoryIdentity(path);
        if (!identity) {
            return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', `.rn-agent.bak/${name} is not a real directory; preserve it and repair that collision explicitly.`, ['.rn-agent', `.rn-agent.bak/${name}`]);
        }
        localIdentities.set(name, identity);
    }
    const actionInspection = inspectRepairActions(backup, source);
    if (typeof actionInspection !== 'string')
        return actionInspection;
    let sourceState = classifySource(source, 'directory', layout.primaryRoot);
    let createdSource = false;
    let createdPrimaryAgent = false;
    if (sourceState.state === 'MISSING') {
        const primaryAgent = join(layout.primaryAppRoot, '.rn-agent');
        for (const relativePath of ['.rn-agent', '.rn-agent/actions']) {
            const ownership = trackedness(layout.primaryRoot, relativePath);
            if (ownership !== 'untracked') {
                return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', ownership === 'tracked'
                    ? `Git owns primary:${relativePath}; explicit repair never creates a shared corpus over tracked state.`
                    : `Git ownership of primary:${relativePath} could not be proven; explicit repair fails closed.`, ['.rn-agent', '.rn-agent.bak']);
            }
        }
        const primaryIdentity = directoryIdentity(primaryAgent);
        if (!primaryIdentity && pathExistsNoFollow(primaryAgent)) {
            return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The verified primary .rn-agent root is not a real directory; no state was changed.', ['.rn-agent', '.rn-agent.bak']);
        }
        if (!primaryIdentity) {
            mkdirSync(primaryAgent, { mode: 0o700 });
            createdPrimaryAgent = true;
        }
        mkdirSync(source, { mode: 0o700 });
        createdSource = true;
        sourceState = classifySource(source, 'directory', layout.primaryRoot);
    }
    if (sourceState.state !== 'AVAILABLE') {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The canonical primary actions corpus is unsafe or unavailable; no local state was moved.', [
            '.rn-agent',
            '.rn-agent.bak',
            ...(createdPrimaryAgent ? ['primary:.rn-agent'] : []),
            ...(createdSource ? ['primary:.rn-agent/actions'] : []),
        ]);
    }
    let prepared = null;
    let rootUnlinked = false;
    let published = false;
    try {
        prepared = prepareRepairActions(backup, source, actionInspection);
        if (prepared.preservedRelative)
            retained.push(prepared.preservedRelative);
        const actionLink = linkIdentity(join(backup, 'actions'));
        if (!actionLink || canonical(join(backup, 'actions')) !== canonical(source)) {
            throw new Error('the prepared actions link did not resolve to the canonical corpus');
        }
        if (!sameIdentity(linkIdentity(root), rootIdentity) ||
            !isVerifiedLegacyRootLink(root, expected)) {
            throw new Error('the legacy root changed while repair was preparing local state');
        }
        if (!sameDirectoryIdentity(backup, backupIdentity)) {
            throw new Error('the recovery backup changed while repair was preparing local state');
        }
        unlinkSync(root);
        rootUnlinked = true;
        renameSync(backup, root);
        published = true;
        if (!sameDirectoryIdentity(root, backupIdentity)) {
            throw new Error('the restored local root changed during publication');
        }
        if (canonical(join(root, 'actions')) !== canonical(source)) {
            throw new Error('the restored actions link did not settle on the canonical corpus');
        }
        const settled = planResource(layout, SHAREABLE_RESOURCES[0]);
        if (settled.state !== 'LINK_VALID_SAFE') {
            throw new Error(settled.state === 'LINK_VALID_GIT_VISIBLE'
                ? 'the restored private root would be Git-visible'
                : `the restored actions layout settled as ${settled.state}`);
        }
        for (const [name, identity] of localIdentities) {
            if (!sameDirectoryIdentity(join(root, name), identity)) {
                throw new Error(`the restored ${name} directory changed during publication`);
            }
        }
        return repairReport('repaired', 'RN_AGENT_LEGACY_ROOT_REPAIR_COMPLETED', retained.length > 0
            ? 'Restored local .rn-agent state, linked only actions, and retained the prior local actions corpus at .rn-agent/actions.pre-repair.'
            : 'Restored local .rn-agent state and linked only the canonical actions corpus.', retained);
    }
    catch (error) {
        let rollbackComplete = true;
        try {
            if (published) {
                if (!sameDirectoryIdentity(root, backupIdentity) || pathExistsNoFollow(backup)) {
                    rollbackComplete = false;
                }
                else {
                    renameSync(root, backup);
                    published = false;
                }
            }
            if (rootUnlinked && !pathExistsNoFollow(root)) {
                symlinkSync(rootTarget, root, 'dir');
                rootUnlinked = false;
            }
            if (prepared && sameDirectoryIdentity(backup, backupIdentity)) {
                rollbackComplete = rollbackPreparedActions(backup, source, prepared) && rollbackComplete;
            }
            else if (prepared) {
                rollbackComplete = false;
            }
        }
        catch {
            rollbackComplete = false;
        }
        const retainedPaths = rollbackComplete
            ? [
                '.rn-agent',
                '.rn-agent.bak',
                ...(createdPrimaryAgent ? ['primary:.rn-agent'] : []),
                ...(createdSource ? ['primary:.rn-agent/actions'] : []),
            ]
            : [
                '.rn-agent',
                '.rn-agent.bak',
                '.rn-agent/actions.pre-repair',
                '.rn-agent.bak/actions.pre-repair',
                ...(createdPrimaryAgent ? ['primary:.rn-agent'] : []),
                ...(createdSource ? ['primary:.rn-agent/actions'] : []),
            ];
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', `${error instanceof Error ? error.message : 'legacy repair failed'}; ${rollbackComplete
            ? 'the original names were restored'
            : 'rollback could not prove every name, so preserve every reported path'}.`, retainedPaths);
    }
}
export function repairLegacyRoot(input) {
    const detection = detectLegacyRootRepair(input);
    if (detection.status !== 'required')
        return detection;
    const layout = resolveWorktreeLayout(input);
    if (!('worktreeRoot' in layout) || layout.refusal || layout.kind !== 'linked') {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The linked-worktree identity changed before repair.', detection.retainedPaths);
    }
    const stateDir = join(layout.commonDir, 'rn-dev-agent');
    const lockPath = join(stateDir, 'worktree-root-repair.lock');
    try {
        mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    }
    catch {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The repository repair lock directory could not be created; no project state was changed.', detection.retainedPaths);
    }
    const stateDirectoryIdentity = directoryIdentity(stateDir);
    if (!stateDirectoryIdentity ||
        canonical(stateDir) !== resolve(stateDir) ||
        !contained(layout.commonDir, resolve(stateDir))) {
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The repository repair lock directory is not a verified real directory; no project state was changed.', [...detection.retainedPaths, 'git-common:rn-dev-agent']);
    }
    let lockFd;
    try {
        lockFd = openSync(lockPath, 'wx', 0o600);
    }
    catch (error) {
        const code = error.code;
        return repairReport('refused', code === 'EEXIST'
            ? 'RN_AGENT_LEGACY_ROOT_REPAIR_LOCKED'
            : 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', code === 'EEXIST'
            ? 'Another explicit worktree repair owns the repository lock; wait for it to finish and retry.'
            : 'The repository repair lock could not be acquired; no project state was changed.', detection.retainedPaths);
    }
    let lockStats;
    try {
        lockStats = fstatSync(lockFd, { bigint: true });
    }
    catch {
        closeSync(lockFd);
        return repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', 'The repository repair lock identity could not be verified; preserve the lock path and retry after inspection.', [...detection.retainedPaths, 'git-common:rn-dev-agent/worktree-root-repair.lock']);
    }
    const lockIdentity = { dev: String(lockStats.dev), ino: String(lockStats.ino) };
    let report;
    try {
        const revalidated = detectLegacyRootRepair(input);
        report =
            revalidated.status === 'required'
                ? performLegacyRootRepair(layout)
                : revalidated.status === 'unchanged'
                    ? revalidated
                    : repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', `Repair state changed while acquiring the lock: ${revalidated.reason}`, revalidated.retainedPaths);
    }
    catch (error) {
        report = repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', `${error instanceof Error ? error.message : 'Explicit repair failed'}; preserve every reported path and retry only after resolving the named boundary.`, [...detection.retainedPaths, 'primary:.rn-agent', 'primary:.rn-agent/actions']);
    }
    finally {
        closeSync(lockFd);
    }
    try {
        const current = lstatSync(lockPath, { bigint: true });
        if (sameDirectoryIdentity(stateDir, stateDirectoryIdentity) &&
            current.isFile() &&
            String(current.dev) === lockIdentity.dev &&
            String(current.ino) === lockIdentity.ino) {
            unlinkSync(lockPath);
        }
        else {
            report = repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', `${report.reason} The repository repair lock changed identity and was retained.`, [...report.retainedPaths, 'git-common:rn-dev-agent/worktree-root-repair.lock']);
        }
    }
    catch (error) {
        if (error.code !== 'ENOENT') {
            report = repairReport('refused', 'RN_AGENT_LEGACY_ROOT_REPAIR_REFUSED', `${report.reason} The repository repair lock could not be released.`, [...report.retainedPaths, 'git-common:rn-dev-agent/worktree-root-repair.lock']);
        }
    }
    return report;
}
export function applyInheritance(input) {
    const plan = planInheritance(input);
    const outcomes = [];
    let applied = 0;
    for (const resourcePlan of plan.resources) {
        const spec = SHAREABLE_RESOURCES.find((entry) => entry.id === resourcePlan.id);
        const anchor = anchorFor(plan.layout, spec);
        const destination = join(anchor.local, spec.path);
        const source = anchor.source ? join(anchor.source, spec.path) : undefined;
        if (resourcePlan.action === 'none') {
            if (resourcePlan.state === 'LINK_VALID_SAFE') {
                const revalidated = planResource(plan.layout, spec);
                if (revalidated.state !== resourcePlan.state ||
                    !sameSourceEvidence(revalidated.sourceEvidence, resourcePlan.sourceEvidence)) {
                    outcomes.push({
                        id: resourcePlan.id,
                        applied: false,
                        state: revalidated.state,
                        result: 'refused',
                        reason: 'source changed while validating the existing link',
                    });
                    continue;
                }
            }
            outcomes.push({
                id: resourcePlan.id,
                applied: false,
                state: resourcePlan.state,
                result: resourcePlan.state === 'LINK_VALID_SAFE' ? 'converged' : 'skipped',
                reason: resourcePlan.remediation,
            });
            continue;
        }
        if ((resourcePlan.action === 'repair' || resourcePlan.action === 'migrate') &&
            !input.allowRepair) {
            outcomes.push({
                id: resourcePlan.id,
                applied: false,
                state: resourcePlan.state,
                result: 'skipped',
                reason: `${resourcePlan.action} requires explicit confirmation`,
            });
            continue;
        }
        const revalidated = planResource(plan.layout, spec);
        if (revalidated.state !== resourcePlan.state ||
            revalidated.action !== resourcePlan.action ||
            !sameSourceEvidence(revalidated.sourceEvidence, resourcePlan.sourceEvidence)) {
            outcomes.push({
                id: resourcePlan.id,
                applied: false,
                state: revalidated.state,
                result: 'refused',
                reason: 'state changed between plan and apply; re-plan and retry',
            });
            continue;
        }
        if (revalidated.action === 'repair') {
            if (!removeStaleLink(destination, revalidated.evidence)) {
                outcomes.push({
                    id: resourcePlan.id,
                    applied: false,
                    state: revalidated.state,
                    result: 'refused',
                    reason: 'stale link changed between plan and apply',
                });
                continue;
            }
        }
        const outcome = createLink(source, destination, plan.layout, spec, revalidated.action, revalidated.sourceEvidence);
        if (outcome.result === 'linked' || outcome.result === 'repaired')
            applied += 1;
        outcomes.push({ ...outcome, id: resourcePlan.id });
    }
    return { outcomes, applied, requested: plan.resources.length, refusal: plan.refusal };
}
function removeStaleLink(destination, evidence) {
    try {
        const current = lstatSync(destination, { bigint: true });
        if (!current.isSymbolicLink())
            return false;
        if (!evidence)
            return false;
        if (String(current.dev) !== evidence.dev || String(current.ino) !== evidence.ino)
            return false;
        unlinkSync(destination);
        return true;
    }
    catch {
        return false;
    }
}
function probeLinkTarget(parentIdentity, destination, source, sourceBoundary, sourceEvidence, spec) {
    const parent = destination.slice(0, destination.lastIndexOf(sep));
    const probe = join(parent, `.rn-dev-agent-probe.${process.pid}.${probeCounter++}`);
    const refuse = (state, reason) => ({
        applied: false,
        state,
        result: 'refused',
        reason,
    });
    try {
        symlinkSync(source, probe, spec.type === 'directory' ? 'dir' : 'file');
    }
    catch {
        return refuse('PERMISSION_DENIED', 'could not verify the link target before creating it');
    }
    try {
        const sourceCheck = classifySource(source, spec.type, sourceBoundary);
        if (sourceCheck.state !== 'AVAILABLE' ||
            !sameSourceEvidence(sourceCheck.evidence, sourceEvidence)) {
            return refuse('SOURCE_WRONG_TYPE', 'the canonical source changed before link creation');
        }
        const resolved = canonical(probe);
        if (!resolved || resolved !== canonical(source)) {
            return refuse('SOURCE_MISSING', 'the canonical source disappeared before the link was created');
        }
        const stats = statSync(resolved);
        const typeOk = spec.type === 'directory' ? stats.isDirectory() : stats.isFile();
        if (!typeOk)
            return refuse('SOURCE_WRONG_TYPE', `the canonical source is not a ${spec.type}`);
        if (!sameDirectoryIdentity(parent, parentIdentity)) {
            return refuse('COLLISION_DIRECTORY', 'the destination parent changed during apply');
        }
        return null;
    }
    catch {
        return refuse('SOURCE_MISSING', 'the canonical source could not be verified');
    }
    finally {
        try {
            unlinkSync(probe);
        }
        catch {
            /* the probe name is unique to this process; a failure leaves nothing shared */
        }
    }
}
let probeCounter = 0;
function isSettledLinkSafe(settled, sourceEvidence) {
    return (settled.state === 'LINK_VALID_SAFE' &&
        sameSourceEvidence(settled.sourceEvidence, sourceEvidence));
}
function createLink(source, destination, layout, spec, action, sourceEvidence) {
    const anchor = anchorFor(layout, spec).local;
    const parentIdentity = bindLinkParent(destination, anchor);
    if (!parentIdentity) {
        return {
            applied: false,
            state: 'COLLISION_DIRECTORY',
            result: 'refused',
            reason: 'destination parent is not a real directory inside this worktree',
        };
    }
    // Prove the link would resolve to the right kind of target BEFORE the destination
    // exists, using a uniquely-named probe only this process can own. That makes "never
    // create a dangling link" structural instead of something rollback has to undo.
    const probe = probeLinkTarget(parentIdentity, destination, source, layout.primaryRoot, sourceEvidence, spec);
    if (probe)
        return probe;
    try {
        symlinkSync(source, destination, spec.type === 'directory' ? 'dir' : 'file');
    }
    catch (error) {
        const code = error.code;
        if (code === 'EEXIST') {
            const settled = planResource(layout, spec);
            if (isSettledLinkSafe(settled, sourceEvidence)) {
                return { applied: false, state: settled.state, result: 'converged' };
            }
            return {
                applied: false,
                state: settled.state,
                result: 'refused',
                reason: 'destination appeared during apply; nothing was overwritten',
            };
        }
        if (code === 'EACCES' || code === 'EPERM') {
            return {
                applied: false,
                state: 'PERMISSION_DENIED',
                result: 'refused',
                reason: 'permission denied creating the link',
            };
        }
        return {
            applied: false,
            state: 'DEST_MISSING',
            result: 'refused',
            reason: 'link creation failed',
        };
    }
    const createdIdentity = linkIdentity(destination);
    const parentDirectory = destination.slice(0, destination.lastIndexOf(sep));
    const settled = planResource(layout, spec);
    if (!sameDirectoryIdentity(parentDirectory, parentIdentity) ||
        !isSettledLinkSafe(settled, sourceEvidence)) {
        const removed = rollbackLink(destination, source, createdIdentity);
        return {
            applied: false,
            state: settled.state,
            result: 'refused',
            reason: removed
                ? 'the link did not settle valid and safe; it was removed'
                : 'the link did not settle valid and safe and could not be removed — inspect it manually',
        };
    }
    return {
        applied: true,
        state: 'LINK_VALID_SAFE',
        result: action === 'repair' ? 'repaired' : 'linked',
    };
}
function linkIdentity(path) {
    try {
        const stats = lstatSync(path, { bigint: true });
        if (!stats.isSymbolicLink())
            return null;
        return { dev: String(stats.dev), ino: String(stats.ino) };
    }
    catch {
        return null;
    }
}
// Removes only the exact inode this call created, and returns proof of removal.
function rollbackLink(destination, source, created) {
    if (!created)
        return false;
    try {
        const current = linkIdentity(destination);
        if (!current || current.dev !== created.dev || current.ino !== created.ino)
            return false;
        if (readlinkSync(destination) !== source)
            return false;
        unlinkSync(destination);
        lstatSync(destination);
        return false;
    }
    catch (error) {
        return error.code === 'ENOENT';
    }
}
