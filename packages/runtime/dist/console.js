"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.installConsolePatch = installConsolePatch;
exports.getConsole = getConsole;
exports.clearConsole = clearConsole;
const utils_1 = require("./utils");
const MAX_ENTRIES = 200;
let buffer = [];
const SENTINEL_KEY = '__RN_DEV_BRIDGE_CONSOLE_PATCHED__';
function installConsolePatch() {
    const g = globalThis;
    if (g[SENTINEL_KEY])
        return;
    if (typeof globalThis.console === 'undefined')
        return;
    g[SENTINEL_KEY] = true;
    const levels = ['log', 'warn', 'error', 'info', 'debug'];
    for (const level of levels) {
        const original = globalThis.console[level];
        if (typeof original !== 'function')
            continue;
        globalThis.console[level] = (...args) => {
            buffer.push({
                level,
                message: args.map((a) => (typeof a === 'string' ? a : (0, utils_1.safeStringify)(a, 2000))).join(' '),
                timestamp: Date.now(),
            });
            if (buffer.length > MAX_ENTRIES) {
                buffer = buffer.slice(-MAX_ENTRIES);
            }
            original.apply(globalThis.console, args);
        };
    }
}
function getConsole(opts) {
    var _a, _b;
    const level = (_a = opts === null || opts === void 0 ? void 0 : opts.level) !== null && _a !== void 0 ? _a : 'all';
    const limit = (_b = opts === null || opts === void 0 ? void 0 : opts.limit) !== null && _b !== void 0 ? _b : 50;
    let filtered = buffer;
    if (level !== 'all') {
        filtered = buffer.filter((e) => e.level === level);
    }
    const entries = filtered.slice(-limit);
    return JSON.stringify({ entries, total: filtered.length, shown: entries.length });
}
function clearConsole() {
    buffer = [];
    return JSON.stringify({ cleared: true });
}
