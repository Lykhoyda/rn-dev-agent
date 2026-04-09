import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findProjectRoot } from '../nav-graph/storage.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { readAppId } from '../project-config.js';
const execFile = promisify(execFileCb);
const AUTH_ROUTE_PATTERNS = [
    'login', 'signin', 'sign_in', 'sign-in',
    'welcome', 'register', 'signup', 'sign_up', 'sign-up',
    'onboarding', 'auth', 'landing',
];
const LOGIN_FLOW_PRIORITY = [
    'login.yaml', 'login.yml',
    'sign_in.yaml', 'sign_in.yml',
    'signin.yaml', 'signin.yml',
    'auth.yaml', 'auth.yml',
    'flow_start.yaml', 'flow_start.yml',
    'register_user.yaml', 'register_user.yml',
    'register.yaml', 'register.yml',
];
function matchesAuthPattern(routeName) {
    const lower = routeName.toLowerCase();
    return AUTH_ROUTE_PATTERNS.some(p => lower.includes(p));
}
function getDeepestRouteName(state) {
    if (state.nested)
        return getDeepestRouteName(state.nested);
    return state.routeName ?? null;
}
export async function isOnAuthScreen(client) {
    if (!client.isConnected || !client.helpersInjected)
        return false;
    try {
        const expr = client.bridgeDetected
            ? '__RN_DEV_BRIDGE__.getNavState()'
            : '__RN_AGENT.getNavState()';
        const result = await client.evaluate(expr);
        if (result.error || typeof result.value !== 'string')
            return false;
        const state = JSON.parse(result.value);
        if (state.error)
            return false;
        const route = getDeepestRouteName(state);
        if (!route)
            return false;
        return matchesAuthPattern(route);
    }
    catch {
        return false;
    }
}
function findLoginFlow(projectRoot) {
    const searchDirs = [
        join(projectRoot, '.maestro', 'subflows'),
        join(projectRoot, '.maestro'),
    ];
    for (const dir of searchDirs) {
        if (!existsSync(dir))
            continue;
        let files;
        try {
            files = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const candidate of LOGIN_FLOW_PRIORITY) {
            if (files.includes(candidate)) {
                return join(dir, candidate);
            }
        }
        const authFile = files.find(f => /\.(ya?ml)$/.test(f) && AUTH_ROUTE_PATTERNS.some(p => f.toLowerCase().includes(p)));
        if (authFile)
            return join(dir, authFile);
    }
    return null;
}
function stripClearState(yamlContent) {
    return yamlContent
        .split('\n')
        .filter(line => !/^\s*clearState\s*:\s*true/i.test(line))
        .join('\n');
}
export async function handleAutoLogin(client, opts = {}) {
    if (!client.isConnected || !client.helpersInjected)
        return null;
    const onAuth = await isOnAuthScreen(client);
    if (!onAuth) {
        return { loggedIn: false, reason: 'App is not on an auth screen' };
    }
    const platform = opts.platform ?? getActiveSession()?.platform;
    if (!platform) {
        return {
            loggedIn: false,
            reason: 'Cannot determine platform. Pass platform="ios" or platform="android" explicitly, or open a device session first.',
        };
    }
    const projectRoot = findProjectRoot();
    if (!projectRoot) {
        return { loggedIn: false, reason: 'Could not find RN project root to scan for Maestro subflows' };
    }
    const flowPath = findLoginFlow(projectRoot);
    if (!flowPath) {
        return {
            loggedIn: false,
            reason: `App is on an auth screen but no Maestro login subflows found in ${projectRoot}/.maestro/. Create a .maestro/subflows/login.yaml flow or log in manually.`,
        };
    }
    const appId = opts.appId ?? readAppId(projectRoot, platform) ?? '';
    const originalContent = readFileSync(flowPath, 'utf-8');
    const flowContent = stripClearState(originalContent);
    const needsStripping = flowContent !== originalContent;
    const wrapperPath = '/tmp/rn-auto-login-wrapper.yaml';
    let runFlowTarget = flowPath;
    if (needsStripping) {
        const strippedPath = '/tmp/rn-auto-login-stripped.yaml';
        writeFileSync(strippedPath, flowContent, 'utf-8');
        runFlowTarget = strippedPath;
    }
    const wrapperContent = appId
        ? `appId: ${appId}\n---\n- launchApp\n- runFlow:\n    file: ${runFlowTarget}\n`
        : `---\n- runFlow:\n    file: ${runFlowTarget}\n`;
    writeFileSync(wrapperPath, wrapperContent, 'utf-8');
    const runnerPath = join(homedir(), '.maestro-runner', 'bin', 'maestro-runner');
    if (!existsSync(runnerPath)) {
        return {
            loggedIn: false,
            reason: 'maestro-runner not found. Install with: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash',
        };
    }
    try {
        await execFile(runnerPath, ['--platform', platform, 'test', wrapperPath], {
            timeout: 120_000,
            encoding: 'utf8',
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            loggedIn: false,
            reason: `Maestro login flow failed: ${msg.slice(0, 200)}`,
            flow: flowPath,
        };
    }
    await new Promise(r => setTimeout(r, 3000));
    const stillOnAuth = await isOnAuthScreen(client);
    if (stillOnAuth) {
        return {
            loggedIn: false,
            reason: 'Maestro flow completed but app is still on an auth screen. The flow may not have logged in successfully.',
            flow: flowPath,
        };
    }
    return {
        loggedIn: true,
        reason: 'Auto-login via Maestro subflow succeeded',
        flow: flowPath,
    };
}
