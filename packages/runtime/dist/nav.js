"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerNavRef = registerNavRef;
exports.getNavState = getNavState;
exports.navigateTo = navigateTo;
const utils_1 = require("./utils");
let _navRef = null;
function registerNavRef(ref) {
    _navRef = ref;
}
function getRef() {
    if (_navRef)
        return _navRef;
    const g = globalThis;
    if (g.__NAV_REF__ && typeof g.__NAV_REF__.getRootState === 'function') {
        return g.__NAV_REF__;
    }
    return null;
}
function simplifyState(state) {
    var _a;
    if (!state || typeof state !== 'object')
        return null;
    const s = state;
    if (!Array.isArray(s.routes) || typeof s.index !== 'number')
        return null;
    const route = s.routes[s.index];
    if (!route)
        return null;
    const result = {
        routeName: route.name,
        params: (_a = route.params) !== null && _a !== void 0 ? _a : {},
        stack: s.routes.map((r) => r.name),
        index: s.index,
    };
    if (route.state) {
        result.nested = simplifyState(route.state);
    }
    return result;
}
function getNavState() {
    const ref = getRef();
    if (!ref) {
        return JSON.stringify({ error: 'No navigation ref registered. Call registerNavRef() or set globalThis.__NAV_REF__' });
    }
    try {
        const rootState = ref.getRootState();
        if (!rootState) {
            return JSON.stringify({ error: 'Navigation state not ready' });
        }
        const simplified = simplifyState(rootState);
        return (0, utils_1.safeStringify)(simplified);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ error: `Navigation state error: ${msg}` });
    }
}
function navigateTo(screen, params) {
    const ref = getRef();
    if (!ref) {
        return JSON.stringify({ error: 'No navigation ref registered' });
    }
    try {
        const rootState = ref.getRootState();
        if (!rootState) {
            return JSON.stringify({ error: 'Navigation state not ready' });
        }
        function findPath(navState, target, path) {
            for (let i = 0; i < navState.routes.length; i++) {
                const route = navState.routes[i];
                if (route.name === target) {
                    return [...path, { name: route.name, index: i }];
                }
                if (route.state && typeof route.state === 'object') {
                    const nested = route.state;
                    if (Array.isArray(nested.routes)) {
                        const found = findPath(nested, target, [...path, { name: route.name, index: i }]);
                        if (found)
                            return found;
                    }
                }
            }
            return null;
        }
        const targetPath = findPath(rootState, screen, []);
        if (!targetPath || targetPath.length === 0) {
            ref.navigate(screen, params);
            return JSON.stringify({ navigated: true, screen, method: 'direct' });
        }
        if (targetPath.length === 1) {
            ref.navigate(screen, params);
        }
        else {
            let navParams = params;
            for (let i = targetPath.length - 1; i > 0; i--) {
                navParams = { screen: targetPath[i].name, params: navParams };
            }
            ref.navigate(targetPath[0].name, navParams);
        }
        return JSON.stringify({ navigated: true, screen, path: targetPath.map((p) => p.name) });
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return JSON.stringify({ error: `Navigate failed: ${msg}` });
    }
}
