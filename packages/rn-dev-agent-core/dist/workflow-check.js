#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { inspectPackageIntegrationFileState } from './session/package-integration.js';
import { getStateDir } from './util/secure-state-file.js';
const LOCKFILES = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' },
    { file: 'bun.lock', manager: 'bun' },
    { file: 'bun.lockb', manager: 'bun' },
];
const REQUIRED_LOCKFILES = {
    pnpm: ['pnpm-lock.yaml'],
    yarn: ['yarn.lock'],
    npm: ['package-lock.json'],
    bun: ['bun.lock', 'bun.lockb'],
};
// Corepack accepts only <name>@<exact-semver>, optionally with +hash metadata.
const COREPACK_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
function installCommandFor(manager, declaredVersion, projectRoot) {
    if (manager === 'pnpm')
        return 'corepack pnpm install --frozen-lockfile';
    if (manager === 'npm')
        return 'npm ci';
    if (manager === 'bun')
        return 'bun install --frozen-lockfile';
    if (declaredVersion !== null) {
        const major = Number.parseInt(declaredVersion, 10);
        return major <= 1
            ? 'corepack yarn install --frozen-lockfile'
            : 'corepack yarn install --immutable';
    }
    const lock = readTextIfFile(path.join(projectRoot, 'yarn.lock'));
    if (lock !== null && lock.includes('yarn lockfile v1')) {
        return 'corepack yarn install --frozen-lockfile';
    }
    return 'corepack yarn install --immutable';
}
const TEMPLATE_HEADING = '## React Native Development (rn-dev-agent)';
const TEMPLATE_SENTINEL = '<!-- rn-dev-agent:template-end -->';
function fail(code, message) {
    process.stderr.write(`${message}\n`);
    process.exit(code);
}
function readTextIfFile(filePath) {
    try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile())
            return null;
        return fs.readFileSync(filePath, 'utf8');
    }
    catch {
        return null;
    }
}
function stateRootFacts() {
    const kind = process.env.XDG_STATE_HOME
        ? 'xdg'
        : process.platform === 'darwin'
            ? 'darwin'
            : 'home';
    return { resolved: getStateDir().length > 0, kind };
}
function isPackageManagerName(value) {
    return value === 'pnpm' || value === 'yarn' || value === 'npm' || value === 'bun';
}
function detectPackageManagerField(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { kind: 'invalid-manifest' };
    }
    if (!isRecord(parsed))
        return { kind: 'invalid-manifest' };
    if (!Object.hasOwn(parsed, 'packageManager'))
        return { kind: 'absent' };
    const field = parsed.packageManager;
    if (typeof field !== 'string')
        return { kind: 'unsupported' };
    const separator = field.indexOf('@');
    if (separator === -1)
        return { kind: 'unsupported' };
    const name = field.slice(0, separator);
    const version = field.slice(separator + 1);
    if (!isPackageManagerName(name) || !COREPACK_VERSION.test(version)) {
        return { kind: 'unsupported' };
    }
    return { kind: 'declared', manager: name, version };
}
function detectLockfiles(projectRoot) {
    return LOCKFILES.filter((candidate) => fs.existsSync(path.join(projectRoot, candidate.file)));
}
function nodeModulesPresent(projectRoot) {
    try {
        const entries = fs.readdirSync(path.join(projectRoot, 'node_modules'));
        return entries.some((entry) => !entry.startsWith('.'));
    }
    catch {
        return false;
    }
}
function yarnPnpPresent(projectRoot) {
    return (fs.existsSync(path.join(projectRoot, '.pnp.cjs')) ||
        fs.existsSync(path.join(projectRoot, '.pnp.loader.mjs')));
}
function preflight(projectRoot) {
    const packageJson = readTextIfFile(path.join(projectRoot, 'package.json'));
    if (packageJson === null) {
        return {
            facts: emptyPreflight(),
            stop: {
                code: 'PROJECT_MANIFEST_MISSING',
                action: 'Run workflow-check from the app root that contains package.json.',
            },
        };
    }
    const declaration = detectPackageManagerField(packageJson);
    const field = declaration.kind === 'declared' ? declaration.manager : null;
    const declaredVersion = declaration.kind === 'declared' ? declaration.version : null;
    const locks = detectLockfiles(projectRoot);
    const lockManagers = new Set(locks.map((lock) => lock.manager));
    const inferredLock = declaration.kind === 'absent' && lockManagers.size === 1 ? locks[0] : null;
    const matchingLock = field === null ? inferredLock : (locks.find((lock) => lock.manager === field) ?? null);
    const claudeMd = readTextIfFile(path.join(projectRoot, 'CLAUDE.md'));
    const claudeMdBlock = claudeMd !== null && claudeMd.includes(TEMPLATE_HEADING) ? 'present' : 'absent';
    const resolvedManager = field ?? inferredLock?.manager ?? null;
    const modulesPresent = nodeModulesPresent(projectRoot);
    const pnpPresent = yarnPnpPresent(projectRoot);
    const facts = {
        packageManager: resolvedManager,
        packageManagerSource: field ? 'packageManager-field' : inferredLock ? 'lockfile' : null,
        lockfile: matchingLock?.file ?? null,
        installCommand: null,
        nodeModulesPresent: modulesPresent,
        yarnPnpPresent: pnpPresent,
        dependenciesReady: modulesPresent || (resolvedManager === 'yarn' && pnpPresent),
        claudeMdBlock,
        claudeMdSentinel: claudeMd !== null && claudeMd.includes(TEMPLATE_SENTINEL),
        stateRoot: stateRootFacts(),
    };
    if (declaration.kind === 'invalid-manifest') {
        return {
            facts,
            stop: {
                code: 'PROJECT_MANIFEST_INVALID',
                action: 'package.json is not valid JSON; repair it before package-manager inference.',
            },
        };
    }
    if (declaration.kind === 'unsupported') {
        return {
            facts,
            stop: {
                code: 'PACKAGE_MANAGER_UNSUPPORTED',
                action: 'package.json has an unsupported or unparseable "packageManager" value; use pnpm, yarn, npm, or bun before installing.',
            },
        };
    }
    const conflictingLocks = field === null ? [] : locks.filter((lock) => lock.manager !== field);
    if (conflictingLocks.length > 0) {
        return {
            facts,
            stop: {
                code: 'PACKAGE_MANAGER_CONFLICT',
                action: `package.json declares ${field} but ${conflictingLocks.map((lock) => lock.file).join(', ')} ${conflictingLocks.length === 1 ? 'is' : 'are'} present; align the project before installing — do not guess.`,
            },
        };
    }
    if (field === null && lockManagers.size > 1) {
        return {
            facts,
            stop: {
                code: 'PACKAGE_MANAGER_CONFLICT',
                action: `Multiple package managers are inferred from ${locks.map((lock) => lock.file).join(', ')}; declare packageManager or remove stale lockfiles before installing — do not guess.`,
            },
        };
    }
    if (facts.packageManager === null) {
        return {
            facts,
            stop: {
                code: 'PACKAGE_MANAGER_UNDECLARED',
                action: 'Declare "packageManager" in package.json (or commit a lockfile) so the install command is unambiguous.',
            },
        };
    }
    facts.installCommand = installCommandFor(facts.packageManager, declaredVersion, projectRoot);
    if (matchingLock === null) {
        const required = REQUIRED_LOCKFILES[facts.packageManager].join(' or ');
        return {
            facts,
            stop: {
                code: 'LOCKFILE_MISSING',
                action: `The declared manager's lockfile (${required}) is absent, so a frozen install cannot succeed; commit the lockfile before installing.`,
            },
        };
    }
    if (!facts.dependenciesReady) {
        return {
            facts,
            stop: {
                code: 'DEPENDENCIES_MISSING',
                action: `Install dependencies with the declared manager: ${facts.installCommand}`,
            },
        };
    }
    return { facts, stop: null };
}
function emptyPreflight() {
    return {
        packageManager: null,
        packageManagerSource: null,
        lockfile: null,
        installCommand: null,
        nodeModulesPresent: false,
        yarnPnpPresent: false,
        dependenciesReady: false,
        claudeMdBlock: 'absent',
        claudeMdSentinel: false,
        stateRoot: stateRootFacts(),
    };
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function readSessionStatus(statusFile) {
    const absent = {
        provided: false,
        state: null,
        metroBound: null,
        runnerBound: null,
        recorderClaim: null,
    };
    if (statusFile === null)
        return { session: absent, stop: null };
    const raw = readTextIfFile(statusFile);
    if (raw === null)
        fail(2, 'workflow-check: --status-file is missing or unreadable');
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return fail(2, 'workflow-check: --status-file is not valid JSON');
    }
    const data = isRecord(parsed) && isRecord(parsed.data) ? parsed.data : null;
    const authority = data && isRecord(data.authority) ? data.authority : null;
    const runtime = authority && isRecord(authority.runtime) ? authority.runtime : null;
    const automation = authority && isRecord(authority.automation) ? authority.automation : null;
    const isCanonical = isRecord(parsed) &&
        parsed.ok === true &&
        authority !== null &&
        typeof authority.state === 'string' &&
        runtime !== null &&
        typeof runtime.metroBound === 'boolean' &&
        automation !== null &&
        typeof automation.runnerBound === 'boolean' &&
        typeof automation.recorderBound === 'boolean';
    if (!isCanonical) {
        return {
            session: {
                provided: true,
                state: authority && typeof authority.state === 'string' ? authority.state : null,
                metroBound: null,
                runnerBound: null,
                recorderClaim: null,
            },
            stop: {
                code: 'SESSION_STATUS_INVALID',
                action: 'Provide the complete redacted rn_session status envelope with data.authority.runtime and data.authority.automation bindings; cleanup cannot be proven from an unknown shape.',
            },
        };
    }
    return {
        session: {
            provided: true,
            state: authority.state,
            metroBound: runtime.metroBound,
            runnerBound: automation.runnerBound,
            recorderClaim: automation.recorderBound,
        },
        stop: null,
    };
}
function postflight(projectRoot, statusFile) {
    let integrationMarkersPresent = true;
    try {
        integrationMarkersPresent =
            inspectPackageIntegrationFileState(projectRoot).verdict !== 'unintegrated';
    }
    catch {
        integrationMarkersPresent = true;
    }
    const recordingsDir = path.join(projectRoot, '.rn-agent', 'recordings');
    let recordingResidue = false;
    try {
        recordingResidue = fs.readdirSync(recordingsDir).some((entry) => entry.endsWith('.json'));
    }
    catch {
        recordingResidue = false;
    }
    const status = readSessionStatus(statusFile);
    const facts = {
        integrationMarkersPresent,
        recordingResidue,
        stateRoot: stateRootFacts(),
        session: status.session,
    };
    if (status.stop)
        return { facts, stop: status.stop };
    if (facts.session.provided && facts.session.runnerBound) {
        return {
            facts,
            stop: {
                code: 'RUNNER_STILL_BOUND',
                action: 'Close the native runner first: device_snapshot action=close, then stop_metro, restore_integration, release.',
            },
        };
    }
    if (facts.session.provided && facts.session.metroBound) {
        return {
            facts,
            stop: {
                code: 'METRO_STILL_BOUND',
                action: 'Managed Metro is still bound; run rn_session stop_metro before restore_integration and release.',
            },
        };
    }
    if (facts.session.provided && facts.session.recorderClaim) {
        return {
            facts,
            stop: {
                code: 'RECORDER_CLAIM_OUTSTANDING',
                action: 'A recorder claim is still held; stop the recording through device_record so the claim is released.',
            },
        };
    }
    if (facts.integrationMarkersPresent) {
        return {
            facts,
            stop: {
                code: 'INTEGRATION_NOT_RESTORED',
                action: 'Package integration residue remains; run rn_session restore_integration (confirmed: true) after stop_metro, then release.',
            },
        };
    }
    return { facts, stop: null };
}
function parseArgs(argv) {
    const mode = argv[0];
    if (mode !== 'preflight' && mode !== 'postflight') {
        fail(2, 'workflow-check: first argument must be "preflight" or "postflight"');
    }
    let projectRoot = process.cwd();
    let statusFile = null;
    for (let i = 1; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--project' && argv[i + 1]) {
            projectRoot = path.resolve(argv[i + 1]);
            i += 1;
        }
        else if (arg === '--status-file' && argv[i + 1]) {
            statusFile = path.resolve(argv[i + 1]);
            i += 1;
        }
        else {
            fail(2, `workflow-check: unknown argument ${arg}`);
        }
    }
    return { mode, projectRoot, statusFile };
}
function main() {
    const { mode, projectRoot, statusFile } = parseArgs(process.argv.slice(2));
    const result = mode === 'preflight' ? preflight(projectRoot) : postflight(projectRoot, statusFile);
    const verdict = result.stop === null ? 'pass' : 'stop';
    process.stdout.write(`${JSON.stringify({ mode, verdict, stop: result.stop, facts: result.facts }, null, 2)}\n`);
    process.exit(verdict === 'pass' ? 0 : 3);
}
main();
