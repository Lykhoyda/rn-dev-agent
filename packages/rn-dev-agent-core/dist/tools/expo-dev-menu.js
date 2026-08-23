export const RESOLVE_EXPO_DEV_MENU = `(function () {
  try { var e = globalThis.expo; if (e && e.modules && e.modules.ExpoDevMenu) return e.modules.ExpoDevMenu; } catch (e0) {}
  try { var nm = require("react-native").NativeModules; if (nm && nm.ExpoDevMenu) return nm.ExpoDevMenu; } catch (e1) {}
  try { if (typeof __turboModuleProxy === "function") { var t = __turboModuleProxy("ExpoDevMenu"); if (t) return t; } } catch (e2) {}
  try { if (typeof globalThis.nativeModuleProxy !== "undefined") { var p = globalThis.nativeModuleProxy.ExpoDevMenu; if (p) return p; } } catch (e3) {}
  return null;
})()`;
export const HIDE_EXPO_DEV_MENU_EXPRESSION = `(function () {
  var m = ${RESOLVE_EXPO_DEV_MENU};
  if (!m) return "no_module";
  var method = null;
  var close = null;
  try {
    if (typeof m.hideMenu === "function") { method = "hideMenu"; close = m.hideMenu; }
    else if (typeof m.closeMenu === "function") { method = "closeMenu"; close = m.closeMenu; }
    if (!method) return "no_method_available";
  } catch (e) { return "resolution_error:" + (e && e.message ? e.message : String(e)); }
  try {
    var pending = Promise.resolve(close.call(m)).then(function () { return "ok:" + method; }, function (e) { return "error:" + method + ":" + (e && e.message ? e.message : String(e)); });
    return { __rnAgentStartValue: "sent:" + method, then: function (resolve, reject) { return pending.then(resolve, reject); } };
  } catch (e) { return "error:" + method + ":" + (e && e.message ? e.message : String(e)); }
})()`;
function surfaceText(nodes) {
    return nodes.flatMap((node) => [node.label, node.identifier]
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
}
function isNonBlockingNavigationChrome(node, packageName) {
    if (packageName !== 'com.android.systemui')
        return false;
    const identifier = typeof node.identifier === 'string' ? node.identifier.trim().toLowerCase() : '';
    if ([
        'back',
        'home',
        'recent_apps',
        'recents',
        'overview',
        'navigation_bar_frame',
        'nav_bar_background',
        'navbuttons_view',
        'start_contextual_buttons',
        'end_contextual_buttons',
        'end_nav_buttons',
        'home_handle',
    ].includes(identifier)) {
        return true;
    }
    const label = typeof node.label === 'string' ? node.label.trim().toLowerCase() : '';
    const type = typeof node.type === 'string' ? node.type.toLowerCase() : '';
    return ['back', 'home', 'recents', 'overview'].includes(label) && type.includes('imageview');
}
function isBlockingForeignSurface(node, boundAppId) {
    const packageName = typeof node.packageName === 'string' ? node.packageName.trim() : '';
    if (!packageName || packageName === boundAppId)
        return false;
    return !isNonBlockingNavigationChrome(node, packageName);
}
export function classifyForegroundSurface(nodes, boundAppId) {
    const text = surfaceText(nodes);
    if (text.length === 0)
        return 'unknown';
    const has = (value) => text.some((candidate) => candidate.includes(value));
    if (nodes.some((node) => node.type === 'Alert') ||
        (boundAppId && nodes.some((node) => isBlockingForeignSurface(node, boundAppId)))) {
        return 'unknown';
    }
    if (has('development servers'))
        return 'dev_client_picker';
    if (has('this is the developer menu'))
        return 'first_run_tutorial';
    if ((has('toggle performance monitor') && has('toggle element inspector')) ||
        (has('copy system info') && has('open devtools'))) {
        return 'expo_dev_menu';
    }
    if (has('open debugger') || has('configure bundler'))
        return 'react_native_dev_menu';
    if (!boundAppId)
        return 'unknown';
    const hasBoundApp = nodes.some((node) => node.packageName === boundAppId || node.type === 'Application');
    return hasBoundApp ? 'app' : 'unknown';
}
export function foregroundSurfaceFromSnapshot(result, boundAppId) {
    if (result.isError)
        return 'unknown';
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '');
        if (!envelope.ok || !Array.isArray(envelope.data?.nodes))
            return 'unknown';
        return classifyForegroundSurface(envelope.data.nodes, boundAppId);
    }
    catch {
        return 'unknown';
    }
}
export function createForegroundSurfaceProbe(dependencies) {
    return async () => {
        const status = dependencies.getAuthorityStatus();
        const session = dependencies.getActiveSession();
        const runner = status.bindings?.runner;
        if (!status.available || !runner || !session)
            return 'unknown';
        const device = status.bindings?.device;
        const platform = device?.platform;
        if ((platform !== 'ios' && platform !== 'android') ||
            session.platform !== platform ||
            session.deviceId !== device?.deviceId ||
            session.appId !== device?.appId) {
            return 'unknown';
        }
        return foregroundSurfaceFromSnapshot(await dependencies.runNative(['snapshot'], { platform }), session.appId);
    };
}
function parseSentinel(value, attempts) {
    const sentinel = typeof value === 'string' ? value : '';
    if (sentinel === 'ok:hideMenu') {
        return {
            callSent: true,
            method: 'hideMenu',
            reason: 'ExpoDevMenu.hideMenu() completed.',
            attempts,
        };
    }
    if (sentinel === 'ok:closeMenu') {
        return {
            callSent: true,
            method: 'closeMenu',
            reason: 'ExpoDevMenu.closeMenu() completed.',
            attempts,
        };
    }
    if (sentinel === 'sent:hideMenu') {
        return {
            callSent: true,
            method: 'hideMenu',
            reason: 'ExpoDevMenu.hideMenu() was invoked but did not settle.',
            attempts,
        };
    }
    if (sentinel === 'sent:closeMenu') {
        return {
            callSent: true,
            method: 'closeMenu',
            reason: 'ExpoDevMenu.closeMenu() was invoked but did not settle.',
            attempts,
        };
    }
    if (sentinel === 'no_module') {
        return {
            callSent: false,
            reason: 'No ExpoDevMenu native module resolved.',
            attempts,
        };
    }
    if (sentinel === 'no_method_available') {
        return {
            callSent: false,
            reason: 'ExpoDevMenu resolved but exposes no hideMenu/closeMenu method.',
            attempts,
        };
    }
    if (sentinel.startsWith('resolution_error:')) {
        return {
            callSent: false,
            reason: `ExpoDevMenu resolution failed: ${sentinel.slice(17)}`,
            attempts,
        };
    }
    const invocationError = sentinel.match(/^error:(hideMenu|closeMenu):(.*)$/s);
    if (invocationError) {
        return {
            callSent: true,
            method: invocationError[1],
            reason: `ExpoDevMenu ${invocationError[1]} invocation failed: ${invocationError[2]}`,
            attempts,
        };
    }
    return {
        callSent: false,
        reason: `Unexpected dev-menu hide result: ${sentinel || '(empty)'}`,
        attempts,
    };
}
export async function hideExpoDevMenu(client, options = {}) {
    const retries = Math.min(1, Math.max(0, options.retries ?? 0));
    const retryDelayMs = Math.max(0, options.retryDelayMs ?? 300);
    const evaluationTimeoutMs = Math.min(5_000, Math.max(1, options.evaluationTimeoutMs ?? 5_000));
    let outcome = {
        callSent: false,
        reason: 'Dev menu hide not attempted.',
        attempts: 0,
    };
    let successfulCall;
    for (let attempt = 0; attempt <= retries; attempt++) {
        const attempts = attempt + 1;
        try {
            const result = await client.evaluate(HIDE_EXPO_DEV_MENU_EXPRESSION, true, evaluationTimeoutMs);
            const startOutcome = parseSentinel(result.value, attempts);
            const attemptOutcome = result.error
                ? startOutcome.callSent
                    ? {
                        ...startOutcome,
                        reason: `${startOutcome.reason} Async evaluation failed: ${result.error}`,
                    }
                    : {
                        callSent: false,
                        reason: `Dev menu hide evaluation failed: ${result.error}`,
                        attempts,
                    }
                : startOutcome;
            outcome = attemptOutcome;
            if (attemptOutcome.callSent)
                successfulCall = attemptOutcome;
        }
        catch (error) {
            outcome = {
                callSent: false,
                reason: `Dev menu hide evaluation threw: ${error instanceof Error ? error.message : String(error)}`,
                attempts,
            };
        }
        if (outcome.reason.startsWith('No ExpoDevMenu')) {
            if (!successfulCall)
                return outcome;
            break;
        }
        if (attempt < retries)
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return successfulCall ? { ...successfulCall, attempts: outcome.attempts } : outcome;
}
