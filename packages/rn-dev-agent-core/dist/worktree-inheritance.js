#!/usr/bin/env node
// Package-local CLI for the linked-worktree private-context split (see commands/setup.md).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync, } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyInheritance, repairLegacyRoot, planInheritance, resolveWorktreeLayout, resourcesForHost, } from './session/worktree-inheritance.js';
const HOOK_MARKER = '# rn-dev-agent:worktree-inheritance';
const HOOK_STATE_DIR = 'rn-dev-agent';
const HOOK_HELPER = 'worktree-inheritance.js';
const HOOK_CONFIG = 'worktree-inheritance.json';
const LAST_RUN = 'worktree-inheritance-last-run.json';
const COMMANDS = ['plan', 'report', 'apply', 'repair', 'hook', 'post-checkout'];
const HOOK_SUBCOMMANDS = ['status', 'install', 'uninstall'];
function parseFlags(argv) {
    try {
        return parseFlagsStrict(argv);
    }
    catch {
        return null;
    }
}
function parseFlagsStrict(argv) {
    const positional = [];
    let hostGiven = false;
    const flags = {
        command: 'plan',
        subcommand: '',
        cwd: process.cwd(),
        host: 'claude',
        json: false,
        allowRepair: false,
    };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (!arg.startsWith('--')) {
            positional.push(arg);
            continue;
        }
        const next = () => {
            const value = argv[++i];
            if (value === undefined || value.startsWith('--'))
                throw new RangeError(arg);
            return value;
        };
        switch (arg) {
            case '--json':
                flags.json = true;
                break;
            case '--allow-repair':
                flags.allowRepair = true;
                break;
            case '--app-root':
                flags.appRoot = next();
                break;
            case '--cwd':
                flags.cwd = next();
                break;
            case '--config':
                flags.config = next();
                break;
            case '--host': {
                const host = next();
                if (host !== 'claude' && host !== 'codex')
                    return null;
                flags.host = host;
                hostGiven = true;
                break;
            }
            case '--resource': {
                const id = next();
                if (id !== 'rn-agent-actions')
                    return null;
                flags.resources = [...(flags.resources ?? []), id];
                break;
            }
            default:
                return null;
        }
    }
    if (positional.length > 2)
        return null;
    if (positional[0])
        flags.command = positional[0];
    if (positional[1])
        flags.subcommand = positional[1];
    if (!COMMANDS.includes(flags.command))
        return null;
    if (flags.command === 'hook') {
        if (flags.subcommand === '')
            flags.subcommand = 'status';
        if (!HOOK_SUBCOMMANDS.includes(flags.subcommand))
            return null;
    }
    else if (flags.subcommand !== '') {
        return null;
    }
    const supported = resourcesForHost(flags.host).map((resource) => resource.id);
    if (flags.resources?.some((id) => !supported.includes(id)))
        return null;
    // Mutating surfaces never inherit a host default: an omitted --host in the Codex
    // package would otherwise silently opt into Claude-only resources.
    const mutating = flags.command === 'apply' || flags.subcommand === 'install';
    if (mutating && !hostGiven)
        return null;
    return flags;
}
const REFUSAL_TEXT = {
    NOT_GIT: 'not a Git working tree',
    BARE: 'bare repository — no checkout to inherit from',
    GIT_UNAVAILABLE: 'Git could not resolve this repository',
    NOT_RN_APP: 'no React Native app manifest at the given app root',
    APP_OUTSIDE_WORKTREE: 'the given app root is outside this worktree',
    NO_PRIMARY: 'no verified primary worktree for this repository',
    AMBIGUOUS: 'multiple verified primary worktrees — refusing to guess',
    PRIMARY_APP_MISSING: 'the primary worktree has no directory at this app-relative path',
};
// Machine output carries no absolute path: only the regime, the worktree-relative
// destination, and whether a canonical source exists.
function redactPlan(plan) {
    return {
        kind: plan.refusal ? 'refused' : plan.layout.kind,
        appRelative: plan.layout.appRelative,
        host: plan.host,
        refusal: plan.refusal,
        resources: plan.resources.map((resource) => ({
            id: resource.id,
            destination: resource.destination,
            regime: resource.regime,
            state: resource.state,
            action: resource.action,
            ignoreSafe: resource.ignoreSafe,
            sourcePresent: resource.sourceState === 'AVAILABLE',
            remediation: resource.remediation,
        })),
    };
}
function planLines(plan) {
    if (plan.refusal)
        return [`rn-dev-agent worktree inheritance: ${REFUSAL_TEXT[plan.refusal]}`];
    if (plan.layout.kind === 'primary')
        return [];
    return plan.resources.map((resource) => {
        const suffix = resource.remediation ? ` — ${resource.remediation}` : '';
        return `${resource.destination}: ${resource.state}${suffix}`;
    });
}
// Refusals that mean "this layout cannot inherit" are reported; refusals that mean
// "inheritance does not apply here" (not Git, bare, not an RN app) stay silent.
const SILENT_REFUSALS = new Set(['NOT_GIT', 'BARE', 'NOT_RN_APP', 'APP_OUTSIDE_WORKTREE']);
function actionableLines(plan) {
    if (plan.refusal) {
        return SILENT_REFUSALS.has(plan.refusal)
            ? []
            : [`rn-dev-agent: ${REFUSAL_TEXT[plan.refusal]}; private context is not inherited here.`];
    }
    if (plan.layout.kind === 'primary')
        return [];
    const notable = plan.resources.filter((resource) => resource.state !== 'LINK_VALID_SAFE' && resource.state !== 'TRACKED');
    if (notable.length === 0)
        return [];
    return [
        'rn-dev-agent linked worktree: the learned-action corpus is not fully inherited here.',
        ...notable.map((resource) => {
            const suffix = resource.remediation ? ` — ${resource.remediation}` : '';
            return `  ${resource.destination}: ${resource.state}${suffix}`;
        }),
        '  Run /rn-dev-agent:setup to review and apply before using learned actions.',
    ];
}
function hookPaths(commonDir) {
    const stateDir = join(commonDir, HOOK_STATE_DIR);
    return {
        stateDir,
        helper: join(stateDir, HOOK_HELPER),
        config: join(stateDir, HOOK_CONFIG),
        hooksDir: join(commonDir, 'hooks'),
        hook: join(commonDir, 'hooks', 'post-checkout'),
    };
}
function hookScript() {
    return `#!/bin/bash
${HOOK_MARKER}
# Local, untracked, idempotent. Runs only on branch checkout (flag 1), never
# blocks the checkout, and performs no network or install work.
[ "$3" = "1" ] || exit 0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_NAMESPACE
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
STATE="$COMMON/${HOOK_STATE_DIR}"
[ -f "$STATE/${HOOK_HELPER}" ] || exit 0
[ -f "$STATE/${HOOK_CONFIG}" ] || exit 0
if command -v node >/dev/null 2>&1; then
  node "$STATE/${HOOK_HELPER}" post-checkout --config "$STATE/${HOOK_CONFIG}" >/dev/null 2>&1
else
  printf '{\\n  "refusal": "NODE_UNAVAILABLE"\\n}\\n' > "$STATE/${LAST_RUN}" 2>/dev/null
fi
exit 0
`;
}
function configuredHooksPath(cwd) {
    const env = { ...process.env };
    for (const key of [
        'GIT_DIR',
        'GIT_WORK_TREE',
        'GIT_INDEX_FILE',
        'GIT_COMMON_DIR',
        'GIT_OBJECT_DIRECTORY',
        'GIT_NAMESPACE',
    ]) {
        delete env[key];
    }
    const result = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd,
        encoding: 'utf8',
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (result.status !== 0)
        return null;
    const value = (result.stdout ?? '').trim();
    return value.length > 0 ? value : null;
}
function selfPath() {
    try {
        return fileURLToPath(import.meta.url);
    }
    catch {
        return resolve(process.argv[1] ?? '');
    }
}
function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}
function readHookConfig(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8'));
        if (parsed.version !== 1)
            return null;
        if (parsed.host !== 'claude' && parsed.host !== 'codex')
            return null;
        if (typeof parsed.hookSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.hookSha256)) {
            return null;
        }
        if (typeof parsed.appRelative !== 'string' || parsed.appRelative.length === 0)
            return null;
        if (parsed.appRelative !== '.') {
            const segments = parsed.appRelative.split('/');
            if (parsed.appRelative.startsWith('/') ||
                segments.some((part) => part === '..' || part === '')) {
                return null;
            }
        }
        const supported = resourcesForHost(parsed.host).map((resource) => resource.id);
        if (!Array.isArray(parsed.resources))
            return null;
        if (parsed.resources.some((id) => !supported.includes(id)))
            return null;
        return parsed;
    }
    catch {
        return null;
    }
}
function hookState(commonDir, cwd) {
    if (configuredHooksPath(cwd)) {
        return {
            status: 'hooks-path-configured',
            detail: "core.hooksPath is managed by another tool. rn-dev-agent will not redirect it; add the composition line manually to that tool's post-checkout hook.",
        };
    }
    const paths = hookPaths(commonDir);
    if (!existsSync(paths.hook))
        return { status: 'absent' };
    let body = '';
    try {
        body = readFileSync(paths.hook, 'utf8');
    }
    catch {
        return { status: 'foreign-hook', detail: 'existing post-checkout hook is unreadable' };
    }
    const owned = readHookConfig(paths.config)?.hookSha256;
    if (owned && owned === sha256(body))
        return { status: 'installed' };
    if (body.includes(HOOK_MARKER)) {
        return {
            status: 'composed-hook',
            detail: 'a post-checkout hook references rn-dev-agent but is not byte-owned by this install; it is never replaced or removed automatically',
        };
    }
    return {
        status: 'foreign-hook',
        detail: 'another post-checkout hook is installed and is never overwritten',
    };
}
function helperRuns(helper, cwd) {
    const probe = spawnSync(process.execPath, [helper, 'plan', '--cwd', cwd], {
        encoding: 'utf8',
        timeout: 30_000,
    });
    return !probe.error && probe.status === 0;
}
// Absent hooks are created with exclusive semantics; an owned hook is replaced only
// after its bytes still hash to the identity this install recorded.
function writeHookBody(paths, body, status, ownedSha) {
    if (status === 'absent') {
        try {
            writeFileSync(paths.hook, body, { flag: 'wx', mode: 0o755 });
            chmodSync(paths.hook, 0o755);
            return true;
        }
        catch {
            return false;
        }
    }
    const staged = `${paths.hook}.${process.pid}.tmp`;
    try {
        if (!ownedSha || sha256(readFileSync(paths.hook, 'utf8')) !== ownedSha)
            return false;
        writeFileSync(staged, body, { flag: 'wx', mode: 0o755 });
        chmodSync(staged, 0o755);
        if (sha256(readFileSync(paths.hook, 'utf8')) !== ownedSha) {
            rmSync(staged, { force: true });
            return false;
        }
        renameSync(staged, paths.hook);
        return true;
    }
    catch {
        rmSync(staged, { force: true });
        return false;
    }
}
function manualComposition() {
    return [
        'Manual composition (add to your existing post-checkout hook, before its exit):',
        '  [ "$3" = "1" ] && {',
        '    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_NAMESPACE',
        '    C=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)',
        `    [ -f "$C/${HOOK_STATE_DIR}/${HOOK_HELPER}" ] && node "$C/${HOOK_STATE_DIR}/${HOOK_HELPER}" \\`,
        `      post-checkout --config "$C/${HOOK_STATE_DIR}/${HOOK_CONFIG}" >/dev/null 2>&1`,
        '  }',
    ].join('\n');
}
function installHook(flags) {
    const layout = resolveWorktreeLayout({ cwd: flags.cwd, appRoot: flags.appRoot });
    if (!('worktreeRoot' in layout) || layout.refusal) {
        const refusal = 'refusal' in layout ? layout.refusal : 'GIT_UNAVAILABLE';
        console.error(`refused: ${REFUSAL_TEXT[refusal]}`);
        return 3;
    }
    const state = hookState(layout.commonDir, flags.cwd);
    const paths = hookPaths(layout.commonDir);
    const requested = (flags.resources ??
        resourcesForHost(flags.host).map((r) => r.id));
    const previousConfig = readHookConfig(paths.config);
    const ownedSha = previousConfig?.hookSha256;
    const resources = [...new Set(requested)];
    const body = hookScript();
    const config = {
        version: 1,
        appRelative: layout.appRelative,
        host: flags.host,
        resources,
        hookSha256: sha256(body),
    };
    // The helper and its config are inert without a hook that calls them, so they are
    // provisioned even when hook composition is refused — that is what makes the
    // printed manual composition line actually work. Both are staged and probed under
    // unique names so a concurrent checkout never executes a partial copy.
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
    // Node picks the module loader from the extension, so the staged copy stays `.js`.
    const stagedHelper = join(paths.stateDir, `worktree-inheritance.${process.pid}.staged.js`);
    const stagedConfig = `${paths.config}.${process.pid}.tmp`;
    copyFileSync(selfPath(), stagedHelper);
    if (!helperRuns(stagedHelper, flags.cwd)) {
        rmSync(stagedHelper, { force: true });
        console.error('refused: the packaged helper copy is not self-contained; install from the host plugin package.');
        return 3;
    }
    writeFileSync(stagedConfig, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    renameSync(stagedHelper, paths.helper);
    renameSync(stagedConfig, paths.config);
    if (state.status !== 'absent' && state.status !== 'installed') {
        console.error(`refused: ${state.detail}`);
        console.error('the helper is provisioned, so the composition below works as written.');
        console.error(manualComposition());
        return 3;
    }
    mkdirSync(paths.hooksDir, { recursive: true });
    if (!writeHookBody(paths, body, state.status, ownedSha)) {
        console.error('refused: another post-checkout hook appeared during install; no hook was created or replaced.');
        console.error(manualComposition());
        return 3;
    }
    console.log('installed: local post-checkout integration for this repository only.');
    console.log(`  app-relative: ${layout.appRelative}`);
    console.log(`  resources: ${resources.join(', ')}`);
    console.log('  note: `git worktree add --no-checkout` and tools that bypass Git hooks do not run it — use /rn-dev-agent:setup before launching an agent there.');
    return 0;
}
function uninstallHook(flags) {
    const layout = resolveWorktreeLayout({ cwd: flags.cwd, appRoot: flags.appRoot });
    if (!('worktreeRoot' in layout)) {
        console.error(`refused: ${REFUSAL_TEXT[layout.refusal]}`);
        return 3;
    }
    const state = hookState(layout.commonDir, flags.cwd);
    if (state.status !== 'installed') {
        console.log(`nothing to remove: ${state.status}`);
        return 0;
    }
    const paths = hookPaths(layout.commonDir);
    if (hookState(layout.commonDir, flags.cwd).status !== 'installed') {
        console.error('refused: the post-checkout hook changed during removal; nothing was deleted.');
        return 3;
    }
    rmSync(paths.hook, { force: true });
    for (const owned of [paths.helper, paths.config, join(paths.stateDir, LAST_RUN)]) {
        rmSync(owned, { force: true });
    }
    try {
        rmdirSync(paths.stateDir);
    }
    catch {
        /* other state lives here; leave it alone */
    }
    console.log('removed: local post-checkout integration.');
    return 0;
}
function reportHook(flags) {
    const layout = resolveWorktreeLayout({ cwd: flags.cwd, appRoot: flags.appRoot });
    if (!('worktreeRoot' in layout)) {
        console.log(`hook: unavailable (${REFUSAL_TEXT[layout.refusal]})`);
        return 0;
    }
    const state = hookState(layout.commonDir, flags.cwd);
    const paths = hookPaths(layout.commonDir);
    const config = readHookConfig(paths.config);
    if (flags.json) {
        console.log(JSON.stringify({ status: state.status, detail: state.detail, config }, null, 2));
        return 0;
    }
    console.log(`hook: ${state.status}${state.detail ? ` — ${state.detail}` : ''}`);
    if (config)
        console.log(`  app-relative: ${config.appRelative}; resources: ${config.resources.join(', ')}`);
    if (state.status === 'foreign-hook' || state.status === 'hooks-path-configured') {
        console.log(manualComposition());
    }
    return 0;
}
// The Git hook discards stdout so a checkout is never polluted; the outcome is
// persisted next to the helper so /doctor and SessionStart can surface a failure.
function runPostCheckout(flags) {
    if (!flags.config)
        return 2;
    const config = readHookConfig(flags.config);
    if (!config)
        return 3;
    const layout = resolveWorktreeLayout({ cwd: flags.cwd });
    const worktreeRoot = 'worktreeRoot' in layout && layout.worktreeRoot ? layout.worktreeRoot : flags.cwd;
    const appRoot = config.appRelative === '.' ? worktreeRoot : join(worktreeRoot, config.appRelative);
    const appPresent = existsSync(appRoot);
    const resources = appPresent ? config.resources : [];
    if (resources.length === 0) {
        recordLastRun(dirname(flags.config), {
            appRelative: config.appRelative,
            refusal: 'PRIMARY_APP_MISSING',
            outcomes: [],
        });
        return 0;
    }
    const report = applyInheritance({
        cwd: flags.cwd,
        appRoot: appPresent ? appRoot : worktreeRoot,
        host: config.host,
        resources,
    });
    const failed = report.refusal !== undefined || report.outcomes.some((o) => o.result === 'refused');
    recordLastRun(dirname(flags.config), {
        appRelative: config.appRelative,
        refusal: report.refusal,
        outcomes: report.outcomes.map((outcome) => ({
            id: outcome.id,
            state: outcome.state,
            result: outcome.result,
        })),
    });
    return failed ? 3 : 0;
}
function recordLastRun(stateDir, payload) {
    try {
        writeFileSync(join(stateDir, LAST_RUN), `${JSON.stringify(payload, null, 2)}\n`, {
            mode: 0o600,
        });
    }
    catch {
        /* diagnostics are best-effort and never block a checkout */
    }
}
function main() {
    const flags = parseFlags(process.argv.slice(2));
    if (!flags) {
        console.error('worktree-inheritance: invalid arguments');
        return 2;
    }
    if (flags.command === 'hook') {
        if (flags.subcommand === 'install')
            return installHook(flags);
        if (flags.subcommand === 'uninstall')
            return uninstallHook(flags);
        if (flags.subcommand === 'status' || flags.subcommand === '')
            return reportHook(flags);
        return 2;
    }
    if (flags.command === 'post-checkout')
        return runPostCheckout(flags);
    if (flags.command === 'repair') {
        const report = repairLegacyRoot({ cwd: flags.cwd, appRoot: flags.appRoot });
        if (flags.json) {
            console.log(JSON.stringify(report, null, 2));
        }
        else {
            console.log(`${report.code}: ${report.reason}`);
            for (const path of report.retainedPaths)
                console.log(`  retained: ${path}`);
        }
        return report.status === 'refused' ? 3 : 0;
    }
    if (flags.command === 'apply') {
        const report = applyInheritance({
            cwd: flags.cwd,
            appRoot: flags.appRoot,
            host: flags.host,
            resources: flags.resources,
            allowRepair: flags.allowRepair,
        });
        if (flags.json) {
            console.log(JSON.stringify(report, null, 2));
        }
        else {
            if (report.refusal)
                console.log(`refused: ${REFUSAL_TEXT[report.refusal]}`);
            for (const outcome of report.outcomes) {
                console.log(`${outcome.id}: ${outcome.result} (${outcome.state})${outcome.reason ? ` — ${outcome.reason}` : ''}`);
            }
            console.log(`applied ${report.applied}/${report.requested}`);
        }
        if (report.refusal && !SILENT_REFUSALS.has(report.refusal))
            return 3;
        return report.outcomes.some((outcome) => outcome.result === 'refused') ? 3 : 0;
    }
    const plan = planInheritance({
        cwd: flags.cwd,
        appRoot: flags.appRoot,
        host: flags.host,
        resources: flags.resources,
    });
    if (flags.json) {
        console.log(JSON.stringify(redactPlan(plan), null, 2));
    }
    else {
        const lines = flags.command === 'report' ? actionableLines(plan) : planLines(plan);
        for (const line of lines)
            console.log(line);
    }
    // `report` is the SessionStart surface and always succeeds; `plan` is the
    // scriptable surface and signals refusal.
    if (flags.command === 'plan' && plan.refusal && !SILENT_REFUSALS.has(plan.refusal))
        return 3;
    return 0;
}
process.exitCode = main();
