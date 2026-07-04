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
    if (typeof m.hideMenu === "function") { m.hideMenu(); return "ok:hideMenu"; }
    if (typeof m.closeMenu === "function") { m.closeMenu(); return "ok:closeMenu"; }
  } catch (e) { return "error:" + (e && e.message ? e.message : String(e)); }
  return "no_method_available";
})()`;
function parseSentinel(value) {
    const s = typeof value === 'string' ? value : '';
    if (s === 'ok:hideMenu')
        return { dismissed: true, method: 'hideMenu', reason: 'Dev menu hidden via hideMenu().' };
    if (s === 'ok:closeMenu')
        return { dismissed: true, method: 'closeMenu', reason: 'Dev menu hidden via closeMenu().' };
    if (s === 'no_module')
        return {
            dismissed: false,
            reason: 'No expo dev-menu module found — is this an expo-dev-client build?',
        };
    if (s === 'no_method_available')
        return { dismissed: false, reason: 'ExpoDevMenu resolved but exposes no hideMenu/closeMenu.' };
    if (s.startsWith('error:'))
        return { dismissed: false, reason: `ExpoDevMenu hide threw: ${s.slice(6)}` };
    return { dismissed: false, reason: `Unexpected dev-menu hide result: ${s || '(empty)'}` };
}
export async function hideExpoDevMenu(client, opts = {}) {
    const retries = Math.max(0, opts.retries ?? 0);
    const retryDelayMs = opts.retryDelayMs ?? 500;
    let outcome = { dismissed: false, reason: 'Dev menu hide not attempted.' };
    for (let attempt = 0; attempt <= retries; attempt++) {
        let value;
        try {
            const result = await client.evaluate(HIDE_EXPO_DEV_MENU_EXPRESSION);
            if (result.error) {
                outcome = { dismissed: false, reason: `Dev menu hide eval failed: ${result.error}` };
            }
            else {
                value = result.value;
            }
        }
        catch (err) {
            outcome = {
                dismissed: false,
                reason: `Dev menu hide eval threw: ${err instanceof Error ? err.message : String(err)}`,
            };
        }
        if (value === 'no_module')
            return parseSentinel(value);
        if (value !== undefined)
            outcome = parseSentinel(value);
        if (attempt < retries) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
        }
    }
    return outcome;
}
export async function autoDismissDevMenuMeta(client) {
    try {
        if (client.connectedTarget?.platform !== 'ios')
            return {};
        // One retry (short delay) covers the dev-menu present-animation window —
        // hideMenu() called mid-animation can no-op, so a second hide settles it.
        const dm = await hideExpoDevMenu(client, { retries: 1, retryDelayMs: 300 });
        return dm.dismissed ? { dev_menu_dismissed: true, dev_menu_method: dm.method } : {};
    }
    catch {
        return {};
    }
}
