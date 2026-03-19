"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStore = exports.registerNavRef = void 0;
exports.install = install;
const console_1 = require("./console");
const errors_1 = require("./errors");
const nav_1 = require("./nav");
Object.defineProperty(exports, "registerNavRef", { enumerable: true, get: function () { return nav_1.registerNavRef; } });
const store_1 = require("./store");
Object.defineProperty(exports, "registerStore", { enumerable: true, get: function () { return store_1.registerStore; } });
const BRIDGE_VERSION = 1;
function install() {
    const g = globalThis;
    if (typeof __DEV__ !== 'undefined' && !__DEV__)
        return;
    const existing = g.__RN_DEV_BRIDGE__;
    if (existing && existing.__v === BRIDGE_VERSION)
        return;
    (0, console_1.installConsolePatch)();
    (0, errors_1.installErrorTracking)();
    const bridge = {
        __v: BRIDGE_VERSION,
        getNavState: nav_1.getNavState,
        navigateTo: nav_1.navigateTo,
        getStoreState: store_1.getStoreState,
        dispatchAction: store_1.dispatchAction,
        getConsole: console_1.getConsole,
        clearConsole: console_1.clearConsole,
        getErrors: errors_1.getErrors,
        clearErrors: errors_1.clearErrors,
    };
    g.__RN_DEV_BRIDGE__ = bridge;
}
