import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { failResult, okResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { readAppId } from '../project-config.js';
import { buildMaestroFlow, parseAndValidateFlow, isValidBundleId, MaestroValidationError, } from '../domain/maestro-validator.js';
import { createMaestroRunHandler, nestedMaestroAuthorityCallbacks, } from './maestro-run.js';
import { regexSelectorCapabilityRefusal } from '../domain/action-engine-compat.js';
import { getWorkerAuthorityRuntime } from '../session/runtime.js';
const AUTH_ROUTE_PATTERNS = [
    'login',
    'signin',
    'sign_in',
    'sign-in',
    'welcome',
    'register',
    'signup',
    'sign_up',
    'sign-up',
    'onboarding',
    'auth',
    'landing',
];
const LOGIN_FLOW_PRIORITY = [
    'login.yaml',
    'login.yml',
    'sign_in.yaml',
    'sign_in.yml',
    'signin.yaml',
    'signin.yml',
    'auth.yaml',
    'auth.yml',
    'flow_start.yaml',
    'flow_start.yml',
    'register_user.yaml',
    'register_user.yml',
    'register.yaml',
    'register.yml',
];
function matchesAuthPattern(routeName) {
    const lower = routeName.toLowerCase();
    return AUTH_ROUTE_PATTERNS.some((p) => lower.includes(p));
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
    const maestroDir = join(projectRoot, '.maestro');
    const searchDirs = [join(maestroDir, 'subflows'), maestroDir];
    for (const dir of searchDirs) {
        let files;
        try {
            const maestroStat = lstatSync(maestroDir);
            const dirStat = lstatSync(dir);
            if (maestroStat.isSymbolicLink() || dirStat.isSymbolicLink()) {
                throw new Error(`Refusing legacy login directory symlink at ${dir}.`);
            }
            if (!maestroStat.isDirectory() || !dirStat.isDirectory())
                continue;
            files = readdirSync(dir);
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
            continue;
        }
        for (const candidate of LOGIN_FLOW_PRIORITY) {
            if (files.includes(candidate)) {
                return assertLegacyLoginFlow(projectRoot, join(dir, candidate));
            }
        }
        const authFile = files.find((f) => /\.(ya?ml)$/.test(f) && AUTH_ROUTE_PATTERNS.some((p) => f.toLowerCase().includes(p)));
        if (authFile)
            return assertLegacyLoginFlow(projectRoot, join(dir, authFile));
    }
    return null;
}
function assertLegacyLoginFlow(projectRoot, flowPath) {
    const stat = lstatSync(flowPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`Refusing legacy login flow symlink at ${flowPath}.`);
    }
    const maestroDir = resolve(projectRoot, '.maestro');
    const resolvedFlow = resolve(flowPath);
    if (resolvedFlow !== maestroDir && !resolvedFlow.startsWith(`${maestroDir}/`)) {
        throw new Error(`Refusing legacy login flow outside ${maestroDir}.`);
    }
    return resolvedFlow;
}
function containsClearState(value) {
    if (value === 'clearState')
        return true;
    if (Array.isArray(value))
        return value.some(containsClearState);
    if (!value || typeof value !== 'object')
        return false;
    return Object.entries(value).some(([key, nested]) => key === 'clearState' || containsClearState(nested));
}
function boundSessionProjectRoot() {
    const status = getWorkerAuthorityRuntime().status();
    return status.available && typeof status.source.appRoot === 'string'
        ? status.source.appRoot
        : null;
}
function canonicalRoot(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return null;
    }
}
function maestroRunFailure(result) {
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '{}');
        if (envelope.ok === true && envelope.data?.passed !== false)
            return null;
        return envelope.error ?? 'Maestro replay did not report a passing result.';
    }
    catch {
        return 'Maestro replay returned an invalid result.';
    }
}
export async function handleAutoLogin(client, opts = {}, deps = {}) {
    if (!client.isConnected || !client.helpersInjected)
        return null;
    const onAuth = await isOnAuthScreen(client);
    if (!onAuth) {
        return { loggedIn: false, reason: 'App is not on an auth screen' };
    }
    const session = (deps.getSession ?? getActiveSession)();
    const platform = opts.platform ?? session?.platform;
    if (platform !== 'ios' && platform !== 'android') {
        return {
            loggedIn: false,
            reason: 'Cannot determine platform. Pass platform="ios" or platform="android" explicitly, or open a device session first.',
        };
    }
    const deviceId = opts.deviceId ?? (session?.platform === platform ? session.deviceId : undefined);
    if (!deviceId) {
        return {
            loggedIn: false,
            reason: `Auto-login requires an owned ${platform} session bound to one exact device.`,
            code: 'DEVICE_AUTHORITY_MISMATCH',
            nextAction: 'Run rn_session with action "status" and repair the device authority binding, then retry cdp_auto_login.',
        };
    }
    const boundProjectRoot = (deps.boundProjectRoot ?? boundSessionProjectRoot)();
    if (!boundProjectRoot) {
        return {
            loggedIn: false,
            reason: 'Auto-login requires an exact app root from the active session authority.',
        };
    }
    const discoveredProjectRoot = (deps.projectRoot ?? findProjectRoot)();
    const boundCanonicalRoot = canonicalRoot(boundProjectRoot);
    const discoveredCanonicalRoot = discoveredProjectRoot
        ? canonicalRoot(discoveredProjectRoot)
        : boundCanonicalRoot;
    if (!boundCanonicalRoot ||
        !discoveredCanonicalRoot ||
        discoveredCanonicalRoot !== boundCanonicalRoot) {
        return {
            loggedIn: false,
            reason: 'Auto-login project discovery does not match the active session app root.',
        };
    }
    const projectRoot = boundCanonicalRoot;
    let flowPath;
    try {
        flowPath = findLoginFlow(projectRoot);
    }
    catch (err) {
        return {
            loggedIn: false,
            reason: err instanceof Error ? err.message : String(err),
        };
    }
    if (!flowPath) {
        return {
            loggedIn: false,
            reason: 'App is on an auth screen but no explicitly authorized legacy login subflow exists. Recovery cannot proceed; use a compatible owned learned action for durable authentication or proof.',
        };
    }
    const projectAppId = readAppId(projectRoot, platform);
    if (opts.appId && projectAppId && opts.appId !== projectAppId) {
        return {
            loggedIn: false,
            reason: 'Auto-login app ID does not match the active session and bound project.',
            flow: flowPath,
        };
    }
    const rawAppId = opts.appId ?? projectAppId ?? '';
    const originalContent = readFileSync(flowPath, 'utf-8');
    let validatedCommands;
    try {
        const parsed = parseAndValidateFlow(originalContent, {
            flowDir: dirname(flowPath),
            flowRoot: join(projectRoot, '.maestro'),
        });
        validatedCommands = parsed.commands;
        if (containsClearState(validatedCommands)) {
            return {
                loggedIn: false,
                reason: 'Auto-login refuses clearState in the expanded login flow.',
                flow: flowPath,
            };
        }
        const selectorRefusal = regexSelectorCapabilityRefusal(validatedCommands);
        if (selectorRefusal)
            return { loggedIn: false, reason: selectorRefusal, flow: flowPath };
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
            return {
                loggedIn: false,
                reason: `Auto-login wrapper refused: ${err.message} (Phase 134.1)`,
            };
        }
        throw err;
    }
    const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
    const managedAuthority = nestedMaestroAuthorityCallbacks(opts);
    const replay = await maestroRun({
        inlineYaml: wrapperContent,
        platform,
        deviceId,
        timeoutMs: 120_000,
        ...managedAuthority,
    });
    const replayFailure = maestroRunFailure(replay);
    if (replayFailure) {
        return {
            loggedIn: false,
            reason: `Maestro login flow failed: ${replayFailure.slice(0, 200)}`,
            flow: flowPath,
        };
    }
    let stillOnAuth = true;
    const authDeadline = Date.now() + 5000;
    do {
        await new Promise((r) => setTimeout(r, 300));
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
export function autoLoginToolResult(result) {
    if (result === null)
        return failResult('CDP not connected or helpers not injected');
    if (result.loggedIn || result.reason.includes('not on an auth screen'))
        return okResult(result);
    if (result.code) {
        return failResult(result.reason, result.code, result.nextAction ? { nextAction: result.nextAction } : undefined);
    }
    return failResult(result.reason);
}
