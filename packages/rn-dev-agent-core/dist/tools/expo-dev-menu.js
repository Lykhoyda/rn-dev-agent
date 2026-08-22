export const RESOLVE_EXPO_DEV_MENU = `(function () {
  try { var e = globalThis.expo; if (e && e.modules && e.modules.ExpoDevMenu) return e.modules.ExpoDevMenu; } catch (e0) {}
  try { var nm = require("react-native").NativeModules; if (nm) { if (nm.ExpoDevMenu) return nm.ExpoDevMenu; if (nm.DevMenu) return nm.DevMenu; } } catch (e1) {}
  try { if (typeof __turboModuleProxy === "function") { var t = __turboModuleProxy("ExpoDevMenu"); if (t) return t; } } catch (e2) {}
  try { if (typeof globalThis.nativeModuleProxy !== "undefined") { var p = globalThis.nativeModuleProxy.ExpoDevMenu; if (p) return p; } } catch (e3) {}
  return null;
})()`;
export const HIDE_EXPO_DEV_MENU_EXPRESSION = `(function () {
  var m = ${RESOLVE_EXPO_DEV_MENU};
  if (!m) return "no_module";
  try {
    var method = typeof m.hideMenu === "function" ? "hideMenu" : (typeof m.closeMenu === "function" ? "closeMenu" : null);
    if (!method) return "no_method_available";
    return Promise.resolve(m[method]()).then(function () { return "ok:" + method; }, function (e) { return "error:" + (e && e.message ? e.message : String(e)); });
  } catch (e) { return "error:" + (e && e.message ? e.message : String(e)); }
})()`;
function surfaceText(nodes) {
    return nodes.flatMap((node) => [node.label, node.identifier]
        .filter((value) => typeof value === 'string')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean));
}
export function classifyForegroundSurface(nodes) {
    const text = surfaceText(nodes);
    if (text.length === 0)
        return 'unknown';
    const has = (value) => text.some((candidate) => candidate.includes(value));
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
    return 'app';
}
export function foregroundSurfaceFromSnapshot(result) {
    if (result.isError)
        return 'unknown';
    try {
        const envelope = JSON.parse(result.content[0]?.text ?? '');
        if (!envelope.ok || !Array.isArray(envelope.data?.nodes))
            return 'unknown';
        return classifyForegroundSurface(envelope.data.nodes);
    }
    catch {
        return 'unknown';
    }
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
    if (sentinel.startsWith('error:')) {
        return {
            callSent: false,
            reason: `ExpoDevMenu hide failed: ${sentinel.slice(6)}`,
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
            const attemptOutcome = result.error
                ? {
                    callSent: false,
                    reason: `Dev menu hide evaluation failed: ${result.error}`,
                    attempts,
                }
                : parseSentinel(result.value, attempts);
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
        if (outcome.reason.startsWith('No ExpoDevMenu'))
            return outcome;
        if (attempt < retries)
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
    return successfulCall ? { ...successfulCall, attempts: outcome.attempts } : outcome;
}
export async function autoDismissDevMenuMeta(client, probeSurface) {
    try {
        if (client.connectedTarget?.platform !== 'ios')
            return {};
        const before = probeSurface ? await probeSurface() : 'unknown';
        const call = await hideExpoDevMenu(client, { retries: 1 });
        const after = probeSurface ? await probeSurface() : 'unknown';
        return before === 'expo_dev_menu' && call.callSent && after === 'app'
            ? { dev_menu_dismissed: true, dev_menu_method: call.method }
            : {};
    }
    catch {
        return {};
    }
}
