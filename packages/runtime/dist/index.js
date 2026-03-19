"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerStore = exports.registerNavRef = exports.install = void 0;
var bridge_1 = require("./bridge");
Object.defineProperty(exports, "install", { enumerable: true, get: function () { return bridge_1.install; } });
Object.defineProperty(exports, "registerNavRef", { enumerable: true, get: function () { return bridge_1.registerNavRef; } });
Object.defineProperty(exports, "registerStore", { enumerable: true, get: function () { return bridge_1.registerStore; } });
const bridge_2 = require("./bridge");
(0, bridge_2.install)();
