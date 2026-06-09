import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { findProjectRoot } from '../nav-graph/storage.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { readAppId } from '../project-config.js';
import { buildMaestroFlow, parseAndValidateFlow, isValidBundleId, MaestroValidationError, } from '../domain/maestro-validator.js';
import { runFlowParked } from './maestro-run.js';
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
    const rawAppId = opts.appId ?? readAppId(projectRoot, platform) ?? '';
    // Phase 134.1 (deepsec CRITICAL #2): the project-supplied login flow is
    // attacker-controlled in the prompt-injection threat model. Previously
    // only `clearState: true` was stripped — `runScript`, `evalScript`,
    // `startRecording`, and any non-allowlist command sailed through. The
    // new flow:
    //   1. Read the project flow + parse it through the central validator,
    //      which rejects denied commands and unsafe scalars by default.
    //   2. Validate the appId against the strict bundle-ID regex before
    //      stamping it into the wrapper header.
    //   3. Inline the validated commands directly into the wrapper (no
    //      `runFlow: file: ...` indirection that would re-load the
    //      unvalidated file from disk at runtime).
    const originalContent = readFileSync(flowPath, 'utf-8');
    const flowContent = stripClearState(originalContent);
    let validatedCommands;
    try {
        const parsed = parseAndValidateFlow(flowContent);
        validatedCommands = parsed.commands;
    }
    catch (err) {
        const reason = err instanceof MaestroValidationError
            ? `Project login flow rejected by validator: ${err.message}`
            : `Project login flow could not be parsed: ${err.message}`;
        return { loggedIn: false, reason: `${reason} (Phase 134.1)` };
    }
    let wrapperContent;
    try {
        const appIdOpts = {};
        if (rawAppId) {
            if (!isValidBundleId(rawAppId)) {
                return {
                    loggedIn: false,
                    reason: `Refusing to run auto-login: invalid bundle ID '${String(rawAppId).slice(0, 80)}' from project config (Phase 134.1)`,
                };
            }
            appIdOpts.appId = rawAppId;
        }
        // Only prepend `launchApp` if the project flow doesn't already start
        // with one — multi-LLM review caught that hand-authored login.yaml
        // files conventionally lead with `- launchApp`, and unconditional
        // prepending caused a double-launch (slowing auto-login and possibly
        // clearing in-memory state set by the first launch).
        const first = validatedCommands[0];
        const startsWithLaunchApp = first === 'launchApp' ||
            (typeof first === 'object' && first !== null && 'launchApp' in first);
        const wrapperCommands = startsWithLaunchApp
            ? validatedCommands
            : [{ launchApp: null }, ...validatedCommands];
        wrapperContent = buildMaestroFlow(appIdOpts, wrapperCommands);
    }
    catch (err) {
        if (err instanceof MaestroValidationError) {
            return { loggedIn: false, reason: `Auto-login wrapper refused: ${err.message} (Phase 134.1)` };
        }
        throw err;
    }
    const wrapperPath = '/tmp/rn-auto-login-wrapper.yaml';
    writeFileSync(wrapperPath, wrapperContent, 'utf-8');
    const runnerPath = join(homedir(), '.maestro-runner', 'bin', 'maestro-runner');
    if (!existsSync(runnerPath)) {
        return {
            loggedIn: false,
            reason: 'maestro-runner not found. Install with: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash',
        };
    }
    try {
        await runFlowParked(() => execFile(runnerPath, ['--platform', platform, 'test', wrapperPath], {
            timeout: 120_000,
            encoding: 'utf8',
        }), { platform: platform === 'android' ? 'android' : 'ios', deviceId: getActiveSession()?.deviceId });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            loggedIn: false,
            reason: `Maestro login flow failed: ${msg.slice(0, 200)}`,
            flow: flowPath,
        };
    }
    // Poll for the auth screen to disappear instead of a blind 3s wait — returns
    // as soon as login lands, and tolerates a slower transition.
    let stillOnAuth = true;
    const authDeadline = Date.now() + 5000;
    do {
        await new Promise(r => setTimeout(r, 300));
        stillOnAuth = await isOnAuthScreen(client);
    } while (stillOnAuth && Date.now() < authDeadline);
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
