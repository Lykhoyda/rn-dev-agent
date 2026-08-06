#!/usr/bin/env node
// workflow-check.ts — deterministic preflight/postflight facts for the
// rn-workflow skill: package-manager/dependency state, private-state-root
// resolution, and postflight residue. Read-only; never opens the authority
// registry. Output is redacted JSON: no absolute paths, device ids, or tokens.
//
// Usage:
//   node workflow-check.js preflight  [--project <dir>]
//   node workflow-check.js postflight [--project <dir>] [--status-file <path>]
//
// Exit codes: 0 verdict pass / 2 invalid args / 3 verdict stop.
import fs from 'node:fs';
import path from 'node:path';
import { getStateDir } from './util/secure-state-file.js';
const LOCKFILES = [
    { file: 'pnpm-lock.yaml', manager: 'pnpm' },
    { file: 'yarn.lock', manager: 'yarn' },
    { file: 'package-lock.json', manager: 'npm' },
    { file: 'bun.lock', manager: 'bun' },
    { file: 'bun.lockb', manager: 'bun' },
];
const INSTALL_COMMANDS = {
    pnpm: 'corepack pnpm install --frozen-lockfile',
    yarn: 'corepack yarn install --immutable',
    npm: 'npm ci',
    bun: 'bun install --frozen-lockfile',
};
const TEMPLATE_HEADING = '## React Native Development (rn-dev-agent)';
const TEMPLATE_SENTINEL = '<!-- rn-dev-agent:template-end -->';
const INTEGRATION_MARKER = '.rn-agent/integration/';
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
function detectPackageManagerField(projectRoot) {
    const raw = readTextIfFile(path.join(projectRoot, 'package.json'));
    if (raw === null)
        return null;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    const field = parsed.packageManager;
    if (typeof field !== 'string')
        return null;
    const name = field.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun')
        return name;
    return null;
}
function detectLockfile(projectRoot) {
    for (const candidate of LOCKFILES) {
        if (fs.existsSync(path.join(projectRoot, candidate.file)))
            return candidate;
    }
    return null;
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
function preflight(projectRoot) {
    if (readTextIfFile(path.join(projectRoot, 'package.json')) === null) {
        return {
            facts: emptyPreflight(),
            stop: {
                code: 'PROJECT_MANIFEST_MISSING',
                action: 'Run workflow-check from the app root that contains package.json.',
            },
        };
    }
    const field = detectPackageManagerField(projectRoot);
    const lock = detectLockfile(projectRoot);
    const claudeMd = readTextIfFile(path.join(projectRoot, 'CLAUDE.md'));
    const claudeMdBlock = claudeMd !== null && claudeMd.includes(TEMPLATE_HEADING) ? 'present' : 'absent';
    const facts = {
        packageManager: field ?? lock?.manager ?? null,
        packageManagerSource: field ? 'packageManager-field' : lock ? 'lockfile' : null,
        lockfile: lock?.file ?? null,
        installCommand: null,
        nodeModulesPresent: nodeModulesPresent(projectRoot),
        claudeMdBlock,
        claudeMdSentinel: claudeMd !== null && claudeMd.includes(TEMPLATE_SENTINEL),
        stateRoot: stateRootFacts(),
    };
    if (field !== null && lock !== null && field !== lock.manager) {
        return {
            facts,
            stop: {
                code: 'PACKAGE_MANAGER_CONFLICT',
                action: `package.json declares ${field} but ${lock.file} is present; align the project before installing — do not guess.`,
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
    facts.installCommand = INSTALL_COMMANDS[facts.packageManager];
    if (claudeMdBlock === 'absent') {
        return {
            facts,
            stop: {
                code: 'PROJECT_NOT_ONBOARDED',
                action: 'CLAUDE.md is missing the rn-dev-agent block; run /rn-dev-agent:setup before any device work.',
            },
        };
    }
    if (!facts.nodeModulesPresent) {
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
        claudeMdBlock: 'absent',
        claudeMdSentinel: false,
        stateRoot: stateRootFacts(),
    };
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
        return absent;
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
    const runtime = parsed.runtime;
    const automation = parsed.automation;
    const bindings = parsed.bindings;
    return {
        provided: true,
        state: typeof parsed.state === 'string' ? parsed.state : null,
        metroBound: Boolean(runtime?.metro ?? bindings?.metro),
        runnerBound: Boolean(automation?.runner ?? bindings?.runner),
        recorderClaim: Boolean(automation?.recorder ?? bindings?.recorder),
    };
}
function postflight(projectRoot, statusFile) {
    const manifest = readTextIfFile(path.join(projectRoot, 'package.json'));
    const recordingsDir = path.join(projectRoot, '.rn-agent', 'recordings');
    let recordingResidue = false;
    try {
        recordingResidue = fs.readdirSync(recordingsDir).some((entry) => entry.endsWith('.json'));
    }
    catch {
        recordingResidue = false;
    }
    const facts = {
        integrationMarkersPresent: manifest !== null && manifest.includes(INTEGRATION_MARKER),
        recordingResidue,
        stateRoot: stateRootFacts(),
        session: readSessionStatus(statusFile),
    };
    if (facts.integrationMarkersPresent) {
        return {
            facts,
            stop: {
                code: 'INTEGRATION_NOT_RESTORED',
                action: 'package.json still carries the session integration; run rn_session restore_integration (confirmed: true) after stop_metro, then release.',
            },
        };
    }
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
