#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __esm = (fn, res, err) => function __init() {
  if (err) throw err[0];
  try {
    return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
  } catch (e) {
    throw err = [e], e;
  }
};
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml2, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml2);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const { anchors: anchors2, doc, maxAliasCount } = ctx;
        const source = this.resolve(doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        let data = anchors2.get(source);
        if (!data) {
          toJS.toJS(source, null, ctx);
          data = anchors2.get(source);
        }
        if (data?.res === void 0) {
          const msg = "This should not happen: Alias anchor was not resolved?";
          throw new ReferenceError(msg);
        }
        if (maxAliasCount >= 0) {
          data.count += 1;
          if (data.aliasCount === 0)
            data.aliasCount = getAliasCount(doc, source, anchors2);
          if (data.count * data.aliasCount > maxAliasCount) {
            const msg = "Excessive alias count indicates a resource exhaustion attack";
            throw new ReferenceError(msg);
          }
        }
        return data.res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start = i + 1;
      let ch = text[start];
      while (ch === " " || ch === "	") {
        if (i < start + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start = i + 1;
          ch = text[start];
        }
      }
      return end;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start > limit)
            return true;
          start = i + 1;
          if (strLen - start <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start, i) + "\\ ";
          i += 1;
          start = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start, i);
                const code = json.substr(i + 2, 4);
                switch (code) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start ? str + json.slice(start) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start) {
        value = value.substring(start.length);
        start = start.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start, end } = flowChars;
      if (lines.length === 0) {
        return start + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add2 = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add2(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add2(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign2 = str[0];
      if (sign2 === "-" || sign2 === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign2 === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign2 === "-" ? -1 * n : n;
    }
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node) => intStringify(node, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign2 = str[0];
      const parts = sign2 === "-" || sign2 === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign2 === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
      let sign2 = "";
      if (value < 0) {
        sign2 = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign2 + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code, message) {
        super();
        this.name = name;
        this.code = code;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLParseError", pos, code, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message) {
        super("YAMLWarning", pos, code, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start = null;
      for (const token2 of tokens) {
        if (reqSpace) {
          if (token2.type !== "space" && token2.type !== "newline" && token2.type !== "comma")
            onError(token2.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token2.type !== "comment" && token2.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token2.type) {
          case "space":
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token2.source.includes("	")) {
              tab = token2;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token2, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token2.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token2.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token2.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token2;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token2, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token2.source.endsWith(":"))
              onError(token2.offset + token2.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token2;
            start ?? (start = token2.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token2, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token2;
            start ?? (start = token2.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token2, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token2.source} indicator`);
            if (found)
              onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${token2.source} in ${flow ?? "collection"}`);
            found = token2;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token2, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
              comma = token2;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${token2.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end,
        start: start ?? end
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start[start.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start, value } of bs.items) {
        const props = resolveProps.resolveProps(start, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token2 of end) {
          const { source, type } = token2;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token2, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
              hasSpace = true;
              break;
            default:
              onError(token2, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token2) => token2 && (token2.type === "block-map" || token2.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token2, onError, tagName, tag) {
      const coll = token2.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token2, onError, tag) : token2.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token2, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token2, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token2, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token2.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token2.type === "block-map" ? "map" : token2.type === "block-seq" ? "seq" : token2.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token2, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token2, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token2, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start, start, start] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token2 = props[i];
        switch (token2.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token2.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token2, "MISSING_CHAR", message);
            }
            length += token2.source.length;
            comment = token2.source.substring(1);
            break;
          case "error":
            onError(token2, "UNEXPECTED_TOKEN", token2.message);
            length += token2.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token2.type}`;
            onError(token2, "UNEXPECTED_TOKEN", message);
            const ts = token2.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return foldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return foldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function foldLines(source) {
      let first, line;
      try {
        first = new RegExp("(.*?)(?<![ 	])[ 	]*\r?\n", "sy");
        line = new RegExp("[ 	]*(.*?)(?:(?<![ 	])[ 	]*)?\r?\n", "sy");
      } catch {
        first = /(.*?)[ \t]*\r?\n/sy;
        line = /[ \t]*(.*?)[ \t]*\r?\n/sy;
      }
      let match = first.exec(source);
      if (!match)
        return source;
      let res = match[1];
      let sep2 = " ";
      let pos = first.lastIndex;
      line.lastIndex = pos;
      while (match = line.exec(source)) {
        if (match[1] === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + match[1];
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token2, tagToken, onError) {
      const { value, type, comment, range } = token2.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token2, onError) : resolveFlowScalar.resolveFlowScalar(token2, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token2.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token2, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token2, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token2, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token2, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token2, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node;
      let isSrcToken = true;
      switch (token2.type) {
        case "alias":
          node = composeAlias(ctx, token2, onError);
          if (anchor || tag)
            onError(token2, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token2, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token2, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token2, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token2.type === "error" ? token2.message : `Unsupported token (type: ${token2.type})`;
          onError(token2, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token2.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token2, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token2.type === "scalar" && token2.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token2;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token2 = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token2, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start, value, end }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start, {
        indicator: "doc-start",
        next: value ?? end?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token2 of tokens)
          yield* this.next(token2);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token2) {
        if (node_process.env.LOG_STREAM)
          console.dir(token2, { depth: null });
        switch (token2.type) {
          case "directive":
            this.directives.add(token2.source, (offset, message, warning) => {
              const pos = getErrorPos(token2);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token2.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token2, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token2, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token2.source);
            break;
          case "error": {
            const msg = token2.source ? `${token2.message}: ${JSON.stringify(token2.source)}` : token2.message;
            const error = new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end = resolveEnd.resolveEnd(token2.end, token2.offset + token2.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token2), "UNEXPECTED_TOKEN", `Unsupported token ${token2.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token2, strict = true, onError) {
      if (token2) {
        const _onError = (pos, code, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message);
        };
        switch (token2.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token2, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token2, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token2, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token2 ? token2.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
      if (!type)
        switch (token2.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token2.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token2, source);
          break;
        case '"':
          setFlowScalarValue(token2, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token2, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token2, source, "scalar");
      }
    }
    function setBlockScalarValue(token2, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body = source.substring(he + 1) + "\n";
      if (token2.type === "block-scalar") {
        const header = token2.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token2.source = body;
      } else {
        const { offset } = token2;
        const indent = "indent" in token2 ? token2.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token2 ? token2.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token2))
          if (key !== "type" && key !== "offset")
            delete token2[key];
        Object.assign(token2, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token2, source, type) {
      switch (token2.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token2.type = type;
          token2.source = source;
          break;
        case "block-scalar": {
          const end = token2.props.slice(1);
          let oa = source.length;
          if (token2.props[0].type === "block-scalar-header")
            oa -= token2.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token2.props;
          Object.assign(token2, { type, source, end });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token2.offset + source.length;
          const nl = { type: "newline", offset, indent: token2.indent, source: "\n" };
          delete token2.items;
          Object.assign(token2, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent = "indent" in token2 ? token2.indent : -1;
          const end = "end" in token2 && Array.isArray(token2.end) ? token2.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token2))
            if (key !== "type" && key !== "offset")
              delete token2[key];
          Object.assign(token2, { type, indent, source, end });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token2) {
      switch (token2.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token2.props)
            res += stringifyToken(tok);
          return res + token2.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token2.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token2.start.source;
          for (const item of token2.items)
            res += stringifyItem(item);
          for (const st of token2.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token2);
          if (token2.end)
            for (const st of token2.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token2.source;
          if ("end" in token2 && token2.end)
            for (const st of token2.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start, key, sep: sep2, value }) {
      let res = "";
      for (const st of start)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field2, index] of path) {
        const tok = item?.[field2];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field2 = path[path.length - 1][0];
      const coll = parent?.[field2];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field2 of ["key", "value"]) {
        const token2 = item[field2];
        if (token2 && "items" in token2) {
          for (let i = 0; i < token2.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field2, i]])), token2.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token2.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field2 === "key")
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token2) => !!token2 && "items" in token2;
    var isScalar = (token2) => !!token2 && (token2.type === "scalar" || token2.type === "single-quoted-scalar" || token2.type === "double-quoted-scalar" || token2.type === "block-scalar");
    function prettyToken(token2) {
      switch (token2) {
        case BOM:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token2);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start = this.lineStarts[low - 1];
          return { line: low, col: offset - start + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token2) {
      switch (token2?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token2 = error ?? this.stack.pop();
        if (!token2) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token2;
        } else {
          const top = this.peek(1);
          if (token2.type === "block-scalar") {
            token2.indent = "indent" in top ? top.indent : 0;
          } else if (token2.type === "flow-collection" && top.type === "document") {
            token2.indent = 0;
          }
          if (token2.type === "flow-collection")
            fixFlowSeqItems(token2);
          switch (top.type) {
            case "document":
              top.value = token2;
              break;
            case "block-scalar":
              top.props.push(token2);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token2, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token2;
              } else {
                Object.assign(it, { key: token2, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token2 });
              else
                it.value = token2;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token2, sep: [] });
              else if (it.sep)
                it.value = token2;
              else
                Object.assign(it, { key: token2, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token2);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token2.type === "block-map" || token2.type === "block-seq")) {
            const last = token2.items[token2.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token2.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token2.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token2.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start = getFirstKeyStartProps(prev);
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start, key: scalar, sep: sep2 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start.push(this.sourceToken);
                map.items.push({ start, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start2 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start2 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key, sep: sep2 }]
                  });
                } else if (start.length > 0) {
                  it.sep = it.sep.concat(start, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start, key: fc, sep: sep2 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            start.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
          return false;
        return start.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token2) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token2.end)
              token2.end.push(this.sourceToken);
            else
              token2.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// packages/rn-dev-agent-core/dist/nav-graph/storage.js
var import_yaml, STRIKE_COOLDOWN_MS;
var init_storage = __esm({
  "packages/rn-dev-agent-core/dist/nav-graph/storage.js"() {
    "use strict";
    import_yaml = __toESM(require_dist(), 1);
    STRIKE_COOLDOWN_MS = 5 * 60 * 1e3;
  }
});

// packages/rn-dev-agent-core/dist/util/trusted-system-executable.js
import { existsSync } from "node:fs";
import { win32 } from "node:path";
function trustedWindowsRoots(environment) {
  return [
    ...new Set([environment.SystemRoot, environment.SYSTEMROOT, environment.windir, environment.WINDIR].filter((root) => typeof root === "string" && /^[a-z]:\\/i.test(root) && win32.basename(win32.normalize(root)).toLowerCase() === "windows").map((root) => win32.normalize(root)).concat("C:\\Windows"))
  ];
}
function resolveTrustedSystemExecutable(executable, platform, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync;
  const environment = dependencies.environment ?? process.env;
  let candidates;
  if (platform === "win32" && executable === "powershell") {
    candidates = trustedWindowsRoots(environment).map((root) => win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  } else if (platform === "win32" && executable === "taskkill") {
    candidates = trustedWindowsRoots(environment).map((root) => win32.join(root, "System32", "taskkill.exe"));
  } else if (platform === "linux" && executable === "ss") {
    candidates = ["/usr/bin/ss", "/usr/sbin/ss", "/bin/ss", "/sbin/ss"];
  } else if (platform === "linux" && executable === "lsof") {
    candidates = ["/usr/bin/lsof", "/usr/sbin/lsof", "/bin/lsof", "/sbin/lsof"];
  } else if (platform === "linux" && executable === "ps") {
    candidates = ["/usr/bin/ps", "/bin/ps"];
  } else if (platform === "darwin" && executable === "lsof") {
    candidates = ["/usr/sbin/lsof"];
  } else if (platform === "darwin" && executable === "ps") {
    candidates = ["/bin/ps", "/usr/bin/ps"];
  } else {
    return null;
  }
  return candidates.find(exists) ?? null;
}
var init_trusted_system_executable = __esm({
  "packages/rn-dev-agent-core/dist/util/trusted-system-executable.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/cdp/metro-cwd.js
import { execFileSync as execFileSync2 } from "node:child_process";
import { readlinkSync as readlinkSync2, realpathSync as realpathSync2 } from "node:fs";
import { resolve, sep } from "node:path";
function parseLsofCwd(stdout) {
  for (const line of stdout.split("\n")) {
    if (line.startsWith("n")) {
      const path = line.slice(1).trim();
      if (path)
        return path;
    }
  }
  return null;
}
function parseWindowsMetroRoot(commandLine) {
  const explicitRoot = /(?:^|\s)--(?:projectRoot|project-root)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(commandLine);
  const explicit = explicitRoot?.[1] ?? explicitRoot?.[2] ?? explicitRoot?.[3];
  return explicit ?? null;
}
function cwdForProcess(pid, platform = process.platform, exec = defaultExec, readLink = readlinkSync2, executableDependencies = {}) {
  try {
    if (platform === "linux") {
      return realpathOrResolve(readLink(`/proc/${pid}/cwd`));
    }
    if (platform === "darwin") {
      const lsof = resolveTrustedSystemExecutable("lsof", platform, executableDependencies);
      if (!lsof)
        return null;
      const cwd = parseLsofCwd(exec(lsof, ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]));
      return cwd ? realpathOrResolve(cwd) : null;
    }
    if (platform === "win32") {
      const powershell = resolveTrustedSystemExecutable("powershell", platform, executableDependencies);
      if (!powershell)
        return null;
      const commandLine = exec(powershell, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}" -ErrorAction Stop).CommandLine`
      ]);
      const root = parseWindowsMetroRoot(commandLine);
      return root ? realpathOrResolve(root) : null;
    }
    return null;
  } catch {
    return null;
  }
}
function realpathOrResolve(p) {
  try {
    return realpathSync2(resolve(p));
  } catch {
    return resolve(p);
  }
}
function pathIsWithinRoot(candidate, root) {
  if (!candidate || !root)
    return false;
  const canonicalCandidate = realpathOrResolve(candidate);
  const canonicalRoot = realpathOrResolve(root);
  return canonicalCandidate === canonicalRoot || canonicalCandidate.startsWith(canonicalRoot + sep);
}
var CWD_LSOF_TIMEOUT_MS, defaultExec;
var init_metro_cwd = __esm({
  "packages/rn-dev-agent-core/dist/cdp/metro-cwd.js"() {
    "use strict";
    init_storage();
    init_trusted_system_executable();
    CWD_LSOF_TIMEOUT_MS = 800;
    defaultExec = (cmd, args) => execFileSync2(cmd, args, {
      timeout: CWD_LSOF_TIMEOUT_MS,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    });
  }
});

// packages/rn-dev-agent-core/dist/session/process-birth.js
import { execFileSync as execFileSync3 } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { closeSync, constants, existsSync as existsSync2, fstatSync, lstatSync as lstatSync2, openSync, readFileSync as readFileSync2, readSync, realpathSync as realpathSync3 } from "node:fs";
import { dirname, join as join2 } from "node:path";
import { fileURLToPath } from "node:url";
function defaultRun(command, args) {
  try {
    return execFileSync3(command, [...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
  } catch (error) {
    if (command === "/bin/ps" && typeof error === "object" && error !== null && "status" in error && error.status === 1) {
      return "";
    }
    throw error;
  }
}
function defaultRunVerifiedHelper(path, pid, requirement) {
  return execFileSync3("/bin/zsh", ["-f", "-c", VERIFIED_HELPER_SCRIPT, "rn-process-birth", path, String(pid), requirement], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 2e3
  });
}
function token(parts) {
  return createHash2("sha256").update(parts.join("\0")).digest("hex");
}
function darwinProcessBirthHelperPath() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join2(moduleDirectory, "native", "darwin-process-birth"),
    join2(moduleDirectory, "..", "native", "darwin-process-birth")
  ];
  for (const candidate of candidates) {
    if (existsSync2(candidate))
      return candidate;
  }
  return candidates[0];
}
function sameFile(before, after) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size && before.uid === after.uid;
}
function darwinProcessBirthRequirement() {
  return `(${DARWIN_HELPER_MANIFEST.cdhashes.map((cdhash) => `cdhash H"${cdhash}"`).join(" or ")})`;
}
function verifyDarwinProcessBirthHelper(dependencies) {
  const helper = (dependencies.helperPath ?? darwinProcessBirthHelperPath)();
  const manifestPath = `${helper}.json`;
  const canonicalize = dependencies.canonicalize ?? realpathSync3;
  const metadata = dependencies.lstat ?? lstatSync2;
  const descriptorMetadata = dependencies.fstat ?? fstatSync;
  const readBinary = dependencies.readBinary ?? ((path) => readFileSync2(path));
  const readDescriptor = dependencies.readDescriptor ?? ((fd2) => {
    const size = descriptorMetadata(fd2).size;
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd2, buffer, offset, size - offset, offset);
      if (bytesRead === 0)
        break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  });
  const open = dependencies.open ?? openSync;
  const close = dependencies.close ?? closeSync;
  const uid = dependencies.uid ?? process.getuid?.();
  if (canonicalize(helper) !== helper || canonicalize(manifestPath) !== manifestPath) {
    throw new Error("Darwin process-birth helper path is not canonical");
  }
  const helperBefore = metadata(helper);
  const manifestBefore = metadata(manifestPath);
  const trustedOwners = /* @__PURE__ */ new Set([0, ...uid === void 0 ? [] : [uid]]);
  if (!helperBefore.isFile() || !manifestBefore.isFile() || !trustedOwners.has(helperBefore.uid) || !trustedOwners.has(manifestBefore.uid) || (helperBefore.mode & 18) !== 0 || (manifestBefore.mode & 18) !== 0 || (helperBefore.mode & 73) === 0) {
    throw new Error("Darwin process-birth helper metadata is untrusted");
  }
  const manifestBytes = readBinary(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (Object.entries(DARWIN_HELPER_MANIFEST).some(([key, expected]) => JSON.stringify(manifest[key]) !== JSON.stringify(expected))) {
    throw new Error("Darwin process-birth helper provenance is invalid");
  }
  const fd = open(helper, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = descriptorMetadata(fd);
    if (!opened.isFile() || !sameFile(helperBefore, opened) || createHash2("sha256").update(readDescriptor(fd)).digest("hex") !== DARWIN_HELPER_MANIFEST.binarySha256 || !sameFile(manifestBefore, metadata(manifestPath))) {
      throw new Error("Darwin process-birth helper changed during verification");
    }
    return {
      path: helper,
      requirement: darwinProcessBirthRequirement()
    };
  } finally {
    close(fd);
  }
}
async function withVerifiedDarwinProcessBirthHelper(callback) {
  return callback(verifyDarwinProcessBirthHelper({}));
}
function readProcessBirth(pid, dependencies = {}) {
  const probe = probeProcessBirth(pid, dependencies);
  return probe.status === "present" ? probe.birth : null;
}
function probeProcessBirth(pid, dependencies = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0)
    return { status: "unknown" };
  const platform = dependencies.platform ?? process.platform;
  const read = dependencies.read ?? ((path) => readFileSync2(path, "utf8"));
  const run = dependencies.run ?? defaultRun;
  const runVerifiedHelper = dependencies.runVerifiedHelper ?? defaultRunVerifiedHelper;
  try {
    if (platform === "darwin") {
      const observedPid = run("/bin/ps", ["-p", String(pid), "-o", "pid="]).trim();
      if (observedPid.length === 0)
        return { status: "absent" };
      if (Number(observedPid) !== pid)
        return { status: "unknown" };
      const helper = verifyDarwinProcessBirthHelper(dependencies);
      const processInfo = runVerifiedHelper(helper.path, pid, helper.requirement).trim();
      const processMatch = /^(\d+):(\d+):(\d+)$/.exec(processInfo);
      if (!processMatch || Number(processMatch[1]) !== pid)
        return { status: "unknown" };
      const bootSession = run("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]).trim();
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(bootSession)) {
        return { status: "unknown" };
      }
      return {
        status: "present",
        birth: {
          pid,
          source: "darwin-libproc",
          token: token([platform, bootSession.toLowerCase(), processMatch[2], processMatch[3]])
        }
      };
    }
    if (platform === "linux") {
      const boot = read("/proc/sys/kernel/random/boot_id").trim();
      let stat;
      try {
        stat = read(`/proc/${pid}/stat`).trim();
      } catch (error) {
        return error.code === "ENOENT" ? { status: "absent" } : { status: "unknown" };
      }
      const commandEnd = stat.lastIndexOf(")");
      const fields = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/) : [];
      const started = fields[19];
      if (!boot || !started || !/^\d+$/.test(started))
        return { status: "unknown" };
      return {
        status: "present",
        birth: { pid, source: "linux-proc", token: token([platform, boot, started]) }
      };
    }
    if (platform === "win32") {
      const powershell = resolveTrustedSystemExecutable("powershell", platform, dependencies.executableDependencies);
      if (!powershell)
        return { status: "unknown" };
      const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -eq $p) { 'ABSENT' } else { $p.StartTime.ToUniversalTime().Ticks }`;
      const started = run(powershell, ["-NoProfile", "-NonInteractive", "-Command", script]).trim();
      if (started === "ABSENT")
        return { status: "absent" };
      if (!/^\d+$/.test(started))
        return { status: "unknown" };
      return {
        status: "present",
        birth: { pid, source: "windows-powershell", token: token([platform, started]) }
      };
    }
  } catch {
    return { status: "unknown" };
  }
  return { status: "unknown" };
}
var DARWIN_HELPER_MANIFEST, VERIFIED_HELPER_SCRIPT;
var init_process_birth = __esm({
  "packages/rn-dev-agent-core/dist/session/process-birth.js"() {
    "use strict";
    init_trusted_system_executable();
    DARWIN_HELPER_MANIFEST = {
      sourceSha256: "99a8025ab1c3cfbe32db184f6e030216d75c535143bd4684a2a89aac61c54c4a",
      recipeSha256: "4f40539bce137f7bcae4731fd1494fae5704cba5327177d7f2a2a47aec95afb3",
      stableBinarySha256: "6b5db7f7a6933f3d11d4c53ecafba9c3ef82c2533faf4bfe07a11b3cb4022dea",
      binarySha256: "fee005927e8d680b1589574211002d8809e3478446b97d3c9291157ea57b0dd5",
      cdhashes: [
        "1e67841d4d49a5e5088d283e26430130f017b989",
        "7f25b0eca55913e522781923a16c6b0cd98bb4fc"
      ]
    };
    VERIFIED_HELPER_SCRIPT = `
set -euo pipefail
helper_pid=
cleanup() {
  if [[ -n "$helper_pid" ]]; then
    /bin/kill -CONT "$helper_pid" 2>/dev/null || true
    /bin/kill -KILL "$helper_pid" 2>/dev/null || true
    wait "$helper_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT HUP INT TERM
coproc "$1" "$2" --hold
helper_pid=$!
IFS= read -r -p result
attempt=0
state=
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ "$state" == T* ]] && break
  [[ -z "$state" || "$state" == Z* ]] && exit 1
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ "$state" == T* ]]
/usr/bin/codesign --verify --strict "-R=$3" "$1" >/dev/null 2>&1
/usr/bin/codesign --verify --strict "+$helper_pid" >/dev/null 2>&1
live_cdhash=$(
  /usr/bin/codesign --display --verbose=4 "+$helper_pid" 2>&1 |
    /usr/bin/awk -F= '/^CDHash=/{print tolower($2); exit}'
)
[[ "$live_cdhash" != *[^0-9a-f]* ]]
[[ "\${#live_cdhash}" == 40 ]]
expected_cdhash="H\\"\${live_cdhash}\\""
[[ "$3" == *"$expected_cdhash"* ]]
/bin/kill -CONT "$helper_pid"
attempt=0
while (( attempt < 100 )); do
  state=$(/bin/ps -p "$helper_pid" -o state= 2>/dev/null || true)
  [[ -z "$state" || "$state" == Z* ]] && break
  /bin/sleep 0.01
  (( attempt += 1 ))
done
[[ -z "$state" || "$state" == Z* ]]
wait "$helper_pid" 2>/dev/null || true
helper_pid=
trap - EXIT HUP INT TERM
print -r -- "$result"
`;
  }
});

// packages/rn-dev-agent-core/dist/session/metro-binding.js
import { execFileSync as execFileSync4 } from "node:child_process";
function resolveMetroListenerExecutable(platform, dependencies = {}) {
  const executable = platform === "win32" ? "powershell" : platform === "linux" ? "ss" : platform === "darwin" ? "lsof" : null;
  return executable ? resolveTrustedSystemExecutable(executable, platform, dependencies) : null;
}
function numericListener(output, emptyStatus) {
  const value = String(output).trim();
  if (!value)
    return { status: emptyStatus };
  const candidates = value.split(/\s+/);
  if (candidates.some((candidate) => !/^\d+$/.test(candidate))) {
    return { status: "unknown" };
  }
  const pids = new Set(candidates.map(Number));
  const [pid] = pids;
  return pids.size === 1 && Number.isSafeInteger(pid) && pid > 0 ? { status: "listening", pid } : { status: "unknown" };
}
function probeMetroListener(port, platform = process.platform, execute = execFileSync4, executableDependencies = {}) {
  const executable = resolveMetroListenerExecutable(platform, executableDependencies);
  if (!executable)
    return { status: "unknown" };
  try {
    if (platform === "win32") {
      const output = execute(executable, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$connections = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object LocalPort -eq ${port}); if ($connections.Count -eq 0) { 'ABSENT' } else { $connections.OwningProcess | Sort-Object -Unique }`
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2e3 });
      return String(output).trim() === "ABSENT" ? { status: "absent" } : numericListener(output, "unknown");
    }
    if (platform === "linux") {
      const output = execute(executable, ["-H", "-ltnp", `sport = :${port}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2e3
      });
      const value = String(output).trim();
      if (!value)
        return { status: "absent" };
      const pids = new Set([...value.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1])));
      const [pid] = pids;
      return pids.size === 1 && Number.isSafeInteger(pid) && pid > 0 ? { status: "listening", pid } : { status: "unknown" };
    }
    if (platform === "darwin") {
      const output = execute(executable, ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 2e3
      });
      return numericListener(output, "unknown");
    }
    return { status: "unknown" };
  } catch (error) {
    const failure = error;
    return platform === "darwin" && failure.status === 1 && !String(failure.stdout ?? "").trim() && !String(failure.stderr ?? "").trim() ? { status: "absent" } : { status: "unknown" };
  }
}
function metroListenerPid(port, platform = process.platform, execute = execFileSync4, executableDependencies = {}) {
  const probe = probeMetroListener(port, platform, execute, executableDependencies);
  return probe.status === "listening" ? probe.pid : null;
}
async function fetchMetroStatus(port) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2e3);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, {
      signal: controller.signal
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}
async function captureMetroBinding(input, dependencies = {}) {
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535 || !Number.isSafeInteger(input.pid) || input.pid < 1 || !input.instanceId || !Number.isSafeInteger(input.buildGeneration) || input.buildGeneration < 1) {
    throw new Error("METRO_AUTHORITY_MISMATCH: Metro binding is incomplete");
  }
  const listenerPid = (dependencies.listenerPid ?? metroListenerPid)(input.port);
  if (listenerPid !== input.pid) {
    throw new Error("METRO_AUTHORITY_MISMATCH: Metro process does not own the claimed listener");
  }
  const birth = (dependencies.readBirth ?? readProcessBirth)(input.pid);
  if (!birth) {
    throw new Error("PROCESS_BIRTH_UNAVAILABLE: Metro process birth could not be proven conservatively");
  }
  const status = await (dependencies.fetchStatus ?? fetchMetroStatus)(input.port);
  if (!status.includes("packager-status:running")) {
    throw new Error("METRO_AUTHORITY_MISMATCH: claimed Metro endpoint is not running");
  }
  const servingRoot = dependencies.servingRoot ? dependencies.servingRoot(input.port) : cwdForProcess(input.pid);
  if (!servingRoot || !pathIsWithinRoot(servingRoot, input.sourceRoot)) {
    throw new Error("METRO_AUTHORITY_MISMATCH: Metro serving root does not match the source worktree");
  }
  return {
    port: input.port,
    pid: input.pid,
    birth: birth.token,
    instanceId: input.instanceId,
    servingRoot,
    buildGeneration: input.buildGeneration
  };
}
var init_metro_binding = __esm({
  "packages/rn-dev-agent-core/dist/session/metro-binding.js"() {
    "use strict";
    init_metro_cwd();
    init_trusted_system_executable();
    init_process_birth();
    init_trusted_system_executable();
  }
});

// packages/rn-dev-agent-core/dist/session/authority-store.js
import { chmodSync, lstatSync as lstatSync3, mkdirSync as mkdirSync3, statSync as statSync3 } from "node:fs";
import { createRequire } from "node:module";
import { dirname as dirname4 } from "node:path";
function loadAuthoritySqlite() {
  try {
    const sqlite = require2("node:sqlite");
    return sqlite.DatabaseSync ?? null;
  } catch {
    return null;
  }
}
function assertPrivateDirectory(path) {
  mkdirSync3(path, { mode: 448, recursive: true });
  const link = lstatSync3(path);
  if (link.isSymbolicLink() || !link.isDirectory()) {
    throw new Error("authority state root must be a real directory");
  }
  const stat = statSync3(path);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("authority state root is not owned by the current user");
  }
  chmodSync(path, 448);
}
function secureDatabaseFiles(path) {
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      const link = lstatSync3(candidate);
      if (link.isSymbolicLink() || !link.isFile()) {
        throw new Error("authority database path is not a regular file");
      }
      const stat = statSync3(candidate);
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        throw new Error("authority database is not owned by the current user");
      }
      chmodSync(candidate, 384);
    } catch (error) {
      const code = error.code;
      if (code !== "ENOENT")
        throw error;
    }
  }
}
function runInitialization(operation) {
  runWithBusyRetry(operation, INITIALIZATION_TIMEOUT_MS);
}
function runWithBusyRetry(operation, timeoutMs = DATABASE_OPERATION_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    try {
      return operation();
    } catch (error) {
      const code = error.code;
      const message = error instanceof Error ? error.message : "";
      if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(message))
        throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw error;
      Atomics.wait(INITIALIZATION_WAIT, 0, 0, Math.min(25, remaining));
    }
  }
}
function retryingDatabase(database) {
  return {
    close: () => database.close(),
    exec: (sql) => runWithBusyRetry(() => database.exec(sql)),
    prepare: (sql) => {
      const statement = database.prepare(sql);
      return {
        get: (...params) => runWithBusyRetry(() => statement.get(...params)),
        run: (...params) => runWithBusyRetry(() => statement.run(...params)),
        all: (...params) => runWithBusyRetry(() => statement.all(...params))
      };
    }
  };
}
function openAuthorityStore(path, options = {}) {
  const ctor = options.sqliteCtor === void 0 ? loadAuthoritySqlite() : options.sqliteCtor;
  if (!ctor) {
    throw new AuthorityStoreUnavailableError("node:sqlite could not be loaded by this Node runtime");
  }
  let database = null;
  try {
    assertPrivateDirectory(dirname4(path));
    try {
      const existing = lstatSync3(path);
      if (existing.isSymbolicLink() || !existing.isFile()) {
        throw new Error("authority database path is not a regular file");
      }
    } catch (error) {
      if (error.code !== "ENOENT")
        throw error;
    }
    const rawDatabase = new ctor(path);
    const openedDatabase = retryingDatabase(rawDatabase);
    database = openedDatabase;
    secureDatabaseFiles(path);
    runInitialization(() => openedDatabase.exec(`
        PRAGMA busy_timeout=50;
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS authority_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO authority_meta(key, value)
        VALUES ('schema_version', '1')
        ON CONFLICT(key) DO NOTHING;
      `));
    secureDatabaseFiles(path);
    return {
      database: openedDatabase,
      secureFiles: () => secureDatabaseFiles(path),
      close: () => {
        let failure;
        try {
          secureDatabaseFiles(path);
        } catch (error) {
          failure = error;
        }
        try {
          openedDatabase.close();
        } catch (error) {
          failure ??= error;
        }
        try {
          secureDatabaseFiles(path);
        } catch (error) {
          failure ??= error;
        }
        if (failure)
          throw failure;
      }
    };
  } catch (cause) {
    try {
      database?.close();
    } catch {
    }
    throw new AuthorityStoreUnavailableError("authority registry could not be opened", { cause });
  }
}
var require2, INITIALIZATION_WAIT, INITIALIZATION_TIMEOUT_MS, DATABASE_OPERATION_TIMEOUT_MS, AuthorityStoreUnavailableError;
var init_authority_store = __esm({
  "packages/rn-dev-agent-core/dist/session/authority-store.js"() {
    "use strict";
    require2 = createRequire(import.meta.url);
    INITIALIZATION_WAIT = new Int32Array(new SharedArrayBuffer(4));
    INITIALIZATION_TIMEOUT_MS = 1e3;
    DATABASE_OPERATION_TIMEOUT_MS = 1e3;
    AuthorityStoreUnavailableError = class extends Error {
      code = "AUTHORITY_STORE_UNAVAILABLE";
      constructor(reason, options) {
        super(reason, options);
        this.name = "AuthorityStoreUnavailableError";
      }
    };
  }
});

// packages/rn-dev-agent-core/dist/session/registry.js
import { createHash as createHash5, randomBytes, timingSafeEqual as timingSafeEqual4 } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
function referencesMetroEvidenceSocket(value, path) {
  if (Array.isArray(value)) {
    return value.some((entry) => referencesMetroEvidenceSocket(entry, path));
  }
  if (!value || typeof value !== "object")
    return false;
  const record = value;
  if (record.runtimeEvidenceSocket === path)
    return true;
  return Object.values(record).some((entry) => referencesMetroEvidenceSocket(entry, path));
}
function asSession(row) {
  return row ? row : null;
}
function asClaim(row) {
  return row ? row : null;
}
function claimConflict(claim) {
  const code = conflictCodes[claim.resource_type] ?? "RESOURCE_CLAIM_CONFLICT";
  return new SessionAuthorityError(code, `${claim.resource_type}:${claim.resource_key} is held`, {
    sessionId: claim.session_id,
    claimEpoch: claim.claim_epoch
  });
}
function isOperationalState(state) {
  return (/* @__PURE__ */ new Set([
    "active",
    "source_bound",
    "metro_bound",
    "device_claimed",
    "device_bound",
    "runtime_bound",
    "ready"
  ])).has(state);
}
function isFenceableState(state) {
  return isOperationalState(state) || state === "handoff";
}
function bindingsRunnerPresent(bindingsJson) {
  const bindings = JSON.parse(bindingsJson);
  return Boolean(bindings.runner && typeof bindings.runner === "object");
}
function managedMetroHandoffReservation(bindings) {
  const value = bindings.managedMetroHandoffReservation;
  if (value === null || value === void 0)
    return null;
  if (typeof value !== "object" || typeof value.handoffId !== "string" || typeof value.sourceClaimEpoch !== "number" || typeof value.targetSessionId !== "string" || typeof value.targetClaimEpoch !== "number" || typeof value.targetInstance !== "string" || !["shutdown_reserved", "shutdown_completed"].includes(String(value.phase)) || typeof value.metro !== "object" || value.metro === null || typeof value.metro.sourceSessionId !== "string") {
    throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff reservation is malformed");
  }
  return value;
}
function openSessionRegistry(path, dependencies) {
  const store = openAuthorityStore(path, { sqliteCtor: dependencies.sqliteCtor });
  try {
    return new SessionRegistry(store.database, store.close, store.secureFiles, dependencies);
  } catch (error) {
    store.close();
    throw error;
  }
}
var INITIALIZATION_WAIT2, AUTHORITY_REGISTRY_SCHEMA_VERSION, SessionAuthorityError, conflictCodes, SessionRegistry;
var init_registry = __esm({
  "packages/rn-dev-agent-core/dist/session/registry.js"() {
    "use strict";
    init_authority_store();
    init_metro_binding();
    INITIALIZATION_WAIT2 = new Int32Array(new SharedArrayBuffer(4));
    AUTHORITY_REGISTRY_SCHEMA_VERSION = 4;
    SessionAuthorityError = class extends Error {
      code;
      holder;
      details;
      constructor(code, message, holder, details) {
        super(`${code}: ${message}`);
        this.name = "SessionAuthorityError";
        this.code = code;
        this.holder = holder;
        this.details = details;
      }
    };
    conflictCodes = {
      device: "DEVICE_CLAIM_CONFLICT",
      "device-receipt": "DEVICE_CLAIM_CONFLICT",
      target: "TARGET_CLAIM_CONFLICT",
      "metro-port": "METRO_PORT_CLAIM_CONFLICT",
      "observe-port": "OBSERVE_PORT_CLAIM_CONFLICT",
      runner: "RUNNER_CLAIM_CONFLICT",
      "runner-receipt": "RUNNER_CLAIM_CONFLICT"
    };
    SessionRegistry = class {
      #database;
      #close;
      #secureFiles;
      #now;
      #ownerStatus;
      #listenerStatus;
      #leaseMs;
      #operationContext = new AsyncLocalStorage();
      #pendingPlatformReceipts = /* @__PURE__ */ new Map();
      constructor(database, close, secureFiles, dependencies) {
        this.#database = database;
        this.#close = close;
        this.#secureFiles = secureFiles;
        this.#now = dependencies.now ?? Date.now;
        this.#ownerStatus = dependencies.ownerStatus;
        this.#listenerStatus = dependencies.listenerStatus ?? ((port) => probeMetroListener(port).status);
        this.#leaseMs = dependencies.leaseMs ?? 3e4;
        this.#initializeWithRetry();
      }
      close() {
        this.#close();
      }
      runWithOperation(operation, callback) {
        return this.#operationContext.run(operation, callback);
      }
      createSession(input) {
        const now = this.#now();
        this.#database.prepare(`INSERT INTO sessions(
          session_id, source_key, worktree_key, app_root_key, state,
          claim_epoch, authority_version, supervisor_pid, supervisor_birth,
          worker_instance, worker_pid, worker_birth, heartbeat_ms, lease_until_ms,
          source_json, bindings_json, created_ms, updated_ms
        ) VALUES (?, ?, ?, ?, 'active', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.sessionId, input.sourceKey, input.worktreeKey, input.appRootKey, input.supervisor.pid, input.supervisor.token, input.worker?.instanceId ?? null, input.worker?.pid ?? null, input.worker?.token ?? null, now, now + this.#leaseMs, JSON.stringify(input.source ?? {}), JSON.stringify(input.bindings ?? {}), now, now);
        this.#secureFiles();
        return { sessionId: input.sessionId, claimEpoch: 1 };
      }
      claimResources(session, resources) {
        const unique = new Map(resources.map((resource) => [`${resource.type}\0${resource.key}`, resource]));
        if (unique.size !== resources.length) {
          throw new SessionAuthorityError("DUPLICATE_RESOURCE_CLAIM", "claim set contains duplicates");
        }
        const probes = this.#probeClaimOwners(session, resources);
        const now = this.#now();
        return this.#transaction(() => {
          const owner = this.#requireSession(session);
          for (const resource of resources) {
            const claim = this.#findConflictingClaim(resource);
            if (!claim || claim.session_id === session.sessionId && claim.claim_epoch === session.claimEpoch) {
              continue;
            }
            const probe = probes.get(claim.session_id);
            if (!probe || probe.claimEpoch !== claim.claim_epoch) {
              throw claimConflict(claim);
            }
            if (probe.status === "match")
              throw claimConflict(claim);
            if (probe.status === "unknown") {
              if (claim.lease_until_ms < now) {
                throw new SessionAuthorityError("STALE_LEASE_NOT_RECLAIMABLE", "expired lease owner identity could not be proven", { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
              }
              throw claimConflict(claim);
            }
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "a proven-stale owner requires explicit adopt_stale before claims transfer", { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
          }
          const leaseUntil = now + this.#leaseMs;
          for (const resource of resources) {
            this.#database.prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`).run(resource.type, resource.key, session.sessionId, session.claimEpoch, leaseUntil);
          }
          this.#database.prepare(`UPDATE sessions
           SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, owner.session_id, owner.claim_epoch);
          this.#advanceActiveOperationFence(session, owner.authority_version, owner.authority_version + 1);
          return session;
        });
      }
      releaseResources(session, resources) {
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session);
          for (const resource of resources) {
            if (resource.type === "runner" || resource.type === "device") {
              const rows = this.#database.prepare(`SELECT platform, receipt_json FROM platform_authority_receipts
               WHERE session_id = ? AND claim_epoch = ?`).all(session.sessionId, session.claimEpoch);
              for (const row of rows) {
                const persisted = JSON.parse(row.receipt_json);
                const receipt = persisted.receipt && typeof persisted.receipt === "object" ? persisted.receipt : persisted;
                if (resource.type === "runner" && receipt.runnerClaim === resource.key || resource.type === "device" && receipt.deviceClaim === resource.key) {
                  this.#invalidatePlatformReceipt(session, row.platform);
                }
              }
            }
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(resource.type, resource.key, session.sessionId, session.claimEpoch);
          }
          this.#database.prepare(`UPDATE sessions SET authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session.sessionId, session.claimEpoch);
          this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
      }
      async claimResourcesWithRetry(session, resources, options = {}) {
        return this.#retry(() => this.claimResources(session, resources), options.timeoutMs ?? 1e3, options.retryDelayMs ?? 5);
      }
      renewSession(session) {
        const now = this.#now();
        this.#transaction(() => {
          this.#requireSession(session);
          const leaseUntil = now + this.#leaseMs;
          this.#database.prepare(`UPDATE sessions
           SET heartbeat_ms = ?, lease_until_ms = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, leaseUntil, now, session.sessionId, session.claimEpoch);
          this.#database.prepare(`UPDATE claims SET lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(leaseUntil, session.sessionId, session.claimEpoch);
        });
      }
      async renewSessionWithRetry(session, options = {}) {
        return this.#retry(() => this.renewSession(session), options.timeoutMs ?? 1e3, options.retryDelayMs ?? 5);
      }
      bindWorker(session, worker) {
        const now = this.#now();
        this.#transaction(() => {
          this.#requireSession(session);
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(worker.instanceId, worker.pid, worker.token, now, session.sessionId, session.claimEpoch);
        });
      }
      bindRecoveryWorker(session, worker, capability) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireRecoverableSession(session);
          const bindings = JSON.parse(row.bindings_json);
          const expected = Buffer.from(String(bindings.recoveryCapabilityHash ?? ""), "hex");
          const actual = createHash5("sha256").update(capability).digest();
          if (expected.length !== actual.length || !timingSafeEqual4(expected, actual)) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "blocked recovery capability is invalid");
          }
          const pendingHandoffs = this.#database.prepare(`SELECT handoff.handoff_id, handoff.claim_epoch, handoff.target_instance,
                  donor.session_id, donor.claim_epoch AS donor_claim_epoch,
                  donor.bindings_json
           FROM handoffs handoff
           JOIN sessions donor ON donor.session_id = handoff.session_id
           WHERE handoff.consumed_ms IS NULL
             AND donor.state = 'handoff'
             AND donor.source_key = ?
             AND donor.worktree_key = ?
             AND donor.app_root_key = ?`).all(row.source_key, row.worktree_key, row.app_root_key);
          const adoptionRequired = bindings.adoptionRequired;
          const rotations = pendingHandoffs.flatMap((handoff) => {
            const donorBindings = JSON.parse(handoff.bindings_json);
            const reservation = managedMetroHandoffReservation(donorBindings);
            if (!reservation)
              return [];
            if (reservation.handoffId !== handoff.handoff_id || reservation.sourceClaimEpoch !== handoff.claim_epoch || reservation.sourceClaimEpoch !== handoff.donor_claim_epoch || reservation.metro.sourceSessionId !== handoff.session_id) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff reservation no longer matches the recovery worker fence");
            }
            if (reservation.targetSessionId !== session.sessionId || reservation.targetClaimEpoch !== session.claimEpoch) {
              return [];
            }
            if (reservation.targetInstance !== row.worker_instance || handoff.target_instance !== row.worker_instance) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff reservation no longer matches the recovery worker fence");
            }
            return [{ handoff, donorBindings, reservation }];
          });
          if (rotations.length > 1) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "multiple managed Metro handoffs target the same recovery session");
          }
          const rotation = rotations[0];
          if (rotation) {
            const rotatedReservation = {
              ...rotation.reservation,
              targetSessionId: session.sessionId,
              targetClaimEpoch: session.claimEpoch,
              targetInstance: worker.instanceId
            };
            const handoffChanged = this.#database.prepare(`UPDATE handoffs SET target_instance = ?
             WHERE handoff_id = ? AND target_instance = ? AND consumed_ms IS NULL`).run(worker.instanceId, rotation.handoff.handoff_id, rotation.reservation.targetInstance);
            if (handoffChanged.changes !== 1) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff target changed during recovery worker rotation");
            }
            const donorChanged = this.#database.prepare(`UPDATE sessions
             SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify({
              ...rotation.donorBindings,
              managedMetroHandoffReservation: rotatedReservation
            }), now, rotation.handoff.session_id, rotation.handoff.donor_claim_epoch);
            if (donorChanged.changes !== 1) {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro donor authority changed during recovery worker rotation");
            }
          }
          const expiresMs = now + 5 * 6e4;
          const recoveryHandles = {
            handoffRecipient: {
              token: randomBytes(32).toString("base64url"),
              expiresMs,
              workerInstance: worker.instanceId
            },
            ...typeof adoptionRequired?.sessionId === "string" ? {
              adoptStale: {
                token: randomBytes(32).toString("base64url"),
                expiresMs,
                priorSessionId: adoptionRequired.sessionId,
                priorClaimEpoch: adoptionRequired.claimEpoch
              }
            } : {}
          };
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET worker_instance = ?, worker_pid = ?, worker_birth = ?,
               bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?
             AND state IN ('blocked', 'handoff_cleanup')`).run(worker.instanceId, worker.pid, worker.token, JSON.stringify({ ...bindings, recoveryHandles }), now, session.sessionId, session.claimEpoch);
        });
      }
      replaceDeviceAuthority(session, input) {
        const resource = input.resource ?? {
          type: "device",
          key: `${String(input.device.platform)}:${String(input.device.deviceId)}`
        };
        const probes = this.#probeClaimOwners(session, [resource]);
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session);
          const claim = this.#findConflictingClaim(resource);
          if (claim && (claim.session_id !== session.sessionId || claim.claim_epoch !== session.claimEpoch)) {
            const probe = probes.get(claim.session_id);
            if (!probe || probe.claimEpoch !== claim.claim_epoch || probe.status !== "mismatch") {
              throw claimConflict(claim);
            }
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "a proven-stale device owner requires explicit adopt_stale before rebinding", { sessionId: claim.session_id, claimEpoch: claim.claim_epoch });
          }
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type IN ('device', 'target', 'runner')`).run(session.sessionId, session.claimEpoch);
          this.#database.prepare(`INSERT INTO claims(
            resource_type, resource_key, session_id, claim_epoch, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?)`).run(resource.type, resource.key, session.sessionId, session.claimEpoch, now + this.#leaseMs);
          const bindings = {
            ...JSON.parse(current.bindings_json),
            device: input.device,
            install: input.install ?? null,
            bundle: null,
            runner: null,
            observe: null,
            proof: null,
            pendingBuild: null
          };
          this.#invalidatePlatformReceipt(session, String(input.device.platform));
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(input.install ? "device_bound" : "device_claimed", JSON.stringify(bindings), now, session.sessionId, session.claimEpoch);
          this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
      }
      updateBindings(session, input) {
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session);
          if (input.expectedAuthorityVersion !== void 0 && current.authority_version !== input.expectedAuthorityVersion) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "session authority version changed before binding commit");
          }
          const bindings = {
            ...JSON.parse(current.bindings_json),
            ...input.bindings
          };
          for (const resource of input.claimResources ?? []) {
            const claim = this.#findConflictingClaim(resource);
            if (claim && (claim.session_id !== session.sessionId || claim.claim_epoch !== session.claimEpoch)) {
              throw claimConflict(claim);
            }
          }
          if (Object.hasOwn(input.bindings, "device") || Object.hasOwn(input.bindings, "install")) {
            const currentBindings = JSON.parse(current.bindings_json);
            const platform = String((input.bindings.device ?? currentBindings.device)?.platform ?? "");
            if (platform) {
              this.#invalidatePlatformReceipt(session, platform);
            }
          }
          for (const resource of input.releaseResources ?? []) {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(resource.type, resource.key, session.sessionId, session.claimEpoch);
          }
          const leaseUntil = now + this.#leaseMs;
          for (const resource of input.claimResources ?? []) {
            this.#database.prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`).run(resource.type, resource.key, session.sessionId, session.claimEpoch, leaseUntil);
          }
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(input.state ?? current.state, JSON.stringify(bindings), now, session.sessionId, session.claimEpoch);
          this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
      }
      replaceBindingsDuringOperation(operation, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const current = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`).get(operation.sessionId));
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          if (!current || !isOperationalState(current.state) || current.claim_epoch !== operation.claimEpoch || current.authority_version !== operation.authorityVersion || !active) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
          }
          for (const resource of input.claimResources ?? []) {
            const claim = this.#findConflictingClaim(resource);
            if (claim && (claim.session_id !== operation.sessionId || claim.claim_epoch !== operation.claimEpoch)) {
              throw claimConflict(claim);
            }
          }
          for (const resource of input.releaseResources ?? []) {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = ? AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(resource.type, resource.key, operation.sessionId, operation.claimEpoch);
          }
          const leaseUntil = now + this.#leaseMs;
          for (const resource of input.claimResources ?? []) {
            this.#database.prepare(`INSERT INTO claims(
              resource_type, resource_key, session_id, claim_epoch, lease_until_ms
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(resource_type, resource_key) DO UPDATE SET
              session_id = excluded.session_id,
              claim_epoch = excluded.claim_epoch,
              lease_until_ms = excluded.lease_until_ms`).run(resource.type, resource.key, operation.sessionId, operation.claimEpoch, leaseUntil);
          }
          const nextAuthorityVersion = operation.authorityVersion + 1;
          const bindings = {
            ...JSON.parse(current.bindings_json),
            ...input.bindings
          };
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`).run(input.state ?? current.state, JSON.stringify(bindings), nextAuthorityVersion, now, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          this.#database.prepare(`UPDATE operations SET authority_version = ?, lease_until_ms = ?
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(nextAuthorityVersion, leaseUntil, operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          const context = this.#operationContext.getStore();
          if (context?.operationId === operation.operationId) {
            context.authorityVersion = nextAuthorityVersion;
          }
          return { ...operation, authorityVersion: nextAuthorityVersion };
        });
      }
      endOperationWithBindings(operation, bindings) {
        const now = this.#now();
        this.#transaction(() => {
          const current = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`).get(operation.sessionId));
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          if (!current || !isOperationalState(current.state) || current.claim_epoch !== operation.claimEpoch || current.authority_version !== operation.authorityVersion || !active) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
          }
          const nextBindings = {
            ...JSON.parse(current.bindings_json),
            ...bindings
          };
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND authority_version = ?`).run(JSON.stringify(nextBindings), now, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          this.#database.prepare(`DELETE FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      getSessionStatus(sessionId) {
        const row = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                  claim_epoch, authority_version, supervisor_pid, supervisor_birth,
                  worker_instance, worker_pid, worker_birth, lease_until_ms,
                  source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(sessionId));
        if (!row)
          return null;
        const claims = this.#database.prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
         FROM claims WHERE session_id = ? AND claim_epoch = ?
         ORDER BY resource_type, resource_key`).all(sessionId, row.claim_epoch).map((claim) => {
          const typed = claim;
          return {
            type: typed.resource_type,
            key: typed.resource_key,
            sessionId: typed.session_id,
            claimEpoch: typed.claim_epoch,
            leaseUntilMs: typed.lease_until_ms
          };
        });
        return {
          sessionId: row.session_id,
          sourceKey: row.source_key,
          worktreeKey: row.worktree_key,
          appRootKey: row.app_root_key,
          state: row.state,
          claimEpoch: row.claim_epoch,
          authorityVersion: row.authority_version,
          leaseUntilMs: row.lease_until_ms,
          source: JSON.parse(row.source_json),
          bindings: JSON.parse(row.bindings_json),
          claims,
          worker: {
            instanceId: row.worker_instance,
            pid: row.worker_pid,
            birthAvailable: row.worker_birth !== null
          }
        };
      }
      countOtherOperationalSessions(sessionId) {
        const rows = this.#database.prepare(`SELECT state FROM sessions
         WHERE session_id <> ?`).all(sessionId);
        return rows.filter((row) => typeof row.state === "string" && isOperationalState(row.state)).length;
      }
      isMetroEvidenceSocketReferencedByOtherSession(sessionId, path) {
        const rows = this.#database.prepare(`SELECT bindings_json FROM sessions
         WHERE session_id <> ? AND state <> 'released'`).all(sessionId);
        return rows.some((row) => {
          try {
            return referencesMetroEvidenceSocket(JSON.parse(String(row.bindings_json)), path);
          } catch {
            return true;
          }
        });
      }
      findSessionsByWorktree(worktreeKey) {
        const rows = this.#database.prepare(`SELECT session_id FROM sessions
         WHERE worktree_key = ? AND state NOT IN ('released', 'stale')
         ORDER BY updated_ms DESC`).all(worktreeKey);
        return rows.map((row) => this.getSessionStatus(String(row.session_id))).filter((status) => status !== null);
      }
      getControllerBinding(session) {
        const row = this.#requireSession(session);
        return this.#controllerBinding(row);
      }
      getHandoffCancellationControllerBinding(session) {
        const row = this.#requireHandoffSession(session);
        return this.#controllerBinding(row);
      }
      #controllerBinding(row) {
        return {
          sessionId: row.session_id,
          claimEpoch: row.claim_epoch,
          authorityVersion: row.authority_version,
          supervisor: { pid: row.supervisor_pid, token: row.supervisor_birth },
          worker: {
            instanceId: row.worker_instance,
            pid: row.worker_pid,
            token: row.worker_birth
          }
        };
      }
      beginSessionClose(session) {
        const now = this.#now();
        const operationIds = this.#transaction(() => {
          const current = this.#requireSession(session);
          const active = this.#database.prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session.sessionId, session.claimEpoch);
          const bindings = JSON.parse(current.bindings_json);
          this.#requireIntegrationRestored(bindings);
          const metro = bindings.metroCleanup ?? bindings.metro;
          if (active?.profile === "transition:ensure-metro" && metro?.mode !== "managed") {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "managed Metro transition has not published exact cleanup authority");
          }
          const rows = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ?`).all(session.sessionId, session.claimEpoch);
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'closing', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session.sessionId, session.claimEpoch);
          return rows.map((row) => String(row.operation_id));
        });
        for (const operationId of operationIds) {
          this.#pendingPlatformReceipts.delete(operationId);
        }
        const status = this.getSessionStatus(session.sessionId);
        if (!status || status.state !== "closing") {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session close reservation did not persist");
        }
        return status;
      }
      completeSessionClose(session) {
        const now = this.#now();
        this.#transaction(() => {
          const row = asSession(this.#database.prepare("SELECT state, claim_epoch, bindings_json FROM sessions WHERE session_id = ?").get(session.sessionId));
          if (!row || row.state !== "closing" || row.claim_epoch !== session.claimEpoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "only the unchanged closing session may be released");
          }
          this.#requireIntegrationRestored(JSON.parse(String(row.bindings_json)));
          this.#database.prepare("DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'closing'`).run(now, session.sessionId, session.claimEpoch);
        });
      }
      releaseSession(session) {
        const now = this.#now();
        this.#transaction(() => {
          const current = this.#requireSession(session);
          this.#requireIntegrationRestored(JSON.parse(current.bindings_json));
          const active = this.#database.prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session.sessionId, session.claimEpoch);
          if (active && !String(active.profile).startsWith("transition:")) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "session cannot be released while an operation is active");
          }
          if (active) {
            const context = this.#operationContext.getStore();
            if (!context || context.operationId !== active.operation_id || context.sessionId !== session.sessionId || context.claimEpoch !== session.claimEpoch) {
              throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "session release is not owned by the active operation fence");
            }
            this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          }
          this.#database.prepare("DELETE FROM claims WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session.sessionId, session.claimEpoch);
        });
      }
      discardBlockedSession(session) {
        const now = this.#now();
        this.#transaction(() => {
          const row = asSession(this.#database.prepare("SELECT state, claim_epoch FROM sessions WHERE session_id = ?").get(session.sessionId));
          if (!row || row.state !== "blocked" || row.claim_epoch !== session.claimEpoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "only the unchanged blocked session may be discarded");
          }
          const claim = this.#database.prepare("SELECT resource_key FROM claims WHERE session_id = ? LIMIT 1").get(session.sessionId);
          if (claim) {
            throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "blocked session unexpectedly owns resource claims");
          }
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session.sessionId, session.claimEpoch);
        });
      }
      prepareHandoff(session, input) {
        const now = this.#now();
        const handoffId = randomBytes(16).toString("hex");
        const token2 = randomBytes(32).toString("base64url");
        const tokenHash = createHash5("sha256").update(token2).digest("hex");
        this.#transaction(() => {
          const current = this.#requireSession(session);
          let targetInstance = input.targetInstance;
          if (input.targetHandle) {
            const targets = this.#database.prepare(`SELECT session_id, bindings_json FROM sessions
             WHERE state = 'blocked' AND source_key = ? AND worktree_key = ? AND app_root_key = ?`).all(current.source_key, current.worktree_key, current.app_root_key);
            for (const target of targets) {
              const bindings = JSON.parse(target.bindings_json);
              const handles = bindings.recoveryHandles;
              const handle = handles?.handoffRecipient;
              if (typeof handle?.token === "string" && typeof handle.expiresMs === "number" && handle.expiresMs >= now && this.#capabilityMatches(handle.token, input.targetHandle)) {
                targetInstance = typeof handle.workerInstance === "string" ? handle.workerInstance : void 0;
                this.#database.prepare("UPDATE sessions SET bindings_json = ? WHERE session_id = ?").run(JSON.stringify({
                  ...bindings,
                  recoveryHandles: { ...handles, handoffRecipient: null }
                }), target.session_id);
                break;
              }
            }
          }
          if (!targetInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "handoff recipient capability is invalid or expired");
          }
          const active = this.#database.prepare(`SELECT operation_id, profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session.sessionId, session.claimEpoch);
          if (active && !String(active.profile).startsWith("transition:")) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "session cannot enter handoff while an operation is active");
          }
          this.#database.prepare(`INSERT INTO handoffs(
            handoff_id, session_id, claim_epoch, target_instance,
            token_hash, source_state, expires_ms, consumed_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`).run(handoffId, session.sessionId, session.claimEpoch, targetInstance, tokenHash, this.#requireSession(session).state, now + (input.ttlMs ?? 15e3));
          this.#database.prepare(`UPDATE sessions
           SET state = 'handoff', authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, session.sessionId, session.claimEpoch);
          this.#advanceActiveOperationFence(session, current.authority_version, current.authority_version + 1);
        });
        return { handoffId, token: token2 };
      }
      prepareHandoffForHandle(session, input) {
        return this.prepareHandoff(session, input);
      }
      cancelHandoff(session, handoffId) {
        const now = this.#now();
        this.#transaction(() => {
          const handoff = this.#database.prepare(`SELECT session_id, claim_epoch, source_state, consumed_ms
           FROM handoffs WHERE handoff_id = ?`).get(handoffId);
          if (!handoff || handoff.session_id !== session.sessionId || handoff.claim_epoch !== session.claimEpoch) {
            throw new SessionAuthorityError("HANDOFF_NOT_FOUND", "handoff does not belong to session");
          }
          if (handoff.consumed_ms !== null) {
            throw new SessionAuthorityError("HANDOFF_ALREADY_CONSUMED", "handoff is already terminal");
          }
          const row = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version, bindings_json
             FROM sessions WHERE session_id = ?`).get(session.sessionId));
          if (!row || row.state !== "handoff" || row.claim_epoch !== session.claimEpoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "handoff source owner changed");
          }
          const bindings = JSON.parse(row.bindings_json);
          if (bindings.managedMetroHandoffReservation) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cancellation is fenced while managed Metro shutdown is reserved");
          }
          this.#database.prepare(`UPDATE sessions
           SET state = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(handoff.source_state, now, session.sessionId, session.claimEpoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, handoffId);
          this.#advanceActiveOperationFence(session, row.authority_version, row.authority_version + 1);
        });
      }
      getHandoffOwner(handoffId) {
        const row = this.#database.prepare("SELECT session_id FROM handoffs WHERE handoff_id = ?").get(handoffId);
        return typeof row?.session_id === "string" ? row.session_id : null;
      }
      reserveManagedMetroHandoffCleanup(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, true);
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`).get(context.prior.session_id, target.sessionId);
          if (active) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "handoff cleanup cannot be reserved while either session has an active operation");
          }
          const managedMetro = context.bindings.metro && typeof context.bindings.metro === "object" && context.bindings.metro.mode === "managed" ? context.bindings.metro : null;
          if (!managedMetro)
            return null;
          if (context.reservation)
            return context.reservation;
          const reservation = {
            handoffId: context.handoff.handoff_id,
            sourceClaimEpoch: context.handoff.claim_epoch,
            targetSessionId: target.sessionId,
            targetClaimEpoch: target.claimEpoch,
            targetInstance: input.targetInstance,
            phase: "shutdown_reserved",
            metro: {
              ...managedMetro,
              sourceSessionId: context.prior.session_id,
              stopRequestedAt: now,
              completedAt: null
            }
          };
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: reservation
          }), now, context.prior.session_id, context.prior.claim_epoch);
          return reservation;
        });
      }
      completeManagedMetroHandoffCleanup(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, true);
          const reservation = context.reservation;
          if (!reservation) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro shutdown has no durable handoff reservation");
          }
          if (reservation.phase === "shutdown_completed")
            return reservation;
          const completed = {
            ...reservation,
            phase: "shutdown_completed",
            metro: { ...reservation.metro, completedAt: now }
          };
          this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: completed
          }), now, context.prior.session_id, context.prior.claim_epoch);
          return completed;
        });
      }
      refuseManagedMetroHandoffCleanup(target, input) {
        const now = this.#now();
        this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, true);
          const reservation = context.reservation;
          if (!reservation || reservation.phase !== "shutdown_reserved") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro shutdown refusal does not match an active reservation");
          }
          const sourceState2 = this.#database.prepare("SELECT source_state FROM handoffs WHERE handoff_id = ?").get(input.handoffId);
          if (typeof sourceState2?.source_state !== "string") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff source state is unavailable for donor restoration");
          }
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(sourceState2.source_state, JSON.stringify({
            ...context.bindings,
            managedMetroHandoffReservation: null
          }), now, context.prior.session_id, context.prior.claim_epoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, input.handoffId);
        });
      }
      validateHandoffInto(target, input) {
        this.#transaction(() => {
          this.#requireHandoffIntoContext(target, input, false);
        });
      }
      acceptHandoff(input) {
        const now = this.#now();
        return this.#transaction(() => {
          const handoff = this.#database.prepare(`SELECT handoff_id, session_id, claim_epoch, target_instance,
                  token_hash, expires_ms, consumed_ms
           FROM handoffs WHERE handoff_id = ?`).get(input.handoffId);
          if (!handoff) {
            throw new SessionAuthorityError("HANDOFF_NOT_FOUND", "handoff does not exist");
          }
          if (handoff.consumed_ms !== null) {
            throw new SessionAuthorityError("HANDOFF_ALREADY_CONSUMED", "handoff was already accepted");
          }
          if (handoff.expires_ms < now) {
            throw new SessionAuthorityError("HANDOFF_EXPIRED", "handoff capability expired");
          }
          if (handoff.target_instance !== input.targetInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "handoff target instance does not match");
          }
          const expected = Buffer.from(handoff.token_hash, "hex");
          const actual = Buffer.from(createHash5("sha256").update(input.token).digest("hex"), "hex");
          if (expected.length !== actual.length || !timingSafeEqual4(expected, actual)) {
            throw new SessionAuthorityError("HANDOFF_TOKEN_INVALID", "handoff capability is invalid");
          }
          const session = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                    supervisor_pid, supervisor_birth, lease_until_ms, bindings_json
             FROM sessions WHERE session_id = ?`).get(handoff.session_id));
          if (!session || session.state !== "handoff" || session.claim_epoch !== handoff.claim_epoch) {
            throw new SessionAuthorityError("SESSION_OWNER_LOST", "handoff no longer matches the session claim epoch");
          }
          const sessionBindings = JSON.parse(session.bindings_json);
          if (sessionBindings.metro && typeof sessionBindings.metro === "object" && sessionBindings.metro.mode === "managed") {
            throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "managed Metro handoff requires durable cleanup through a blocked recipient");
          }
          const nextEpoch = session.claim_epoch + 1;
          const leaseUntil = now + this.#leaseMs;
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'recorder')`).run(session.session_id, session.claim_epoch);
          this.#database.prepare(`UPDATE claims SET claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(nextEpoch, leaseUntil, session.session_id, session.claim_epoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'source_bound', claim_epoch = ?, authority_version = authority_version + 1,
               supervisor_pid = ?, supervisor_birth = ?, heartbeat_ms = ?,
               lease_until_ms = ?, bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(nextEpoch, input.supervisor.pid, input.supervisor.token, now, leaseUntil, JSON.stringify({
            ...sessionBindings,
            bundle: null,
            runner: null,
            observe: null,
            proof: null,
            pendingBuild: null
          }), now, session.session_id, session.claim_epoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, handoff.handoff_id);
          return { sessionId: session.session_id, claimEpoch: nextEpoch };
        });
      }
      acceptHandoffInto(target, input) {
        const now = this.#now();
        return this.#transaction(() => {
          const context = this.#requireHandoffIntoContext(target, input, true);
          const { targetRow, handoff, prior, bindings } = context;
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ?
              OR (session_id = ? AND profile NOT LIKE 'transition:%')
           LIMIT 1`).get(prior.session_id, target.sessionId);
          if (active) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "handoff cannot transfer while either session has an active operation");
          }
          const priorRunnerClaim = this.#database.prepare(`SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`).get(prior.session_id, prior.claim_epoch);
          if (bindingsRunnerPresent(prior.bindings_json) && !priorRunnerClaim?.resource_key) {
            throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "handoff runner binding has no exclusive cleanup claim");
          }
          const managedMetro = bindings.metro && typeof bindings.metro === "object" && bindings.metro.mode === "managed" ? bindings.metro : null;
          if (managedMetro && (!context.reservation || context.reservation.phase !== "shutdown_completed" || typeof context.reservation.metro.completedAt !== "number")) {
            throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "managed Metro shutdown reservation must be durably completed before ownership transfers");
          }
          const priorRecorderClaim = this.#database.prepare(`SELECT resource_key FROM claims
           WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'recorder'`).get(prior.session_id, prior.claim_epoch);
          if (bindings.recorder && !priorRecorderClaim?.resource_key) {
            throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "handoff recorder binding has no exclusive cleanup claim");
          }
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch);
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner', 'recorder')`).run(prior.session_id, prior.claim_epoch);
          this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
          const targetBindings = JSON.parse(targetRow.bindings_json);
          this.#database.prepare(`UPDATE sessions
           SET state = 'handoff_cleanup', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(JSON.stringify({
            ...bindings,
            managedMetroHandoffReservation: null,
            metro: managedMetro ? null : bindings.metro,
            bundle: null,
            runner: null,
            recorder: null,
            observe: null,
            proof: null,
            pendingBuild: null,
            recoveryCapabilityHash: targetBindings.recoveryCapabilityHash,
            handoffCleanup: {
              metro: null,
              observe: bindings.observe && typeof bindings.observe === "object" ? {
                ...bindings.observe,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              runner: bindings.runner && typeof bindings.runner === "object" ? {
                ...bindings.runner,
                claimKey: priorRunnerClaim?.resource_key,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              recorder: bindings.recorder && typeof bindings.recorder === "object" ? {
                ...bindings.recorder,
                claimKey: priorRecorderClaim?.resource_key,
                stopRequestedAt: null,
                completedAt: null
              } : null
            }
          }), now, target.sessionId, target.claimEpoch);
          this.#database.prepare(`UPDATE sessions
           SET state = 'released', claim_epoch = claim_epoch + 1,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(now, prior.session_id, prior.claim_epoch);
          this.#database.prepare("UPDATE handoffs SET consumed_ms = ? WHERE handoff_id = ?").run(now, handoff.handoff_id);
          return {
            ...this.getSessionStatus(target.sessionId)?.bindings.handoffCleanup
          };
        });
      }
      beginHandoffCleanupResource(target, targetInstance, resource) {
        const now = this.#now();
        return this.#transaction(() => {
          const row = this.#requireHandoffCleanupOwner(target, targetInstance);
          const bindings = JSON.parse(row.bindings_json);
          const cleanup = bindings.handoffCleanup;
          const current = cleanup?.[resource];
          if (!current || typeof current !== "object")
            return null;
          const binding = current;
          if (typeof binding.completedAt === "number")
            return binding;
          if (resource === "runner") {
            const claimKey = String(binding.claimKey ?? "");
            const expectedClaimKey = `${String(binding.platform)}:${String(binding.deviceId)}:${String(binding.port)}`;
            const claim = this.#findClaim("runner", claimKey);
            if (!claimKey || claimKey !== expectedClaimKey || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch || typeof binding.capability !== "string" || typeof binding.instanceId !== "string") {
              throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "handoff runner cleanup claim no longer matches the authenticated binding");
            }
          }
          if (resource === "recorder") {
            const claimKey = String(binding.claimKey ?? "");
            const expectedClaimKey = `${String(binding.platform)}:${String(binding.deviceId)}`;
            const claim = this.#findClaim("recorder", claimKey);
            if (!claimKey || claimKey !== expectedClaimKey || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch || typeof binding.scope !== "string" || binding.phase !== "starting" && typeof binding.processBirth !== "string") {
              throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "handoff recorder cleanup claim no longer matches the authenticated binding");
            }
          }
          if (resource === "metro") {
            const claim = this.#findClaim("metro-port", String(binding.port));
            if (binding.port !== bindings.metroPort || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch) {
              throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "handoff Metro cleanup claim no longer matches the authenticated binding");
            }
          }
          if (resource === "observe") {
            const claim = this.#findClaim("observe-port", String(binding.port));
            if (binding.port !== bindings.observePort || claim?.session_id !== target.sessionId || claim.claim_epoch !== target.claimEpoch) {
              throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "handoff Observe cleanup claim no longer matches the authenticated binding");
            }
          }
          const requested = {
            ...binding,
            stopRequestedAt: typeof binding.stopRequestedAt === "number" ? binding.stopRequestedAt : now
          };
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`).run(JSON.stringify({
            ...bindings,
            handoffCleanup: { ...cleanup, [resource]: requested }
          }), now, target.sessionId, target.claimEpoch);
          return requested;
        });
      }
      completeHandoffCleanupResource(target, targetInstance, resource) {
        const now = this.#now();
        this.#transaction(() => {
          const row = this.#requireHandoffCleanupOwner(target, targetInstance);
          const bindings = JSON.parse(row.bindings_json);
          const cleanup = bindings.handoffCleanup;
          const current = cleanup?.[resource];
          if (!current || typeof current !== "object")
            return;
          const binding = current;
          if (typeof binding.stopRequestedAt !== "number") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", `${resource} cleanup was not durably requested`);
          }
          if (typeof binding.completedAt === "number")
            return;
          if (resource === "runner") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'runner' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(String(binding.claimKey), target.sessionId, target.claimEpoch);
          }
          if (resource === "recorder") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'recorder' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(String(binding.claimKey), target.sessionId, target.claimEpoch);
          }
          this.#database.prepare(`UPDATE sessions SET bindings_json = ?, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`).run(JSON.stringify({
            ...bindings,
            handoffCleanup: {
              ...cleanup,
              [resource]: { ...binding, completedAt: now }
            }
          }), now, target.sessionId, target.claimEpoch);
        });
      }
      finishHandoffCleanup(target, targetInstance) {
        const now = this.#now();
        this.#transaction(() => {
          const row = asSession(this.#database.prepare(`SELECT state, claim_epoch, worker_instance, bindings_json
             FROM sessions WHERE session_id = ?`).get(target.sessionId));
          if (!row || row.state !== "handoff_cleanup" || row.claim_epoch !== target.claimEpoch || row.worker_instance !== targetInstance) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cleanup is not owned by this recovery worker");
          }
          const bindings = JSON.parse(row.bindings_json);
          const cleanup = bindings.handoffCleanup;
          for (const resource of ["metro", "runner", "observe", "recorder"]) {
            const binding = cleanup?.[resource];
            if (binding && typeof binding === "object" && typeof binding.completedAt !== "number") {
              throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", `${resource} cleanup has not been durably completed`);
            }
          }
          this.#database.prepare(`UPDATE sessions
           SET state = 'source_bound', bindings_json = ?,
               authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff_cleanup'`).run(JSON.stringify({
            ...bindings,
            handoffCleanup: null,
            recoveryHandles: null
          }), now, target.sessionId, target.claimEpoch);
        });
      }
      recordPlatformAuthorityReceipt(session, platform, receipt) {
        const operation = this.#operationContext.getStore();
        if (!operation || operation.sessionId !== session.sessionId || operation.claimEpoch !== session.claimEpoch) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "platform receipt recording requires the active operation fence");
        }
        this.verifyOperation(operation);
        const staged = this.#platformReceiptFromCurrentAuthority(session, platform, receipt);
        const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
        pending.push(staged);
        this.#pendingPlatformReceipts.set(operation.operationId, pending);
      }
      commitPlatformAuthorityReceipts(operation) {
        const pending = this.#pendingPlatformReceipts.get(operation.operationId) ?? [];
        if (pending.length === 0)
          return;
        const now = this.#now();
        this.#transaction(() => {
          this.verifyOperation(operation);
          for (const staged of pending) {
            const current = this.#platformReceiptFromCurrentAuthority(staged.session, staged.platform, staged.receipt);
            this.#invalidatePlatformReceipt(staged.session, staged.platform);
            this.#database.prepare(`INSERT INTO platform_authority_receipts(
               session_id, claim_epoch, platform, receipt_json, updated_ms
             ) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(session_id, platform) DO UPDATE SET
               claim_epoch = excluded.claim_epoch,
               receipt_json = excluded.receipt_json,
               updated_ms = excluded.updated_ms`).run(staged.session.sessionId, staged.session.claimEpoch, staged.platform, JSON.stringify({ receipt: staged.receipt, probe: current.probe }), now);
          }
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      validatePlatformAuthorityReceipt(session, platform, receipt) {
        const row = this.#database.prepare(`SELECT claim_epoch, receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND platform = ?`).get(session.sessionId, platform);
        const persisted = typeof row?.receipt_json === "string" ? JSON.parse(row.receipt_json) : null;
        const persistedReceipt = persisted?.receipt && typeof persisted.receipt === "object" ? persisted.receipt : persisted;
        return row?.claim_epoch === session.claimEpoch && JSON.stringify(persistedReceipt) === JSON.stringify(receipt);
      }
      getPlatformAuthorityProbe(session, platform, receipt) {
        if (!this.validatePlatformAuthorityReceipt(session, platform, receipt))
          return null;
        const row = this.#database.prepare(`SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`).get(session.sessionId, session.claimEpoch, platform);
        if (typeof row?.receipt_json !== "string")
          return null;
        const persisted = JSON.parse(row.receipt_json);
        const probe = persisted.probe;
        if (!probe || createHash5("sha256").update(probe.capability).digest("hex") !== receipt.runnerCapabilityHash) {
          return null;
        }
        return probe;
      }
      adoptStaleIntoBlocked(target, priorSessionId, targetInstance) {
        const priorStatus = this.getSessionStatus(priorSessionId);
        if (!priorStatus) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "stale session is unavailable");
        }
        const owner = asSession(this.#database.prepare(`SELECT supervisor_pid, supervisor_birth FROM sessions WHERE session_id = ?`).get(priorSessionId));
        if (!owner || this.#ownerStatus({
          sessionId: priorSessionId,
          pid: owner.supervisor_pid,
          token: owner.supervisor_birth
        }) !== "mismatch") {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "prior source owner is not proven stale");
        }
        const now = this.#now();
        this.#transaction(() => {
          const targetRow = this.#requireRecoverableSession(target);
          if (targetRow.state !== "blocked") {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale adoption is not available during handoff cleanup");
          }
          if (targetRow.worker_instance !== targetInstance) {
            throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "stale adoption target is not the recovery worker");
          }
          const prior = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                    claim_epoch, bindings_json
             FROM sessions WHERE session_id = ?`).get(priorSessionId));
          if (!prior || prior.claim_epoch !== priorStatus.claimEpoch || prior.source_key !== targetRow.source_key || prior.worktree_key !== targetRow.worktree_key || prior.app_root_key !== targetRow.app_root_key) {
            throw new SessionAuthorityError("SOURCE_WORKTREE_MISMATCH", "stale session does not belong to this exact source worktree");
          }
          const priorBindings = JSON.parse(prior.bindings_json);
          const targetBindings = JSON.parse(targetRow.bindings_json);
          const priorCleanup = priorBindings.handoffCleanup && typeof priorBindings.handoffCleanup === "object" ? priorBindings.handoffCleanup : null;
          const resumesCleanup = prior.state === "handoff_cleanup" && priorCleanup !== null;
          if (prior.state === "handoff_cleanup" && !resumesCleanup) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale handoff cleanup state has no durable cleanup plan");
          }
          if (resumesCleanup) {
            const resumesMetroCleanup = priorCleanup.metro !== null && typeof priorCleanup.metro === "object";
            this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
             WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
            this.#database.prepare(`UPDATE sessions
             SET state = 'handoff_cleanup', bindings_json = ?,
                 authority_version = authority_version + 1, updated_ms = ?
             WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`).run(JSON.stringify({
              ...targetBindings,
              adoptionRequired: null,
              recoveryHandles: targetBindings.recoveryHandles,
              metro: resumesMetroCleanup ? null : priorBindings.metro ?? null,
              metroCleanup: resumesMetroCleanup ? null : priorBindings.metroCleanup ?? null,
              device: priorBindings.device ?? null,
              install: priorBindings.install ?? null,
              packageIntegration: priorBindings.packageIntegration ?? null,
              bundle: null,
              runner: null,
              recorder: null,
              observe: null,
              proof: null,
              handoffCleanup: priorCleanup
            }), now, target.sessionId, target.claimEpoch);
            this.#fenceSession(prior.session_id, now);
            return;
          }
          const activeOperation = this.#database.prepare(`SELECT profile FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(prior.session_id, prior.claim_epoch);
          const priorMetro = priorBindings.metro && typeof priorBindings.metro === "object" ? priorBindings.metro : null;
          const metroCleanup = priorBindings.metroCleanup && typeof priorBindings.metroCleanup === "object" ? priorBindings.metroCleanup : priorMetro?.mode === "managed" ? priorMetro : null;
          const runnerCleanup = priorBindings.runner && typeof priorBindings.runner === "object" ? priorBindings.runner : null;
          const observeCleanup = priorBindings.observe && typeof priorBindings.observe === "object" ? priorBindings.observe : null;
          const recorderCleanup = priorBindings.recorder && typeof priorBindings.recorder === "object" ? priorBindings.recorder : null;
          if (activeOperation?.profile === "transition:ensure-metro" && !metroCleanup && !priorBindings.metro) {
            throw new SessionAuthorityError("SESSION_OPERATION_ACTIVE", "stale Metro transition has not published exact cleanup authority");
          }
          let runnerClaimKey = null;
          if (runnerCleanup) {
            runnerClaimKey = `${String(runnerCleanup.platform)}:${String(runnerCleanup.deviceId)}:${String(runnerCleanup.port)}`;
            const runnerClaim = this.#findClaim("runner", runnerClaimKey);
            if (runnerClaim?.session_id !== prior.session_id || runnerClaim.claim_epoch !== prior.claim_epoch) {
              throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "stale runner cleanup claim no longer matches the authenticated binding");
            }
          }
          let recorderClaimKey = null;
          if (recorderCleanup) {
            recorderClaimKey = `${String(recorderCleanup.platform)}:${String(recorderCleanup.deviceId)}`;
            const recorderClaim = this.#findClaim("recorder", recorderClaimKey);
            if (recorderClaim?.session_id !== prior.session_id || recorderClaim.claim_epoch !== prior.claim_epoch) {
              throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "stale recorder cleanup claim no longer matches the authenticated binding");
            }
          }
          if (observeCleanup) {
            const observePort = String(observeCleanup.port);
            const observeClaim = this.#findClaim("observe-port", observePort);
            if (priorBindings.observePort !== observeCleanup.port || observeClaim?.session_id !== prior.session_id || observeClaim.claim_epoch !== prior.claim_epoch) {
              throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "stale Observe cleanup claim no longer matches the authenticated binding");
            }
          }
          this.#database.prepare(`DELETE FROM claims
           WHERE session_id = ? AND claim_epoch = ?
             AND resource_type NOT IN ('source', 'metro-port', 'observe-port', 'device', 'runner', 'recorder')`).run(prior.session_id, prior.claim_epoch);
          this.#database.prepare(`UPDATE claims SET session_id = ?, claim_epoch = ?, lease_until_ms = ?
           WHERE session_id = ? AND claim_epoch = ?`).run(target.sessionId, target.claimEpoch, now + this.#leaseMs, prior.session_id, prior.claim_epoch);
          const cleanupRequired = Boolean(metroCleanup || runnerCleanup || observeCleanup || recorderCleanup);
          const sameMetro = Number(priorMetro?.port) === Number(targetBindings.metroPort);
          this.#database.prepare(`UPDATE sessions
           SET state = ?, bindings_json = ?, authority_version = authority_version + 1,
               updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'blocked'`).run(cleanupRequired ? "handoff_cleanup" : sameMetro && priorBindings.device ? "device_bound" : "source_bound", JSON.stringify({
            ...targetBindings,
            adoptionRequired: null,
            recoveryHandles: cleanupRequired ? targetBindings.recoveryHandles : null,
            metro: metroCleanup ? null : sameMetro ? priorBindings.metro : null,
            metroCleanup: null,
            device: priorBindings.device ?? null,
            install: priorBindings.install ?? null,
            packageIntegration: priorBindings.packageIntegration ?? null,
            bundle: null,
            runner: null,
            recorder: null,
            observe: null,
            proof: null,
            handoffCleanup: cleanupRequired ? {
              metro: metroCleanup ? {
                ...metroCleanup,
                sourceSessionId: prior.session_id,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              runner: runnerCleanup ? {
                ...runnerCleanup,
                claimKey: runnerClaimKey,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              recorder: recorderCleanup ? {
                ...recorderCleanup,
                claimKey: recorderClaimKey,
                stopRequestedAt: null,
                completedAt: null
              } : null,
              observe: observeCleanup ? {
                ...observeCleanup,
                stopRequestedAt: null,
                completedAt: null
              } : null
            } : null
          }), now, target.sessionId, target.claimEpoch);
          this.#fenceSession(prior.session_id, now);
        });
      }
      adoptStaleWithHandle(target, handle, targetInstance) {
        const targetStatus = this.getSessionStatus(target.sessionId);
        const recovery = targetStatus?.bindings.recoveryHandles;
        const adoption = recovery?.adoptStale;
        if (targetStatus?.state !== "blocked" || typeof adoption?.token !== "string" || typeof adoption.expiresMs !== "number" || adoption.expiresMs < this.#now() || typeof adoption.priorSessionId !== "string" || !this.#capabilityMatches(adoption.token, handle)) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "stale adoption capability is invalid or expired");
        }
        const prior = this.getSessionStatus(adoption.priorSessionId);
        if (prior?.claimEpoch !== adoption.priorClaimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "stale adoption capability no longer matches the prior claim epoch");
        }
        this.adoptStaleIntoBlocked(target, adoption.priorSessionId, targetInstance);
      }
      beginOperation(session, operation) {
        return this.#beginOperation(session, operation, false);
      }
      beginHandoffCancellationOperation(session, operation) {
        return this.#beginOperation(session, operation, true);
      }
      #beginOperation(session, operation, handoffCancellation) {
        const now = this.#now();
        return this.#transaction(() => {
          const owner = handoffCancellation ? this.#requireHandoffSession(session) : this.#requireSession(session);
          if (handoffCancellation && JSON.parse(owner.bindings_json).managedMetroHandoffReservation) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cancellation is fenced while managed Metro shutdown is reserved");
          }
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session.sessionId, session.claimEpoch);
          if (active) {
            throw new SessionAuthorityError("OPERATION_ALREADY_IN_PROGRESS", "session already has an active fenced operation");
          }
          this.#database.prepare(`INSERT INTO operations(
            operation_id, session_id, claim_epoch, authority_version,
            tool, profile, started_ms, lease_until_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(operation.operationId, session.sessionId, session.claimEpoch, owner.authority_version, operation.tool, operation.profile, now, now + this.#leaseMs);
          return {
            operationId: operation.operationId,
            sessionId: session.sessionId,
            claimEpoch: session.claimEpoch,
            authorityVersion: owner.authority_version
          };
        });
      }
      refreshOperation(operation) {
        this.verifyOperation(operation);
        return operation;
      }
      endOperation(operation) {
        this.#transaction(() => {
          const session = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version
             FROM sessions WHERE session_id = ?`).get(operation.sessionId));
          const active = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
          if (!session || !isFenceableState(session.state) || session.claim_epoch !== operation.claimEpoch || session.authority_version !== operation.authorityVersion || !active) {
            throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
          }
          this.#database.prepare("DELETE FROM operations WHERE operation_id = ?").run(operation.operationId);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      cancelOperation(operation) {
        this.#transaction(() => {
          this.#database.prepare(`DELETE FROM operations
           WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
             AND authority_version = ?`).run(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        });
        this.#pendingPlatformReceipts.delete(operation.operationId);
      }
      cancelActiveOperationForSession(session) {
        const operationIds = this.#transaction(() => {
          this.#requireSession(session);
          const rows = this.#database.prepare(`SELECT operation_id FROM operations
           WHERE session_id = ? AND claim_epoch = ?`).all(session.sessionId, session.claimEpoch);
          this.#database.prepare("DELETE FROM operations WHERE session_id = ? AND claim_epoch = ?").run(session.sessionId, session.claimEpoch);
          return rows.map((row) => String(row.operation_id));
        });
        for (const operationId of operationIds) {
          this.#pendingPlatformReceipts.delete(operationId);
        }
      }
      verifyOperation(operation) {
        const session = asSession(this.#database.prepare(`SELECT state, claim_epoch, authority_version
           FROM sessions WHERE session_id = ?`).get(operation.sessionId));
        const active = this.#database.prepare(`SELECT operation_id FROM operations
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`).get(operation.operationId, operation.sessionId, operation.claimEpoch, operation.authorityVersion);
        if (!session || !isFenceableState(session.state) || session.claim_epoch !== operation.claimEpoch || session.authority_version !== operation.authorityVersion || !active) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence no longer matches current authority");
        }
      }
      renewOperation(operation) {
        const now = this.#now();
        this.#transaction(() => {
          this.verifyOperation(operation);
          this.#database.prepare("UPDATE operations SET lease_until_ms = ? WHERE operation_id = ?").run(now + this.#leaseMs, operation.operationId);
        });
      }
      getClaim(type, key) {
        const claim = this.#findClaim(type, key);
        return claim ? {
          type: claim.resource_type,
          key: claim.resource_key,
          sessionId: claim.session_id,
          claimEpoch: claim.claim_epoch,
          leaseUntilMs: claim.lease_until_ms
        } : null;
      }
      allocatePort(input) {
        if (!Number.isSafeInteger(input.base) || input.base < 1 || !Number.isSafeInteger(input.span) || input.span < 1 || input.base + input.span > 65536) {
          throw new SessionAuthorityError("INVALID_PORT_RANGE", "port allocation range is invalid");
        }
        return this.#transaction(() => {
          const existing = this.#database.prepare("SELECT port FROM allocations WHERE service = ? AND worktree_key = ?").get(input.service, input.worktreeKey);
          if (existing) {
            const claim = this.#findClaim(`${input.service}-port`, String(existing.port));
            const listenerStatus = claim ? "absent" : this.#listenerStatus(existing.port);
            if (listenerStatus === "absent")
              return existing.port;
            if (listenerStatus === "unknown") {
              throw new SessionAuthorityError("PORT_LISTENER_PROBE_UNAVAILABLE", `listener ownership for ${input.service} port ${existing.port} is unavailable`);
            }
            this.#database.prepare("DELETE FROM allocations WHERE service = ? AND worktree_key = ?").run(input.service, input.worktreeKey);
          }
          const digest3 = createHash5("sha256").update(`${input.uid}\0${input.worktreeKey}\0${input.service}`).digest();
          const preferred = digest3.readUInt32BE(0) % input.span;
          for (let offset = 0; offset < input.span; offset += 1) {
            const port = input.base + (preferred + offset) % input.span;
            const occupied = this.#database.prepare("SELECT worktree_key FROM allocations WHERE service = ? AND port = ?").get(input.service, port);
            if (occupied)
              continue;
            const listenerStatus = this.#listenerStatus(port);
            if (listenerStatus === "listening")
              continue;
            if (listenerStatus === "unknown") {
              throw new SessionAuthorityError("PORT_LISTENER_PROBE_UNAVAILABLE", `listener ownership for ${input.service} port ${port} is unavailable`);
            }
            this.#database.prepare(`INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`).run(input.service, input.worktreeKey, port);
            return port;
          }
          const orphanRows = this.#database.prepare(`SELECT allocation.worktree_key, allocation.port
           FROM allocations allocation
           WHERE allocation.service = ?
             AND allocation.port >= ?
             AND allocation.port < ?
             AND NOT EXISTS (
               SELECT 1 FROM sessions session
               WHERE session.worktree_key = allocation.worktree_key
                 AND session.state NOT IN ('released', 'stale')
             )
           ORDER BY allocation.generation ASC, allocation.worktree_key ASC
           `).all(input.service, input.base, input.base + input.span);
          for (const row of orphanRows) {
            if (!Number.isSafeInteger(row.port) || typeof row.worktree_key !== "string") {
              throw new SessionAuthorityError("AUTHORITY_STORE_INVALID", "persisted port allocation is malformed");
            }
            const orphan = { port: row.port, worktree_key: row.worktree_key };
            const listenerStatus = this.#listenerStatus(orphan.port);
            if (listenerStatus === "listening")
              continue;
            if (listenerStatus === "unknown") {
              throw new SessionAuthorityError("PORT_LISTENER_PROBE_UNAVAILABLE", `listener ownership for ${input.service} port ${orphan.port} is unavailable`);
            }
            this.#database.prepare(`DELETE FROM allocations
             WHERE service = ? AND worktree_key = ? AND port = ?`).run(input.service, orphan.worktree_key, orphan.port);
            this.#database.prepare(`INSERT INTO allocations(service, worktree_key, port, generation)
             VALUES (?, ?, ?, 1)`).run(input.service, input.worktreeKey, orphan.port);
            return orphan.port;
          }
          throw new SessionAuthorityError("PORT_RANGE_EXHAUSTED", `no ${input.service} port is available in the configured range`);
        });
      }
      #initialize() {
        const schema = this.#database.prepare("SELECT value FROM authority_meta WHERE key = ?").get("schema_version")?.value;
        const version = Number(schema);
        if (!Number.isSafeInteger(version) || version < 1 || version > AUTHORITY_REGISTRY_SCHEMA_VERSION) {
          throw new SessionAuthorityError("AUTHORITY_STORE_UNAVAILABLE", version > 4 ? `authority registry schema ${version} is newer than supported schema ${AUTHORITY_REGISTRY_SCHEMA_VERSION}` : "authority registry schema version is invalid");
        }
        this.#database.exec("BEGIN IMMEDIATE");
        try {
          this.#database.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        source_key TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        app_root_key TEXT NOT NULL,
        state TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        authority_version INTEGER NOT NULL,
        supervisor_pid INTEGER NOT NULL,
        supervisor_birth TEXT NOT NULL,
        worker_instance TEXT,
        worker_pid INTEGER,
        worker_birth TEXT,
        heartbeat_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        bindings_json TEXT NOT NULL,
        created_ms INTEGER NOT NULL,
        updated_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS claims (
        resource_type TEXT NOT NULL,
        resource_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL,
        PRIMARY KEY(resource_type, resource_key)
      );
      CREATE INDEX IF NOT EXISTS claims_session_idx
        ON claims(session_id, claim_epoch);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        authority_version INTEGER NOT NULL,
        tool TEXT NOT NULL,
        profile TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        lease_until_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS operations_session_idx
        ON operations(session_id, claim_epoch);
      CREATE TABLE IF NOT EXISTS allocations (
        service TEXT NOT NULL,
        worktree_key TEXT NOT NULL,
        port INTEGER NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY(service, worktree_key),
        UNIQUE(service, port)
      );
      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        target_instance TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_ms INTEGER NOT NULL,
        consumed_ms INTEGER
      );
      CREATE TABLE IF NOT EXISTS platform_authority_receipts (
        session_id TEXT NOT NULL,
        claim_epoch INTEGER NOT NULL,
        platform TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        updated_ms INTEGER NOT NULL,
        PRIMARY KEY(session_id, platform)
      );
      `);
          if (version < 3) {
            const columns = this.#database.prepare("PRAGMA table_info(handoffs)").all();
            if (!columns.some((column) => column.name === "source_state")) {
              this.#database.exec("ALTER TABLE handoffs ADD COLUMN source_state TEXT NOT NULL DEFAULT 'active';");
            }
          }
          this.#database.exec(`UPDATE authority_meta SET value = '${AUTHORITY_REGISTRY_SCHEMA_VERSION}' WHERE key = 'schema_version';`);
          this.#database.exec("COMMIT");
        } catch (error) {
          this.#database.exec("ROLLBACK");
          throw error;
        }
        this.#secureFiles();
      }
      #initializeWithRetry() {
        const deadline = Date.now() + 1e3;
        for (; ; ) {
          try {
            this.#initialize();
            return;
          } catch (error) {
            const code = error.code;
            const message = error instanceof Error ? error.message : "";
            if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(message))
              throw error;
            const remaining = deadline - Date.now();
            if (remaining <= 0)
              throw error;
            Atomics.wait(INITIALIZATION_WAIT2, 0, 0, Math.min(25, remaining));
          }
        }
      }
      #probeClaimOwners(session, resources) {
        const owners = /* @__PURE__ */ new Map();
        for (const resource of resources) {
          const claim = this.#findConflictingClaim(resource);
          if (!claim || claim.session_id === session.sessionId || owners.has(claim.session_id)) {
            continue;
          }
          const owner = asSession(this.#database.prepare(`SELECT session_id, claim_epoch, supervisor_pid, supervisor_birth
             FROM sessions WHERE session_id = ?`).get(claim.session_id));
          let status = "unknown";
          if (owner && owner.claim_epoch === claim.claim_epoch) {
            try {
              status = this.#ownerStatus({
                sessionId: owner.session_id,
                pid: owner.supervisor_pid,
                token: owner.supervisor_birth
              });
            } catch {
              status = "unknown";
            }
          }
          owners.set(claim.session_id, { claimEpoch: claim.claim_epoch, status });
        }
        return owners;
      }
      #requireSession(session) {
        const row = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(session.sessionId));
        if (!row || !isOperationalState(row.state) || row.claim_epoch !== session.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session owner no longer matches the active claim epoch");
        }
        return row;
      }
      #requireIntegrationRestored(bindings) {
        if (bindings.packageIntegration) {
          throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "package integration must be restored before session release");
        }
      }
      #requireFenceableSession(session) {
        const row = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(session.sessionId));
        if (!row || !isFenceableState(row.state) || row.claim_epoch !== session.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session owner no longer matches the fenceable claim epoch");
        }
        return row;
      }
      #requireHandoffSession(session) {
        const row = this.#requireFenceableSession(session);
        if (row.state !== "handoff") {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session owner no longer matches the handoff claim epoch");
        }
        return row;
      }
      #requireRecoverableSession(session) {
        const row = asSession(this.#database.prepare(`SELECT session_id, state, claim_epoch, authority_version,
                  source_key, worktree_key, app_root_key,
                  supervisor_pid, supervisor_birth, worker_instance, worker_pid,
                  worker_birth, lease_until_ms, source_json, bindings_json
           FROM sessions WHERE session_id = ?`).get(session.sessionId));
        if (!row || row.state !== "blocked" && row.state !== "handoff_cleanup" || row.claim_epoch !== session.claimEpoch) {
          throw new SessionAuthorityError("SESSION_OWNER_LOST", "session is not an unchanged recovery contender");
        }
        return row;
      }
      #requireHandoffCleanupOwner(session, targetInstance) {
        const row = this.#requireRecoverableSession(session);
        if (row.state !== "handoff_cleanup" || row.worker_instance !== targetInstance) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff cleanup is not owned by this recovery worker");
        }
        return row;
      }
      #requireHandoffIntoContext(target, input, allowExactReservationAfterExpiry) {
        const targetRow = this.#requireRecoverableSession(target);
        if (targetRow.state !== "blocked") {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff acceptance is not available during cleanup");
        }
        if (targetRow.worker_instance !== input.targetInstance) {
          throw new SessionAuthorityError("HANDOFF_TARGET_MISMATCH", "handoff target is not the current fenced worker instance");
        }
        const handoff = this.#database.prepare(`SELECT handoff_id, session_id, claim_epoch, target_instance,
                token_hash, expires_ms, consumed_ms
         FROM handoffs WHERE handoff_id = ?`).get(input.handoffId);
        if (!handoff) {
          throw new SessionAuthorityError("HANDOFF_NOT_FOUND", "handoff does not exist");
        }
        if (handoff.consumed_ms !== null) {
          throw new SessionAuthorityError("HANDOFF_ALREADY_CONSUMED", "handoff was already accepted");
        }
        const expected = Buffer.from(handoff.token_hash, "hex");
        const actual = createHash5("sha256").update(input.token).digest();
        if (expected.length !== actual.length || !timingSafeEqual4(expected, actual)) {
          throw new SessionAuthorityError("HANDOFF_TOKEN_INVALID", "handoff capability is invalid");
        }
        const prior = asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                  claim_epoch, authority_version, bindings_json
           FROM sessions WHERE session_id = ?`).get(handoff.session_id));
        if (!prior || prior.state !== "handoff" || prior.claim_epoch !== handoff.claim_epoch) {
          throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "handoff no longer matches the live owner epoch");
        }
        if (prior.source_key !== targetRow.source_key || prior.worktree_key !== targetRow.worktree_key || prior.app_root_key !== targetRow.app_root_key) {
          throw new SessionAuthorityError("SOURCE_WORKTREE_MISMATCH", "handoff source does not match the target session");
        }
        let bindings = JSON.parse(prior.bindings_json);
        let reservation = managedMetroHandoffReservation(bindings);
        let exactReservation = reservation?.handoffId === handoff.handoff_id && reservation.sourceClaimEpoch === handoff.claim_epoch && reservation.targetSessionId === target.sessionId && reservation.targetClaimEpoch === target.claimEpoch && reservation.targetInstance === input.targetInstance && reservation.metro?.sourceSessionId === prior.session_id;
        if (handoff.target_instance !== input.targetInstance || reservation && !exactReservation) {
          const targetBindings = JSON.parse(targetRow.bindings_json);
          const adoptionRequired = targetBindings.adoptionRequired;
          const priorTarget = reservation ? asSession(this.#database.prepare(`SELECT session_id, source_key, worktree_key, app_root_key, state,
                        claim_epoch, supervisor_pid, supervisor_birth
                 FROM sessions WHERE session_id = ?`).get(reservation.targetSessionId)) : null;
          const priorTargetTerminal = priorTarget !== null && (priorTarget.state === "released" || priorTarget.state === "stale") && priorTarget.claim_epoch === reservation.targetClaimEpoch + 1;
          let priorTargetDead = false;
          if (priorTarget?.state === "blocked" && priorTarget.claim_epoch === reservation?.targetClaimEpoch) {
            try {
              priorTargetDead = this.#ownerStatus({
                sessionId: priorTarget.session_id,
                pid: priorTarget.supervisor_pid,
                token: priorTarget.supervisor_birth
              }) === "mismatch";
            } catch {
              priorTargetDead = false;
            }
          }
          if (!reservation || reservation.handoffId !== handoff.handoff_id || reservation.sourceClaimEpoch !== handoff.claim_epoch || reservation.metro.sourceSessionId !== prior.session_id || reservation.targetInstance !== handoff.target_instance || adoptionRequired?.sessionId !== prior.session_id || adoptionRequired.claimEpoch !== prior.claim_epoch || !priorTarget || priorTarget.source_key !== targetRow.source_key || priorTarget.worktree_key !== targetRow.worktree_key || priorTarget.app_root_key !== targetRow.app_root_key || !priorTargetTerminal && !priorTargetDead) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro cleanup reservation belongs to a different handoff recipient");
          }
          if (handoff.expires_ms < this.#now() && !allowExactReservationAfterExpiry) {
            throw new SessionAuthorityError("HANDOFF_EXPIRED", "handoff capability expired");
          }
          const rotatedReservation = {
            ...reservation,
            targetSessionId: target.sessionId,
            targetClaimEpoch: target.claimEpoch,
            targetInstance: input.targetInstance
          };
          const handoffChanged = this.#database.prepare(`UPDATE handoffs SET target_instance = ?
           WHERE handoff_id = ? AND target_instance = ? AND consumed_ms IS NULL`).run(input.targetInstance, handoff.handoff_id, reservation.targetInstance);
          if (handoffChanged.changes !== 1) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro handoff target changed during recipient rotation");
          }
          bindings = {
            ...bindings,
            managedMetroHandoffReservation: rotatedReservation
          };
          const donorChanged = this.#database.prepare(`UPDATE sessions
           SET bindings_json = ?, authority_version = authority_version + 1, updated_ms = ?
           WHERE session_id = ? AND claim_epoch = ? AND state = 'handoff'`).run(JSON.stringify(bindings), this.#now(), prior.session_id, prior.claim_epoch);
          if (donorChanged.changes !== 1) {
            throw new SessionAuthorityError("HANDOFF_NOT_AUTHORIZED", "managed Metro donor authority changed during recipient rotation");
          }
          if (priorTarget.state === "blocked") {
            this.#fenceSession(priorTarget.session_id, this.#now());
          }
          handoff.target_instance = input.targetInstance;
          reservation = rotatedReservation;
          exactReservation = true;
        }
        if (handoff.expires_ms < this.#now() && !(allowExactReservationAfterExpiry && exactReservation)) {
          throw new SessionAuthorityError("HANDOFF_EXPIRED", "handoff capability expired");
        }
        return {
          targetRow,
          handoff,
          prior,
          bindings,
          reservation: exactReservation ? reservation : null
        };
      }
      #advanceActiveOperationFence(session, priorAuthorityVersion, nextAuthorityVersion) {
        const active = this.#database.prepare(`SELECT operation_id, authority_version FROM operations
         WHERE session_id = ? AND claim_epoch = ? LIMIT 1`).get(session.sessionId, session.claimEpoch);
        if (!active)
          return;
        const context = this.#operationContext.getStore();
        if (!context || context.operationId !== active.operation_id || context.sessionId !== session.sessionId || context.claimEpoch !== session.claimEpoch || context.authorityVersion !== priorAuthorityVersion || active.authority_version !== priorAuthorityVersion) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "authority mutation is not owned by the active operation fence");
        }
        const changed = this.#database.prepare(`UPDATE operations SET authority_version = ?, lease_until_ms = ?
         WHERE operation_id = ? AND session_id = ? AND claim_epoch = ?
           AND authority_version = ?`).run(nextAuthorityVersion, this.#now() + this.#leaseMs, context.operationId, session.sessionId, session.claimEpoch, priorAuthorityVersion);
        if (changed.changes === 0) {
          throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "operation fence did not advance atomically");
        }
        context.authorityVersion = nextAuthorityVersion;
      }
      #findClaim(type, key) {
        return asClaim(this.#database.prepare(`SELECT resource_type, resource_key, session_id, claim_epoch, lease_until_ms
           FROM claims WHERE resource_type = ? AND resource_key = ?`).get(type, key));
      }
      #findConflictingClaim(resource) {
        return this.#findClaim(resource.type, resource.key) ?? (resource.type === "runner" ? this.#findClaim("runner-receipt", resource.key) : resource.type === "device" ? this.#findClaim("device-receipt", resource.key) : null);
      }
      #platformReceiptFromCurrentAuthority(session, platform, receipt) {
        const row = this.#requireSession(session);
        const bindings = JSON.parse(row.bindings_json);
        const device = bindings.device;
        const install = bindings.install;
        const runner = bindings.runner;
        const runnerClaim = this.#database.prepare(`SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'runner'`).get(session.sessionId, session.claimEpoch);
        const deviceClaim = this.#database.prepare(`SELECT resource_key FROM claims
         WHERE session_id = ? AND claim_epoch = ? AND resource_type = 'device'`).get(session.sessionId, session.claimEpoch);
        const runnerCapabilityHash = typeof runner?.capability === "string" ? createHash5("sha256").update(runner.capability).digest("hex") : null;
        if (device?.platform !== platform || receipt.sessionId !== session.sessionId || receipt.claimEpoch !== session.claimEpoch || receipt.sourceKey !== row.source_key || receipt.worktreeKey !== row.worktree_key || receipt.appRootKey !== row.app_root_key || receipt.deviceId !== device.deviceId || receipt.appId !== device.appId || receipt.installGeneration !== install?.installGeneration || receipt.artifactDigest !== install?.artifactDigest || receipt.runnerInstanceId !== runner?.instanceId || receipt.runnerPid !== runner?.pid || receipt.runnerProcessBirth !== runner?.processBirth || receipt.runnerPort !== runner?.port || receipt.runnerClaim !== runnerClaim?.resource_key || receipt.deviceClaim !== deviceClaim?.resource_key || receipt.runnerCapabilityHash !== runnerCapabilityHash || typeof runner?.port !== "number" || typeof runner.capability !== "string" || typeof runner.instanceId !== "string" || typeof runner.pid !== "number" || typeof runner.processBirth !== "string" || typeof device?.deviceId !== "string" || typeof device.appId !== "string" || typeof install?.installGeneration !== "string") {
          throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "snapshot receipt does not match exact persistent platform authority");
        }
        return {
          session,
          platform,
          receipt,
          probe: {
            platform,
            port: runner.port,
            capability: runner.capability,
            instanceId: runner.instanceId,
            sessionId: session.sessionId,
            claimEpoch: session.claimEpoch,
            deviceId: device.deviceId,
            appId: device.appId,
            pid: runner.pid,
            processBirth: runner.processBirth,
            installGeneration: install.installGeneration
          }
        };
      }
      #invalidatePlatformReceipt(session, platform) {
        const row = this.#database.prepare(`SELECT receipt_json FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`).get(session.sessionId, session.claimEpoch, platform);
        if (typeof row?.receipt_json === "string") {
          const persisted = JSON.parse(row.receipt_json);
          const receipt = persisted.receipt && typeof persisted.receipt === "object" ? persisted.receipt : persisted;
          if (typeof receipt.runnerClaim === "string") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'runner-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(receipt.runnerClaim, session.sessionId, session.claimEpoch);
          }
          if (typeof receipt.deviceClaim === "string") {
            this.#database.prepare(`DELETE FROM claims
             WHERE resource_type = 'device-receipt' AND resource_key = ?
               AND session_id = ? AND claim_epoch = ?`).run(receipt.deviceClaim, session.sessionId, session.claimEpoch);
          }
        }
        this.#database.prepare(`DELETE FROM platform_authority_receipts
         WHERE session_id = ? AND claim_epoch = ? AND platform = ?`).run(session.sessionId, session.claimEpoch, platform);
      }
      #capabilityMatches(expected, actual) {
        const expectedDigest = createHash5("sha256").update(expected).digest();
        const actualDigest = createHash5("sha256").update(actual).digest();
        return timingSafeEqual4(expectedDigest, actualDigest);
      }
      #fenceSession(sessionId, now) {
        this.#database.prepare("DELETE FROM claims WHERE session_id = ?").run(sessionId);
        this.#database.prepare("DELETE FROM operations WHERE session_id = ?").run(sessionId);
        this.#database.prepare(`UPDATE sessions
         SET state = 'stale', claim_epoch = claim_epoch + 1,
             authority_version = authority_version + 1, updated_ms = ?
         WHERE session_id = ?`).run(now, sessionId);
      }
      #transaction(operation) {
        this.#database.exec("BEGIN IMMEDIATE");
        try {
          const result = operation();
          this.#database.exec("COMMIT");
          this.#secureFiles();
          return result;
        } catch (error) {
          this.#database.exec("ROLLBACK");
          this.#secureFiles();
          throw error;
        }
      }
      async #retry(operation, timeoutMs, retryDelayMs) {
        const deadline = Date.now() + timeoutMs;
        for (; ; ) {
          try {
            return operation();
          } catch (error) {
            const code = error.code;
            const message = error instanceof Error ? error.message : "";
            if (code !== "SQLITE_BUSY" && !/database is (?:locked|busy)/i.test(message))
              throw error;
            if (Date.now() >= deadline) {
              throw new SessionAuthorityError("AUTHORITY_STORE_BUSY", "authority registry remained contended past the retry deadline");
            }
            await new Promise((resolve5) => setTimeout(resolve5, retryDelayMs));
          }
        }
      }
    };
  }
});

// packages/rn-dev-agent-core/dist/util/secure-state-file.js
import { readFileSync as readFileSync6, writeFileSync, unlinkSync, mkdirSync as mkdirSync4, renameSync, lstatSync as lstatSync5 } from "node:fs";
import { join as join5, dirname as dirname6 } from "node:path";
import { homedir } from "node:os";
function getStateDir() {
  if (process.env.XDG_STATE_HOME) {
    return join5(process.env.XDG_STATE_HOME, "rn-dev-agent");
  }
  if (process.platform === "darwin") {
    return join5(homedir(), "Library", "Application Support", "rn-dev-agent");
  }
  return join5(homedir(), ".rn-dev-agent");
}
function readJsonStateFile(path) {
  try {
    const stat = lstatSync5(path);
    if (stat.isSymbolicLink())
      return null;
    return JSON.parse(readFileSync6(path, "utf8"));
  } catch {
    return null;
  }
}
function writeJsonStateFileAtomic(path, value) {
  mkdirSync4(dirname6(path), { recursive: true });
  const tmpPath = `${path}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(value), { encoding: "utf8", mode: 384 });
  renameSync(tmpPath, path);
}
var init_secure_state_file = __esm({
  "packages/rn-dev-agent-core/dist/util/secure-state-file.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/settle-hash.js
var init_settle_hash = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/settle-hash.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/fast-runner-ref-map.js
var init_fast_runner_ref_map = __esm({
  "packages/rn-dev-agent-core/dist/fast-runner-ref-map.js"() {
    "use strict";
    init_settle_hash();
  }
});

// packages/rn-dev-agent-core/dist/runners/keyboard-guard.js
var init_keyboard_guard = __esm({
  "packages/rn-dev-agent-core/dist/runners/keyboard-guard.js"() {
    "use strict";
    init_utils();
  }
});

// packages/rn-dev-agent-core/dist/runners/runtime-paths.js
import { existsSync as existsSync8, statSync as statSync5 } from "node:fs";
import { join as join9 } from "node:path";
function compactUnique(paths) {
  const out = [];
  for (const path of paths) {
    if (!path || out.includes(path))
      continue;
    out.push(path);
  }
  return out;
}
function isDirectory(path) {
  try {
    return statSync5(path).isDirectory();
  } catch {
    return false;
  }
}
function candidateNativeRunnerDirs(runnerName, baseDir = import.meta.dirname) {
  const runnerRoot = process.env.RN_DEV_AGENT_NATIVE_RUNNER_ROOT;
  const repoRoot = process.env.RN_DEV_AGENT_ROOT;
  const codexPluginRoot = process.env.RN_DEV_AGENT_CODEX_PLUGIN_ROOT;
  const claudePluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
  return compactUnique([
    runnerRoot ? join9(runnerRoot, runnerName) : void 0,
    repoRoot ? join9(repoRoot, "packages", runnerName) : void 0,
    repoRoot ? join9(repoRoot, "scripts", runnerName) : void 0,
    codexPluginRoot ? join9(codexPluginRoot, "scripts", runnerName) : void 0,
    claudePluginRoot ? join9(claudePluginRoot, "..", runnerName) : void 0,
    claudePluginRoot ? join9(claudePluginRoot, "..", "..", "packages", runnerName) : void 0,
    claudePluginRoot ? join9(claudePluginRoot, "..", "..", "scripts", runnerName) : void 0,
    claudePluginRoot ? join9(claudePluginRoot, "scripts", runnerName) : void 0,
    // Bundled Codex runtime: <plugin>/rn-dev-agent-core/dist.
    join9(baseDir, "..", "..", "scripts", runnerName),
    // Source checkout: packages/rn-dev-agent-core/dist/runners.
    // Also covers the legacy scripts/cdp-bridge/dist/runners layout.
    join9(baseDir, "..", "..", "..", runnerName),
    // Legacy source checkout: packages/rn-dev-agent-core/dist/runners before runner package split.
    join9(baseDir, "..", "..", "..", "..", "scripts", runnerName)
  ]);
}
function resolveNativeRunnerDir(runnerName, baseDir = import.meta.dirname) {
  const candidates = candidateNativeRunnerDirs(runnerName, baseDir);
  return candidates.find(isDirectory) ?? candidates[0];
}
var init_runtime_paths = __esm({
  "packages/rn-dev-agent-core/dist/runners/runtime-paths.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/protocol.js
var init_protocol = __esm({
  "packages/rn-dev-agent-core/dist/runners/protocol.js"() {
    "use strict";
    init_runtime_paths();
  }
});

// packages/rn-dev-agent-core/dist/runners/quiescence.js
var init_quiescence = __esm({
  "packages/rn-dev-agent-core/dist/runners/quiescence.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/runner-artifacts.js
var init_runner_artifacts = __esm({
  "packages/rn-dev-agent-core/dist/runners/runner-artifacts.js"() {
    "use strict";
    init_runtime_paths();
  }
});

// packages/rn-dev-agent-core/dist/runners/transport-recovery.js
var init_transport_recovery = __esm({
  "packages/rn-dev-agent-core/dist/runners/transport-recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/rn-fast-runner-client.js
import { join as join10 } from "node:path";
function resolveReadyTimeoutMs() {
  const raw = Number(process.env.RN_FAST_RUNNER_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3e4;
}
var READY_TIMEOUT_MS, FAST_RUNNER_PROJECT, REBUILD_LOCK_DIR, REBUILD_LOCK_STALE_MS, REBUILD_BUDGET_FILE, fetchImpl;
var init_rn_fast_runner_client = __esm({
  "packages/rn-dev-agent-core/dist/runners/rn-fast-runner-client.js"() {
    "use strict";
    init_utils();
    init_fast_runner_ref_map();
    init_keyboard_guard();
    init_secure_state_file();
    init_protocol();
    init_quiescence();
    init_runner_artifacts();
    init_runtime_paths();
    init_transport_recovery();
    init_process_birth();
    READY_TIMEOUT_MS = resolveReadyTimeoutMs();
    FAST_RUNNER_PROJECT = resolveNativeRunnerDir("rn-fast-runner");
    REBUILD_LOCK_DIR = join10(FAST_RUNNER_PROJECT, "build", ".rebuild-lock");
    REBUILD_LOCK_STALE_MS = 15 * 6e4;
    REBUILD_BUDGET_FILE = join10(FAST_RUNNER_PROJECT, "build", "commands-rebuild.json");
    fetchImpl = globalThis.fetch;
  }
});

// packages/rn-dev-agent-core/dist/tools/device-screenshot-raw.js
import { execFile, spawn as spawn3 } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync;
var init_device_screenshot_raw = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-screenshot-raw.js"() {
    "use strict";
    execFileAsync = promisify(execFile);
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/no-change-tracker.js
var WEDGED_DISTINCT_TARGETS, WEDGED_RUNTIME_HINT;
var init_no_change_tracker = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/no-change-tracker.js"() {
    "use strict";
    WEDGED_DISTINCT_TARGETS = 3;
    WEDGED_RUNTIME_HINT = `${WEDGED_DISTINCT_TARGETS} consecutive taps on distinct targets produced no UI change \u2014 the app runtime may be wedged (JS thread paused or touch events swallowed). Run cdp_status (iOS auto-recovers a paused JS thread), then cdp_restart with hardReset=true if it persists.`;
  }
});

// packages/rn-dev-agent-core/dist/logger.js
import { createWriteStream, mkdirSync as mkdirSync6, existsSync as existsSync9 } from "node:fs";
import { join as join11 } from "node:path";
import { tmpdir as tmpdir2, homedir as homedir2 } from "node:os";
function resolveLogPath() {
  if (process.argv.includes("--diagnostic-contract-probe"))
    return null;
  if (configuredLevel !== "debug" && configuredLevel !== "info")
    return null;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    try {
      if (!existsSync9(pluginData))
        mkdirSync6(pluginData, { recursive: true });
      return join11(pluginData, "cdp-bridge.log");
    } catch {
    }
  }
  const fallbackDir = join11(homedir2(), ".claude", "logs");
  try {
    if (!existsSync9(fallbackDir))
      mkdirSync6(fallbackDir, { recursive: true });
    return join11(fallbackDir, "rn-dev-agent-cdp-bridge.log");
  } catch {
  }
  return join11(tmpdir2(), "rn-dev-agent-cdp-bridge.log");
}
var configuredLevel, logFilePath;
var init_logger = __esm({
  "packages/rn-dev-agent-core/dist/logger.js"() {
    "use strict";
    configuredLevel = process.env.LOG_LEVEL ?? process.env.RN_DEV_AGENT_LOG_LEVEL ?? "warn";
    logFilePath = resolveLogPath();
  }
});

// packages/rn-dev-agent-core/dist/project-config.js
var init_project_config = __esm({
  "packages/rn-dev-agent-core/dist/project-config.js"() {
    "use strict";
    init_storage();
    init_logger();
  }
});

// packages/rn-dev-agent-core/dist/agent-device-wrapper.js
import { join as join12 } from "node:path";
import { createHash as createHash7 } from "node:crypto";
function getSessionFilePath() {
  const projectId = createHash7("sha256").update(process.cwd()).digest("hex").slice(0, 12);
  return join12(getStateDir(), `session-${projectId}.json`);
}
var SESSION_FILE, LEGACY_SESSION_FILE, activeSession;
var init_agent_device_wrapper = __esm({
  "packages/rn-dev-agent-core/dist/agent-device-wrapper.js"() {
    "use strict";
    init_utils();
    init_rn_fast_runner_client();
    init_protocol();
    init_device_screenshot_raw();
    init_fast_runner_ref_map();
    init_no_change_tracker();
    init_project_config();
    init_secure_state_file();
    SESSION_FILE = getSessionFilePath();
    LEGACY_SESSION_FILE = "/tmp/rn-dev-agent-session.json";
    activeSession = null;
    activeSession = readJsonStateFile(SESSION_FILE);
    if (!activeSession) {
      const legacy = readJsonStateFile(LEGACY_SESSION_FILE);
      if (legacy) {
        activeSession = legacy;
        try {
          writeJsonStateFileAtomic(SESSION_FILE, legacy);
        } catch {
        }
      }
    }
  }
});

// packages/rn-dev-agent-core/dist/tools/platform-utils.js
import { execFile as execFileCb } from "node:child_process";
import { promisify as promisify2 } from "node:util";
var execFile2;
var init_platform_utils = __esm({
  "packages/rn-dev-agent-core/dist/tools/platform-utils.js"() {
    "use strict";
    init_agent_device_wrapper();
    execFile2 = promisify2(execFileCb);
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-validator.js
var import_yaml2;
var init_maestro_validator = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-validator.js"() {
    "use strict";
    import_yaml2 = __toESM(require_dist(), 1);
  }
});

// packages/rn-dev-agent-core/dist/tools/maestro-dispatch.js
var init_maestro_dispatch = __esm({
  "packages/rn-dev-agent-core/dist/tools/maestro-dispatch.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-error-parser.js
var init_maestro_error_parser = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-error-parser.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/resolve-ios-app-file.js
var init_resolve_ios_app_file = __esm({
  "packages/rn-dev-agent-core/dist/tools/resolve-ios-app-file.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/engine-pin.js
import { execFile as execFileCb2, spawnSync as spawnSync2 } from "node:child_process";
import { promisify as promisify3 } from "node:util";
var execFile3;
var init_engine_pin = __esm({
  "packages/rn-dev-agent-core/dist/domain/engine-pin.js"() {
    "use strict";
    init_maestro_invoke();
    execFile3 = promisify3(execFileCb2);
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-step-parser.js
var ANSI_RE;
var init_maestro_step_parser = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-step-parser.js"() {
    "use strict";
    init_maestro_error_parser();
    ANSI_RE = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");
  }
});

// packages/rn-dev-agent-core/dist/domain/tap-latency.js
var init_tap_latency = __esm({
  "packages/rn-dev-agent-core/dist/domain/tap-latency.js"() {
    "use strict";
    init_maestro_step_parser();
  }
});

// packages/rn-dev-agent-core/dist/cdp/recovery.js
var init_recovery = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-device-authority.js
var init_maestro_device_authority = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-device-authority.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/domain/maestro-runner-report.js
var init_maestro_runner_report = __esm({
  "packages/rn-dev-agent-core/dist/domain/maestro-runner-report.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/session/tool-profiles.js
function add(names, profile) {
  for (const name of names) {
    if (profiles.has(name))
      throw new Error(`DUPLICATE_AUTHORITY_PROFILE: ${name}`);
    profiles.set(name, profile);
  }
}
var diagnostic, transition, sourceState, nativeRead, nativeMutation, hybridMutation, optionalHybridMutation, nativeDiagnostic, cdpRead, cdpMutation, observe, proof, profiles;
var init_tool_profiles = __esm({
  "packages/rn-dev-agent-core/dist/session/tool-profiles.js"() {
    "use strict";
    diagnostic = ["cdp_status", "cdp_targets", "device_list"];
    transition = ["rn_session", "cdp_connect", "cdp_disconnect"];
    sourceState = [
      "cdp_nav_graph",
      "cdp_record_test_generate",
      "cdp_record_test_list",
      "cdp_record_test_load",
      "cdp_record_test_save",
      "cdp_record_test_save_as_action",
      "maestro_generate"
    ];
    nativeRead = [
      "cross_platform_verify",
      "device_find",
      "device_screenshot",
      "device_snapshot"
    ];
    nativeMutation = [
      "cdp_lock_e2e_test",
      "cdp_repair_action",
      "device_accept_system_dialog",
      "device_back",
      "device_batch",
      "device_deeplink",
      "device_dismiss_system_dialog",
      "device_fill",
      "device_focus_next",
      "device_longpress",
      "device_permission",
      "device_pick_date",
      "device_pick_value",
      "device_pinch",
      "device_press",
      "device_record",
      "device_reset_state",
      "device_scroll",
      "device_scrollintoview",
      "device_swipe",
      "maestro_run",
      "maestro_test_all"
    ];
    hybridMutation = ["cdp_auto_login", "cdp_run_e2e_suite"];
    optionalHybridMutation = ["cdp_run_action"];
    nativeDiagnostic = ["cdp_native_errors"];
    cdpRead = [
      "cdp_component_state",
      "cdp_component_tree",
      "cdp_console_log",
      "cdp_cpu_profile",
      "cdp_diagnostic_renderers",
      "cdp_error_log",
      "cdp_heap_usage",
      "cdp_metro_events",
      "cdp_navigation_state",
      "cdp_network_body",
      "cdp_network_log",
      "cdp_object_inspect",
      "cdp_open_devtools",
      "cdp_store_state",
      "cdp_wait_for_network",
      "collect_logs",
      "expect_redux",
      "expect_route",
      "expect_text",
      "expect_visible_by_testid"
    ];
    cdpMutation = [
      "cdp_dev_settings",
      "cdp_dismiss_dev_client_picker",
      "cdp_dispatch",
      "cdp_evaluate",
      "cdp_exception_breakpoint",
      "cdp_interact",
      "cdp_mmkv",
      "cdp_navigate",
      "cdp_record_test_annotate",
      "cdp_record_test_start",
      "cdp_record_test_stop",
      "cdp_reload",
      "cdp_restart",
      "cdp_set_shared_value"
    ];
    observe = ["observe"];
    proof = ["proof_capture", "proof_step"];
    profiles = /* @__PURE__ */ new Map();
    add(diagnostic, {
      kind: "diagnostic",
      axes: [],
      mutation: false,
      liveBundleProbe: false
    });
    add(transition, {
      kind: "transition",
      axes: ["C", "S"],
      mutation: true,
      liveBundleProbe: false
    });
    add(sourceState, {
      kind: "authoritative",
      axes: ["C", "S"],
      mutation: true,
      liveBundleProbe: false
    });
    add(nativeRead, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "D", "R"],
      mutation: false,
      liveBundleProbe: false
    });
    add(nativeMutation, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "A", "D", "R"],
      mutation: true,
      liveBundleProbe: false
    });
    add(hybridMutation, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "B", "D", "R"],
      mutation: true,
      liveBundleProbe: true
    });
    add(optionalHybridMutation, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "D", "R"],
      optionalAxes: ["B"],
      managedOrigin: true,
      mutation: true,
      liveBundleProbe: true
    });
    add(nativeDiagnostic, {
      kind: "authoritative",
      axes: ["C", "S", "I", "D"],
      mutation: false,
      liveBundleProbe: false
    });
    add(cdpRead, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "B", "D"],
      mutation: false,
      liveBundleProbe: true
    });
    add(cdpMutation, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "B", "D"],
      mutation: true,
      liveBundleProbe: true
    });
    add(observe, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "B", "D", "O"],
      mutation: false,
      liveBundleProbe: true
    });
    add(proof, {
      kind: "authoritative",
      axes: ["C", "S", "I", "M", "B", "D", "R", "P"],
      mutation: true,
      liveBundleProbe: true
    });
  }
});

// packages/rn-dev-agent-core/dist/session/authority-gate.js
var init_authority_gate = __esm({
  "packages/rn-dev-agent-core/dist/session/authority-gate.js"() {
    "use strict";
    init_utils();
    init_registry();
    init_tool_profiles();
  }
});

// packages/rn-dev-agent-core/dist/tools/maestro-run.js
import { execFile as execFileCb3 } from "node:child_process";
import { promisify as promisify4 } from "node:util";
var defaultExecFile;
var init_maestro_run = __esm({
  "packages/rn-dev-agent-core/dist/tools/maestro-run.js"() {
    "use strict";
    init_utils();
    init_engine_pin();
    init_agent_device_wrapper();
    init_project_config();
    init_maestro_dispatch();
    init_resolve_ios_app_file();
    init_maestro_validator();
    init_maestro_error_parser();
    init_tap_latency();
    init_maestro_step_parser();
    init_rn_fast_runner_client();
    init_release_android_slot();
    init_recovery();
    init_maestro_device_authority();
    init_maestro_runner_report();
    init_authority_gate();
    init_registry();
    defaultExecFile = promisify4(execFileCb3);
  }
});

// packages/rn-dev-agent-core/dist/maestro-invoke.js
import { execFile as execFileCb4 } from "node:child_process";
import { promisify as promisify5 } from "node:util";
var execFile4;
var init_maestro_invoke = __esm({
  "packages/rn-dev-agent-core/dist/maestro-invoke.js"() {
    "use strict";
    init_project_config();
    init_maestro_validator();
    init_maestro_dispatch();
    init_maestro_error_parser();
    init_resolve_ios_app_file();
    init_maestro_run();
    init_agent_device_wrapper();
    init_maestro_device_authority();
    init_maestro_runner_report();
    execFile4 = promisify5(execFileCb4);
  }
});

// packages/rn-dev-agent-core/dist/tools/runner-leak-recovery.js
var init_runner_leak_recovery = __esm({
  "packages/rn-dev-agent-core/dist/tools/runner-leak-recovery.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/app-lifecycle.js
import { execFile as execFileCb5 } from "node:child_process";
import { promisify as promisify6 } from "node:util";
var execFile5;
var init_app_lifecycle = __esm({
  "packages/rn-dev-agent-core/dist/tools/app-lifecycle.js"() {
    "use strict";
    execFile5 = promisify6(execFileCb5);
  }
});

// packages/rn-dev-agent-core/dist/runners/external-runner-detect.js
import { execFile as execFile6 } from "node:child_process";
import { promisify as promisify7 } from "node:util";
function executableBasename(command) {
  const executable = command.trimStart().split(/\s+/, 1)[0] ?? "";
  return executable.slice(executable.lastIndexOf("/") + 1);
}
function shellWrappedMaestro(command) {
  const tokens = command.trimStart().split(/\s+/);
  if (!SHELL_WRAPPERS.test(executableBasename(tokens[0] ?? "")))
    return false;
  return tokens.slice(1).some((token2) => token2.startsWith("/") && /^maestro(?:\.\w+)?$/i.test(executableBasename(token2)));
}
function isIosExternalRunnerProcessLine(line) {
  const match = line.match(/^\s*\d+\s+(.+)$/);
  if (!match)
    return false;
  const command = match[1];
  const executable = executableBasename(command);
  if (/^maestro(?:-driver-iosUITests-Runner)?$/i.test(executable))
    return true;
  if (shellWrappedMaestro(command))
    return true;
  if (/^WebDriverAgent(?:Runner)?(?:-Runner)?$/i.test(executable))
    return true;
  if (/^java$/i.test(executable) && /(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i.test(command)) {
    return true;
  }
  if (/^xcodebuild$/i.test(executable) && /(?:maestro[^\s]*|WebDriverAgent[^\s]*)\.xctestrun(?:\s|$)/i.test(command)) {
    return true;
  }
  return false;
}
async function detectIosExternalRunner(execFileImpl = execFile6, udid) {
  try {
    const opts = { timeout: 2e3, encoding: "utf8" };
    const run = execFileImpl === execFile6 ? promisify7(execFileImpl) : execFileImpl;
    const { stdout } = await run("ps", ["axww", "-o", "pid=,command="], opts);
    const lines = stdout.split("\n").filter((line) => isIosExternalRunnerProcessLine(line)).filter((line) => !RN_FAST_RUNNER_RE.test(line)).filter((line) => udid ? line.includes(udid) : true).map((line) => line.trim()).filter((line) => line.length > 0);
    if (lines.length === 0)
      return null;
    return {
      platform: "ios",
      code: "IOS_XCUITEST_COMPETITOR",
      message: "A foreign maestro/WebDriverAgent automation session is driving this simulator. Interleaving device_* with it may trigger a re-foreground of your app; CDP reads are unaffected. (If this is your own maestro flow, it is expected.)",
      processLines: lines
    };
  } catch {
    return null;
  }
}
var SHELL_WRAPPERS, RN_FAST_RUNNER_RE;
var init_external_runner_detect = __esm({
  "packages/rn-dev-agent-core/dist/runners/external-runner-detect.js"() {
    "use strict";
    SHELL_WRAPPERS = /^(?:sh|bash|zsh|dash|ksh|env)$/i;
    RN_FAST_RUNNER_RE = /RnFastRunner/i;
  }
});

// packages/rn-dev-agent-core/dist/cdp/discovery.js
var init_discovery = __esm({
  "packages/rn-dev-agent-core/dist/cdp/discovery.js"() {
    "use strict";
    init_logger();
    init_maestro_validator();
    init_metro_cwd();
  }
});

// packages/rn-dev-agent-core/dist/runners/ensure-single-runner.js
import { homedir as homedir3 } from "node:os";
import { join as join13 } from "node:path";
var DAEMON_JSON, DAEMON_LOCK;
var init_ensure_single_runner = __esm({
  "packages/rn-dev-agent-core/dist/runners/ensure-single-runner.js"() {
    "use strict";
    init_discovery();
    DAEMON_JSON = join13(homedir3(), ".agent-device", "daemon.json");
    DAEMON_LOCK = join13(homedir3(), ".agent-device", "daemon.lock");
  }
});

// packages/rn-dev-agent-core/dist/runners/suppress-ios-autocorrect.js
import { execFile as execFileCb6 } from "node:child_process";
import { promisify as promisify8 } from "node:util";
var execFile7;
var init_suppress_ios_autocorrect = __esm({
  "packages/rn-dev-agent-core/dist/runners/suppress-ios-autocorrect.js"() {
    "use strict";
    execFile7 = promisify8(execFileCb6);
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/foreign-flow-gate.js
var ForeignFlowGate, foreignFlowGate;
var init_foreign_flow_gate = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/foreign-flow-gate.js"() {
    "use strict";
    init_external_runner_detect();
    ForeignFlowGate = class {
      detect;
      ttlMs;
      now;
      cachedAt = -Infinity;
      cachedUdid = null;
      cached = null;
      inFlight = null;
      inFlightUdid = null;
      _lastActive = false;
      constructor(deps = {}) {
        this.detect = deps.detect ?? ((udid) => detectIosExternalRunner(void 0, udid));
        this.ttlMs = deps.ttlMs ?? 5e3;
        this.now = deps.now ?? Date.now;
      }
      get lastActive() {
        return this._lastActive;
      }
      async check(udid) {
        const t = this.now();
        if (this.cachedUdid === udid && t - this.cachedAt < this.ttlMs) {
          return { active: this.cached !== null, warning: this.cached, fromCache: true, scanMs: 0 };
        }
        if (this.inFlight && this.inFlightUdid === udid)
          return this.inFlight;
        this.inFlightUdid = udid;
        const scan = (async () => {
          const started = this.now();
          let warning = null;
          try {
            warning = await this.detect(udid);
          } catch {
            warning = null;
          }
          this.cached = warning;
          this.cachedUdid = udid;
          this.cachedAt = this.now();
          this._lastActive = warning !== null;
          return { active: warning !== null, warning, fromCache: false, scanMs: this.now() - started };
        })();
        this.inFlight = scan;
        try {
          return await scan;
        } finally {
          if (this.inFlight === scan) {
            this.inFlight = null;
            this.inFlightUdid = null;
          }
        }
      }
    };
    foreignFlowGate = new ForeignFlowGate();
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/device-arbiter.js
var DeviceSessionArbiter, arbiter;
var init_device_arbiter = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/device-arbiter.js"() {
    "use strict";
    init_utils();
    init_foreign_flow_gate();
    DeviceSessionArbiter = class {
      flowLeaseHeldBy = null;
      ops = /* @__PURE__ */ new Map();
      nextOpId = 1;
      now;
      constructor(now = Date.now) {
        this.now = now;
      }
      tryAcquire(plane, tool) {
        if (plane === "flow") {
          if (this.flowLeaseHeldBy !== null || this.ops.size > 0) {
            return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
          }
          return this.grant(plane, tool, true);
        }
        if (this.flowLeaseHeldBy !== null) {
          return { ok: false, code: "BUSY_FLOW_ACTIVE", holder: this.describeBlocker() };
        }
        return this.grant(plane, tool, false);
      }
      grant(plane, tool, isFlow) {
        const opId = this.nextOpId++;
        this.ops.set(opId, { plane, tool, startedAtMs: this.now() });
        if (isFlow)
          this.flowLeaseHeldBy = opId;
        return { ok: true, lease: { plane, opId } };
      }
      describeBlocker() {
        const id = this.flowLeaseHeldBy ?? this.oldestOpId();
        if (id === null)
          return null;
        const info = this.ops.get(id);
        return info ? { plane: info.plane, tool: info.tool, opId: id } : null;
      }
      oldestOpId() {
        let oldest = null;
        let oldestAt = Infinity;
        for (const [id, info] of this.ops) {
          if (info.startedAtMs < oldestAt) {
            oldestAt = info.startedAtMs;
            oldest = id;
          }
        }
        return oldest;
      }
      /** GH#186: set when a FLOW lease releases. Our own maestro driver (argv
       * carries the udid) keeps tearing down WDA for seconds after release and
       * matches the foreign detector — taps inside this window must not scan. */
      lastFlowReleasedAt = -Infinity;
      get msSinceFlowReleased() {
        return this.now() - this.lastFlowReleasedAt;
      }
      release(lease) {
        this.ops.delete(lease.opId);
        if (this.flowLeaseHeldBy === lease.opId) {
          this.flowLeaseHeldBy = null;
          this.lastFlowReleasedAt = this.now();
        }
      }
      reset(reason) {
        const clearedOps = this.ops.size;
        const hadFlow = this.flowLeaseHeldBy !== null;
        this.ops.clear();
        this.flowLeaseHeldBy = null;
        return { clearedOps, hadFlow, reason };
      }
      get snapshot() {
        return {
          flowLeaseHeldBy: this.flowLeaseHeldBy,
          activeOps: this.ops.size,
          ops: [...this.ops.entries()].map(([opId, i]) => ({ opId, plane: i.plane, tool: i.tool }))
        };
      }
      /** #210: true while a flow (Maestro) owns the device. Flow-fallback tools consult this to take an OS-level path. */
      get flowActive() {
        return this.flowLeaseHeldBy !== null;
      }
    };
    arbiter = new DeviceSessionArbiter();
  }
});

// packages/rn-dev-agent-core/dist/cdp/recover-wedge.js
import { execFile as execFileCb7 } from "node:child_process";
import { promisify as promisify9 } from "node:util";
var execFile8;
var init_recover_wedge = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recover-wedge.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_device_arbiter();
    init_recovery();
    execFile8 = promisify9(execFileCb7);
  }
});

// packages/rn-dev-agent-core/dist/cdp/app-installed-probe.js
import { execFile as execFileCb8 } from "node:child_process";
import { promisify as promisify10 } from "node:util";
var execFile9;
var init_app_installed_probe = __esm({
  "packages/rn-dev-agent-core/dist/cdp/app-installed-probe.js"() {
    "use strict";
    execFile9 = promisify10(execFileCb8);
  }
});

// packages/rn-dev-agent-core/dist/cdp/recover-detached.js
import { execFile as execFileCb9 } from "node:child_process";
import { promisify as promisify11 } from "node:util";
var execFile10;
var init_recover_detached = __esm({
  "packages/rn-dev-agent-core/dist/cdp/recover-detached.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_device_arbiter();
    init_recovery();
    init_app_installed_probe();
    init_maestro_validator();
    execFile10 = promisify11(execFileCb9);
  }
});

// packages/rn-dev-agent-core/dist/lifecycle/device-lock.js
var init_device_lock = __esm({
  "packages/rn-dev-agent-core/dist/lifecycle/device-lock.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/device-session-close.js
var init_device_session_close = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-session-close.js"() {
    "use strict";
    init_utils();
  }
});

// packages/rn-dev-agent-core/dist/tools/device-session.js
import { execFile as execFileCb10 } from "node:child_process";
import { promisify as promisify12 } from "node:util";
var execFile11;
var init_device_session = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-session.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_rn_android_runner_client();
    init_app_lifecycle();
    init_recovery();
    init_external_runner_detect();
    init_ensure_single_runner();
    init_suppress_ios_autocorrect();
    init_recover_wedge();
    init_recover_detached();
    init_utils();
    init_project_config();
    init_maestro_validator();
    init_logger();
    init_runner_leak_recovery();
    init_device_lock();
    init_device_arbiter();
    init_device_session_close();
    execFile11 = promisify12(execFileCb10);
  }
});

// packages/rn-dev-agent-core/dist/tools/fill-verify.js
var init_fill_verify = __esm({
  "packages/rn-dev-agent-core/dist/tools/fill-verify.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/tools/device-interact.js
import { execFile as execFileCb11 } from "node:child_process";
import { promisify as promisify13 } from "node:util";
var execFile12;
var init_device_interact = __esm({
  "packages/rn-dev-agent-core/dist/tools/device-interact.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_rn_fast_runner_client();
    init_rn_android_runner_client();
    init_keyboard_guard();
    init_project_config();
    init_utils();
    init_utils();
    init_maestro_invoke();
    init_runner_leak_recovery();
    init_device_session();
    init_fast_runner_ref_map();
    init_fill_verify();
    execFile12 = promisify13(execFileCb11);
  }
});

// packages/rn-dev-agent-core/dist/tools/dev-client-picker.js
var init_dev_client_picker = __esm({
  "packages/rn-dev-agent-core/dist/tools/dev-client-picker.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_platform_utils();
    init_utils();
    init_device_interact();
  }
});

// packages/rn-dev-agent-core/dist/utils.js
var init_utils = __esm({
  "packages/rn-dev-agent-core/dist/utils.js"() {
    "use strict";
    init_agent_device_wrapper();
    init_dev_client_picker();
    init_recovery();
  }
});

// packages/rn-dev-agent-core/dist/runners/free-port.js
var init_free_port = __esm({
  "packages/rn-dev-agent-core/dist/runners/free-port.js"() {
    "use strict";
  }
});

// packages/rn-dev-agent-core/dist/runners/rn-android-runner-client.js
import { spawn as spawn4, execFile as execFile13 } from "node:child_process";
import { promisify as promisify14 } from "node:util";
import { join as join14 } from "node:path";
var execFileAsync2, RN_ANDROID_RUNNER_DIR, GRADLEW, APK_APP, APK_TEST, ANDROID_REBUILD_ROOT, ANDROID_REBUILD_LOCK_DATABASE, ANDROID_REBUILD_LOCK_STALE_MS, fetchImpl2;
var init_rn_android_runner_client = __esm({
  "packages/rn-dev-agent-core/dist/runners/rn-android-runner-client.js"() {
    "use strict";
    init_utils();
    init_fast_runner_ref_map();
    init_free_port();
    init_keyboard_guard();
    init_secure_state_file();
    init_protocol();
    init_runner_artifacts();
    init_runtime_paths();
    init_transport_recovery();
    init_process_birth();
    init_authority_store();
    execFileAsync2 = promisify14(execFile13);
    RN_ANDROID_RUNNER_DIR = resolveNativeRunnerDir("rn-android-runner");
    GRADLEW = join14(RN_ANDROID_RUNNER_DIR, "gradlew");
    APK_APP = join14(RN_ANDROID_RUNNER_DIR, "app", "build", "outputs", "apk", "debug", "app-debug.apk");
    APK_TEST = join14(RN_ANDROID_RUNNER_DIR, "app", "build", "outputs", "apk", "androidTest", "debug", "app-debug-androidTest.apk");
    ANDROID_REBUILD_ROOT = join14(RN_ANDROID_RUNNER_DIR, "app", "build");
    ANDROID_REBUILD_LOCK_DATABASE = join14(ANDROID_REBUILD_ROOT, ".authority-rebuild", "lock.sqlite");
    ANDROID_REBUILD_LOCK_STALE_MS = 15 * 6e4;
    fetchImpl2 = globalThis.fetch;
  }
});

// packages/rn-dev-agent-core/dist/runners/release-android-slot.js
import { execFile as execFileCb12 } from "node:child_process";
import { promisify as promisify15 } from "node:util";
import { homedir as homedir4 } from "node:os";
import { join as join15 } from "node:path";
var execFile14, DAEMON_JSON2, DAEMON_LOCK2, OWNED_PACKAGES;
var init_release_android_slot = __esm({
  "packages/rn-dev-agent-core/dist/runners/release-android-slot.js"() {
    "use strict";
    init_rn_android_runner_client();
    init_agent_device_wrapper();
    execFile14 = promisify15(execFileCb12);
    DAEMON_JSON2 = join15(homedir4(), ".agent-device", "daemon.json");
    DAEMON_LOCK2 = join15(homedir4(), ".agent-device", "daemon.lock");
    OWNED_PACKAGES = [
      "dev.lykhoyda.rndevagent.androidrunner.test",
      "dev.lykhoyda.rndevagent.androidrunner"
    ];
  }
});

// packages/rn-dev-agent-core/dist/rn-session.js
import { randomUUID as randomUUID3 } from "node:crypto";
import { readFileSync as readFileSync10 } from "node:fs";
import { join as join16 } from "node:path";

// packages/rn-dev-agent-core/dist/session/build-receipt.js
import { createHmac, timingSafeEqual } from "node:crypto";
function serialize(payload) {
  return JSON.stringify(payload);
}
function sign(payload, capability) {
  return createHmac("sha256", capability).update(serialize(payload)).digest("hex");
}
function createBuildReceipt(payload, capability) {
  return { version: 1, payload, signature: sign(payload, capability) };
}

// packages/rn-dev-agent-core/dist/session/install-authority.js
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
function runText(command, args) {
  return execFileSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1e4,
    maxBuffer: 8 * 1024 * 1024
  });
}
function runBuffer(command, args) {
  return execFileSync(command, [...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 3e4,
    maxBuffer: 512 * 1024 * 1024
  });
}
function digest(parts) {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${part.byteLength}:`);
    hash.update(part);
  }
  return hash.digest("hex");
}
function generation(parts) {
  return digest(parts.map((part) => Buffer.from(part)));
}
function listAppFiles(appPath) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(relative(appPath, path));
      } else {
        throw new Error("APP_INSTALL_IDENTITY_CHANGED: iOS app contains an unsupported filesystem entry");
      }
    }
  };
  visit(appPath);
  return files.sort();
}
function iosAppFiles(appPath, dependencies) {
  return [...(dependencies.listAppFiles ?? listAppFiles)(appPath)].sort();
}
function assertIosSymlinkContained(appPath, path, realpath) {
  const target = realpath(path);
  const child = relative(realpath(appPath), target);
  if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(child)) {
    throw new Error("APP_INSTALL_IDENTITY_CHANGED: iOS app symlink escapes the installed bundle");
  }
}
function androidApkPaths(target, text) {
  return text("adb", ["-s", target.deviceId, "shell", "pm", "path", target.appId]).split("\n").map((line) => line.trim()).filter((line) => line.startsWith("package:")).map((line) => line.slice("package:".length)).sort();
}
function captureInstallGeneration(target, dependencies = {}) {
  const text = dependencies.runText ?? runText;
  if (target.platform === "ios") {
    const appPath = text("xcrun", [
      "simctl",
      "get_app_container",
      target.deviceId,
      target.appId,
      "app"
    ]).trim();
    if (!appPath) {
      throw new Error("APP_INSTALL_IDENTITY_CHANGED: exact iOS app container was not found");
    }
    const infoPath = join(appPath, "Info.plist");
    const executable = text("plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      infoPath
    ]).trim();
    if (!executable) {
      throw new Error("APP_INSTALL_IDENTITY_CHANGED: iOS executable identity is unavailable");
    }
    const stat = dependencies.stat ?? statSync;
    const metadata2 = iosAppFiles(appPath, dependencies).map((entry) => {
      const path = join(appPath, entry);
      const value = stat(path);
      return `${entry}:${String(value.ino)}:${value.size}:${value.mtimeMs}`;
    });
    return generation(metadata2);
  }
  const apkPaths = androidApkPaths(target, text);
  if (!apkPaths.length) {
    throw new Error("APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found");
  }
  const metadata = text("adb", [
    "-s",
    target.deviceId,
    "shell",
    "stat",
    "-c",
    "%n:%i:%s:%Y",
    ...apkPaths
  ]).split("\n").map((line) => line.trim()).filter(Boolean).sort();
  if (metadata.length !== apkPaths.length) {
    throw new Error("APP_INSTALL_IDENTITY_CHANGED: Android install generation is unavailable");
  }
  return generation(metadata);
}
function captureInstalledArtifact(target, dependencies = {}) {
  const text = dependencies.runText ?? runText;
  const buffer = dependencies.runBuffer ?? runBuffer;
  const read = dependencies.read ?? readFileSync;
  if (target.platform === "ios") {
    const appPath = text("xcrun", [
      "simctl",
      "get_app_container",
      target.deviceId,
      target.appId,
      "app"
    ]).trim();
    if (!appPath) {
      throw new Error("APP_INSTALL_IDENTITY_CHANGED: exact iOS app container was not found");
    }
    const infoPath = join(appPath, "Info.plist");
    const executable = text("plutil", [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      infoPath
    ]).trim();
    if (!executable) {
      throw new Error("APP_INSTALL_IDENTITY_CHANGED: iOS executable identity is unavailable");
    }
    const files = iosAppFiles(appPath, dependencies);
    const lstat = dependencies.lstat ?? lstatSync;
    const readLink = dependencies.readLink ?? readlinkSync;
    const realpath = dependencies.realpath ?? realpathSync;
    const artifactParts = [];
    for (const entry of files) {
      const path = join(appPath, entry);
      const stat = lstat(path);
      artifactParts.push(Buffer.from(entry));
      if (stat.isFile()) {
        artifactParts.push(Buffer.from("file"), read(path));
      } else if (stat.isSymbolicLink()) {
        assertIosSymlinkContained(appPath, path, realpath);
        artifactParts.push(Buffer.from("symlink"), Buffer.from(readLink(path)));
      } else {
        throw new Error("APP_INSTALL_IDENTITY_CHANGED: iOS app contains an unsupported filesystem entry");
      }
    }
    return {
      ...target,
      artifactDigest: digest(artifactParts),
      installGeneration: captureInstallGeneration(target, dependencies)
    };
  }
  const apkPaths = androidApkPaths(target, text);
  if (!apkPaths.length) {
    throw new Error("APP_INSTALL_IDENTITY_CHANGED: exact Android package was not found");
  }
  return {
    ...target,
    artifactDigest: digest(apkPaths.map((path) => buffer("adb", ["-s", target.deviceId, "exec-out", "cat", path]))),
    installGeneration: captureInstallGeneration(target, dependencies)
  };
}

// packages/rn-dev-agent-core/dist/session/metro-authority.js
import { createHmac as createHmac2, createSecretKey, timingSafeEqual as timingSafeEqual2 } from "node:crypto";
function serializePayload(payload) {
  return JSON.stringify(payload);
}
function signPayload(payload, signerCapability) {
  const signingKey = createSecretKey(Buffer.from(signerCapability, "base64url"));
  return createHmac2("sha256", signingKey).update(serializePayload(payload)).digest("hex");
}
function buildSignedMetroMarker(binding, signerCapability) {
  const payload = {
    ...binding,
    authorityScope: "initial-bundle",
    sourceFidelity: "not-proven"
  };
  return { version: 1, payload, signature: signPayload(payload, signerCapability) };
}
function createMetroAuthorityModule(marker) {
  const value = marker ? { status: "signed", marker } : {
    status: "unavailable",
    authorityScope: "initial-bundle",
    sourceFidelity: "not-proven"
  };
  return `globalThis.__RN_DEV_AGENT_AUTHORITY__=${JSON.stringify(value)};
`;
}

// packages/rn-dev-agent-core/dist/rn-session.js
init_metro_binding();

// packages/rn-dev-agent-core/dist/session/managed-metro.js
init_metro_binding();
init_trusted_system_executable();
init_process_birth();
import { execFileSync as execFileSync5, spawn } from "node:child_process";
import { createHash as createHash4, createHmac as createHmac3, timingSafeEqual as timingSafeEqual3 } from "node:crypto";
import { closeSync as closeSync3, existsSync as existsSync4, fstatSync as fstatSync2, mkdirSync as mkdirSync2, openSync as openSync3, readFileSync as readFileSync4, readSync as readSync2, realpathSync as realpathSync5, rmSync as rmSync2 } from "node:fs";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join3, relative as relative2, resolve as resolve3 } from "node:path";

// packages/rn-dev-agent-core/dist/session/authority-json.js
var intrinsicJsonStringify = JSON.stringify;
var intrinsicObjectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var intrinsicObjectGetOwnPropertyNames = Object.getOwnPropertyNames;
var intrinsicObjectGetPrototypeOf = Object.getPrototypeOf;
var intrinsicArrayIsArray = Array.isArray;
var intrinsicArraySort = Array.prototype.sort;
var intrinsicNumberIsFinite = Number.isFinite;
var intrinsicReflectApply = Reflect.apply;
var IntrinsicObject = Object;
var intrinsicObjectPrototype = Object.prototype;
var IntrinsicWeakSet = WeakSet;
var intrinsicWeakSetAdd = WeakSet.prototype.add;
var intrinsicWeakSetDelete = WeakSet.prototype.delete;
var intrinsicWeakSetHas = WeakSet.prototype.has;
function quoted(value) {
  return intrinsicReflectApply(intrinsicJsonStringify, JSON, [value]);
}
function sortedOwnNames(value) {
  const names = intrinsicReflectApply(intrinsicObjectGetOwnPropertyNames, IntrinsicObject, [
    value
  ]);
  const enumerable = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [value, name]);
    if (descriptor?.enumerable)
      enumerable.push(name);
  }
  return intrinsicReflectApply(intrinsicArraySort, enumerable, []);
}
function canonicalAuthorityJson(value) {
  const active = new IntrinsicWeakSet();
  const encode = (candidate) => {
    if (candidate === null)
      return "null";
    if (typeof candidate === "string")
      return quoted(candidate);
    if (typeof candidate === "boolean")
      return candidate ? "true" : "false";
    if (typeof candidate === "number") {
      return intrinsicNumberIsFinite(candidate) ? quoted(candidate) : "null";
    }
    if (typeof candidate !== "object") {
      throw new TypeError("AUTHORITY_JSON_UNSUPPORTED_VALUE");
    }
    if (intrinsicReflectApply(intrinsicWeakSetHas, active, [candidate])) {
      throw new TypeError("AUTHORITY_JSON_CYCLE");
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, active, [candidate]);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized2 = "[";
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0)
            serialized2 += ",";
          const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [candidate, String(index)]);
          if (!descriptor || !("value" in descriptor)) {
            throw new TypeError("AUTHORITY_JSON_ACCESSOR");
          }
          serialized2 += encode(descriptor.value);
        }
        return `${serialized2}]`;
      }
      const prototype = intrinsicReflectApply(intrinsicObjectGetPrototypeOf, IntrinsicObject, [
        candidate
      ]);
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw new TypeError("AUTHORITY_JSON_UNSUPPORTED_OBJECT");
      }
      const names = sortedOwnNames(candidate);
      let serialized = "{";
      for (let index = 0; index < names.length; index += 1) {
        if (index > 0)
          serialized += ",";
        const name = names[index];
        const descriptor = intrinsicReflectApply(intrinsicObjectGetOwnPropertyDescriptor, IntrinsicObject, [candidate, name]);
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError("AUTHORITY_JSON_ACCESSOR");
        }
        serialized += `${quoted(name)}:${encode(descriptor.value)}`;
      }
      return `${serialized}}`;
    } finally {
      intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
    }
  };
  return encode(value);
}

// packages/rn-dev-agent-core/dist/session/managed-metro-enforcement.js
import { spawnSync } from "node:child_process";
import { createHash as createHash3 } from "node:crypto";
import { closeSync as closeSync2, constants as constants2, existsSync as existsSync3, mkdirSync, openSync as openSync2, readFileSync as readFileSync3, realpathSync as realpathSync4, rmSync, statSync as statSync2, symlinkSync, writeSync } from "node:fs";
import { dirname as dirname2, resolve as resolve2 } from "node:path";
var DARWIN_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
var DARWIN_CODESIGN_EXECUTABLE = "/usr/bin/codesign";
function sha256(value) {
  return createHash3("sha256").update(value).digest("hex");
}
function defaultRun2(command, args) {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 25e3
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? ""
  };
}
function field(details, name) {
  const prefix = `${name}=`;
  return details.split("\n").find((line) => line.startsWith(prefix))?.slice(prefix.length).trim() ?? null;
}
function verifiedSandboxExecutable(dependencies) {
  const exists = dependencies.exists ?? existsSync3;
  const canonicalize = dependencies.canonicalize ?? realpathSync4;
  const stat = dependencies.stat ?? statSync2;
  const readBytes = dependencies.readBytes ?? readFileSync3;
  const run = dependencies.run ?? defaultRun2;
  try {
    if (!exists(DARWIN_SANDBOX_EXECUTABLE))
      return null;
    if (canonicalize(DARWIN_SANDBOX_EXECUTABLE) !== DARWIN_SANDBOX_EXECUTABLE)
      return null;
    const metadata = stat(DARWIN_SANDBOX_EXECUTABLE);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 18) !== 0)
      return null;
    const verification = run(DARWIN_CODESIGN_EXECUTABLE, [
      "--verify",
      "--strict",
      DARWIN_SANDBOX_EXECUTABLE
    ]);
    if (verification.status !== 0)
      return null;
    const details = run(DARWIN_CODESIGN_EXECUTABLE, [
      "-dv",
      "--verbose=4",
      DARWIN_SANDBOX_EXECUTABLE
    ]);
    const authorities = details.stderr.split("\n").filter((line) => line.startsWith("Authority="));
    const cdHash = field(details.stderr, "CDHash");
    if (details.status !== 0 || field(details.stderr, "Identifier") !== "com.apple.sandbox-exec" || !/^\d+$/.test(field(details.stderr, "Platform identifier") ?? "") || !/^[a-f0-9]{40,64}$/.test(cdHash ?? "") || !authorities.includes("Authority=Software Signing") || !authorities.includes("Authority=Apple Code Signing Certification Authority") || !authorities.includes("Authority=Apple Root CA")) {
      return null;
    }
    return {
      path: DARWIN_SANDBOX_EXECUTABLE,
      sha256: sha256(readBytes(DARWIN_SANDBOX_EXECUTABLE)),
      cdHash
    };
  } catch {
    return null;
  }
}
function signingIdentity(path, run) {
  const verification = run(DARWIN_CODESIGN_EXECUTABLE, ["--verify", "--strict", path]);
  if (verification.status !== 0)
    return null;
  const details = run(DARWIN_CODESIGN_EXECUTABLE, ["-dv", "--verbose=4", path]);
  const identifier = field(details.stderr, "Identifier");
  const cdHash = field(details.stderr, "CDHash");
  if (details.status !== 0 || !identifier || !/^[a-f0-9]{40,64}$/.test(cdHash ?? "")) {
    return null;
  }
  return {
    identifier,
    cdHash,
    authorities: details.stderr.split("\n").filter((line) => line.startsWith("Authority=")).map((line) => line.slice("Authority=".length)).sort()
  };
}
function defaultRuntimeVersion(nodeExecutable, run) {
  const result = run(nodeExecutable, ["--version"]);
  if (result.status !== 0)
    throw new Error("node version unavailable");
  return result.stdout.trim();
}
function defaultRuntimeFiles(nodeExecutable, run) {
  const result = run("/usr/bin/otool", ["-L", nodeExecutable]);
  if (result.status !== 0)
    throw new Error("node runtime dependencies unavailable");
  return result.stdout.split("\n").slice(1).map((line) => line.trim().split(/\s+\(/, 1)[0]).filter((path) => path.startsWith("/"));
}
function defaultRuntimeCache(exists) {
  const architecture = process.arch === "arm64" ? "arm64e" : process.arch;
  return [
    `/System/Volumes/Preboot/Cryptexes/OS/System/Library/dyld/dyld_shared_cache_${architecture}`,
    `/System/Library/dyld/dyld_shared_cache_${architecture}`
  ].find(exists) ?? null;
}
function attestRuntimeFile(path, dependencies) {
  const canonicalize = dependencies.canonicalize ?? realpathSync4;
  const stat = dependencies.stat ?? statSync2;
  const readBytes = dependencies.readBytes ?? readFileSync3;
  const run = dependencies.run ?? defaultRun2;
  const canonical = canonicalize(path);
  if (!stat(canonical).isFile())
    throw new Error("runtime input is not a file");
  return {
    path: canonical,
    sha256: sha256(readBytes(canonical)),
    signingIdentity: signingIdentity(canonical, run)
  };
}
function attestNodeRuntime(input, executableMappings, dependencies) {
  const run = dependencies.run ?? defaultRun2;
  const exists = dependencies.exists ?? existsSync3;
  const runtimeVersion = dependencies.runtimeVersion?.(input.nodeExecutable) ?? defaultRuntimeVersion(input.nodeExecutable, run);
  if (runtimeVersion !== input.nodeVersion)
    return null;
  try {
    const executable = attestRuntimeFile(input.nodeExecutable, dependencies);
    const linkedRuntimePaths = [
      ...new Set(dependencies.runtimeFiles?.(executable.path) ?? defaultRuntimeFiles(executable.path, run))
    ].sort();
    if (linkedRuntimePaths.length === 0)
      return null;
    const missingRuntimePaths = linkedRuntimePaths.filter((path) => !exists(path));
    if (missingRuntimePaths.some((path) => !path.startsWith("/System/Library/") && !path.startsWith("/usr/lib/"))) {
      return null;
    }
    const runtimeCachePath = missingRuntimePaths.length > 0 ? dependencies.runtimeCache?.() ?? defaultRuntimeCache(exists) : null;
    if (missingRuntimePaths.length > 0 && !runtimeCachePath)
      return null;
    const loadedRuntimeFiles = [executable.path, ...linkedRuntimePaths.filter(exists)].sort().map((path) => attestRuntimeFile(path, dependencies));
    const mappings = [...new Set(executableMappings)].sort().map((path) => attestRuntimeFile(path, dependencies));
    return {
      version: 1,
      executable,
      runtimeVersion,
      linkedRuntimePaths,
      loadedRuntimeFiles,
      sharedRuntimeCache: runtimeCachePath ? attestRuntimeFile(runtimeCachePath, dependencies) : null,
      executableMappings: mappings
    };
  } catch {
    return null;
  }
}
function sandboxString(value) {
  if (value.includes("\0"))
    throw new Error("METRO_RUNTIME_ENFORCEMENT_PATH_INVALID");
  return JSON.stringify(value);
}
function canonicalPath(path, canonicalize) {
  try {
    return canonicalize(path);
  } catch {
    return resolve2(path);
  }
}
function pathFilters(paths) {
  return paths.flatMap((path) => [
    `    (literal ${sandboxString(path)})`,
    `    (subpath ${sandboxString(path)})`
  ]).join("\n");
}
function managedMetroSandboxProfile(input) {
  const readRoots = [...new Set(input.readRoots)].sort();
  const writeRoots = [...new Set(input.writeRoots)].sort();
  const executablePaths = [...new Set(input.executablePaths)].sort();
  const executableMapPaths = [...new Set(input.executableMapPaths)].sort();
  const nativeAddonRoots = [...new Set(input.nativeAddonRoots)].sort();
  const protectedRuntimeRoots = [...new Set(input.protectedRuntimeRoots)].sort();
  const pathAncestors = [.../* @__PURE__ */ new Set([...readRoots, ...writeRoots])].sort();
  return `(version 1)
(deny default)
(import "system.sb")
(allow process-fork)
(allow signal (target children))
(deny network-outbound)
(allow file-map-executable
${executableMapPaths.map((path) => `    (literal ${sandboxString(path)})`).join("\n")})
(allow file-map-executable
${nativeAddonRoots.map((path) => `    (require-all
      (subpath ${sandboxString(path)})
      (extension "node"))`).join("\n")})
(allow process-exec
${executablePaths.map((path) => `    (literal ${sandboxString(path)})`).join("\n")})
(allow file-read* file-test-existence
${pathFilters(readRoots)})
(allow file-read-metadata file-test-existence
${pathAncestors.map((path) => `    (path-ancestors ${sandboxString(path)})`).join("\n")})
(allow file-write* file-test-existence
${pathFilters(writeRoots)})
${protectedRuntimeRoots.length > 0 ? `(deny file-write*
${pathFilters(protectedRuntimeRoots)})` : ""}
(allow network-bind
    (local tcp ${sandboxString(`*:${input.port}`)}))
(allow network-inbound
    (local tcp ${sandboxString(`*:${input.port}`)}))
`;
}
function prepareManagedMetroEnforcement(input, dependencies = {}) {
  if (input.platform !== "darwin") {
    return { status: "unsupported", reason: "host-enforcement-unavailable" };
  }
  const sandbox = verifiedSandboxExecutable(dependencies);
  if (!sandbox) {
    return { status: "unsupported", reason: "sandbox-executable-unverified" };
  }
  const canonicalize = dependencies.canonicalize ?? realpathSync4;
  const sourceRoot = canonicalPath(input.sourceRoot, canonicalize);
  const appRoot = canonicalPath(input.appRoot, canonicalize);
  const runtimeRoot = canonicalPath(input.runtimeRoot, canonicalize);
  const nodeExecutable = canonicalPath(input.nodeExecutable, canonicalize);
  const commandExecutable = canonicalPath(input.commandExecutable, canonicalize);
  const commandArguments = [...input.commandArguments ?? []];
  const commandExecutableMappings = (input.commandExecutableMappings ?? []).map((path) => canonicalPath(path, canonicalize));
  const commandChainInputs = (input.commandChainInputs ?? []).map((path) => canonicalPath(path, canonicalize));
  const protectedRuntimeRoots = (input.protectedRuntimeRoots ?? []).map((path) => canonicalPath(path, canonicalize));
  const nativeAddonRoots = (input.nativeAddonRoots ?? [sourceRoot, appRoot]).map((path) => canonicalPath(path, canonicalize));
  const runtimeInputs = input.runtimeInputs.map((path) => canonicalPath(path, canonicalize));
  const expoStateRoot = resolve2(appRoot, ".expo");
  const readRoots = [
    "/dev/fd",
    sourceRoot,
    appRoot,
    runtimeRoot,
    nodeExecutable,
    commandExecutable,
    ...commandExecutableMappings,
    ...commandChainInputs,
    ...runtimeInputs
  ];
  const executablePaths = [
    nodeExecutable,
    commandExecutable,
    ...commandExecutableMappings,
    "/usr/bin/env"
  ];
  const nodeRuntimeAttestation = attestNodeRuntime({
    ...input,
    nodeExecutable,
    commandExecutable,
    runtimeInputs
  }, executablePaths, dependencies);
  if (!nodeRuntimeAttestation) {
    return { status: "unsupported", reason: "node-runtime-unverified" };
  }
  let commandChainAttestation;
  try {
    commandChainAttestation = [...new Set(commandChainInputs)].sort().map((path) => attestRuntimeFile(path, dependencies));
  } catch {
    return { status: "unsupported", reason: "node-runtime-unverified" };
  }
  const profile = managedMetroSandboxProfile({
    readRoots,
    writeRoots: [runtimeRoot, expoStateRoot],
    executablePaths,
    executableMapPaths: [
      ...nodeRuntimeAttestation.loadedRuntimeFiles.map((entry) => entry.path),
      ...nodeRuntimeAttestation.executableMappings.map((entry) => entry.path)
    ],
    nativeAddonRoots,
    protectedRuntimeRoots,
    port: input.port
  });
  const canaryId = sha256(`${input.instanceId}\0${input.port}`).slice(0, 32);
  return {
    status: "enforced",
    kind: "darwin-seatbelt-v2",
    sandboxExecutable: sandbox.path,
    sandboxExecutableSha256: sandbox.sha256,
    sandboxExecutableCdHash: sandbox.cdHash,
    commandLaunchSha256: sha256(canonicalAuthorityJson({ executable: commandExecutable, arguments: commandArguments })),
    resolvedCommandSha256: sha256(canonicalAuthorityJson({
      executable: commandExecutable,
      arguments: commandArguments
    })),
    profile,
    profileSha256: sha256(profile),
    canaryPath: `/private/tmp/rn-dev-agent-metro-${canaryId}.canary`,
    descendantCanaryPath: resolve2(runtimeRoot, `descendant-${canaryId}.cjs`),
    symlinkCanaryPath: resolve2(runtimeRoot, `enforcement-${canaryId}.canary`),
    port: input.port,
    unallocatedPort: 0,
    nodeExecutable,
    appRoot,
    commandExecutable,
    commandArguments,
    baseNodeOptions: input.baseNodeOptions ?? "",
    preflightEnvironmentPath: resolve2(runtimeRoot, `preflight-environment-${canaryId}.json`),
    nodeRuntimeAttestation,
    commandChainAttestation
  };
}
var PREFLIGHT_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } = require('node:fs');
const { createConnection, createServer } = require('node:net');
const input = JSON.parse(process.argv[1]);
const logicalArgumentPrefix = 'rn-dev-agent-logical-path:';
const denied = (run) => {
  try {
    run();
    return false;
  } catch (error) {
    return error && (error.code === 'EPERM' || error.code === 'EACCES');
  }
};
const unauthorizedResult = spawnSync('/usr/bin/true', []);
const unauthorizedExecutableDenied =
  unauthorizedResult.status === null &&
  unauthorizedResult.error &&
  (unauthorizedResult.error.code === 'EPERM' || unauthorizedResult.error.code === 'EACCES');
const unmanifestedReadDenied = denied(() => readFileSync(input.canaryPath));
const unmanifestedWriteDenied = denied(() => writeFileSync(input.canaryPath, 'forged'));
const symlinkEscapeDenied = denied(() => readFileSync(input.symlinkCanaryPath));
const listen = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', (error) => resolve({ ok: false, code: error.code }));
    server.listen(port, '127.0.0.1', () =>
      server.close((error) => resolve({ ok: !error, code: error && error.code })),
    );
  });
const waitUntil = async (predicate, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};
const processGroupExists = (pid) => {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error && error.code !== 'ESRCH';
  }
};
(async () => {
  const commandSnapshots = [];
  const boundPaths = new Map();
  const argumentPaths = new Set(
    input.commandArguments.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : argument,
    ),
  );
  for (const entry of input.commandChainAttestation) {
    if (!argumentPaths.has(entry.path)) continue;
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(descriptor).size;
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, contents, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    closeSync(descriptor);
    const snapshot = contents.subarray(0, offset);
    if (createHash('sha256').update(snapshot).digest('hex') !== entry.sha256) {
      throw new Error('command-chain identity mismatch');
    }
    boundPaths.set(entry.path, '/dev/fd/' + (10 + commandSnapshots.length));
    commandSnapshots.push(snapshot);
  }
  const allocated = await listen(input.port);
  if (!allocated.ok) throw new Error('allocated listener unavailable before command');
  const commandEnvironment = JSON.parse(readFileSync(input.preflightEnvironmentPath, 'utf8'));
  const stdio = ['ignore', 'ignore', 'ignore', 'ipc'];
  while (stdio.length < 9) stdio.push('ignore');
  stdio[8] = 'pipe';
  stdio.push('pipe');
  stdio.push(...commandSnapshots.map(() => 'pipe'));
  const command = spawn(
    input.commandExecutable,
    input.commandArguments.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : boundPaths.get(argument) ?? argument,
    ),
    {
    cwd: input.appRoot,
    detached: true,
    env: commandEnvironment,
    stdio,
    },
  );
  command.stdio[8].end('admitted\n');
  for (let index = 0; index < commandSnapshots.length; index += 1) {
    command.stdio[10 + index].end(commandSnapshots[index]);
  }
  command.stdio[9].resume();
  command.once('error', () => {});
  const resolvedCommandAllowed = await waitUntil(async () => {
    const probe = await listen(input.port);
    return !probe.ok && probe.code === 'EADDRINUSE';
  }, 15000);
  let commandCleanupConfirmed = false;
  if (Number.isSafeInteger(command.pid)) {
    try {
      command.kill('SIGTERM');
    } catch {}
    try {
      process.kill(-command.pid, 'SIGTERM');
    } catch {}
    await waitUntil(() => command.exitCode !== null, 2000);
    commandCleanupConfirmed = !processGroupExists(command.pid);
    if (!commandCleanupConfirmed) {
      try {
        command.kill('SIGKILL');
      } catch {}
      try {
        process.kill(-command.pid, 'SIGKILL');
      } catch {}
      await waitUntil(() => command.exitCode !== null, 2000);
      commandCleanupConfirmed = !processGroupExists(command.pid);
    }
  }
  const released = await listen(input.port);
  commandCleanupConfirmed = commandCleanupConfirmed && released.ok;
  const commandChainStable = true;
  const descendantCreationAllowed = resolvedCommandAllowed && commandCleanupConfirmed;
  const unallocated = await listen(input.unallocatedPort);
  const networkOutboundDenied = await new Promise((resolve) => {
    const connection = createConnection(input.port, '127.0.0.1');
    connection.once('connect', () => {
      connection.destroy();
      resolve(false);
    });
    connection.once('error', (error) =>
      resolve(error.code === 'EPERM' || error.code === 'EACCES'),
    );
  });
  const receipt = {
    descendantCreationAllowed,
    unauthorizedExecutableDenied: Boolean(unauthorizedExecutableDenied),
    unmanifestedReadDenied,
    unmanifestedWriteDenied,
    symlinkEscapeDenied,
    unallocatedListenerDenied:
      !unallocated.ok && (unallocated.code === 'EPERM' || unallocated.code === 'EACCES'),
    allocatedListenerAllowed: allocated.ok,
    networkOutboundDenied,
    resolvedCommandAllowed,
    commandCleanupConfirmed,
    commandChainStable,
  };
  process.stdout.write(JSON.stringify(receipt));
  process.exit(Object.values(receipt).every(Boolean) ? 0 : 1);
})().catch(() => process.exit(1));
`;
function runManagedMetroEnforcementPreflight(plan, dependencies = {}) {
  const writeCanary = dependencies.writeCanary ?? ((path, contents) => {
    const descriptor = openSync2(path, constants2.O_WRONLY | constants2.O_CREAT | constants2.O_EXCL | (constants2.O_NOFOLLOW ?? 0), 384);
    try {
      writeSync(descriptor, contents);
    } finally {
      closeSync2(descriptor);
    }
  });
  const removeCanary = dependencies.removeCanary ?? ((path) => rmSync(path, { force: true }));
  const run = dependencies.run ?? defaultRun2;
  let canaryCreated = false;
  let environmentCreated = false;
  let symlinkCreated = false;
  try {
    writeCanary(plan.canaryPath, "rn-dev-agent sandbox canary");
    canaryCreated = true;
    mkdirSync(dirname2(plan.preflightEnvironmentPath), { recursive: true });
    const preflightEnvironment = Object.fromEntries(Object.entries(dependencies.environment ?? process.env));
    preflightEnvironment.NODE_OPTIONS = plan.baseNodeOptions;
    delete preflightEnvironment.RN_DEV_AGENT_METRO_EVIDENCE_FD;
    delete preflightEnvironment.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT;
    writeCanary(plan.preflightEnvironmentPath, canonicalAuthorityJson(preflightEnvironment));
    environmentCreated = true;
    mkdirSync(dirname2(plan.symlinkCanaryPath), { recursive: true });
    rmSync(plan.symlinkCanaryPath, { force: true });
    symlinkSync(plan.canaryPath, plan.symlinkCanaryPath);
    symlinkCreated = true;
    const result = run(plan.sandboxExecutable, [
      "-p",
      plan.profile,
      plan.nodeExecutable,
      "-e",
      PREFLIGHT_SOURCE,
      JSON.stringify({
        canaryPath: plan.canaryPath,
        symlinkCanaryPath: plan.symlinkCanaryPath,
        commandExecutable: plan.commandExecutable,
        commandArguments: plan.commandArguments,
        commandChainAttestation: plan.commandChainAttestation,
        preflightEnvironmentPath: plan.preflightEnvironmentPath,
        appRoot: plan.appRoot,
        port: plan.port,
        unallocatedPort: plan.unallocatedPort
      })
    ]);
    if (result.status !== 0) {
      throw new Error("METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight failed");
    }
    const observed = JSON.parse(result.stdout);
    if (observed.descendantCreationAllowed !== true || observed.unauthorizedExecutableDenied !== true || observed.unmanifestedReadDenied !== true || observed.unmanifestedWriteDenied !== true || observed.symlinkEscapeDenied !== true || observed.unallocatedListenerDenied !== true || observed.allocatedListenerAllowed !== true || observed.networkOutboundDenied !== true || observed.resolvedCommandAllowed !== true || observed.commandCleanupConfirmed !== true || observed.commandChainStable !== true) {
      throw new Error("METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is incomplete");
    }
    return {
      version: 2,
      kind: plan.kind,
      profileSha256: plan.profileSha256,
      sandboxExecutableSha256: plan.sandboxExecutableSha256,
      sandboxExecutableCdHash: plan.sandboxExecutableCdHash,
      commandLaunchSha256: plan.commandLaunchSha256,
      resolvedCommandSha256: plan.resolvedCommandSha256,
      descendantCreationAllowed: true,
      unauthorizedExecutableDenied: true,
      unmanifestedReadDenied: true,
      unmanifestedWriteDenied: true,
      symlinkEscapeDenied: true,
      unallocatedListenerDenied: true,
      allocatedListenerAllowed: true,
      networkOutboundDenied: true,
      resolvedCommandAllowed: true,
      commandCleanupConfirmed: true,
      commandChainStable: true,
      nodeRuntimeAttestation: plan.nodeRuntimeAttestation,
      commandChainAttestation: plan.commandChainAttestation
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("METRO_RUNTIME_ENFORCEMENT_")) {
      throw error;
    }
    throw new Error("METRO_RUNTIME_ENFORCEMENT_UNAVAILABLE: sandbox preflight is invalid", {
      cause: error
    });
  } finally {
    if (symlinkCreated)
      rmSync(plan.symlinkCanaryPath, { force: true });
    if (environmentCreated)
      removeCanary(plan.preflightEnvironmentPath);
    if (canaryCreated)
      removeCanary(plan.canaryPath);
  }
}

// packages/rn-dev-agent-core/dist/session/managed-metro.js
var METRO_LAUNCHER_SOURCE = String.raw`
const { spawn, spawnSync } = require('node:child_process');
const { createHash, createHmac } = require('node:crypto');
const { chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } = require('node:fs');
const { createServer } = require('node:net');
const { basename, dirname, isAbsolute, relative, sep } = require('node:path');
const intrinsicJsonStringify = JSON.stringify;
const intrinsicGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const intrinsicGetOwnPropertyNames = Object.getOwnPropertyNames;
const intrinsicGetPrototypeOf = Object.getPrototypeOf;
const intrinsicArrayIsArray = Array.isArray;
const intrinsicArraySort = Array.prototype.sort;
const intrinsicNumberIsFinite = Number.isFinite;
const intrinsicReflectApply = Reflect.apply;
const intrinsicObjectPrototype = Object.prototype;
const IntrinsicObject = Object;
const IntrinsicWeakSet = WeakSet;
const intrinsicWeakSetAdd = WeakSet.prototype.add;
const intrinsicWeakSetDelete = WeakSet.prototype.delete;
const intrinsicWeakSetHas = WeakSet.prototype.has;
function canonicalAuthorityJson(value) {
  const active = new IntrinsicWeakSet();
  const encode = (candidate) => {
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') {
      return intrinsicReflectApply(intrinsicJsonStringify, JSON, [candidate]);
    }
    if (typeof candidate === 'number') {
      return intrinsicNumberIsFinite(candidate)
        ? intrinsicReflectApply(intrinsicJsonStringify, JSON, [candidate])
        : 'null';
    }
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate !== 'object') throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_VALUE');
    if (intrinsicReflectApply(intrinsicWeakSetHas, active, [candidate])) {
      throw new TypeError('AUTHORITY_JSON_CYCLE');
    }
    intrinsicReflectApply(intrinsicWeakSetAdd, active, [candidate]);
    try {
      if (intrinsicArrayIsArray(candidate)) {
        let serialized = '[';
        for (let index = 0; index < candidate.length; index += 1) {
          if (index > 0) serialized += ',';
          const descriptor = intrinsicReflectApply(
            intrinsicGetOwnPropertyDescriptor,
            IntrinsicObject,
            [candidate, String(index)],
          );
          if (!descriptor || !('value' in descriptor)) throw new TypeError('AUTHORITY_JSON_ACCESSOR');
          serialized += encode(descriptor.value);
        }
        return serialized + ']';
      }
      const prototype = intrinsicReflectApply(
        intrinsicGetPrototypeOf,
        IntrinsicObject,
        [candidate],
      );
      if (prototype !== intrinsicObjectPrototype && prototype !== null) {
        throw new TypeError('AUTHORITY_JSON_UNSUPPORTED_OBJECT');
      }
      const names = intrinsicReflectApply(
        intrinsicGetOwnPropertyNames,
        IntrinsicObject,
        [candidate],
      );
      const enumerable = [];
      for (let index = 0; index < names.length; index += 1) {
        const descriptor = intrinsicReflectApply(
          intrinsicGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, names[index]],
        );
        if (descriptor?.enumerable) enumerable.push(names[index]);
      }
      intrinsicReflectApply(intrinsicArraySort, enumerable, []);
      let serialized = '{';
      for (let index = 0; index < enumerable.length; index += 1) {
        if (index > 0) serialized += ',';
        const name = enumerable[index];
        const descriptor = intrinsicReflectApply(
          intrinsicGetOwnPropertyDescriptor,
          IntrinsicObject,
          [candidate, name],
        );
        if (!descriptor || !('value' in descriptor)) throw new TypeError('AUTHORITY_JSON_ACCESSOR');
        serialized +=
          intrinsicReflectApply(intrinsicJsonStringify, JSON, [name]) +
          ':' +
          encode(descriptor.value);
      }
      return serialized + '}';
    } finally {
      intrinsicReflectApply(intrinsicWeakSetDelete, active, [candidate]);
    }
  };
  return encode(value);
}
const launcherDiagnosticPath = process.env.RN_DEV_AGENT_METRO_LAUNCHER_DIAGNOSTIC;
function failLauncher(code, stage, detail) {
  const diagnostic = { version: 1, code, stage, detail };
  if (launcherDiagnosticPath) {
    try {
      writeFileSync(launcherDiagnosticPath, intrinsicJsonStringify(diagnostic), {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {}
  }
  try {
    process.stderr.write(code + ': stage=' + stage + '; detail=' + detail + '\n');
  } catch {}
  process.exit(1);
}
const executable = process.env.RN_DEV_AGENT_METRO_EXECUTABLE;
let args;
try {
  args = JSON.parse(process.env.RN_DEV_AGENT_METRO_ARGS || '[]');
} catch {
  failLauncher('METRO_LAUNCHER_ENVIRONMENT_INVALID', 'environment', 'arguments-invalid');
}
const evidencePath = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE;
const evidenceSocket = process.env.RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET;
const policyPath = process.env.RN_DEV_AGENT_METRO_RUNTIME_POLICY;
const capability = process.env.RN_DEV_AGENT_METRO_POLICY_CAPABILITY;
const sessionId = process.env.RN_DEV_AGENT_SESSION_ID;
const metroInstanceId = process.env.RN_DEV_AGENT_METRO_INSTANCE_ID;
const childNodeOptions = process.env.RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS;
const contentRoot = process.env.RN_DEV_AGENT_METRO_CONTENT_ROOT;
const appRoot = process.env.RN_DEV_AGENT_METRO_APP_ROOT;
const childEnvironmentSource = process.env.RN_DEV_AGENT_METRO_CHILD_ENVIRONMENT;
const runtimeManifestSource = process.env.RN_DEV_AGENT_METRO_RUNTIME_MANIFEST;
const runtimeEnforcementSource = process.env.RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT;
const nativeAddonAcknowledgmentRoot = process.env.RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT;
const requiredEnvironment = [
  [launcherDiagnosticPath, 'diagnostic-path-missing'],
  [executable, 'executable-missing'],
  [evidencePath, 'evidence-path-missing'],
  [evidenceSocket, 'evidence-socket-missing'],
  [policyPath, 'policy-path-missing'],
  [capability, 'policy-capability-missing'],
  [sessionId, 'session-id-missing'],
  [metroInstanceId, 'metro-instance-id-missing'],
  [childNodeOptions, 'child-node-options-missing'],
  [contentRoot, 'content-root-missing'],
  [appRoot, 'app-root-missing'],
  [childEnvironmentSource, 'child-environment-missing'],
  [runtimeManifestSource, 'runtime-manifest-missing'],
  [runtimeEnforcementSource, 'runtime-enforcement-missing'],
  [nativeAddonAcknowledgmentRoot, 'native-addon-ack-root-missing'],
];
const missingEnvironment = requiredEnvironment.find(([value]) => !value);
if (missingEnvironment) {
  failLauncher(
    'METRO_LAUNCHER_ENVIRONMENT_INVALID',
    'environment',
    missingEnvironment[1],
  );
}
const policyDirectoryPath = dirname(policyPath);
const policyName = basename(policyPath);
const launcherWorkingDirectory = process.cwd();
let policyDirectoryDescriptor;
let policyDescriptor;
let policyDirectoryIdentity;
let policyIdentity;
try {
  policyDirectoryDescriptor = openSync(
    policyDirectoryPath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  policyDirectoryIdentity = fstatSync(policyDirectoryDescriptor, { bigint: true });
  if (!policyDirectoryIdentity.isDirectory()) throw new Error('policy-directory-not-regular');
  process.chdir(policyDirectoryPath);
  const boundDirectory = statSync('.', { bigint: true });
  if (
    boundDirectory.dev !== policyDirectoryIdentity.dev ||
    boundDirectory.ino !== policyDirectoryIdentity.ino
  ) {
    throw new Error('policy-directory-identity-mismatch');
  }
  policyDescriptor = openSync(
    policyName,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  policyIdentity = fstatSync(policyDescriptor, { bigint: true });
  const publishedPolicy = lstatSync(policyPath, { bigint: true });
  if (
    !policyIdentity.isFile() ||
    policyIdentity.nlink !== 1n ||
    publishedPolicy.dev !== policyIdentity.dev ||
    publishedPolicy.ino !== policyIdentity.ino
  ) {
    throw new Error('policy-file-identity-mismatch');
  }
  fchmodSync(policyDescriptor, 0o600);
  process.chdir(launcherWorkingDirectory);
} catch (error) {
  try {
    process.chdir(launcherWorkingDirectory);
  } catch {}
  const detail =
    error instanceof Error && /^policy-[a-z-]+$/.test(error.message)
      ? error.message
      : 'policy-binding-failed';
  failLauncher(
    'METRO_LAUNCHER_POLICY_UNAVAILABLE',
    'policy-binding',
    detail,
  );
}
function assertPolicyIdentity() {
  const retainedDirectory = fstatSync(policyDirectoryDescriptor, { bigint: true });
  const retainedPolicy = fstatSync(policyDescriptor, { bigint: true });
  const publishedPolicy = lstatSync(policyPath, { bigint: true });
  if (
    !retainedDirectory.isDirectory() ||
    retainedDirectory.dev !== policyDirectoryIdentity.dev ||
    retainedDirectory.ino !== policyDirectoryIdentity.ino ||
    !retainedPolicy.isFile() ||
    retainedPolicy.nlink !== 1n ||
    retainedPolicy.dev !== policyIdentity.dev ||
    retainedPolicy.ino !== policyIdentity.ino ||
    publishedPolicy.dev !== policyIdentity.dev ||
    publishedPolicy.ino !== policyIdentity.ino
  ) {
    throw new Error('policy-publication-identity-mismatch');
  }
}
let runtimeManifest;
let runtimeEnforcement;
try {
  runtimeManifest = JSON.parse(runtimeManifestSource);
  runtimeEnforcement = JSON.parse(runtimeEnforcementSource);
} catch {
  failLauncher('METRO_LAUNCHER_ENVIRONMENT_INVALID', 'environment', 'manifest-invalid');
}
const logicalArgumentPrefix = 'rn-dev-agent-logical-path:';
const enforcementReceipt = runtimeEnforcement.receipt;
const snapshotAttestedFiles = (entries, arguments_, firstDescriptor) => {
  if (!Array.isArray(entries)) throw new Error('invalid command-chain attestation');
  const snapshots = [];
  const paths = new Map();
  const argumentPaths = new Set(
    arguments_.map((argument) =>
      argument.startsWith(logicalArgumentPrefix)
        ? argument.slice(logicalArgumentPrefix.length)
        : argument,
    ),
  );
  for (const entry of entries) {
    if (typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      throw new Error('invalid command-chain attestation');
    }
    const descriptor = openSync(entry.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const size = fstatSync(descriptor).size;
    const contents = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, contents, offset, size - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    closeSync(descriptor);
    const snapshot = contents.subarray(0, offset);
    if (createHash('sha256').update(snapshot).digest('hex') !== entry.sha256) {
      throw new Error('command-chain identity mismatch');
    }
    if (!argumentPaths.has(entry.path)) continue;
    paths.set(entry.path, '/dev/fd/' + (firstDescriptor + snapshots.length));
    snapshots.push(snapshot);
  }
  return { snapshots, paths };
};
const liveCodeIdentityMatches = (pid, identity) => {
  if (
    !Number.isSafeInteger(pid) ||
    !identity ||
    typeof identity.identifier !== 'string' ||
    typeof identity.cdHash !== 'string'
  ) {
    return false;
  }
  const verification = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '+' + pid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (verification.status !== 0) return false;
  const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', '+' + pid], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (details.status !== 0) return false;
  const fields = new Map(
    details.stderr
      .split('\n')
      .filter((line) => line.includes('='))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1).trim()];
      }),
  );
  return (
    fields.get('Identifier') === identity.identifier &&
    fields.get('CDHash') === identity.cdHash
  );
};
const waitForLiveCodeIdentity = (pid, identity) => {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (liveCodeIdentityMatches(pid, identity)) return true;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  return false;
};
let child;
let commandChainSnapshot = null;
try {
  commandChainSnapshot = snapshotAttestedFiles(
    enforcementReceipt?.commandChainAttestation ?? [],
    args,
    10,
  );
} catch {
  commandChainSnapshot = null;
}
let managedSandbox =
  runtimeEnforcement.status === 'enforced' &&
  runtimeEnforcement.kind === 'darwin-seatbelt-v2' &&
  runtimeEnforcement.sandboxExecutable === '/usr/bin/sandbox-exec' &&
  typeof runtimeEnforcement.profile === 'string' &&
  /^[a-f0-9]{64}$/.test(runtimeEnforcement.profileSha256 || '') &&
  createHash('sha256').update(runtimeEnforcement.profile).digest('hex') ===
    runtimeEnforcement.profileSha256 &&
  enforcementReceipt?.version === 2 &&
  enforcementReceipt.kind === runtimeEnforcement.kind &&
  enforcementReceipt.profileSha256 === runtimeEnforcement.profileSha256 &&
  enforcementReceipt.sandboxExecutableSha256 ===
    runtimeEnforcement.sandboxExecutableSha256 &&
  enforcementReceipt.sandboxExecutableCdHash ===
    runtimeEnforcement.sandboxExecutableCdHash &&
  enforcementReceipt.commandLaunchSha256 === runtimeEnforcement.commandLaunchSha256 &&
  enforcementReceipt.resolvedCommandSha256 === runtimeEnforcement.resolvedCommandSha256 &&
  enforcementReceipt.descendantCreationAllowed === true &&
  enforcementReceipt.unauthorizedExecutableDenied === true &&
  enforcementReceipt.unmanifestedReadDenied === true &&
  enforcementReceipt.unmanifestedWriteDenied === true &&
  enforcementReceipt.symlinkEscapeDenied === true &&
  enforcementReceipt.unallocatedListenerDenied === true &&
  enforcementReceipt.allocatedListenerAllowed === true &&
  enforcementReceipt.networkOutboundDenied === true &&
  enforcementReceipt.resolvedCommandAllowed === true &&
  enforcementReceipt.commandCleanupConfirmed === true &&
  enforcementReceipt.commandChainStable === true &&
  commandChainSnapshot !== null &&
  canonicalAuthorityJson(enforcementReceipt.nodeRuntimeAttestation) ===
    canonicalAuthorityJson(runtimeEnforcement.nodeRuntimeAttestation) &&
  canonicalAuthorityJson(enforcementReceipt.commandChainAttestation) ===
    canonicalAuthorityJson(runtimeEnforcement.commandChainAttestation);
let runtimeEvidenceAuthority = managedSandbox ? 'managed-sandbox-v1' : 'reported-v1';
const evidenceDescriptor = 9;
let journalDescriptor;
try {
  journalDescriptor = openSync(evidencePath, 'w', 0o600);
} catch {
  failLauncher('METRO_LAUNCHER_EVIDENCE_UNAVAILABLE', 'evidence-journal', 'journal-open-failed');
}
let sequence = 0;
let previousSignature = null;
let buffered = '';
function appendEvidence(payload) {
  const chainedPayload = {
    ...payload,
    runtimeEvidenceAuthority,
    sequence: ++sequence,
    previousSignature,
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(chainedPayload))
    .digest('hex');
  writeSync(
    journalDescriptor,
    canonicalAuthorityJson({ ...chainedPayload, signature }) + '\n',
  );
  previousSignature = signature;
}
const violations = [];
function publishPolicy() {
  const payload = {
    version: 1,
    runtimeEvidenceAuthority,
    sessionId,
    metroInstanceId,
    contentRoot,
    appRoot,
    runtimeEnforcement: managedSandbox ? 'os-enforced-v1' : 'unsupported',
    runtimeEnforcementReceipt: managedSandbox ? enforcementReceipt : null,
    runtimeManifest,
    runtimeInputs: runtimeManifest.runtimeInputs,
    violations: [...violations],
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(payload))
    .digest('hex');
  const publication = Buffer.from(
    canonicalAuthorityJson({ ...payload, signature }) + '\n',
    'utf8',
  );
  assertPolicyIdentity();
  ftruncateSync(policyDescriptor, 0);
  let offset = 0;
  while (offset < publication.length) {
    offset += writeSync(
      policyDescriptor,
      publication,
      offset,
      publication.length - offset,
      offset,
    );
  }
  fsyncSync(policyDescriptor);
  assertPolicyIdentity();
}
function appendViolation(value) {
  if (!violations.includes(value)) violations.push(value);
  publishPolicy();
  appendEvidence({
    version: 1,
    sessionId,
    metroInstanceId,
    kind: 'violation',
    value,
    digest: null,
  });
}
function publishNativeAddonAcknowledgment(requestId, acknowledgment) {
  writeFileSync(
    nativeAddonAcknowledgmentRoot + '/' + requestId + '.json',
    canonicalAuthorityJson({ version: 1, requestId, ...acknowledgment }),
    { encoding: 'utf8', flag: 'wx', mode: 0o400 },
  );
}
const pendingNativeAddons = new Map();
function digestNativeAddon(candidate) {
  const sourceDescriptor = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = fstatSync(sourceDescriptor);
    if (!initial.isFile()) {
      const error = new Error('native addon is not a regular file');
      error.code = 'NATIVE_ADDON_NOT_REGULAR';
      throw error;
    }
    if (initial.size > 128 * 1024 * 1024) {
      const error = new Error('native addon exceeds the 128 MiB evidence limit');
      error.code = 'NATIVE_ADDON_TOO_LARGE';
      throw error;
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < initial.size) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        Math.min(buffer.length, initial.size - position),
        position,
      );
      if (bytesRead === 0 || position + bytesRead > 128 * 1024 * 1024) {
        const error = new Error('native addon changed while reading evidence');
        error.code = 'NATIVE_ADDON_CHANGED';
        throw error;
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    if (readSync(sourceDescriptor, buffer, 0, 1, position) !== 0) {
      const error = new Error('native addon changed while reading evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    const final = fstatSync(sourceDescriptor);
    if (
      final.dev !== initial.dev ||
      final.ino !== initial.ino ||
      final.size !== initial.size ||
      final.mtimeMs !== initial.mtimeMs ||
      final.ctimeMs !== initial.ctimeMs
    ) {
      const error = new Error('native addon changed while reading evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    return hash.digest('hex');
  } finally {
    closeSync(sourceDescriptor);
  }
}
function runtimeInputWithinRoot(candidate, root) {
  const nested = relative(root, candidate);
  return nested === '' || (
    nested !== '..' &&
    !nested.startsWith('..' + sep) &&
    !isAbsolute(nested)
  );
}
function handleNativeAddonRequest(payload) {
  let request;
  try {
    request = JSON.parse(payload.value);
    if (
      !request ||
      !/^[a-f0-9]{32}$/.test(request.requestId || '') ||
      typeof request.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(request.digest || '')
    ) {
      throw new Error('invalid request');
    }
    const candidate = realpathSync(request.path);
    const allowedRoots = runtimeManifest.nativeAddonRoots;
    if (
      !Array.isArray(allowedRoots) ||
      !allowedRoots.some(
        (root) => typeof root === 'string' && runtimeInputWithinRoot(candidate, root),
      )
    ) {
      const error = new Error('outside:' + basename(request.path));
      error.code = 'NATIVE_ADDON_OUTSIDE_ROOTS';
      throw error;
    }
    const digest = digestNativeAddon(candidate);
    if (digest !== request.digest) {
      const error = new Error('native addon changed before signed evidence');
      error.code = 'NATIVE_ADDON_CHANGED';
      throw error;
    }
    appendEvidence({
      version: 1,
      sessionId,
      metroInstanceId,
      kind: 'input',
      value: candidate,
      digest,
    });
    fsyncSync(journalDescriptor);
    pendingNativeAddons.set(request.requestId, { path: candidate, digest });
    publishNativeAddonAcknowledgment(request.requestId, {
      accepted: true,
      digest,
      path: candidate,
      reason: null,
    });
  } catch (error) {
    const reason =
      error?.code === 'NATIVE_ADDON_OUTSIDE_ROOTS'
        ? 'RN_DEV_AGENT_UNSUPPORTED_NATIVE_ADDON: ' + error.message
        : 'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' +
          (error instanceof Error ? error.message : 'native addon bytes could not be verified');
    appendViolation(reason);
    if (request && /^[a-f0-9]{32}$/.test(request.requestId || '')) {
      try {
        publishNativeAddonAcknowledgment(request.requestId, {
          accepted: false,
          digest: typeof request.digest === 'string' ? request.digest : null,
          path: null,
          reason,
        });
      } catch {}
    }
  }
}
function handleNativeAddonCompletion(payload) {
  let completion;
  try {
    completion = JSON.parse(payload.value);
    if (
      !completion ||
      !/^[a-f0-9]{32}$/.test(completion.requestId || '') ||
      typeof completion.path !== 'string' ||
      !/^[a-f0-9]{64}$/.test(completion.digest || '') ||
      !['success', 'failure'].includes(completion.outcome)
    ) {
      throw new Error('completion record is invalid');
    }
    const pending = pendingNativeAddons.get(completion.requestId);
    if (
      !pending ||
      pending.path !== completion.path ||
      pending.digest !== completion.digest ||
      digestNativeAddon(pending.path) !== pending.digest
    ) {
      throw new Error('native addon changed during load');
    }
    pendingNativeAddons.delete(completion.requestId);
    rmSync(nativeAddonAcknowledgmentRoot + '/' + completion.requestId + '.json', {
      force: true,
    });
    if (completion.outcome === 'success') {
      appendEvidence({
        version: 1,
        sessionId,
        metroInstanceId,
        kind: 'stability',
        value: pending.path,
        digest: pending.digest,
      });
    } else {
      appendViolation('METRO_NATIVE_ADDON_LOAD_FAILED: ' + basename(pending.path));
    }
  } catch (error) {
    if (completion && /^[a-f0-9]{32}$/.test(completion.requestId || '')) {
      pendingNativeAddons.delete(completion.requestId);
      rmSync(nativeAddonAcknowledgmentRoot + '/' + completion.requestId + '.json', {
        force: true,
      });
    }
    appendViolation(
      'METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: ' +
        (error instanceof Error ? error.message : 'native addon stability could not be verified'),
    );
  }
}
if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
const headConnections = new Set();
const pendingHeads = new Map();
function closeHeadConnection(connection) {
  headConnections.delete(connection);
  for (const [challenge, pending] of pendingHeads) {
    if (pending === connection) pendingHeads.delete(challenge);
  }
}
function respondWithHead(connection, challenge) {
  if (pendingNativeAddons.size > 0) {
    connection.destroy();
    return;
  }
  const payload = {
    version: 1,
    runtimeEvidenceAuthority,
    sessionId,
    metroInstanceId,
    challenge,
    sequence,
    journalSignature: previousSignature,
  };
  const signature = createHmac('sha256', capability)
    .update(canonicalAuthorityJson(payload))
    .digest('hex');
  connection.end(canonicalAuthorityJson({ ...payload, signature }) + '\n');
}
const headServer = createServer((connection) => {
  headConnections.add(connection);
  let request = '';
  connection.setEncoding('utf8');
  connection.setTimeout(1500, () => connection.destroy());
  connection.once('close', () => closeHeadConnection(connection));
  connection.on('data', (chunk) => {
    request += chunk;
    if (request.length > 256) {
      connection.destroy();
      return;
    }
    const newline = request.indexOf('\n');
    if (newline < 0) return;
    const challenge = request.slice(0, newline);
    if (!/^[a-f0-9]{64}$/.test(challenge)) {
      connection.destroy();
      return;
    }
    if (pendingHeads.has(challenge) || evidenceFinished || !child?.connected) {
      connection.destroy();
      return;
    }
    pendingHeads.set(challenge, connection);
    try {
      child.send({ type: 'rn-dev-agent:evidence-barrier', challenge }, (error) => {
        if (error) connection.destroy();
      });
    } catch {
      connection.destroy();
    }
  });
});
headServer.once('error', () =>
  failLauncher(
    'METRO_LAUNCHER_EVIDENCE_UNAVAILABLE',
    'evidence-listener',
    'evidence-listener-error',
  ),
);
headServer.listen(evidenceSocket, () => {
  if (process.platform !== 'win32') chmodSync(evidenceSocket, 0o600);
});
const childEnvironment = JSON.parse(childEnvironmentSource);
const environmentDigest = createHash('sha256')
  .update(canonicalAuthorityJson(childEnvironment))
  .digest('hex');
if (environmentDigest !== runtimeManifest.environmentDigest) {
  failLauncher(
    'METRO_LAUNCHER_ENVIRONMENT_INVALID',
    'environment-digest',
    'child-environment-mismatch',
  );
}
if (runtimeEnforcement.status === 'enforced' && !managedSandbox) {
  failLauncher(
    'METRO_LAUNCHER_ENFORCEMENT_REFUSED',
    'enforcement',
    'sandbox-admission-invalid',
  );
}
const sandboxExecutable = runtimeEnforcement.sandboxExecutable;
const boundArgs = args.map((argument) =>
  argument.startsWith(logicalArgumentPrefix)
    ? argument.slice(logicalArgumentPrefix.length)
    : commandChainSnapshot?.paths.get(argument) ?? argument,
);
const sandboxArgs = managedSandbox
  ? ['-p', runtimeEnforcement.profile, executable, ...boundArgs]
  : boundArgs;
child = spawn(managedSandbox ? sandboxExecutable : executable, sandboxArgs, {
  cwd: process.cwd(),
  env: childEnvironment,
  stdio: [
    'inherit',
    'inherit',
    'inherit',
    'ipc',
    'ignore',
    'ignore',
    'ignore',
    'ignore',
    'pipe',
    'pipe',
    ...(commandChainSnapshot?.snapshots.map(() => 'pipe') ?? []),
  ],
});
if (!Number.isSafeInteger(child.pid)) {
  failLauncher(
    'METRO_LAUNCHER_CHILD_SPAWN_FAILED',
    'child-spawn',
    'child-pid-unavailable',
  );
}
for (let index = 0; index < (commandChainSnapshot?.snapshots.length ?? 0); index += 1) {
  child.stdio[10 + index].end(commandChainSnapshot.snapshots[index]);
}
if (
  managedSandbox &&
  !waitForLiveCodeIdentity(
    child.pid,
    enforcementReceipt.commandChainAttestation?.find(
      (entry) => entry.path === executable,
    )?.signingIdentity,
  )
) {
  managedSandbox = false;
  runtimeEvidenceAuthority = 'reported-v1';
  appendViolation('Metro command executable kernel identity did not match attestation');
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
  failLauncher(
    'METRO_LAUNCHER_ENFORCEMENT_REFUSED',
    'child-admission',
    'command-identity-mismatch',
  );
}
child.stdio[8].end('admitted\n');
runtimeManifest.descendantAuthority.rootIdentity = 'process:' + child.pid;
appendEvidence({
  version: 1,
  sessionId,
  metroInstanceId,
  kind: 'semantics',
  value: canonicalAuthorityJson(runtimeManifest),
  digest: null,
});
publishPolicy();
const evidence = child.stdio[evidenceDescriptor];
let childOutcome = null;
let evidenceFinished = false;
let launcherFinished = false;
function finishLauncher() {
  if (launcherFinished || childOutcome === null || !evidenceFinished) return;
  launcherFinished = true;
  if (buffered) appendViolation('Metro runtime evidence record is incomplete');
  for (const requestId of pendingNativeAddons.keys()) {
    pendingNativeAddons.delete(requestId);
    rmSync(nativeAddonAcknowledgmentRoot + '/' + requestId + '.json', { force: true });
    appendViolation('METRO_NATIVE_ADDON_EVIDENCE_UNAVAILABLE: stability receipt is missing');
  }
  for (const connection of headConnections) connection.destroy();
  pendingHeads.clear();
  closeSync(journalDescriptor);
  headServer.close(() => {
    if (process.platform !== 'win32') rmSync(evidenceSocket, { force: true });
    process.exit(childOutcome.signal ? 1 : childOutcome.code);
  });
}
function finishEvidence() {
  if (evidenceFinished) return;
  if (child.exitCode === null && child.signalCode === null) {
    appendViolation('Metro runtime evidence stream ended before Metro exited');
  }
  evidenceFinished = true;
  finishLauncher();
}
evidence.setEncoding('utf8');
evidence.on('data', (chunk) => {
  buffered += chunk;
  if (buffered.length > 1024 * 1024) {
    appendViolation('Metro runtime evidence record exceeds the limit');
    buffered = '';
    return;
  }
  let newline;
  while ((newline = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (!line) continue;
    try {
      const payload = JSON.parse(line);
      if (
        payload.version !== 1 ||
        payload.sessionId !== sessionId ||
        payload.metroInstanceId !== metroInstanceId ||
        ![
          'input',
          'violation',
          'launch',
          'attestation',
          'semantics',
          'pending',
          'completion',
          'barrier',
          'native-addon-request',
          'native-addon-completion',
          'stability',
        ].includes(payload.kind) ||
        typeof payload.value !== 'string' ||
        (payload.kind === 'input' || payload.kind === 'stability'
          ? typeof payload.digest !== 'string'
          : payload.digest !== null)
      ) {
        throw new Error('invalid evidence');
      }
      if (payload.kind === 'native-addon-request') {
        handleNativeAddonRequest(payload);
        continue;
      }
      if (payload.kind === 'native-addon-completion') {
        handleNativeAddonCompletion(payload);
        continue;
      }
      if (payload.kind === 'barrier') {
        const connection = pendingHeads.get(payload.value);
        if (connection) {
          pendingHeads.delete(payload.value);
          respondWithHead(connection, payload.value);
        }
        continue;
      }
      if (payload.kind === 'violation') {
        appendViolation(payload.value);
        continue;
      }
      if (payload.kind === 'input') {
        let candidate;
        let digest;
        try {
          candidate = realpathSync(payload.value);
          digest = candidate.toLowerCase().endsWith('.node')
            ? digestNativeAddon(candidate)
            : createHash('sha256').update(readFileSync(candidate)).digest('hex');
        } catch {
          appendViolation('Metro runtime input could not be observed by the managed sandbox');
          continue;
        }
        const allowedRoots = [
          runtimeManifest.contentRoot,
          runtimeManifest.appRoot,
          ...runtimeManifest.runtimeInputs,
        ];
        const withinManifest = allowedRoots.some(
          (root) =>
            typeof root === 'string' && runtimeInputWithinRoot(candidate, root),
        );
        if (!withinManifest || digest !== payload.digest) {
          appendViolation('Metro runtime input is outside the managed sandbox manifest');
          continue;
        }
        appendEvidence({ ...payload, value: candidate });
        continue;
      }
      appendEvidence(payload);
    } catch {
      appendViolation('Metro runtime evidence record is invalid');
    }
  }
});
child.once('error', () =>
  failLauncher(
    'METRO_LAUNCHER_CHILD_SPAWN_FAILED',
    'child-spawn',
    'child-process-error',
  ),
);
evidence.once('end', finishEvidence);
evidence.once('close', finishEvidence);
evidence.once('error', () => {
  appendViolation('Metro runtime evidence stream failed');
  finishEvidence();
});
child.once('exit', (code, signal) => {
  childOutcome = { code: code ?? 1, signal };
  finishLauncher();
});
setInterval(() => {}, 1 << 30);
`;
function parseNodeOptions(value) {
  const tokens = [];
  let token2 = "";
  let quoted2 = false;
  for (let index = 0; index < value.length; index += 1) {
    let character = value[index];
    if (character === "\\" && quoted2) {
      if (index + 1 === value.length)
        return tokens;
      character = value[index += 1];
    } else if (character === " " && !quoted2) {
      if (token2)
        tokens.push(token2);
      token2 = "";
      continue;
    } else if (character === '"') {
      quoted2 = !quoted2;
      continue;
    }
    token2 += character;
  }
  if (token2)
    tokens.push(token2);
  return tokens;
}
function hasNodeLoaderOption(value) {
  return parseNodeOptions(value).some((token2) => {
    const equals = token2.indexOf("=");
    const option = equals < 0 ? token2 : token2.slice(0, equals);
    return ["--require", "-r", "--import", "--loader", "--experimental-loader"].includes(option.replaceAll("_", "-"));
  });
}
function hasUnsupportedNodeOption(value) {
  const booleanOptions = /* @__PURE__ */ new Set([
    "--enable-source-maps",
    "--experimental-strip-types",
    "--experimental-transform-types",
    "--no-deprecation",
    "--no-warnings",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    "--trace-deprecation",
    "--trace-uncaught",
    "--trace-warnings"
  ]);
  const valueOptions = /* @__PURE__ */ new Set([
    "--conditions",
    "--dns-result-order",
    "--max-old-space-size",
    "--max-semi-space-size",
    "--stack-trace-limit",
    "--title",
    "--unhandled-rejections"
  ]);
  const tokens = parseNodeOptions(value);
  for (let index = 0; index < tokens.length; index += 1) {
    const token2 = tokens[index];
    const equals = token2.indexOf("=");
    const option = (equals < 0 ? token2 : token2.slice(0, equals)).replaceAll("_", "-");
    if (booleanOptions.has(option)) {
      if (equals >= 0)
        return true;
      continue;
    }
    if (!valueOptions.has(option))
      return true;
    if (equals >= 0) {
      if (token2.slice(equals + 1).length === 0)
        return true;
      continue;
    }
    const optionValue = tokens[index + 1];
    if (!optionValue || optionValue.startsWith("-"))
      return true;
    index += 1;
  }
  return false;
}
function managedMetroParentPid(pid, platform = process.platform, execute = execFileSync5, executableDependencies = {}) {
  const executable = resolveTrustedSystemExecutable(platform === "win32" ? "powershell" : "ps", platform, executableDependencies);
  if (!executable)
    return null;
  try {
    const output = platform === "win32" ? execute(executable, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2e3 }) : execute(executable, ["-p", String(pid), "-o", "ppid="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2e3
    });
    const parsed = Number(output.trim());
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}
function listenerOwnedByLauncher(listenerPid, launcherPid) {
  let current = listenerPid;
  const visited = /* @__PURE__ */ new Set();
  while (current && !visited.has(current)) {
    if (current === launcherPid)
      return true;
    visited.add(current);
    current = managedMetroParentPid(current);
  }
  return false;
}
function managedMetroListenerPid(port, platform = process.platform, execute = execFileSync5, executableDependencies = {}) {
  return metroListenerPid(port, platform, execute, executableDependencies);
}
function probeManagedMetroListener(port, platform = process.platform, execute = execFileSync5, executableDependencies = {}) {
  return probeMetroListener(port, platform, execute, executableDependencies);
}
function resolveManagedMetroCommand(appRoot, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync4;
  const readText = dependencies.readText ?? ((path) => readFileSync4(path, "utf8"));
  const platform = dependencies.platform ?? process.platform;
  const packageJson = JSON.parse(readText(join3(appRoot, "package.json")));
  const all = { ...packageJson.dependencies, ...packageJson.devDependencies };
  if (all.expo) {
    if (platform === "win32") {
      return resolveWindowsPackageCommand(appRoot, "expo", "expo", ["start", "--dev-client"], {
        exists,
        readText
      });
    }
    const executable = join3(appRoot, "node_modules", ".bin", "expo");
    if (!exists(executable)) {
      throw new Error("METRO_START_UNAVAILABLE: package-local Expo CLI is unavailable");
    }
    return { executable, args: ["start", "--dev-client"] };
  }
  if (all["react-native"]) {
    if (platform === "win32") {
      return resolveWindowsPackageCommand(appRoot, "react-native", "react-native", ["start"], {
        exists,
        readText
      });
    }
    const executable = join3(appRoot, "node_modules", ".bin", "react-native");
    if (!exists(executable)) {
      throw new Error("METRO_START_UNAVAILABLE: package-local React Native CLI is unavailable");
    }
    return { executable, args: ["start"] };
  }
  throw new Error("METRO_START_UNAVAILABLE: project is neither Expo nor bare React Native");
}
function resolveWindowsPackageCommand(appRoot, packageName, commandName, args, dependencies) {
  const packageRoot = resolve3(appRoot, "node_modules", packageName);
  const manifest = JSON.parse(dependencies.readText(join3(packageRoot, "package.json")));
  const bin = typeof manifest.bin === "string" ? manifest.bin : typeof manifest.bin?.[commandName] === "string" ? manifest.bin[commandName] : null;
  if (!bin) {
    throw new Error(`METRO_START_UNAVAILABLE: package-local ${commandName} CLI is unavailable`);
  }
  const executable = resolve3(packageRoot, bin);
  const relativeExecutable = relative2(packageRoot, executable);
  if (!relativeExecutable || relativeExecutable === ".." || relativeExecutable.startsWith("../") || relativeExecutable.startsWith("..\\") || isAbsolute2(relativeExecutable) || !dependencies.exists(executable)) {
    throw new Error(`METRO_START_UNAVAILABLE: package-local ${commandName} CLI is unavailable`);
  }
  return { executable, args };
}
function resolveManagedMetroLaunchCommand(command, dependencies) {
  const exists = dependencies.exists ?? existsSync4;
  const readText = dependencies.readText ?? ((path) => readFileSync4(path, "utf8"));
  const platform = dependencies.platform ?? process.platform;
  let firstLine = "";
  try {
    firstLine = readText(command.executable).split(/\r?\n/, 1)[0] ?? "";
  } catch {
    return {
      sourceExecutable: command.executable,
      executable: command.executable,
      nodeExecutable: process.execPath,
      args: command.args,
      probeArgs: ["--version"],
      executableMappings: [],
      chainInputs: [command.executable],
      protectedRuntimeRoots: []
    };
  }
  if (/^#!\s*\/usr\/bin\/env\s+node(?:\s|$)/.test(firstLine)) {
    return {
      sourceExecutable: command.executable,
      executable: process.execPath,
      nodeExecutable: process.execPath,
      args: [command.executable, ...command.args],
      probeArgs: [command.executable, "--version"],
      executableMappings: [],
      chainInputs: [command.executable, process.execPath],
      protectedRuntimeRoots: []
    };
  }
  if (platform !== "win32" && /^#!\s*(?:\/bin\/sh|\/usr\/bin\/env\s+sh|\/bin\/bash)(?:\s|$)/.test(firstLine)) {
    const shellSelector = exists("/private/var/select/sh") ? "/private/var/select/sh" : "/bin/sh";
    const shellExecutable = canonicalRuntimeInput(shellSelector);
    const shellHelpers = ["/usr/bin/dirname", "/usr/bin/sed", "/usr/bin/uname"].filter(exists).map(canonicalRuntimeInput);
    return {
      sourceExecutable: command.executable,
      executable: shellExecutable,
      nodeExecutable: process.execPath,
      args: [
        "-c",
        'read -r rn_dev_agent_admission <&8; script=$1; shift; . "$script"',
        `rn-dev-agent-logical-path:${command.executable}`,
        command.executable,
        ...command.args
      ],
      probeArgs: [
        "-c",
        'script=$1; shift; . "$script"',
        `rn-dev-agent-logical-path:${command.executable}`,
        command.executable,
        "--version"
      ],
      executableMappings: [process.execPath, ...shellHelpers],
      chainInputs: [command.executable, shellExecutable, process.execPath, ...shellHelpers],
      protectedRuntimeRoots: []
    };
  }
  return {
    sourceExecutable: command.executable,
    executable: command.executable,
    nodeExecutable: process.execPath,
    args: command.args,
    probeArgs: ["--version"],
    executableMappings: [],
    chainInputs: [command.executable],
    protectedRuntimeRoots: []
  };
}
function managementProof(sessionId, authority, signerCapability) {
  return createHmac3("sha256", signerCapability).update(canonicalAuthorityJson({
    sessionId,
    port: authority.port,
    pid: authority.pid,
    birth: authority.birth,
    launcherPid: authority.launcherPid,
    launcherBirth: authority.launcherBirth,
    instanceId: authority.instanceId,
    runtimeEvidencePath: authority.runtimeEvidencePath,
    runtimeEvidenceSocket: authority.runtimeEvidenceSocket,
    runtimeEvidenceAuthority: authority.runtimeEvidenceAuthority,
    runtimeEvidenceProtocol: authority.runtimeEvidenceProtocol,
    servingRoot: authority.servingRoot,
    buildGeneration: authority.buildGeneration
  })).digest("hex");
}
function managedMetroChildEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name, value]) => value !== void 0 && name !== "CI" && !name.startsWith("RN_DEV_AGENT_")));
}
function verifyManagedMetroRuntimeAdmission(path, capability, expected) {
  try {
    const admission = JSON.parse(readFileSync4(path, "utf8"));
    const signature = admission.signature;
    if (typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature))
      return false;
    const payload = { ...admission };
    delete payload.signature;
    const computed = createHmac3("sha256", capability).update(canonicalAuthorityJson(payload)).digest("hex");
    const computedBytes = Buffer.from(computed, "hex");
    const signatureBytes = Buffer.from(signature, "hex");
    const observedManifest = structuredClone(payload.runtimeManifest);
    const expectedManifest = structuredClone(expected.runtimeManifest);
    const observedDescendantAuthority = observedManifest.descendantAuthority;
    const expectedDescendantAuthority = expectedManifest.descendantAuthority;
    if (!observedDescendantAuthority || !expectedDescendantAuthority || typeof observedDescendantAuthority.rootIdentity !== "string" || !/^process:\d+$/.test(observedDescendantAuthority.rootIdentity)) {
      return false;
    }
    delete observedDescendantAuthority.rootIdentity;
    delete expectedDescendantAuthority.rootIdentity;
    return computedBytes.length === signatureBytes.length && timingSafeEqual3(computedBytes, signatureBytes) && payload.runtimeEvidenceAuthority === "managed-sandbox-v1" && payload.runtimeEnforcement === "os-enforced-v1" && payload.sessionId === expected.sessionId && payload.metroInstanceId === expected.metroInstanceId && payload.contentRoot === expected.contentRoot && payload.appRoot === expected.appRoot && Array.isArray(payload.violations) && payload.violations.length === 0 && canonicalAuthorityJson(observedManifest) === canonicalAuthorityJson(expectedManifest) && canonicalAuthorityJson(payload.runtimeEnforcementReceipt) === canonicalAuthorityJson(expected.enforcementReceipt);
  } catch {
    return false;
  }
}
function verifyManagedMetroManagementProof(binding, input) {
  if (binding.mode !== "managed" || typeof binding.port !== "number" || typeof binding.pid !== "number" || typeof binding.birth !== "string" || typeof binding.launcherPid !== "number" || typeof binding.launcherBirth !== "string" || typeof binding.instanceId !== "string" || typeof binding.runtimeEvidencePath !== "string" || typeof binding.runtimeEvidenceSocket !== "string" || typeof binding.servingRoot !== "string" || !Number.isSafeInteger(binding.buildGeneration) || binding.buildGeneration < 0 || binding.runtimeEvidenceAuthority !== "managed-sandbox-v1" && binding.runtimeEvidenceAuthority !== "reported-v1" || binding.runtimeEvidenceProtocol !== 2 || typeof binding.managementProof !== "string") {
    return false;
  }
  const expected = managementProof(input.sessionId, {
    port: binding.port,
    pid: binding.pid,
    birth: binding.birth,
    launcherPid: binding.launcherPid,
    launcherBirth: binding.launcherBirth,
    instanceId: binding.instanceId,
    runtimeEvidencePath: binding.runtimeEvidencePath,
    runtimeEvidenceSocket: binding.runtimeEvidenceSocket,
    runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
    runtimeEvidenceProtocol: binding.runtimeEvidenceProtocol,
    servingRoot: binding.servingRoot,
    buildGeneration: binding.buildGeneration
  }, input.signerCapability);
  const expectedBuffer = Buffer.from(expected, "hex");
  const observedBuffer = Buffer.from(binding.managementProof, "hex");
  return expectedBuffer.length === observedBuffer.length && timingSafeEqual3(expectedBuffer, observedBuffer);
}
function exactManagedProcessInspection(role, pid, birth, probe) {
  const prefix = role === "launcher" ? "METRO_LAUNCHER" : "METRO_LISTENER";
  if (probe.status === "absent") {
    return {
      status: "lost",
      code: `${prefix}_EXITED`,
      reason: `authenticated managed Metro ${role} exited`
    };
  }
  if (probe.status === "unknown") {
    return {
      status: "lost",
      code: `${prefix}_UNVERIFIABLE`,
      reason: `authenticated managed Metro ${role} process identity is unavailable`
    };
  }
  if (probe.birth.pid !== pid || probe.birth.token !== birth) {
    return {
      status: "lost",
      code: `${prefix}_IDENTITY_CHANGED`,
      reason: `authenticated managed Metro ${role} process identity changed`
    };
  }
  return null;
}
function inspectManagedMetroLifecycle(binding, input, dependencies = {}) {
  if (!verifyManagedMetroManagementProof(binding, input)) {
    return {
      status: "lost",
      code: "METRO_MANAGEMENT_PROOF_INVALID",
      reason: "managed Metro lifecycle evidence is not authenticated by this session"
    };
  }
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const launcher = exactManagedProcessInspection("launcher", binding.launcherPid, binding.launcherBirth, probeBirth(binding.launcherPid));
  if (launcher)
    return launcher;
  const listener = exactManagedProcessInspection("listener", binding.pid, binding.birth, probeBirth(binding.pid));
  if (listener)
    return listener;
  const port = (dependencies.probeListener ?? probeManagedMetroListener)(binding.port);
  if (port.status === "absent") {
    return {
      status: "lost",
      code: "METRO_PORT_RELEASED",
      reason: "authenticated managed Metro no longer owns its allocated listener port"
    };
  }
  if (port.status === "unknown") {
    return {
      status: "lost",
      code: "METRO_PORT_UNVERIFIABLE",
      reason: "managed Metro listener port ownership is unavailable"
    };
  }
  if (port.pid !== binding.pid) {
    return {
      status: "lost",
      code: "METRO_PORT_OWNER_CHANGED",
      reason: "allocated managed Metro port is owned by a different process"
    };
  }
  if (!(dependencies.exists ?? existsSync4)(binding.runtimeEvidenceSocket)) {
    return {
      status: "lost",
      code: "METRO_EVIDENCE_SOCKET_MISSING",
      reason: "managed Metro runtime evidence socket is missing"
    };
  }
  return { status: "live" };
}
function refreshManagedMetroBuildGeneration(binding, input) {
  if (!Number.isSafeInteger(input.buildGeneration) || input.buildGeneration < binding.buildGeneration || !verifyManagedMetroManagementProof(binding, input)) {
    throw new Error("METRO_AUTHORITY_MISMATCH: managed Metro build generation cannot rotate from unverified authority");
  }
  const refreshed = { ...binding, buildGeneration: input.buildGeneration };
  return {
    ...refreshed,
    managementProof: managementProof(input.sessionId, refreshed, input.signerCapability)
  };
}
function legacyManagementProof(sessionId, authority, signerCapability) {
  return createHmac3("sha256", signerCapability).update([
    sessionId,
    authority.port,
    authority.pid,
    authority.birth,
    authority.launcherPid,
    authority.launcherBirth,
    authority.instanceId,
    authority.runtimeEvidencePath,
    authority.runtimeEvidenceSocket
  ].join("\0")).digest("hex");
}
function managedSandboxManagementProofV1(sessionId, authority, signerCapability) {
  return createHmac3("sha256", signerCapability).update(canonicalAuthorityJson({
    sessionId,
    ...authority
  })).digest("hex");
}
function dependencyRoots(appRoot, sourceRoot, exists) {
  const roots = /* @__PURE__ */ new Set();
  for (const start of [resolve3(appRoot), resolve3(sourceRoot)]) {
    let current = start;
    while (true) {
      const candidate = join3(current, "node_modules");
      if (exists(candidate))
        roots.add(candidate);
      const parent = dirname3(current);
      if (parent === current)
        break;
      current = parent;
    }
  }
  for (const candidate of [
    join3(sourceRoot, ".yarn", "cache"),
    join3(sourceRoot, ".yarn", "unplugged"),
    join3(sourceRoot, ".pnpm")
  ]) {
    if (exists(candidate))
      roots.add(resolve3(candidate));
  }
  return [...roots].sort();
}
function canonicalRuntimeInput(path) {
  try {
    return realpathSync5(path);
  } catch {
    return resolve3(path);
  }
}
function latestSignedRuntimeViolation(path, capability, expected) {
  try {
    const bytes = readFileSync4(path);
    if (bytes.byteLength > 2 * 1024 * 1024)
      return null;
    let previousSignature = null;
    let sequence = 0;
    let latest = null;
    for (const line of bytes.toString("utf8").split("\n").filter(Boolean)) {
      const observed = JSON.parse(line);
      const signature = observed.signature;
      if (typeof signature !== "string")
        return null;
      const { signature: _signature, ...payload } = observed;
      const expectedSignature = createHmac3("sha256", capability).update(canonicalAuthorityJson(payload)).digest("hex");
      const actualBytes = Buffer.from(signature, "hex");
      const expectedBytes = Buffer.from(expectedSignature, "hex");
      if (actualBytes.length !== expectedBytes.length || !timingSafeEqual3(actualBytes, expectedBytes) || payload.sessionId !== expected.sessionId || payload.metroInstanceId !== expected.metroInstanceId || payload.sequence !== sequence + 1 || payload.previousSignature !== previousSignature) {
        return null;
      }
      sequence += 1;
      previousSignature = signature;
      if (payload.kind === "violation" && typeof payload.value === "string") {
        latest = payload.value;
      }
    }
    return latest;
  } catch {
    return null;
  }
}
function boundedMetroLogTail(path, maxBytes = 4096) {
  let descriptor;
  try {
    descriptor = openSync3(path, "r");
    const size = fstatSync2(descriptor).size;
    const length = Math.min(size, maxBytes);
    if (length === 0)
      return null;
    const buffer = Buffer.alloc(length);
    readSync2(descriptor, buffer, 0, length, size - length);
    const tail = buffer.toString("utf8").replace(/[^\t\n\r\x20-\x7e]/g, "?").trim();
    return tail || null;
  } catch {
    return null;
  } finally {
    if (descriptor !== void 0)
      closeSync3(descriptor);
  }
}
var MANAGED_METRO_SENSITIVE_ENVIRONMENT_NAME = /(?:access[_-]?key|token|secret|password|passwd|pwd|credential|api[_-]?key|authorization|auth|cookie|private[_-]?key)/i;
function readManagedMetroLauncherDiagnostic(path) {
  try {
    const source = readFileSync4(path, "utf8");
    if (Buffer.byteLength(source) > 4096)
      return null;
    const diagnostic2 = JSON.parse(source);
    if (diagnostic2.version !== 1 || typeof diagnostic2.code !== "string" || !/^METRO_LAUNCHER_[A-Z0-9_]+$/.test(diagnostic2.code) || typeof diagnostic2.stage !== "string" || !/^[a-z0-9-]{1,64}$/.test(diagnostic2.stage) || typeof diagnostic2.detail !== "string" || !/^[a-z0-9-]{1,96}$/.test(diagnostic2.detail)) {
      return null;
    }
    return diagnostic2;
  } catch {
    return null;
  }
}
function sanitizeManagedMetroStartupDetail(value, redactions) {
  let sanitized = value.replace(/[^\t\n\r\x20-\x7e]/g, "?");
  for (const redaction of [...redactions].sort((left, right) => right.length - left.length)) {
    if (redaction)
      sanitized = sanitized.replaceAll(redaction, "<redacted>");
  }
  return sanitized.replace(/\b(?:Basic|Bearer)\s+\S+/gi, "<redacted-authorization>").replace(/(\b[A-Za-z_][A-Za-z0-9_.-]*(?:access[-_]?key|token|secret|password|passwd|pwd|credential|api[-_]?key|authorization|auth|cookie|private[-_]?key)[A-Za-z0-9_.-]*\b["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, "$1<redacted>").replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1<redacted>@").replace(/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "<path>").replace(/(?:\/[A-Za-z0-9._@%+~=-]+){2,}/g, "<path>").trim().slice(-4096);
}
function boundedManagedMetroStartupMessage(code, details) {
  const compactDetails = details.filter((detail) => Boolean(detail));
  const suffix = compactDetails.length > 0 ? ` (${compactDetails.join("; ")})` : "";
  return `${code}: managed Metro launcher failed before runtime evidence${suffix}`.slice(0, 4096);
}
function managedMetroStartupError(input) {
  const violation = latestSignedRuntimeViolation(input.runtimeEvidencePath, input.runtimePolicyCapability, {
    sessionId: input.sessionId,
    metroInstanceId: input.metroInstanceId
  });
  const childOutcome = input.exitCode !== null ? `launcher exit ${input.exitCode}` : input.signalCode ? `launcher signal ${input.signalCode}` : null;
  const launcherDiagnostic = readManagedMetroLauncherDiagnostic(input.launcherDiagnosticPath);
  const redactions = [
    input.appRoot,
    input.sourceRoot,
    input.runtimeRoot,
    input.sessionId,
    input.metroInstanceId,
    input.signerCapability,
    input.runtimePolicyCapability,
    ...input.credentialRedactions
  ];
  const lastError = input.lastError instanceof Error ? sanitizeManagedMetroStartupDetail(input.lastError.message, redactions) : null;
  const logTailSource = boundedMetroLogTail(input.logPath);
  const logTail = logTailSource ? sanitizeManagedMetroStartupDetail(logTailSource, redactions) : null;
  const details = [
    launcherDiagnostic ? `stage ${launcherDiagnostic.stage}` : null,
    childOutcome,
    launcherDiagnostic?.detail,
    lastError,
    logTail ? `Metro log tail:
${logTail}` : null
  ].filter((detail) => Boolean(detail));
  if (launcherDiagnostic) {
    return new Error(boundedManagedMetroStartupMessage(launcherDiagnostic.code, details));
  }
  if (violation && /^[A-Z][A-Z0-9_]+:/.test(violation)) {
    return new Error(`${sanitizeManagedMetroStartupDetail(violation, redactions)}${details.length > 0 ? `; ${details.join("; ")}` : ""}`.slice(0, 4096));
  }
  let runtimeEvidenceInitialized = false;
  let runtimeEvidenceDescriptor = null;
  try {
    runtimeEvidenceDescriptor = openSync3(input.runtimeEvidencePath, "r");
    runtimeEvidenceInitialized = fstatSync2(runtimeEvidenceDescriptor).size > 0;
  } catch {
  } finally {
    if (runtimeEvidenceDescriptor !== null)
      closeSync3(runtimeEvidenceDescriptor);
  }
  if (!runtimeEvidenceInitialized) {
    return new Error(boundedManagedMetroStartupMessage("METRO_LAUNCHER_PRE_EVIDENCE_FAILED", [
      "stage node-startup",
      ...details
    ]));
  }
  return new Error(`METRO_START_UNAVAILABLE: allocated Metro did not become authoritative${details.length > 0 ? ` (${details.join("; ")})` : ""}`.slice(0, 4096));
}
async function stopSpawnedProcessGroup(input, dependencies) {
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
  const signalTree = dependencies.signalTree ?? signalProcessTree;
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve5) => setTimeout(resolve5, ms)));
  let signalFailed = false;
  try {
    signalTree({
      launcherPid: input.launcherPid,
      listenerPid: input.launcherPid,
      launcherPresent: true,
      signal: "SIGTERM"
    });
  } catch {
    signalFailed = true;
  }
  const deadline = Date.now() + 2e3;
  while (true) {
    const launcher = probeBirth(input.launcherPid);
    const port = probeListener(input.port);
    if (launcher.status === "unknown" || port.status === "unknown")
      return false;
    if (launcher.status === "absent" && port.status === "absent")
      return true;
    if (signalFailed)
      return false;
    if (Date.now() >= deadline)
      return false;
    await wait(25);
  }
}
async function startManagedMetro(input, dependencies = {}) {
  const command = resolveManagedMetroCommand(input.appRoot, dependencies);
  const resolvedLaunchCommand = resolveManagedMetroLaunchCommand(command, dependencies);
  const launchCommand = resolvedLaunchCommand;
  const instanceId = input.instanceId;
  const runtimePolicyCapability = createHmac3("sha256", input.signerCapability).update("metro-runtime-policy").digest("base64url");
  const baseNodeOptions = (process.env.NODE_OPTIONS ?? "").trim();
  if (hasNodeLoaderOption(baseNodeOptions) || hasUnsupportedNodeOption(baseNodeOptions)) {
    throw new Error("METRO_START_UNAVAILABLE: NODE_OPTIONS contain unsupported execution inputs");
  }
  const authorityPreload = join3(input.appRoot, ".rn-agent", "integration", "rn-session-metro.cjs");
  const runtimeEvidencePath = join3(input.runtimeRoot, "metro-runtime-evidence.jsonl");
  const launcherDiagnosticPath = join3(input.runtimeRoot, "metro-launcher-diagnostic.json");
  const nativeAddonAcknowledgmentRoot = join3(input.runtimeRoot, "native-addon-acknowledgments");
  const runtimePolicyPath = join3(input.appRoot, ".rn-agent", "integration", "metro-runtime-policy.json");
  const runtimeEvidenceEndpointId = createHmac3("sha256", input.signerCapability).update(`metro-runtime-evidence\0${instanceId}`).digest("hex").slice(0, 32);
  const runtimeEvidenceSocket = process.platform === "win32" ? `\\\\.\\pipe\\rn-dev-agent-${runtimeEvidenceEndpointId}` : `/tmp/rn-dev-agent-${runtimeEvidenceEndpointId}.sock`;
  const authorityNodeOptions = [baseNodeOptions, `--require=${JSON.stringify(authorityPreload)}`].filter(Boolean).join(" ");
  const exists = dependencies.exists ?? existsSync4;
  const resolvedDependencyRoots = dependencyRoots(input.appRoot, input.sourceRoot, exists).map(canonicalRuntimeInput);
  const allowedCodeRoots = [
    canonicalRuntimeInput(input.sourceRoot),
    canonicalRuntimeInput(input.appRoot),
    ...resolvedDependencyRoots
  ].filter((value, index, entries) => entries.indexOf(value) === index);
  const authorityRootNonce = createHmac3("sha256", input.signerCapability).update(`metro-descendant-root\0${instanceId}`).digest("hex").slice(0, 32);
  const metroArgs = [...launchCommand.args, "--port", String(input.port)];
  const metroHome = join3(input.runtimeRoot, "metro-home");
  const metroTemporaryRoot = join3(input.runtimeRoot, "metro-tmp");
  const metroCacheRoot = join3(input.runtimeRoot, "metro-cache");
  for (const path of [
    metroHome,
    metroTemporaryRoot,
    metroCacheRoot,
    join3(input.appRoot, ".expo"),
    nativeAddonAcknowledgmentRoot
  ]) {
    if (!exists(path))
      mkdirSync2(path, { recursive: true, mode: 448 });
  }
  const metroEnvironment = managedMetroChildEnvironment({
    ...dependencies.environment ?? process.env,
    HOME: metroHome,
    TMPDIR: metroTemporaryRoot,
    TMP: metroTemporaryRoot,
    TEMP: metroTemporaryRoot,
    XDG_CACHE_HOME: metroCacheRoot,
    EXPO_OFFLINE: "1",
    EXPO_UNSTABLE_HEADLESS: "1",
    RCT_METRO_PORT: String(input.port)
  });
  const childEnvironment = {
    ...metroEnvironment,
    ...launchCommand.binPath ? {
      PATH: [launchCommand.binPath, metroEnvironment.PATH].filter(Boolean).join(":")
    } : {},
    NODE_OPTIONS: authorityNodeOptions,
    RN_DEV_AGENT_METRO_EVIDENCE_FD: "9",
    RN_DEV_AGENT_SESSION_ID: input.sessionId,
    RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
    RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD: authorityPreload,
    RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS: baseNodeOptions,
    RN_DEV_AGENT_METRO_CONTENT_ROOT: canonicalRuntimeInput(input.sourceRoot),
    RN_DEV_AGENT_METRO_APP_ROOT: canonicalRuntimeInput(input.appRoot),
    RN_DEV_AGENT_METRO_ALLOWED_CODE_ROOTS: canonicalAuthorityJson(allowedCodeRoots),
    RN_DEV_AGENT_METRO_AUTHORITY_ROOT_NONCE: authorityRootNonce,
    RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT: nativeAddonAcknowledgmentRoot
  };
  const packageInputs = [canonicalRuntimeInput(join3(input.appRoot, "package.json"))];
  const metroConfigInputs = ["metro.config.js", "metro.config.cjs"].map((name) => join3(input.appRoot, name)).filter(exists).map(canonicalRuntimeInput);
  const runtimeInputs = [
    canonicalRuntimeInput(launchCommand.sourceExecutable),
    canonicalRuntimeInput(authorityPreload),
    ...packageInputs,
    ...metroConfigInputs,
    ...resolvedDependencyRoots
  ].filter((value, index, entries) => entries.indexOf(value) === index);
  const commandChainInputs = [...launchCommand.chainInputs, authorityPreload].filter((value, index, entries) => entries.indexOf(value) === index);
  const runtimeManifest = {
    version: 1,
    executable: canonicalRuntimeInput(launchCommand.executable),
    sourceExecutable: canonicalRuntimeInput(launchCommand.sourceExecutable),
    commandProbeArguments: launchCommand.probeArgs,
    commandExecutableMappings: launchCommand.executableMappings.map(canonicalRuntimeInput),
    commandChainInputs: commandChainInputs.map(canonicalRuntimeInput),
    protectedRuntimeRoots: [...launchCommand.protectedRuntimeRoots, nativeAddonAcknowledgmentRoot].map(canonicalRuntimeInput).filter((value, index, entries) => entries.indexOf(value) === index),
    nativeAddonRoots: allowedCodeRoots,
    nodeExecutable: canonicalRuntimeInput(launchCommand.nodeExecutable),
    nodeVersion: process.version,
    port: input.port,
    args: metroArgs,
    nodeOptions: authorityNodeOptions,
    environmentDigest: createHash4("sha256").update(canonicalAuthorityJson(childEnvironment)).digest("hex"),
    contentRoot: resolve3(input.sourceRoot),
    appRoot: resolve3(input.appRoot),
    servingRoot: resolve3(input.sourceRoot),
    buildGeneration: input.buildGeneration,
    packageInputs,
    metroConfigInputs,
    dependencyRoots: resolvedDependencyRoots,
    runtimeInputs,
    descendantAuthority: {
      version: 1,
      rootNonce: authorityRootNonce,
      allowedCodeRoots
    }
  };
  const prepareEnforcement = dependencies.prepareEnforcement ?? prepareManagedMetroEnforcement;
  const preflightEnforcement = dependencies.preflightEnforcement ?? runManagedMetroEnforcementPreflight;
  const preparedEnforcement = prepareEnforcement({
    platform: process.platform,
    appRoot: input.appRoot,
    sourceRoot: input.sourceRoot,
    runtimeRoot: input.runtimeRoot,
    nodeExecutable: launchCommand.nodeExecutable,
    nodeVersion: process.version,
    commandExecutable: launchCommand.executable,
    commandArguments: metroArgs,
    commandProbeArguments: launchCommand.probeArgs,
    baseNodeOptions,
    commandExecutableMappings: launchCommand.executableMappings,
    commandChainInputs,
    protectedRuntimeRoots: runtimeManifest.protectedRuntimeRoots,
    nativeAddonRoots: allowedCodeRoots,
    port: input.port,
    instanceId,
    runtimeInputs
  });
  let runtimeEnforcement = preparedEnforcement;
  if (preparedEnforcement.status === "enforced") {
    try {
      runtimeEnforcement = {
        ...preparedEnforcement,
        receipt: preflightEnforcement(preparedEnforcement, { environment: childEnvironment })
      };
    } catch {
      runtimeEnforcement = {
        status: "unsupported",
        reason: "sandbox-preflight-failed"
      };
    }
  }
  const runtimeEvidenceAuthority = runtimeEnforcement.status === "enforced" ? "managed-sandbox-v1" : "reported-v1";
  const requiresSandboxAdmission = runtimeEnforcement.status === "enforced";
  const enforcementReceiptForAdmission = runtimeEnforcement.status === "enforced" && "receipt" in runtimeEnforcement ? runtimeEnforcement.receipt : null;
  const logPath = join3(input.runtimeRoot, "metro.log");
  rmSync2(launcherDiagnosticPath, { force: true });
  const log = openSync3(logPath, "a", 384);
  const child = (dependencies.spawnProcess ?? spawn)(launchCommand.nodeExecutable, ["-e", METRO_LAUNCHER_SOURCE], {
    cwd: input.appRoot,
    env: {
      ...metroEnvironment,
      RN_DEV_AGENT_METRO_EXECUTABLE: launchCommand.executable,
      RN_DEV_AGENT_METRO_ARGS: JSON.stringify(metroArgs),
      RN_DEV_AGENT_SESSION_ID: input.sessionId,
      RN_DEV_AGENT_METRO_INSTANCE_ID: instanceId,
      RN_DEV_AGENT_METRO_POLICY_CAPABILITY: runtimePolicyCapability,
      RN_DEV_AGENT_METRO_AUTHORITY_PRELOAD: authorityPreload,
      RN_DEV_AGENT_METRO_BASE_NODE_OPTIONS: baseNodeOptions,
      RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE: runtimeEvidencePath,
      RN_DEV_AGENT_METRO_LAUNCHER_DIAGNOSTIC: launcherDiagnosticPath,
      RN_DEV_AGENT_METRO_RUNTIME_EVIDENCE_SOCKET: runtimeEvidenceSocket,
      RN_DEV_AGENT_METRO_RUNTIME_POLICY: runtimePolicyPath,
      RN_DEV_AGENT_METRO_CONTENT_ROOT: input.sourceRoot,
      RN_DEV_AGENT_METRO_APP_ROOT: input.appRoot,
      RN_DEV_AGENT_METRO_CHILD_ENVIRONMENT: JSON.stringify(childEnvironment),
      RN_DEV_AGENT_METRO_RUNTIME_MANIFEST: canonicalAuthorityJson(runtimeManifest),
      RN_DEV_AGENT_METRO_RUNTIME_ENFORCEMENT: canonicalAuthorityJson(runtimeEnforcement),
      RN_DEV_AGENT_METRO_CHILD_NODE_OPTIONS: authorityNodeOptions,
      RN_DEV_AGENT_METRO_NATIVE_ADDON_ACK_ROOT: nativeAddonAcknowledgmentRoot,
      NODE_OPTIONS: baseNodeOptions
    },
    detached: true,
    stdio: ["ignore", log, log]
  });
  closeSync3(log);
  if (!child.pid) {
    throw new Error("METRO_START_UNAVAILABLE: package-local Metro process did not start");
  }
  const readBirth = dependencies.readBirth ?? readProcessBirth;
  const launcherBirth = readBirth(child.pid);
  if (!launcherBirth) {
    const cleanupProven2 = await stopSpawnedProcessGroup({ launcherPid: child.pid, port: input.port }, dependencies);
    if (!cleanupProven2) {
      throw new Error("METRO_START_CLEANUP_UNPROVEN: Metro launcher birth and cleanup could not be proven");
    }
    if (!removeManagedMetroEvidenceSocketSafely(runtimeEvidenceSocket, dependencies)) {
      throw new Error("METRO_START_CLEANUP_UNPROVEN: Metro evidence socket cleanup failed");
    }
    throw new Error("PROCESS_BIRTH_UNAVAILABLE: Metro launcher birth could not be proven");
  }
  child.unref();
  const listenerPid = dependencies.listenerPid ?? managedMetroListenerPid;
  const ownsListener = dependencies.listenerOwnedByLauncher ?? listenerOwnedByLauncher;
  const capture = dependencies.capture ?? captureMetroBinding;
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve5) => setTimeout(resolve5, ms)));
  const deadline = Date.now() + 2e4;
  let lastError = null;
  let listenerIdentity = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode != null)
      break;
    const pid = listenerPid(input.port);
    if (pid && ownsListener(pid, child.pid)) {
      const listenerBirth = probeBirth(pid);
      if (listenerBirth.status === "present") {
        listenerIdentity = { pid, birth: listenerBirth.birth.token };
      }
      try {
        if (requiresSandboxAdmission && (!enforcementReceiptForAdmission || !(dependencies.verifyRuntimeAdmission ?? verifyManagedMetroRuntimeAdmission)(runtimePolicyPath, runtimePolicyCapability, {
          sessionId: input.sessionId,
          metroInstanceId: instanceId,
          contentRoot: resolve3(input.sourceRoot),
          appRoot: resolve3(input.appRoot),
          runtimeManifest,
          enforcementReceipt: enforcementReceiptForAdmission
        }))) {
          throw new Error("METRO_RUNTIME_ADMISSION_UNAVAILABLE: launcher did not admit managed sandbox");
        }
        const binding = await capture({
          port: input.port,
          pid,
          instanceId,
          sourceRoot: input.sourceRoot,
          buildGeneration: input.buildGeneration
        }, { servingRoot: () => input.sourceRoot });
        const authority = {
          ...binding,
          mode: "managed",
          launcherPid: child.pid,
          launcherBirth: launcherBirth.token,
          runtimeEvidencePath,
          runtimeEvidenceSocket,
          runtimeEvidenceAuthority,
          runtimeEvidenceProtocol: 2
        };
        return {
          ...authority,
          managementProof: managementProof(input.sessionId, authority, input.signerCapability)
        };
      } catch (error) {
        lastError = error;
      }
    }
    await wait(100);
  }
  const cleanupProven = await stopManagedMetroProcesses({
    port: input.port,
    launcher: { pid: child.pid, birth: launcherBirth.token },
    listener: listenerIdentity
  }, dependencies);
  if (!cleanupProven) {
    throw new Error("METRO_START_CLEANUP_UNPROVEN: failed Metro startup left process or listener state ambiguous");
  }
  if (!removeManagedMetroEvidenceSocketSafely(runtimeEvidenceSocket, dependencies)) {
    throw new Error("METRO_START_CLEANUP_UNPROVEN: Metro evidence socket cleanup failed");
  }
  throw managedMetroStartupError({
    runtimeEvidencePath,
    runtimePolicyCapability,
    launcherDiagnosticPath,
    logPath,
    appRoot: input.appRoot,
    sourceRoot: input.sourceRoot,
    runtimeRoot: input.runtimeRoot,
    sessionId: input.sessionId,
    metroInstanceId: instanceId,
    signerCapability: input.signerCapability,
    credentialRedactions: Object.entries(childEnvironment).filter(([name, value]) => value !== void 0 && (MANAGED_METRO_SENSITIVE_ENVIRONMENT_NAME.test(name) || /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(value))).map(([, value]) => value),
    exitCode: child.exitCode,
    signalCode: child.signalCode,
    lastError
  });
}
function signalManagedMetroProcessTree(input, platform = process.platform, execute = execFileSync5, executableDependencies = {}) {
  if (platform === "win32") {
    const executable = resolveTrustedSystemExecutable("taskkill", platform, executableDependencies);
    if (!executable)
      throw new Error("METRO_CLEANUP_EXECUTABLE_UNAVAILABLE");
    const pid = input.launcherPresent ? input.launcherPid : input.listenerPid;
    execute(executable, ["/PID", String(pid), "/T"], {
      stdio: "ignore",
      timeout: 2e3
    });
    return;
  }
  process.kill(-input.launcherPid, input.signal);
}
var signalProcessTree = signalManagedMetroProcessTree;
var MANAGED_METRO_STOP_TIMEOUT_MS = 5e3;
function removeManagedMetroEvidenceSocket(path) {
  if (process.platform === "win32")
    return;
  if (!/^\/tmp\/rn-dev-agent-[a-f0-9]{32}\.sock$/.test(path)) {
    throw new Error("METRO_EVIDENCE_SOCKET_INVALID");
  }
  rmSync2(path, { force: true });
}
function removeManagedMetroEvidenceSocketSafely(path, dependencies) {
  if (process.platform === "win32" && !/^\\\\\.\\pipe\\rn-dev-agent-[a-f0-9]{32}$/.test(path) || process.platform !== "win32" && !/^\/tmp\/rn-dev-agent-[a-f0-9]{32}\.sock$/.test(path)) {
    return false;
  }
  try {
    (dependencies.removeEvidenceSocket ?? removeManagedMetroEvidenceSocket)(path);
    return true;
  } catch {
    return false;
  }
}
function exactProcessState(expected, probe) {
  if (probe.status === "unknown")
    return "unknown";
  if (probe.status === "absent")
    return "stopped";
  return probe.birth.token === expected.birth ? "present" : "stopped";
}
async function stopManagedMetroProcesses(input, dependencies) {
  const probeBirth = dependencies.probeBirth ?? probeProcessBirth;
  const probeListener = dependencies.probeListener ?? probeManagedMetroListener;
  const signalTree = dependencies.signalTree ?? signalProcessTree;
  const wait = dependencies.wait ?? ((ms) => new Promise((resolve5) => setTimeout(resolve5, ms)));
  const inspect = () => {
    const launcher = exactProcessState(input.launcher, probeBirth(input.launcher.pid));
    const listener = input.listener ? exactProcessState(input.listener, probeBirth(input.listener.pid)) : "stopped";
    const port = probeListener(input.port);
    return { launcher, listener, port };
  };
  const initial = inspect();
  if (initial.launcher === "unknown" || initial.listener === "unknown" || initial.port.status === "unknown") {
    return false;
  }
  if (initial.port.status === "listening" && (input.listener ? initial.port.pid !== input.listener.pid || initial.listener !== "present" : initial.launcher !== "present")) {
    return false;
  }
  if (initial.launcher === "stopped" && initial.listener === "stopped" && initial.port.status === "absent") {
    return true;
  }
  try {
    signalTree({
      launcherPid: input.launcher.pid,
      listenerPid: input.listener?.pid ?? input.launcher.pid,
      launcherPresent: initial.launcher === "present",
      signal: "SIGTERM"
    });
  } catch {
    return false;
  }
  const deadline = Date.now() + MANAGED_METRO_STOP_TIMEOUT_MS;
  while (true) {
    const current = inspect();
    const uncertain = current.launcher === "unknown" || current.listener === "unknown" || current.port.status === "unknown";
    if (!uncertain) {
      if (current.launcher === "stopped" && current.listener === "stopped" && current.port.status === "absent") {
        return true;
      }
      if (current.port.status === "listening" && input.listener && (current.port.pid !== input.listener.pid || current.listener !== "present")) {
        return false;
      }
    }
    if (Date.now() >= deadline)
      return false;
    await wait(25);
  }
}
async function stopManagedMetro(binding, input, dependencies = {}) {
  if (binding?.mode !== "managed" || typeof binding.port !== "number" || typeof binding.pid !== "number" || typeof binding.birth !== "string" || typeof binding.launcherPid !== "number" || typeof binding.launcherBirth !== "string" || typeof binding.instanceId !== "string" || typeof binding.runtimeEvidencePath !== "string" || typeof binding.runtimeEvidenceSocket !== "string" || binding.runtimeEvidenceAuthority !== void 0 && binding.runtimeEvidenceAuthority !== "reported-v1" && binding.runtimeEvidenceAuthority !== "managed-sandbox-v1" || binding.runtimeEvidenceAuthority === "managed-sandbox-v1" && binding.runtimeEvidenceProtocol !== 2 || typeof binding.managementProof !== "string") {
    return false;
  }
  const legacyAuthority = {
    port: binding.port,
    pid: binding.pid,
    birth: binding.birth,
    launcherPid: binding.launcherPid,
    launcherBirth: binding.launcherBirth,
    instanceId: binding.instanceId,
    runtimeEvidencePath: binding.runtimeEvidencePath,
    runtimeEvidenceSocket: binding.runtimeEvidenceSocket
  };
  const observedBuffer = Buffer.from(binding.managementProof, "hex");
  const expectedProofs = binding.runtimeEvidenceAuthority === void 0 ? [legacyManagementProof(input.sessionId, legacyAuthority, input.signerCapability)] : binding.runtimeEvidenceAuthority === "reported-v1" ? [
    createHmac3("sha256", input.signerCapability).update(canonicalAuthorityJson({
      sessionId: input.sessionId,
      ...legacyAuthority,
      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority
    })).digest("hex"),
    ...binding.runtimeEvidenceProtocol === 2 && typeof binding.servingRoot === "string" && Number.isSafeInteger(binding.buildGeneration) && binding.buildGeneration >= 0 ? [
      managementProof(input.sessionId, {
        ...legacyAuthority,
        runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
        runtimeEvidenceProtocol: 2,
        servingRoot: binding.servingRoot,
        buildGeneration: binding.buildGeneration
      }, input.signerCapability)
    ] : []
  ] : [
    managedSandboxManagementProofV1(input.sessionId, {
      ...legacyAuthority,
      runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
      runtimeEvidenceProtocol: 2
    }, input.signerCapability),
    ...typeof binding.servingRoot === "string" && Number.isSafeInteger(binding.buildGeneration) && binding.buildGeneration >= 0 ? [
      managementProof(input.sessionId, {
        ...legacyAuthority,
        runtimeEvidenceAuthority: binding.runtimeEvidenceAuthority,
        runtimeEvidenceProtocol: 2,
        servingRoot: binding.servingRoot,
        buildGeneration: binding.buildGeneration
      }, input.signerCapability)
    ] : []
  ];
  if (!expectedProofs.some((expected) => {
    const expectedBuffer = Buffer.from(expected, "hex");
    return expectedBuffer.length === observedBuffer.length && timingSafeEqual3(expectedBuffer, observedBuffer);
  })) {
    return false;
  }
  const stopped = await stopManagedMetroProcesses({
    port: binding.port,
    launcher: { pid: binding.launcherPid, birth: binding.launcherBirth },
    listener: { pid: binding.pid, birth: binding.birth }
  }, dependencies);
  if (!stopped)
    return false;
  return removeManagedMetroEvidenceSocketSafely(binding.runtimeEvidenceSocket, dependencies);
}

// packages/rn-dev-agent-core/dist/session/process-owner.js
init_process_birth();
function defaultProcessState(pid) {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = error.code;
    if (code === "ESRCH")
      return "dead";
    if (code === "EPERM")
      return "alive";
    return "unknown";
  }
}
function inspectSessionOwner(owner, dependencies = {}) {
  const state = (dependencies.processState ?? defaultProcessState)(owner.pid);
  if (state === "dead")
    return "mismatch";
  if (state === "unknown")
    return "unknown";
  const observed = (dependencies.readBirth ?? readProcessBirth)(owner.pid);
  if (!observed)
    return "unknown";
  return observed.token === owner.token ? "match" : "mismatch";
}

// packages/rn-dev-agent-core/dist/rn-session.js
init_registry();

// packages/rn-dev-agent-core/dist/session/source-identity.js
init_metro_cwd();
import { createHash as createHash6, createHmac as createHmac4, randomBytes as randomBytes2, timingSafeEqual as timingSafeEqual5 } from "node:crypto";
import { execFileSync as execFileSync6 } from "node:child_process";
import { closeSync as closeSync4, constants as constants3, existsSync as existsSync5, fstatSync as fstatSync3, lstatSync as lstatSync4, openSync as openSync4, readdirSync as readdirSync2, readFileSync as readFileSync5, readlinkSync as readlinkSync3, readSync as readSync3, realpathSync as realpathSync6 } from "node:fs";
import { dirname as dirname5, isAbsolute as isAbsolute3, join as join4, relative as relative3, resolve as resolve4 } from "node:path";
function digest2(parts) {
  const hash = createHash6("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex");
}
var MAX_STRICT_PROOF_FILE_BYTES = 16 * 1024 * 1024;
var MAX_STRICT_PROOF_TOTAL_BYTES = 64 * 1024 * 1024;
var MAX_STRICT_PROOF_DEPENDENCY_FILE_BYTES = 128 * 1024 * 1024;
var MAX_STRICT_PROOF_DEPENDENCY_TOTAL_BYTES = 512 * 1024 * 1024;
var STRICT_PROOF_READ_BUFFER_BYTES = 64 * 1024;
var EXCLUDED_RUNTIME_DIRECTORIES = [
  ".gradle",
  ".expo",
  ".cache",
  "ios/Pods",
  "ios/build",
  "ios/DerivedData",
  "android/build",
  "android/app/build",
  "android/app/.cxx"
];
var IGNORED_RUNTIME_INPUT_PATHS = [
  ":(top,glob)**",
  ":(top,exclude,glob)**/node_modules/**",
  ":(top,exclude,glob)**/.yarn/cache/**",
  ":(top,exclude,glob)**/.yarn/unplugged/**",
  ...EXCLUDED_RUNTIME_DIRECTORIES.map((entry) => `:(top,exclude,glob)**/${entry}/**`)
];
var METRO_INTEGRATION_START = "// rn-dev-agent session integration: begin";
var METRO_INTEGRATION_END = "// rn-dev-agent session integration: end";
var METRO_INTEGRATION_BLOCK = `${METRO_INTEGRATION_START}
module.exports = require('./.rn-agent/integration/rn-session-metro.cjs')(module.exports);
${METRO_INTEGRATION_END}`;
var METRO_EVIDENCE_HEAD_CLIENT = String.raw`
const { createConnection } = require('node:net');
const socket = createConnection(process.argv[1]);
let response = '';
socket.setEncoding('utf8');
socket.setTimeout(1500);
socket.once('connect', () => socket.write(process.argv[2] + '\n'));
socket.on('data', (chunk) => {
  response += chunk;
  if (response.length > 4096) process.exit(2);
});
socket.once('end', () => process.stdout.write(response));
socket.once('timeout', () => process.exit(3));
socket.once('error', () => process.exit(4));
`;
function defaultGit(root, args) {
  return execFileSync6("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5e3,
    maxBuffer: 64 * 1024 * 1024
  }).trim();
}
function isDefinitiveNonGitError(error) {
  if (!(error instanceof Error))
    return false;
  const stderr = "stderr" in error && typeof error.stderr === "string" ? error.stderr : "stderr" in error && Buffer.isBuffer(error.stderr) ? error.stderr.toString("utf8") : "";
  return `${error.message}
${stderr}`.toLowerCase().includes("not a git repository");
}
function assertContained(root, candidate, code) {
  const child = relative3(root, candidate);
  if (child === ".." || child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute3(child)) {
    throw new Error(`${code}: path is outside the declared content root`);
  }
}
function resolveDeclaredIdentity(appRoot, dependencies, canonicalize) {
  if (!dependencies.declaredRoot || !dependencies.declaredManifests?.length) {
    throw new Error("NON_GIT_MANIFEST_REQUIRED: non-Git authority needs an explicit root and manifest list");
  }
  const contentRoot = canonicalize(resolve4(dependencies.declaredRoot));
  assertContained(contentRoot, appRoot, "NON_GIT_ROOT_MISMATCH");
  const manifestParts = [];
  for (const entry of [...dependencies.declaredManifests].sort()) {
    const manifest = canonicalize(resolve4(contentRoot, entry));
    assertContained(contentRoot, manifest, "NON_GIT_MANIFEST_OUTSIDE_ROOT");
    manifestParts.push(relative3(contentRoot, manifest), readFileSync5(manifest));
  }
  const manifestDigest = digest2(manifestParts);
  const appRelative = relative3(contentRoot, appRoot) || ".";
  return {
    kind: "declared-root",
    contentRoot,
    appRoot,
    sourceKey: digest2(["declared-source", contentRoot, manifestDigest]),
    worktreeKey: digest2(["declared-root", contentRoot]),
    appRootKey: digest2(["declared-app", appRelative]),
    manifestDigest,
    declaredManifests: [...dependencies.declaredManifests]
  };
}
function resolveSourceIdentity(inputRoot, dependencies = {}) {
  const canonicalize = dependencies.canonicalize ?? realpathSync6;
  const appRoot = canonicalize(resolve4(inputRoot));
  const git = dependencies.git ?? defaultGit;
  try {
    const contentRoot = canonicalize(git(appRoot, ["rev-parse", "--show-toplevel"]));
    assertContained(contentRoot, appRoot, "APP_ROOT_OUTSIDE_WORKTREE");
    const commonRaw = git(appRoot, ["rev-parse", "--git-common-dir"]);
    const commonDirectory = canonicalize(isAbsolute3(commonRaw) ? commonRaw : join4(appRoot, commonRaw));
    const head = git(appRoot, ["rev-parse", "HEAD"]);
    const appRelative = relative3(contentRoot, appRoot) || ".";
    return {
      kind: "git",
      contentRoot,
      appRoot,
      sourceKey: digest2(["git-source", commonDirectory]),
      worktreeKey: digest2(["git-worktree", contentRoot]),
      appRootKey: digest2(["git-app", appRelative]),
      head
    };
  } catch (error) {
    if (error instanceof Error && (error.message.startsWith("APP_ROOT_OUTSIDE_WORKTREE") || error.message.startsWith("NON_GIT_"))) {
      throw error;
    }
    if (!isDefinitiveNonGitError(error))
      throw error;
    return resolveDeclaredIdentity(appRoot, dependencies, canonicalize);
  }
}

// packages/rn-dev-agent-core/dist/session/state-root.js
init_secure_state_file();
import { randomBytes as randomBytes3, randomUUID } from "node:crypto";
import { chmodSync as chmodSync2, linkSync, lstatSync as lstatSync6, mkdirSync as mkdirSync5, readFileSync as readFileSync7, renameSync as renameSync2, rmSync as rmSync3, statSync as statSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join6 } from "node:path";
function fail(code, detail) {
  throw new Error(`${code}: ${detail}`);
}
function ensurePrivateDirectory(path) {
  try {
    mkdirSync5(path, { recursive: true, mode: 448 });
    const link = lstatSync6(path);
    const stat = statSync4(path);
    if (link.isSymbolicLink() || !link.isDirectory() || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("AUTHORITY_STATE_ROOT_UNSAFE", "state directory is not private and user-owned");
    }
    chmodSync2(path, 448);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AUTHORITY_STATE_ROOT_UNSAFE")) {
      throw error;
    }
    fail("AUTHORITY_STATE_ROOT_UNSAFE", error instanceof Error ? error.message : "state directory could not be secured");
  }
}
function sessionDirectory(layout, sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
    fail("INVALID_SESSION_ID", "session identifier is not path-safe");
  }
  const path = join6(layout.sessions, sessionId);
  ensurePrivateDirectory(path);
  return path;
}
function createAuthorityStateLayout(stateDir = getStateDir()) {
  ensurePrivateDirectory(stateDir);
  const root = join6(stateDir, "v2");
  ensurePrivateDirectory(root);
  const layout = {
    root,
    registry: join6(root, "registry.sqlite3"),
    sessions: join6(root, "sessions"),
    runners: join6(root, "runner"),
    observe: join6(root, "observe"),
    migrations: join6(root, "migrations")
  };
  for (const path of [layout.sessions, layout.runners, layout.observe, layout.migrations]) {
    ensurePrivateDirectory(path);
  }
  return layout;
}
function getBoundDirectoryJournalKey(layout = createAuthorityStateLayout()) {
  const path = join6(layout.root, "bound-directory.key");
  const temporary = join6(layout.root, `.bound-directory.${randomUUID()}.key`);
  try {
    try {
      writeFileSync2(temporary, randomBytes3(32), { flag: "wx", mode: 384, flush: true });
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (error.code !== "EEXIST")
          throw error;
      }
    } finally {
      rmSync3(temporary, { force: true });
    }
    const link = lstatSync6(path);
    const stat = statSync4(path);
    const key = readFileSync7(path);
    if (link.isSymbolicLink() || !link.isFile() || key.length !== 32 || typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      fail("AUTHORITY_STATE_ROOT_UNSAFE", "bound-directory journal key is invalid");
    }
    chmodSync2(path, 384);
    return key.toString("base64url");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("AUTHORITY_STATE_ROOT_UNSAFE")) {
      throw error;
    }
    fail("AUTHORITY_STATE_ROOT_UNSAFE", error instanceof Error ? error.message : "bound-directory journal key is unavailable");
  }
}
function sessionRuntimeDirectory(layout, sessionId) {
  const path = join6(sessionDirectory(layout, sessionId), "runtime");
  ensurePrivateDirectory(path);
  return path;
}

// packages/rn-dev-agent-core/dist/session/migration-diagnostic.js
import { existsSync as existsSync7, readFileSync as readFileSync9 } from "node:fs";
import { join as join8 } from "node:path";

// packages/rn-dev-agent-core/dist/session/bound-directory.js
import { spawn as spawn2 } from "node:child_process";
import { randomUUID as randomUUID2 } from "node:crypto";
import { closeSync as closeSync5, constants as constants4, existsSync as existsSync6, fstatSync as fstatSync4, lstatSync as lstatSync7, mkdtempSync, openSync as openSync5, readFileSync as readFileSync8, realpathSync as realpathSync7, renameSync as renameSync3, rmSync as rmSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { tmpdir } from "node:os";
import { join as join7 } from "node:path";
var WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
var WORKER_READY_TIMEOUT_MS = 3e4;
var BOUND_DIRECTORY_LIFECYCLE_MONITOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');

const controlPath = process.argv[1];
const lifecycleCapability = process.argv[2];
const transactionLock = '.rn-bound-transaction.lock';
process.on('disconnect', () => {
  try {
    const lock = JSON.parse(fs.readFileSync(transactionLock, 'utf8'));
    if (lock.owner === lifecycleCapability) fs.unlinkSync(transactionLock);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      try {
        fs.writeFileSync(path.join(controlPath, 'lock-retained'), '', {
          flag: 'wx',
          mode: 0o600,
        });
      } catch {}
    }
  }
  try {
    fs.writeFileSync(path.join(controlPath, 'stopped'), '', { flag: 'wx', mode: 0o600 });
  } catch {}
  process.exit(0);
});
fs.writeFileSync(path.join(controlPath, 'monitor-ready'), '', { flag: 'wx', mode: 0o600 });
`;
var BOUND_DIRECTORY_TERMINATION_WATCHDOG = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

function poll() {
  try {
    const request = JSON.parse(
      fs.readFileSync(path.join(workerData.controlPath, 'terminate'), 'utf8'),
    );
    if (
      request.lifecycleCapability === workerData.lifecycleCapability &&
      (request.signal === 'SIGTERM' || request.signal === 'SIGKILL')
    ) {
      process.kill(process.pid, request.signal);
      return;
    }
  } catch {}
  setTimeout(poll, 5);
}

poll();
`;
var BOUND_DIRECTORY_ANCESTRY_MONITOR = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const { workerData } = require('node:worker_threads');

const state = new Int32Array(workerData.stateBuffer);
const watchers = [];
const records = [];

function invalidate() {
  Atomics.add(state, 1, 1);
  Atomics.notify(state, 1);
}

function fail() {
  Atomics.store(state, 2, 1);
  invalidate();
}

try {
  for (const ancestor of workerData.ancestors) {
    const parentPath = path.dirname(ancestor.publicPath);
    let parent = fs.statSync(parentPath, { bigint: true });
    const sameParent = (left, right) =>
      left.isDirectory() &&
      right.isDirectory() &&
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.ctimeNs === right.ctimeNs &&
      left.mtimeNs === right.mtimeNs;
    const inspectFence = (captureBaseline) => {
      let current;
      try {
        current = fs.statSync(parentPath, { bigint: true });
      } catch {
        invalidate();
        return;
      }
      if (!sameParent(current, parent)) {
        if (!captureBaseline) invalidate();
        parent = current;
      }
    };
    const parentWatcher = fs.watch(parentPath, () => {});
    const contentWatcher = fs.watch(ancestor.publicPath, () => {});
    parentWatcher.on('error', fail);
    contentWatcher.on('error', fail);
    watchers.push(parentWatcher, contentWatcher);
    records.push({ inspectFence });
  }
  let barrierPending = false;
  const barrier = setInterval(() => {
    const requested = Atomics.load(state, 3);
    if (barrierPending || requested === Atomics.load(state, 4)) return;
    barrierPending = true;
    setImmediate(() => {
      setImmediate(() => {
        setImmediate(() => {
          const captureBaseline = Atomics.load(state, 5) === 1;
          for (const record of records) record.inspectFence(captureBaseline);
          Atomics.store(state, 4, requested);
          barrierPending = false;
          Atomics.notify(state, 4);
        });
      });
    });
  }, 1);
  barrier.unref();
  Atomics.store(state, 0, 1);
  Atomics.notify(state, 0);
} catch {
  fail();
  Atomics.store(state, 0, -1);
  Atomics.notify(state, 0);
}
`;
var BOUND_DIRECTORY_WORKER = String.raw`
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

class ConflictError extends Error {}
class AncestryError extends Error {}

const controlPath = process.argv[1];
const binding = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
const childWorkers = new Map();
const transactionLock = '.rn-bound-transaction.lock';
process.on('disconnect', () => process.exit(0));
process.channel?.unref();

const lifecycleMonitor = childProcess.spawn(
  process.execPath,
  [
    '-e',
    ${JSON.stringify(BOUND_DIRECTORY_LIFECYCLE_MONITOR)},
    controlPath,
    binding.lifecycleCapability,
  ],
  { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
);
lifecycleMonitor.on('error', () => {});
lifecycleMonitor.on('exit', () => process.exit(1));
lifecycleMonitor.channel?.unref();
lifecycleMonitor.unref();
const terminationWatchdog = new Worker(${JSON.stringify(BOUND_DIRECTORY_TERMINATION_WATCHDOG)}, {
  eval: true,
  workerData: {
    controlPath,
    lifecycleCapability: binding.lifecycleCapability,
  },
});
terminationWatchdog.on('error', () => process.exit(1));
terminationWatchdog.unref();
const agentAncestorIndex = binding.ancestors.findIndex(
  (ancestor) => path.basename(ancestor.publicPath) === '.rn-agent',
);
const monitoredAncestors =
  agentAncestorIndex === -1
    ? []
    : binding.ancestors.slice(agentAncestorIndex);
const ancestryState = new Int32Array(new SharedArrayBuffer(6 * 4));
if (monitoredAncestors.length > 0) {
  const ancestryMonitor = new Worker(${JSON.stringify(BOUND_DIRECTORY_ANCESTRY_MONITOR)}, {
    eval: true,
    workerData: {
      ancestors: monitoredAncestors,
      stateBuffer: ancestryState.buffer,
    },
  });
  ancestryMonitor.on('error', () => {
    Atomics.store(ancestryState, 2, 1);
    Atomics.add(ancestryState, 1, 1);
  });
  ancestryMonitor.unref();
  if (
    Atomics.wait(ancestryState, 0, 0, 5_000) === 'timed-out' ||
    Atomics.load(ancestryState, 0) !== 1
  ) {
    process.exit(1);
  }
}

function wait(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function synchronizeAncestryMonitor(captureBaseline = false) {
  if (monitoredAncestors.length === 0) return;
  Atomics.store(ancestryState, 5, captureBaseline ? 1 : 0);
  const requested = Atomics.add(ancestryState, 3, 1) + 1;
  Atomics.notify(ancestryState, 3);
  const deadline = Date.now() + 5_000;
  while (Atomics.load(ancestryState, 4) !== requested) {
    const remaining = deadline - Date.now();
    if (
      remaining <= 0 ||
      Atomics.wait(
        ancestryState,
        4,
        Atomics.load(ancestryState, 4),
        remaining,
      ) === 'timed-out'
    ) {
      throw new AncestryError('bound-directory ancestry monitor synchronization failed');
    }
  }
}

function mutateBoundDirectory(mutation) {
  try {
    return mutation();
  } finally {
    synchronizeAncestryMonitor();
  }
}

function validateName(name) {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name === '.' ||
    name === '..' ||
    path.basename(name) !== name
  ) {
    throw new Error('invalid bound-directory filename');
  }
}

function assertBoundDirectory(expectedGuard, settle = false) {
  if (settle) synchronizeAncestryMonitor();
  if (Atomics.load(ancestryState, 2) !== 0) {
    throw new AncestryError('bound-directory ancestry monitor failed');
  }
  const guardBefore = Atomics.load(ancestryState, 1);
  const current = fs.statSync('.', { bigint: true });
  if (
    !current.isDirectory() ||
    current.dev.toString() !== binding.dev ||
    current.ino.toString() !== binding.ino ||
    fs.realpathSync('.') !== binding.realPath
  ) {
    throw new AncestryError('bound-directory identity changed');
  }
  for (const ancestor of binding.ancestors) {
    const publicPath = fs.lstatSync(ancestor.publicPath, { bigint: true });
    if (
      !publicPath.isDirectory() ||
      publicPath.isSymbolicLink() ||
      publicPath.dev.toString() !== ancestor.dev ||
      publicPath.ino.toString() !== ancestor.ino ||
      fs.realpathSync(ancestor.publicPath) !== ancestor.realPath
    ) {
      throw new AncestryError('bound-directory ancestor changed');
    }
  }
  const guardAfter = Atomics.load(ancestryState, 1);
  if (guardBefore !== guardAfter || (expectedGuard !== undefined && guardAfter !== expectedGuard)) {
    throw new AncestryError('bound-directory ancestor changed during operation');
  }
  return guardAfter;
}

function readRegularFile(name) {
  validateName(name);
  let before;
  try {
    before = fs.lstatSync(name, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('bound-directory input is not a regular file');
  }
  const descriptor = fs.openSync(
    name,
    fs.constants.O_RDONLY |
      (fs.constants.O_NOFOLLOW || 0) |
      (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const after = fs.lstatSync(name, { bigint: true });
    if (
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino
    ) {
      throw new Error('bound-directory input changed while opening');
    }
    return {
      contents: fs.readFileSync(descriptor).toString('base64'),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
      mode: Number(opened.mode & 0o777n),
      name,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameContentsAndMode(snapshot, encoded, mode) {
  return (
    snapshot !== null &&
    encoded !== null &&
    (mode === undefined ||
      (process.platform === 'win32'
        ? ((snapshot.mode & 0o222) !== 0) === ((mode & 0o222) !== 0)
        : snapshot.mode === mode)) &&
    Buffer.from(encoded, 'base64').equals(Buffer.from(snapshot.contents, 'base64'))
  );
}

function sameIdentity(left, right) {
  return (
    left !== null &&
    right !== null &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

function removeOptional(name) {
  try {
    mutateBoundDirectory(() => fs.unlinkSync(name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function signedPayload(value) {
  const { signature, ...payload } = value;
  return JSON.stringify(payload);
}

function sign(value) {
  return crypto
    .createHmac('sha256', Buffer.from(binding.journalKey, 'base64url'))
    .update(signedPayload(value))
    .digest('hex');
}

function authenticate(value) {
  if (!value || typeof value.signature !== 'string') return false;
  const expected = Buffer.from(sign(value), 'hex');
  const actual = Buffer.from(value.signature, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readTransactionLock() {
  try {
    return JSON.parse(fs.readFileSync(transactionLock, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateTransactionLock(lock) {
  return (
    lock !== null &&
    lock.version === 1 &&
    typeof lock.controlPath === 'string' &&
    typeof lock.owner === 'string' &&
    authenticate(lock)
  );
}

function publishTransactionLock(lock) {
  const temporary = transactionLock + '.' + binding.lifecycleCapability + '.initial';
  removeOptional(temporary);
  mutateBoundDirectory(() =>
    fs.writeFileSync(temporary, JSON.stringify(lock), {
      flag: 'wx',
      mode: 0o600,
      flush: true,
    }),
  );
  try {
    mutateBoundDirectory(() =>
      fs.linkSync(temporary, transactionLock),
    );
  } finally {
    removeOptional(temporary);
  }
}

function acquireTransactionLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = {
      controlPath,
      owner: binding.lifecycleCapability,
      version: 1,
    };
    lock.signature = sign(lock);
    try {
      publishTransactionLock(lock);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let existing;
      try {
        existing = readTransactionLock();
      } catch {
        throw new Error('bound-directory transaction lock is invalid');
      }
      if (!validateTransactionLock(existing)) {
        throw new Error('bound-directory transaction lock is invalid');
      }
      if (!fs.existsSync(path.join(existing.controlPath, 'stopped'))) {
        throw new Error('bound-directory transaction is active');
      }
      mutateBoundDirectory(() => fs.unlinkSync(transactionLock));
      fs.rmSync(existing.controlPath, { force: true, recursive: true });
    }
  }
  throw new Error('bound-directory transaction lock is unavailable');
}

function ensureTransactionLock() {
  const lock = readTransactionLock();
  if (
    validateTransactionLock(lock) &&
    lock.owner === binding.lifecycleCapability
  ) {
    return;
  }
  acquireTransactionLock();
}

function releaseTransactionLock() {
  const lock = readTransactionLock();
  if (lock === null) return;
  if (
    !validateTransactionLock(lock) ||
    lock.owner !== binding.lifecycleCapability ||
    typeof lock.owner !== 'string'
  ) {
    throw new Error('bound-directory transaction lock is invalid');
  }
  mutateBoundDirectory(() => fs.unlinkSync(transactionLock));
}

function writeJournal(name, value, exclusive) {
  validateName(name);
  value.signature = sign(value);
  const contents = JSON.stringify(value);
  if (exclusive) {
    const temporary = name + '.initial';
    removeOptional(temporary);
    mutateBoundDirectory(() =>
      fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true }),
    );
    try {
      mutateBoundDirectory(() => fs.linkSync(temporary, name));
    } finally {
      removeOptional(temporary);
    }
    return;
  }
  const temporary = name + '.next';
  removeOptional(temporary);
  mutateBoundDirectory(() =>
    fs.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true }),
  );
  mutateBoundDirectory(() => fs.renameSync(temporary, name));
}

function readJournal(name) {
  validateName(name);
  try {
    const snapshot = readRegularFile(name);
    return snapshot === null
      ? null
      : JSON.parse(Buffer.from(snapshot.contents, 'base64').toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function validateWrite(write) {
  validateName(write.name);
  validateName(write.temporary);
  validateName(write.captured);
}

function prepareReplacement(write) {
  if (write.replacement === null) return;
  mutateBoundDirectory(() =>
    fs.writeFileSync(write.temporary, Buffer.from(write.replacement, 'base64'), {
      flag: 'wx',
      mode: write.mode,
    }),
  );
  mutateBoundDirectory(() => fs.chmodSync(write.temporary, write.mode));
}

function applyWrite(write) {
  validateWrite(write);
  prepareReplacement(write);
  if (write.expected === null) {
    if (readRegularFile(write.name) !== null) {
      throw new ConflictError('bound-directory input changed before commit');
    }
  } else {
    try {
      mutateBoundDirectory(() =>
        fs.renameSync(write.name, write.captured),
      );
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new ConflictError('bound-directory input changed before commit');
      }
      throw error;
    }
    if (write.afterCaptureDelayMs > 0) wait(write.afterCaptureDelayMs);
    const observed = readRegularFile(write.captured);
    if (!sameContentsAndMode(observed, write.expected, write.expectedMode)) {
      throw new ConflictError('bound-directory input changed before commit');
    }
  }
  if (write.replacement !== null) {
    try {
      mutateBoundDirectory(() =>
        fs.linkSync(write.temporary, write.name),
      );
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new ConflictError('bound-directory input changed before commit');
      }
      throw error;
    }
  }
  if (write.afterReplacementDelayMs > 0) wait(write.afterReplacementDelayMs);
}

function cleanupArtifacts(writes) {
  for (const write of writes) {
    removeOptional(write.temporary);
    removeOptional(write.captured);
  }
}

function cleanupJournal(name) {
  removeOptional(name + '.next');
  removeOptional(name);
}

function rollbackOwnedWrites(writes, recoveryDelayAfterUnlinkMs) {
  for (const write of [...writes].reverse()) {
    validateWrite(write);
    const captured = readRegularFile(write.captured);
    const temporary = readRegularFile(write.temporary);
    const target = readRegularFile(write.name);
    if (captured !== null) {
      if (target === null) {
        mutateBoundDirectory(() =>
          fs.linkSync(write.captured, write.name),
        );
      } else if (!sameIdentity(target, captured)) {
        if (!sameIdentity(target, temporary)) {
          throw new ConflictError('bound-directory input changed during recovery');
        }
        mutateBoundDirectory(() => fs.unlinkSync(write.name));
        if (recoveryDelayAfterUnlinkMs > 0) wait(recoveryDelayAfterUnlinkMs);
        mutateBoundDirectory(() =>
          fs.linkSync(write.captured, write.name),
        );
      }
      removeOptional(write.captured);
      removeOptional(write.temporary);
      continue;
    }
    if (write.expected === null && sameIdentity(target, temporary)) {
      mutateBoundDirectory(() => fs.unlinkSync(write.name));
    }
    removeOptional(write.temporary);
  }
}

function recoverTransaction(
  journalName,
  requestedWrites,
  recoveryDelayAfterUnlinkMs = 0,
  releaseLock = true,
  ancestryGuard,
) {
  const journal = readJournal(journalName);
  if (journal === null) {
    throw new Error('bound-directory transaction outcome is unknown');
  }
  if (
    journal.version !== 1 ||
    journal.name !== journalName ||
    !authenticate(journal) ||
    JSON.stringify(journal.writes) !== JSON.stringify(requestedWrites)
  ) {
    throw new Error('bound-directory transaction journal is invalid');
  }
  if (journal.state === 'committed') {
    cleanupArtifacts(journal.writes);
    assertBoundDirectory(ancestryGuard, true);
    cleanupJournal(journalName);
    assertBoundDirectory(ancestryGuard, true);
    if (releaseLock) {
      releaseTransactionLock();
      assertBoundDirectory(ancestryGuard, true);
    }
    return { committed: true };
  }
  if (journal.state !== 'applying') {
    throw new Error('bound-directory transaction state is invalid');
  }
  rollbackOwnedWrites(journal.writes, recoveryDelayAfterUnlinkMs);
  assertBoundDirectory(ancestryGuard, true);
  cleanupJournal(journalName);
  assertBoundDirectory(ancestryGuard, true);
  if (releaseLock) {
    releaseTransactionLock();
    assertBoundDirectory(ancestryGuard, true);
  }
  return { committed: false };
}

function transactionJournalNames() {
  return fs
    .readdirSync('.')
    .filter((name) => /^\.rn-bound-([0-9a-f-]{36})\.journal$/.test(name));
}

function inspectTransactions() {
  const invalidJournals = [];
  const transactions = transactionJournalNames()
      .map((journalName) => {
      let journal;
      try {
        journal = readJournal(journalName);
      } catch {
        invalidJournals.push(journalName);
        return null;
      }
      if (
        journal === null ||
        journal.version !== 1 ||
        journal.name !== journalName ||
        typeof journal.owner !== 'string' ||
        !authenticate(journal) ||
        (journal.state !== 'applying' && journal.state !== 'committed') ||
        !Array.isArray(journal.writes)
      ) {
        invalidJournals.push(journalName);
        return null;
      }
      const transactionId = journalName.slice('.rn-bound-'.length, -'.journal'.length);
      if (journal.writes.length > 100) {
        throw new Error('bound-directory transaction journal is too large');
      }
      for (const [index, write] of journal.writes.entries()) {
        validateName(write.name);
        validateName(write.temporary);
        validateName(write.captured);
        if (
          write.temporary !== '.rn-bound-' + transactionId + '-' + index + '.tmp' ||
          write.captured !== '.rn-bound-' + transactionId + '-' + index + '.captured' ||
          (write.expected !== null && typeof write.expected !== 'string') ||
          (write.replacement !== null && typeof write.replacement !== 'string') ||
          !Number.isSafeInteger(write.mode) ||
          (write.expectedMode !== undefined && !Number.isSafeInteger(write.expectedMode))
        ) {
          throw new Error('bound-directory transaction journal write is invalid');
        }
      }
      return {
        journal: journalName,
        state: journal.state,
        transactionId,
        writes: journal.writes,
      };
      })
      .filter((transaction) => transaction !== null);
  if (transactions.length > 1) {
    throw new Error('bound-directory has multiple pending transactions');
  }
  return { invalidJournals, transactions };
}

function quarantineInvalidTransactions(journalNames) {
  return journalNames.map((journal) => {
    const quarantine = journal + '.invalid-' + crypto.randomUUID();
    mutateBoundDirectory(() =>
      fs.renameSync(journal, quarantine),
    );
    return { journal, quarantine };
  });
}

function restoreQuarantinedTransactions(quarantined) {
  for (const entry of [...quarantined].reverse()) {
    mutateBoundDirectory(() =>
      fs.renameSync(entry.quarantine, entry.journal),
    );
  }
}

function discoverTransactions(ancestryGuard) {
  if (transactionJournalNames().length === 0) {
    const lock = readTransactionLock();
    if (
      lock === null ||
      !validateTransactionLock(lock) ||
      lock.owner !== binding.lifecycleCapability
    ) {
      return [];
    }
    assertBoundDirectory(ancestryGuard, true);
    releaseTransactionLock();
    assertBoundDirectory(ancestryGuard, true);
    return [];
  }
  ensureTransactionLock();
  let quarantined = [];
  try {
    const inspection = inspectTransactions();
    assertBoundDirectory(ancestryGuard, true);
    quarantined = quarantineInvalidTransactions(inspection.invalidJournals);
    assertBoundDirectory(ancestryGuard, true);
    if (inspection.transactions.length === 0) {
      releaseTransactionLock();
      assertBoundDirectory(ancestryGuard, true);
    }
    return inspection.transactions;
  } catch (error) {
    if (error instanceof AncestryError) {
      try {
        const rollbackGuard = assertBoundDirectory();
        restoreQuarantinedTransactions(quarantined);
        assertBoundDirectory(rollbackGuard, true);
        releaseTransactionLock();
        assertBoundDirectory(rollbackGuard, true);
      } catch {}
    } else {
      try {
        releaseTransactionLock();
      } catch {}
    }
    throw error;
  }
}

function applyBatch(request, ancestryGuard) {
  acquireTransactionLock();
  const inspection = inspectTransactions();
  if (inspection.invalidJournals.length > 0) {
    releaseTransactionLock();
    throw new Error('bound-directory transaction journal is invalid');
  }
  const pending = inspection.transactions;
  if (pending.length === 1) {
    recoverTransaction(pending[0].journal, pending[0].writes, 0, false, ancestryGuard);
  } else {
    assertBoundDirectory(ancestryGuard, true);
  }
  const journal = {
    version: 1,
    name: request.journal,
    owner: binding.lifecycleCapability,
    state: 'applying',
    writes: request.writes,
  };
  let committed = false;
  try {
    writeJournal(request.journal, journal, true);
    for (const write of request.writes) applyWrite(write);
    assertBoundDirectory(ancestryGuard, true);
    journal.state = 'committed';
    writeJournal(request.journal, journal, false);
    committed = true;
    assertBoundDirectory(ancestryGuard, true);
    if (request.failCleanupAfterCommit) {
      throw new Error('bound-directory cleanup unavailable');
    }
    cleanupArtifacts(request.writes);
    assertBoundDirectory(ancestryGuard, true);
    cleanupJournal(request.journal);
    assertBoundDirectory(ancestryGuard, true);
    releaseTransactionLock();
    if (request.afterLockReleaseDelayMs) wait(request.afterLockReleaseDelayMs);
    assertBoundDirectory(ancestryGuard, true);
    return { committed: true };
  } catch (error) {
    if (committed) {
      return {
        cleanupPending: true,
        committed: true,
        ...(error instanceof AncestryError ? { cleanupError: error.message } : {}),
      };
    }
    try {
      recoverTransaction(
        request.journal,
        request.writes,
        0,
        true,
        assertBoundDirectory(),
      );
    } catch (recoveryError) {
      throw new AggregateError([error, recoveryError]);
    }
    throw error;
  }
}

function spawnChildWorker(request, directory) {
  const existing = childWorkers.get(request.childId);
  if (existing) {
    throw new Error('bound-directory child worker already exists');
  }
  const childBinding = Buffer.from(
    JSON.stringify({
      dev: directory.dev.toString(),
      ino: directory.ino.toString(),
      ancestors: [
        ...binding.ancestors,
        {
          dev: directory.dev.toString(),
          ino: directory.ino.toString(),
          publicPath: request.publicPath,
          realPath: directory.realPath,
        },
      ],
      lifecycleCapability: request.lifecycleCapability,
      controlPath: request.controlPath,
      journalKey: binding.journalKey,
      publicPath: request.publicPath,
      realPath: directory.realPath,
    }),
  ).toString('base64url');
  const child = childProcess.spawn(
    process.execPath,
    [...process.execArgv, request.controlPath, childBinding],
    {
      cwd: request.name,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  child.on('error', () => {});
  child.on('exit', () => {
    if (childWorkers.get(request.childId) === child) {
      childWorkers.delete(request.childId);
    }
  });
  child.channel?.unref();
  child.unref();
  childWorkers.set(request.childId, child);
}

function execute(request) {
  synchronizeAncestryMonitor(true);
  const ancestryGuard = assertBoundDirectory();
  if (request.operation === 'directory') {
    validateName(request.childId);
    validateName(request.name);
    let created = false;
    if (request.create) {
      try {
        mutateBoundDirectory(() =>
          fs.mkdirSync(request.name, { mode: request.mode }),
        );
        created = true;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    let before;
    try {
      before = fs.lstatSync(request.name, { bigint: true });
    } catch (error) {
      if (request.optional && error.code === 'ENOENT') {
        if (request.optionalMissingDelayMs) wait(request.optionalMissingDelayMs);
        assertBoundDirectory(ancestryGuard, true);
        return { directoryMissing: true };
      }
      throw error;
    }
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error('bound-directory child is not a directory');
    }
    const realPath = fs.realpathSync(request.name);
    if (realPath !== path.join(binding.realPath, request.name)) {
      throw new Error('bound-directory child escaped retained parent');
    }
    const after = fs.lstatSync(request.name, { bigint: true });
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error('bound-directory child changed while binding');
    }
    const directory = { dev: after.dev, ino: after.ino, realPath };
    try {
      assertBoundDirectory(ancestryGuard, true);
    } catch (error) {
      if (created) {
        mutateBoundDirectory(() => fs.rmdirSync(request.name));
      }
      throw error;
    }
    spawnChildWorker(request, directory);
    return {
      directoryIdentity: {
        dev: directory.dev.toString(),
        ino: directory.ino.toString(),
        realPath,
      },
    };
  }
  if (request.operation === 'child-identity') {
    const child = childWorkers.get(request.childId);
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('bound-directory child worker is unavailable');
    }
    assertBoundDirectory(ancestryGuard, true);
    return {};
  }
  if (request.operation === 'read') {
    const snapshots = request.names.map((name) => {
      const snapshot = readRegularFile(name);
      return snapshot ?? { contents: null, mode: 0o600, name };
    });
    assertBoundDirectory(ancestryGuard, true);
    return { snapshots };
  }
  if (request.operation === 'cas') {
    return applyBatch(request, ancestryGuard);
  }
  if (request.operation === 'recover') {
    ensureTransactionLock();
    if (request.cleanupRecoveryDelayMs) wait(request.cleanupRecoveryDelayMs);
    if (request.failCleanupRecovery) {
      throw new Error('bound-directory cleanup recovery unavailable');
    }
    return recoverTransaction(
      request.journal,
      request.writes,
      request.recoveryDelayAfterUnlinkMs,
      true,
      ancestryGuard,
    );
  }
  if (request.operation === 'discover') {
    if (request.discoveryQuarantineDelayMs) wait(request.discoveryQuarantineDelayMs);
    return { transactions: discoverTransactions(ancestryGuard) };
  }
  if (request.operation === 'identity') {
    assertBoundDirectory(ancestryGuard, true);
    return {};
  }
  throw new Error('invalid bound-directory operation');
}

function respond(requestPath, responsePath) {
  let response;
  let request;
  try {
    request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
    response = { ok: true, ...execute(request) };
    synchronizeAncestryMonitor();
  } catch (error) {
    const conflict =
      error instanceof ConflictError ||
      (error instanceof AggregateError &&
        error.errors.some((entry) => entry instanceof ConflictError));
    response = {
      ok: false,
      code: conflict ? 'CONFLICT' : 'UNSAFE',
      message:
        error instanceof AggregateError
          ? error.errors
              .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
              .join('; ')
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
  const temporary = responsePath + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(response), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, responsePath);
  if (request?.operation === 'cas' && response.ok && !response.cleanupPending) {
    cleanupJournal(request.journal);
  }
  removeOptional(requestPath);
}

async function run() {
  assertBoundDirectory();
  while (!fs.existsSync(path.join(controlPath, 'monitor-ready'))) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  fs.writeFileSync(
    path.join(controlPath, 'ready'),
    JSON.stringify({
      lifecycleCapability: binding.lifecycleCapability,
      ok: true,
      pid: process.pid,
    }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  while (!fs.existsSync(path.join(controlPath, 'stop'))) {
    for (const entry of fs.readdirSync(controlPath)) {
      if (!entry.endsWith('.request')) continue;
      const requestPath = path.join(controlPath, entry);
      const responsePath = path.join(controlPath, entry.replace(/\.request$/, '.response'));
      respond(requestPath, responsePath);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

run().catch((error) => {
  try {
    fs.writeFileSync(
      path.join(controlPath, 'ready'),
      JSON.stringify({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  } catch {}
  process.exitCode = 1;
});
`;
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync6(path))
      return true;
    Atomics.wait(WAIT_BUFFER, 0, 0, 5);
  }
  return existsSync6(path);
}
function stopWorker(worker, signal = "SIGTERM") {
  const stoppedPath = join7(worker.controlPath, "stopped");
  if (signal === "SIGTERM") {
    try {
      writeFileSync3(join7(worker.controlPath, "stop"), "", { flag: "wx", mode: 384 });
    } catch {
    }
    if (waitForFile(stoppedPath, 1e3)) {
      if (!existsSync6(join7(worker.controlPath, "lock-retained"))) {
        rmSync4(worker.controlPath, { force: true, recursive: true });
      }
      return;
    }
  }
  try {
    writeFileSync3(join7(worker.controlPath, "terminate"), JSON.stringify({
      lifecycleCapability: worker.lifecycleCapability,
      signal: "SIGKILL"
    }), { flag: "wx", mode: 384 });
  } catch {
  }
  if (!waitForFile(stoppedPath, 1e4)) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker exit was not confirmed");
  }
  if (!existsSync6(join7(worker.controlPath, "lock-retained"))) {
    rmSync4(worker.controlPath, { force: true, recursive: true });
  }
}
function bindWorker(controlPath, child, owner, childId, lifecycleCapability = "") {
  const rejectWorker = (message) => {
    if (typeof lifecycleCapability === "string") {
      try {
        stopWorker({
          child,
          childId,
          controlPath,
          lifecycleCapability,
          owner,
          pid: child?.pid ?? 0,
          sequence: 0
        }, "SIGKILL");
      } catch {
      }
    }
    throw new Error(message);
  };
  const readyPath = join7(controlPath, "ready");
  if (!waitForFile(readyPath, WORKER_READY_TIMEOUT_MS)) {
    rejectWorker("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable");
  }
  let ready = {};
  try {
    ready = JSON.parse(readFileSync8(readyPath, "utf8"));
  } catch {
    rejectWorker("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker unavailable");
  }
  const readyPid = ready.pid;
  if (ready.ok !== true || lifecycleCapability.length === 0 || ready.lifecycleCapability !== lifecycleCapability || typeof readyPid !== "number" || !Number.isSafeInteger(readyPid) || readyPid <= 0 || child?.pid !== void 0 && child.pid !== readyPid) {
    rejectWorker("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory worker rejected path");
  }
  return {
    child,
    childId,
    controlPath,
    lifecycleCapability,
    owner,
    pid: readyPid,
    sequence: 0
  };
}
function startWorker(path, identity, realPath) {
  const controlPath = mkdtempSync(join7(tmpdir(), "rn-bound-directory-"));
  const lifecycleCapability = randomUUID2();
  const binding = Buffer.from(JSON.stringify({
    dev: identity.dev.toString(),
    ino: identity.ino.toString(),
    ancestors: [
      {
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
        publicPath: path,
        realPath
      }
    ],
    lifecycleCapability,
    controlPath,
    journalKey: getBoundDirectoryJournalKey(),
    publicPath: path,
    realPath
  })).toString("base64url");
  const child = spawn2(process.execPath, ["-e", BOUND_DIRECTORY_WORKER, controlPath, binding], {
    cwd: path,
    stdio: ["ignore", "ignore", "ignore", "ipc"]
  });
  child.on("error", () => {
  });
  child.channel?.unref();
  child.unref();
  return bindWorker(controlPath, child, void 0, void 0, lifecycleCapability);
}
function startSubdirectoryWorker(parent, name, expectedIdentity, expectedRealPath) {
  const controlPath = mkdtempSync(join7(tmpdir(), "rn-bound-directory-"));
  const childId = randomUUID2();
  const lifecycleCapability = randomUUID2();
  let worker;
  let childStarted = false;
  try {
    const result = runBoundOperation(parent, {
      operation: "directory",
      childId,
      controlPath,
      lifecycleCapability,
      name,
      publicPath: join7(parent.path, name),
      create: false,
      mode: 448
    });
    childStarted = true;
    worker = bindWorker(controlPath, void 0, parent, childId, lifecycleCapability);
    if (!result.directoryIdentity || BigInt(result.directoryIdentity.dev) !== expectedIdentity.dev || BigInt(result.directoryIdentity.ino) !== expectedIdentity.ino || result.directoryIdentity.realPath !== expectedRealPath) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory child identity changed");
    }
    return worker;
  } catch (error) {
    try {
      if (worker)
        stopWorker(worker, "SIGKILL");
      else if (childStarted || error instanceof Error && error.message === "SESSION_INTEGRATION_WORKER_TIMEOUT") {
        stopWorker({
          childId,
          controlPath,
          lifecycleCapability,
          owner: parent,
          pid: 0,
          sequence: 0
        }, "SIGKILL");
      } else {
        rmSync4(controlPath, { force: true, recursive: true });
      }
    } catch (cleanupError) {
      throw new AggregateError([
        error instanceof Error ? error : new Error(String(error)),
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      ], "bound-directory child cleanup failed");
    }
    throw error;
  }
}
function restartWorker(directory) {
  const descendants = [...directory.children];
  stopDescendantWorkers(directory);
  stopWorker(directory.worker, "SIGKILL");
  if (directory.parent && directory.name) {
    directory.worker = startSubdirectoryWorker(directory.parent, directory.name, directory.identity, directory.realPath);
  } else {
    directory.worker = startWorker(directory.path, directory.identity, directory.realPath);
  }
  for (const descendant of descendants) {
    descendant.worker = startSubdirectoryWorker(directory, descendant.name, descendant.identity, descendant.realPath);
    rebindDescendants(descendant);
  }
}
function stopDescendantWorkers(directory) {
  for (const descendant of directory.children) {
    stopDescendantWorkers(descendant);
    stopWorker(descendant.worker, "SIGKILL");
  }
}
function rebindDescendants(directory) {
  for (const descendant of directory.children) {
    descendant.worker = startSubdirectoryWorker(directory, descendant.name, descendant.identity, descendant.realPath);
    rebindDescendants(descendant);
  }
}
function sendOperation(directory, request, timeoutMs) {
  const sequence = ++directory.worker.sequence;
  const prefix = String(sequence).padStart(8, "0");
  const pendingPath = join7(directory.worker.controlPath, `${prefix}.pending`);
  const requestPath = join7(directory.worker.controlPath, `${prefix}.request`);
  const responsePath = join7(directory.worker.controlPath, `${prefix}.response`);
  writeFileSync3(pendingPath, JSON.stringify(request), { flag: "wx", mode: 384 });
  renameSync3(pendingPath, requestPath);
  if (!waitForFile(responsePath, timeoutMs)) {
    throw new Error("SESSION_INTEGRATION_WORKER_TIMEOUT");
  }
  let result;
  try {
    result = JSON.parse(readFileSync8(responsePath, "utf8"));
  } catch {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation returned invalid output");
  } finally {
    rmSync4(responsePath, { force: true });
  }
  return result;
}
function throwOperationFailure(result) {
  const prefix = result.code === "CONFLICT" ? "SESSION_INTEGRATION_CONFLICT" : "SESSION_INTEGRATION_PATH_UNSAFE";
  throw new Error(`${prefix}: ${result.message ?? "bound-directory operation failed"}`);
}
function runBoundOperation(directory, request, dependencies = {}) {
  if (directory.closed) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound directory is closed");
  }
  if (directory.descriptor !== void 0) {
    const retained = fstatSync4(directory.descriptor, { bigint: true });
    if (!retained.isDirectory() || retained.dev !== directory.identity.dev || retained.ino !== directory.identity.ino) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: retained directory identity changed");
    }
  }
  let current;
  let currentRealPath;
  try {
    current = lstatSync7(directory.path, { bigint: true });
    currentRealPath = realpathSync7(directory.path);
  } catch {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound directory path is unavailable");
  }
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, directory.identity) || currentRealPath !== directory.realPath) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound directory path changed");
  }
  try {
    const result = sendOperation(directory, request, dependencies.timeoutMs ?? 5e3);
    if (!result.ok)
      throwOperationFailure(result);
    if (request.operation === "cas" && result.cleanupPending) {
      if (result.cleanupError)
        return result;
      try {
        dependencies.beforeCleanupRecovery?.();
        const cleanup = sendOperation(directory, {
          operation: "recover",
          failCleanupRecovery: dependencies.failCleanupRecovery ?? false,
          cleanupRecoveryDelayMs: dependencies.cleanupRecoveryDelayMs ?? 0,
          journal: request.journal,
          writes: request.writes
        }, dependencies.recoveryTimeoutMs ?? 5e3);
        if (!cleanup.ok)
          throwOperationFailure(cleanup);
        if (!cleanup.committed) {
          throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved");
        }
        return { ...result, cleanupPending: false };
      } catch (cleanupError) {
        let unresolvedCleanup = cleanupError;
        if (cleanupError instanceof Error && cleanupError.message === "SESSION_INTEGRATION_WORKER_TIMEOUT") {
          try {
            restartWorker(directory);
            const cleanup = sendOperation(directory, {
              operation: "recover",
              failCleanupRecovery: dependencies.failCleanupRecovery ?? false,
              journal: request.journal,
              writes: request.writes
            }, dependencies.recoveryTimeoutMs ?? 5e3);
            if (!cleanup.ok)
              throwOperationFailure(cleanup);
            if (!cleanup.committed) {
              throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: committed bound-directory cleanup was not preserved");
            }
            return { ...result, cleanupPending: false };
          } catch (retryError) {
            unresolvedCleanup = retryError;
          }
        }
        return {
          ...result,
          cleanupPending: true,
          cleanupError: unresolvedCleanup instanceof Error ? unresolvedCleanup.message : String(unresolvedCleanup)
        };
      }
    }
    return result;
  } catch (error) {
    if (request.operation !== "cas" || !(error instanceof Error) || error.message !== "SESSION_INTEGRATION_WORKER_TIMEOUT") {
      throw error;
    }
    restartWorker(directory);
    let recovery;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        recovery = sendOperation(directory, {
          operation: "recover",
          journal: request.journal,
          writes: request.writes,
          recoveryDelayAfterUnlinkMs: dependencies.recoveryDelayAfterUnlinkMs ?? 0
        }, dependencies.recoveryTimeoutMs ?? 5e3);
        if (!recovery.ok)
          throwOperationFailure(recovery);
        break;
      } catch (recoveryError) {
        if (!(recoveryError instanceof Error) || recoveryError.message !== "SESSION_INTEGRATION_WORKER_TIMEOUT") {
          throw recoveryError;
        }
        restartWorker(directory);
      }
    }
    if (!recovery) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery failed");
    }
    if (recovery.committed)
      return recovery;
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory operation unavailable");
  }
}
function recoverDiscoveredTransactions(directory, discoveryQuarantineDelayMs = 0) {
  const result = runBoundOperation(directory, {
    operation: "discover",
    discoveryQuarantineDelayMs
  });
  if (!result.transactions) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory discovery returned invalid output");
  }
  for (const transaction of result.transactions) {
    if (!/^[0-9a-f-]{36}$/.test(transaction.transactionId) || transaction.journal !== `.rn-bound-${transaction.transactionId}.journal` || transaction.state !== "applying" && transaction.state !== "committed") {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory discovery returned invalid transaction");
    }
    directory.pendingCleanups.set(transaction.transactionId, {
      journal: transaction.journal,
      knownCommitted: transaction.state === "committed",
      writes: transaction.writes
    });
    retryBoundDirectoryCleanup(directory, {
      transactionId: transaction.transactionId
    });
  }
}
function openValidatedDirectory(path, expected) {
  let descriptor;
  let worker;
  try {
    const before = lstatSync7(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is not a directory");
    }
    descriptor = openSync5(path, constants4.O_RDONLY | (constants4.O_DIRECTORY ?? 0) | (constants4.O_NOFOLLOW ?? 0));
    const opened = fstatSync4(descriptor, { bigint: true });
    const after = lstatSync7(path, { bigint: true });
    const realPath = realpathSync7(path);
    if (!opened.isDirectory() || !sameIdentity(before, opened) || !sameIdentity(after, opened) || expected !== void 0 && (!sameIdentity(expected.identity, opened) || expected.realPath !== realPath)) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor changed while opening");
    }
    const identity = { dev: opened.dev, ino: opened.ino };
    worker = startWorker(path, identity, realPath);
    const directory = {
      children: /* @__PURE__ */ new Set(),
      descriptor,
      identity,
      path,
      pendingCleanups: /* @__PURE__ */ new Map(),
      realPath,
      worker,
      closed: false
    };
    recoverDiscoveredTransactions(directory);
    return directory;
  } catch (error) {
    const cleanupErrors = [];
    if (worker !== void 0) {
      try {
        stopWorker(worker, "SIGKILL");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
    }
    if (descriptor !== void 0) {
      try {
        closeSync5(descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)));
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error instanceof Error ? error : new Error(String(error)), ...cleanupErrors], "bound-directory open cleanup failed");
    }
    if (error instanceof Error && error.message.includes("SESSION_INTEGRATION_PATH_UNSAFE")) {
      throw error;
    }
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: integration ancestor is unavailable");
  }
}
function openBoundDirectory(path) {
  return openValidatedDirectory(path);
}
function closeBoundDirectory(directory) {
  if (directory.closed)
    return;
  const cleanupErrors = [];
  for (const child of directory.children) {
    try {
      closeBoundDirectory(child);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  for (const transactionId of directory.pendingCleanups.keys()) {
    try {
      retryBoundDirectoryCleanup(directory, { transactionId });
    } catch (error) {
      cleanupErrors.push(new Error(`bound-directory cleanup ${transactionId} failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  directory.closed = true;
  try {
    stopWorker(directory.worker);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(`bound-directory close failed: ${String(error)}`));
  }
  directory.parent?.children.delete(directory);
  if (directory.descriptor !== void 0) {
    try {
      closeSync5(directory.descriptor);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "bound-directory cleanup failed");
  }
}
function closeBoundDirectories(directories, primaryError) {
  const closeErrors = [];
  for (const directory of directories) {
    if (!directory)
      continue;
    try {
      closeBoundDirectory(directory);
    } catch (error) {
      closeErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (closeErrors.length === 0)
    return;
  const errors = primaryError === void 0 ? closeErrors : [
    primaryError instanceof Error ? primaryError : new Error(String(primaryError)),
    ...closeErrors
  ];
  throw new AggregateError(errors, "bound-directory cleanup failed");
}
function openBoundSubdirectoryInternal(parent, name, options = {}) {
  const controlPath = mkdtempSync(join7(tmpdir(), "rn-bound-directory-"));
  const childId = randomUUID2();
  const lifecycleCapability = randomUUID2();
  let worker;
  let childStarted = false;
  try {
    const result = runBoundOperation(parent, {
      operation: "directory",
      childId,
      controlPath,
      lifecycleCapability,
      name,
      publicPath: join7(parent.path, name),
      create: options.create ?? false,
      mode: options.mode ?? 448,
      optional: options.optional ?? false,
      optionalMissingDelayMs: options.optionalMissingDelayMs ?? 0
    });
    childStarted = !result.directoryMissing;
    if (result.directoryMissing) {
      rmSync4(controlPath, { force: true, recursive: true });
      return null;
    }
    worker = bindWorker(controlPath, void 0, parent, childId, lifecycleCapability);
    options.afterChildBind?.();
    if (!result.directoryIdentity) {
      throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory traversal returned invalid output");
    }
    const directory = {
      children: /* @__PURE__ */ new Set(),
      identity: {
        dev: BigInt(result.directoryIdentity.dev),
        ino: BigInt(result.directoryIdentity.ino)
      },
      name,
      parent,
      path: join7(parent.path, name),
      pendingCleanups: /* @__PURE__ */ new Map(),
      realPath: result.directoryIdentity.realPath,
      worker,
      closed: false
    };
    recoverDiscoveredTransactions(directory, options.discoveryQuarantineDelayMs);
    runBoundOperation(parent, { operation: "child-identity", childId });
    parent.children.add(directory);
    return directory;
  } catch (error) {
    try {
      if (worker)
        stopWorker(worker, "SIGKILL");
      else if (childStarted || error instanceof Error && error.message === "SESSION_INTEGRATION_WORKER_TIMEOUT") {
        stopWorker({
          childId,
          controlPath,
          lifecycleCapability,
          owner: parent,
          pid: 0,
          sequence: 0
        }, "SIGKILL");
      } else {
        rmSync4(controlPath, { force: true, recursive: true });
      }
    } catch (cleanupError) {
      throw new AggregateError([
        error instanceof Error ? error : new Error(String(error)),
        cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError))
      ], "bound-directory child cleanup failed");
    }
    throw error;
  }
}
function openBoundSubdirectory(parent, name, options = {}) {
  return openBoundSubdirectoryInternal(parent, name, options);
}
function readBoundDirectoryFiles(directory, names) {
  const result = runBoundOperation(directory, { operation: "read", names });
  if (!result.snapshots || result.snapshots.length !== names.length) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory read returned invalid output");
  }
  return result.snapshots.map((snapshot) => ({
    contents: snapshot.contents === null ? null : Buffer.from(snapshot.contents, "base64"),
    mode: snapshot.mode,
    name: snapshot.name
  }));
}
function casBoundDirectoryFiles(directory, writes, dependencies = {}) {
  for (const transactionId2 of directory.pendingCleanups.keys()) {
    retryBoundDirectoryCleanup(directory, { transactionId: transactionId2 });
  }
  const transactionId = randomUUID2();
  const journal = `.rn-bound-${transactionId}.journal`;
  const serializedWrites = writes.map((write, index) => ({
    expected: write.expected?.toString("base64") ?? null,
    expectedMode: write.expectedMode,
    mode: write.mode,
    name: write.name,
    replacement: write.replacement?.toString("base64") ?? null,
    temporary: `.rn-bound-${transactionId}-${index}.tmp`,
    captured: `.rn-bound-${transactionId}-${index}.captured`,
    afterCaptureDelayMs: dependencies.afterCaptureDelayMs ?? 0,
    afterReplacementDelayMs: dependencies.afterReplacementDelayMs ?? 0
  }));
  const result = runBoundOperation(directory, {
    operation: "cas",
    journal,
    writes: serializedWrites,
    afterLockReleaseDelayMs: dependencies.afterLockReleaseDelayMs ?? 0,
    failCleanupAfterCommit: dependencies.failCleanupAfterCommit ?? false
  }, dependencies);
  if (!result.committed) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory commit was not confirmed");
  }
  if (result.cleanupPending) {
    directory.pendingCleanups.set(transactionId, {
      journal,
      knownCommitted: true,
      writes: serializedWrites
    });
  } else {
    directory.pendingCleanups.delete(transactionId);
  }
  return {
    committed: true,
    cleanupPending: result.cleanupPending ?? false,
    ...result.cleanupPending ? { cleanupObligation: { transactionId } } : {},
    ...result.cleanupError ? { cleanupError: result.cleanupError } : {}
  };
}
function retryBoundDirectoryCleanup(directory, obligation, dependencies = {}) {
  const transaction = directory.pendingCleanups.get(obligation.transactionId);
  if (!transaction) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory cleanup obligation is unavailable");
  }
  const request = {
    operation: "recover",
    journal: transaction.journal,
    writes: transaction.writes
  };
  let result;
  try {
    result = runBoundOperation(directory, request, dependencies);
  } catch (error) {
    if (transaction.knownCommitted && error instanceof Error && error.message.includes("bound-directory transaction outcome is unknown")) {
      directory.pendingCleanups.delete(obligation.transactionId);
      return;
    }
    if (!(error instanceof Error) || error.message !== "SESSION_INTEGRATION_WORKER_TIMEOUT") {
      throw error;
    }
    restartWorker(directory);
    result = runBoundOperation(directory, request, {
      ...dependencies,
      cleanupRecoveryDelayMs: 0
    });
  }
  if (result.committed !== transaction.knownCommitted) {
    throw new Error("SESSION_INTEGRATION_PATH_UNSAFE: bound-directory recovery changed transaction outcome");
  }
  directory.pendingCleanups.delete(obligation.transactionId);
}
function writeBoundDirectoryFile(directory, name, contents, mode, dependencies = {}) {
  const [snapshot] = readBoundDirectoryFiles(directory, [name]);
  dependencies.beforeCommit?.();
  const result = casBoundDirectoryFiles(directory, [
    {
      expected: snapshot.contents,
      expectedMode: snapshot.mode,
      mode,
      name,
      replacement: contents
    }
  ]);
  return result;
}

// packages/rn-dev-agent-core/dist/session/migration-diagnostic.js
init_registry();
function readPackageIntegrationManifest(appRoot, dependencies) {
  const manifestPath = join8(appRoot, ".rn-agent", "integration", "rn-session-integration.json");
  if (dependencies.exists || dependencies.readText) {
    const exists = dependencies.exists ?? existsSync7;
    if (!exists(manifestPath))
      return void 0;
    const readText = dependencies.readText ?? ((path) => readFileSync9(path, "utf8"));
    return readText(manifestPath);
  }
  const agent = openBoundDirectory(join8(appRoot, ".rn-agent"));
  let integration;
  let primaryError;
  try {
    integration = openBoundSubdirectory(agent, "integration");
    const [manifest] = readBoundDirectoryFiles(integration, ["rn-session-integration.json"]);
    return manifest?.contents?.toString("utf8");
  } catch (error) {
    if (error instanceof Error && error.message.includes("SESSION_INTEGRATION_PATH_UNSAFE") && error.message.includes("ENOENT") && error.message.includes("lstat 'integration'")) {
      return void 0;
    }
    primaryError = error;
    throw error;
  } finally {
    closeBoundDirectories([integration, agent], primaryError);
  }
}
function inspectAuthorityMigration(status, dependencies = {}) {
  const exists = dependencies.exists ?? existsSync7;
  const appRoot = typeof status.source.appRoot === "string" ? status.source.appRoot : "";
  let packageIntegrationInstalled = false;
  if (appRoot) {
    try {
      const manifestText = readPackageIntegrationManifest(appRoot, dependencies);
      const manifest = manifestText ? JSON.parse(manifestText) : void 0;
      packageIntegrationInstalled = manifest?.version === 1;
    } catch (error) {
      if (error instanceof Error && error.message.includes("SESSION_INTEGRATION_PATH_UNSAFE") && !error.message.includes("ancestor is unavailable")) {
        throw error;
      }
      packageIntegrationInstalled = false;
    }
  }
  const legacyStateDetected = [
    "/tmp/rn-dev-agent-session.json",
    "/tmp/rn-fast-runner-state.json",
    "/tmp/rn-android-runner-state.json"
  ].some(exists);
  return {
    rollout: "strict-default",
    storeAvailable: true,
    registrySchema: AUTHORITY_REGISTRY_SCHEMA_VERSION,
    legacyStateDetected,
    bundleHandshake: {
      supported: true,
      scope: "coarse-initial-bundle",
      bound: Boolean(status.bindings.bundle),
      sourceFidelity: "not-proven"
    },
    packageIntegration: {
      supported: true,
      installed: packageIntegrationInstalled
    },
    strictEnforcement: true
  };
}

// packages/rn-dev-agent-core/dist/session/public-status.js
function projectPublicAuthorityStatus(status, options = {}) {
  if (!status.available) {
    return {
      available: false,
      code: status.code
    };
  }
  const recovery = status.bindings.recoveryHandles;
  const recoveryStatus = status.state === "blocked" && recovery ? {
    handoffRecipientHandle: typeof recovery.handoffRecipient?.token === "string" ? recovery.handoffRecipient.token : void 0,
    handoffRecipientExpiresMs: typeof recovery.handoffRecipient?.expiresMs === "number" ? recovery.handoffRecipient.expiresMs : void 0,
    adoptionRequired: Boolean(recovery.adoptStale),
    adoptionHandle: typeof recovery.adoptStale?.token === "string" ? recovery.adoptStale.token : void 0,
    adoptionExpiresMs: typeof recovery.adoptStale?.expiresMs === "number" ? recovery.adoptStale.expiresMs : void 0
  } : void 0;
  const metro = status.bindings.metro;
  const metroTerminal = status.bindings.metroTerminal;
  return {
    available: true,
    ...options.includeSessionId ? { sessionId: status.sessionId } : {},
    state: status.state,
    sourceKind: status.source.kind,
    metroPort: status.bindings.metroPort,
    observePort: status.bindings.observePort,
    platform: status.bindings.device?.platform,
    deviceBound: Boolean(status.bindings.device),
    installBound: Boolean(status.bindings.install),
    metroBound: Boolean(status.bindings.metro),
    ...metroTerminal ? {
      metroTerminal: {
        code: metroTerminal.code,
        reason: metroTerminal.reason,
        phase: metroTerminal.phase,
        observedAt: metroTerminal.observedAt
      }
    } : {},
    sandbox: metro?.runtimeEvidenceAuthority === "managed-sandbox-v1" ? "managed-sandbox-v1" : "unavailable",
    bundleBound: Boolean(status.bindings.bundle),
    runnerBound: Boolean(status.bindings.runner),
    recorderBound: Boolean(status.bindings.recorder),
    ...recoveryStatus ? { recovery: recoveryStatus } : {},
    migration: inspectAuthorityMigration(status)
  };
}

// packages/rn-dev-agent-core/dist/session/process-cleanup.js
init_release_android_slot();
import { execFile as execFileCb13, spawn as spawn5 } from "node:child_process";
import { promisify as promisify16 } from "node:util";
init_process_birth();
init_registry();
var execFile15 = promisify16(execFileCb13);
var RECORDER_POST_KILL_CONFIRM_MS = 2e3;
function executeRecorderScript(script, args, options) {
  return new Promise((resolve5, reject) => {
    const child = spawn5(script, args, {
      detached: process.platform !== "win32",
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timer;
    let killTimer;
    let groupPollTimer;
    let groupExitDeadline;
    let terminationError;
    const finish = (error, result) => {
      if (settled)
        return;
      settled = true;
      if (timer)
        clearTimeout(timer);
      if (killTimer)
        clearTimeout(killTimer);
      if (groupPollTimer)
        clearTimeout(groupPollTimer);
      if (error)
        reject(error);
      else
        resolve5(result);
    };
    const signal = (value) => {
      if (child.pid === void 0)
        return;
      try {
        if (process.platform === "win32")
          child.kill(value);
        else
          process.kill(-child.pid, value);
      } catch {
      }
    };
    const processGroupExists = () => {
      if (child.pid === void 0 || process.platform === "win32")
        return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        return error.code !== "ESRCH";
      }
    };
    const waitForProcessGroupExit = () => {
      if (!terminationError || settled)
        return;
      if (!processGroupExists()) {
        finish(terminationError);
        return;
      }
      if (groupExitDeadline !== void 0 && Date.now() >= groupExitDeadline) {
        finish(new Error(`${terminationError.message}; recorder process-group termination is unconfirmed`, { cause: terminationError }));
        return;
      }
      groupPollTimer = setTimeout(waitForProcessGroupExit, 25);
    };
    const terminate = (error) => {
      if (terminationError)
        return;
      terminationError = error;
      signal("SIGTERM");
      if (process.platform === "win32")
        return;
      killTimer = setTimeout(() => {
        groupExitDeadline = Date.now() + RECORDER_POST_KILL_CONFIRM_MS;
        signal("SIGKILL");
        waitForProcessGroupExit();
      }, 250);
      waitForProcessGroupExit();
    };
    const collect = (target) => (chunk) => {
      if (terminationError)
        return;
      outputBytes += chunk.length;
      if (outputBytes > 8 * 1024 * 1024) {
        terminate(new Error("record_proof.sh output exceeded 8 MiB"));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.on("error", (error) => {
      if (child.pid === void 0)
        finish(error);
      else
        terminate(error);
    });
    child.on("close", (code, signal2) => {
      if (terminationError) {
        if (process.platform === "win32")
          finish(terminationError);
        else
          waitForProcessGroupExit();
        return;
      }
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8")
      };
      if (code === 0) {
        finish(void 0, result);
        return;
      }
      finish(new Error(`record_proof.sh exited with ${code ?? signal2 ?? "unknown"}: ${result.stderr.trim()}`));
    });
    timer = setTimeout(() => {
      terminate(new Error(`record_proof.sh timed out after ${options.timeout}ms`));
    }, options.timeout);
  });
}
async function runRecordProofScript(script, args, timeout = 6e4, dependencies = {}) {
  const execute = dependencies.execute ?? executeRecorderScript;
  if ((dependencies.platform ?? process.platform) !== "darwin") {
    return execute(script, args, { timeout, env: { ...process.env } });
  }
  const withHelper = dependencies.withHelper ?? withVerifiedDarwinProcessBirthHelper;
  return withHelper((helper) => execute(script, args, {
    timeout,
    env: {
      ...process.env,
      RN_DEV_AGENT_PROCESS_BIRTH_HELPER: helper.path,
      RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: helper.requirement
    }
  }));
}
async function waitForExactStopped(probe, deadlineMs, code, message) {
  while (true) {
    const status = probe();
    if (status === "stopped")
      return;
    if (status === "unknown") {
      throw new SessionAuthorityError(code, `${message}; shutdown identity is unknown`);
    }
    if (Date.now() >= deadlineMs) {
      throw new SessionAuthorityError(code, message);
    }
    await new Promise((resolve5) => setTimeout(resolve5, 25));
  }
}
async function stopBoundObserve(binding, listenerProbe = probeManagedMetroListener, processProbe = probeProcessBirth, timeoutMs = 2e3, request = fetch) {
  const deadlineMs = Date.now() + timeoutMs;
  const port = Number(binding.port);
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? "");
  const instanceId = String(binding.instanceId ?? "");
  const capability = String(binding.cleanupCapability ?? "");
  if (!Number.isSafeInteger(port) || !Number.isSafeInteger(pid) || !expectedBirth || !instanceId || !capability) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup authority is incomplete");
  }
  const currentListener = listenerProbe(port);
  if (currentListener.status === "unknown") {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe listener lookup is inconclusive");
  }
  if (currentListener.status === "absent" || currentListener.pid !== pid)
    return;
  const currentBirth = processProbe(pid);
  if (currentBirth.status === "unknown") {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe process identity is unavailable");
  }
  if (currentBirth.status === "absent") {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe listener identity is internally inconsistent");
  }
  if (currentBirth.birth.token !== expectedBirth) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe listener PID was reused before cleanup completed");
  }
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup timed out before the stop request");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  let response;
  try {
    response = await request(`http://127.0.0.1:${port}/api/stop`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${capability}`,
        "x-rn-observe-instance": instanceId
      },
      signal: controller.signal
    });
  } catch {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup request failed or timed out");
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe server refused fenced cleanup");
  }
  await waitForExactStopped(() => {
    const observed = listenerProbe(port);
    if (observed.status === "unknown")
      return "unknown";
    return observed.status === "listening" && observed.pid === pid ? "running" : "stopped";
  }, deadlineMs, "OBSERVE_AUTHORITY_MISMATCH", "Observe listener did not stop before the cleanup deadline");
}
async function stopBoundRunner(binding, processProbe = probeProcessBirth, signalProcess = process.kill, timeoutMs = 2e3, runAdb = async (args) => execFile15("adb", args, { timeout: 5e3, encoding: "utf8" })) {
  const deadlineMs = Date.now() + timeoutMs;
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? "");
  const instanceId = String(binding.instanceId ?? "");
  const capability = String(binding.capability ?? "");
  if (!Number.isSafeInteger(pid) || !expectedBirth || !instanceId || !capability) {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "runner cleanup identity is incomplete");
  }
  const platform = String(binding.platform ?? "");
  const deviceId = String(binding.deviceId ?? "");
  const port = Number(binding.port);
  const current = processProbe(pid);
  if (current.status === "unknown") {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "runner process identity is unavailable");
  }
  if (current.status === "present" && current.birth.token === expectedBirth) {
    signalProcess(pid, "SIGTERM");
    await waitForExactStopped(() => {
      const observed = processProbe(pid);
      if (observed.status === "unknown")
        return "unknown";
      return observed.status === "present" && observed.birth.token === expectedBirth ? "running" : "stopped";
    }, deadlineMs, "RUNNER_ADOPTION_REQUIRED", "runner process did not stop before the cleanup deadline");
  }
  if (platform !== "android")
    return;
  if (!deviceId || !Number.isSafeInteger(port)) {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", "Android runner cleanup identity is incomplete");
  }
  const serial = ["-s", deviceId];
  try {
    await runAdb([...serial, "forward", "--remove", `tcp:${port}`]);
    for (const pkg of OWNED_PACKAGES) {
      await runAdb([...serial, "shell", "am", "force-stop", pkg]);
      const process2 = await runAdb([...serial, "shell", "sh", "-c", `pidof ${pkg} || true`]);
      if (process2.stdout.trim()) {
        throw new Error(`${pkg} remains alive after force-stop`);
      }
    }
    const instrumentation = await runAdb([
      ...serial,
      "shell",
      "dumpsys",
      "activity",
      "instrumentation"
    ]);
    const output = `${instrumentation.stdout}
${instrumentation.stderr}`;
    if (OWNED_PACKAGES.some((pkg) => output.includes(pkg))) {
      throw new Error("owned instrumentation remains registered");
    }
  } catch (error) {
    throw new SessionAuthorityError("RUNNER_ADOPTION_REQUIRED", `Android device-side runner termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function stopBoundRecorder(binding, _processProbe = probeProcessBirth, runRecorder = async (script, args) => runRecordProofScript(script, args)) {
  const script = String(binding.script ?? "");
  const scope = String(binding.scope ?? "");
  const pid = Number(binding.pid);
  const expectedBirth = String(binding.processBirth ?? "");
  if (!script || !/^[a-f0-9]{64}$/.test(scope)) {
    throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "recorder cleanup identity is incomplete");
  }
  if (binding.phase === "starting") {
    try {
      const initialStatus = await runRecorder(script, ["status", scope]);
      const active = initialStatus.stdout.match(/^(?:ios|android): pid=(\d+) birth=(\S+) status=\w+ output=.*$/m);
      if (active) {
        await runRecorder(script, ["abort", scope]);
      } else if (/^No active recordings/m.test(initialStatus.stdout)) {
        await runRecorder(script, ["abort", scope]);
      } else {
        throw new Error("provisional recorder status is not parseable");
      }
      const finalStatus = await runRecorder(script, ["status", scope]);
      if (!/^No active recordings/m.test(finalStatus.stdout)) {
        throw new Error("provisional recorder state remains active after cleanup");
      }
      return "";
    } catch (error) {
      throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", `provisional recorder termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!Number.isSafeInteger(pid) || !expectedBirth) {
    throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "recorder cleanup identity is incomplete");
  }
  try {
    const stopped = await runRecorder(script, ["stop", scope, String(pid), expectedBirth]);
    const status = await runRecorder(script, ["status", scope]);
    if (!/^No active recordings/m.test(status.stdout)) {
      throw new Error("recorder state remains active after cleanup");
    }
    return stopped.stdout;
  } catch (error) {
    throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", `recorder termination is unproven: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// packages/rn-dev-agent-core/dist/rn-session.js
function resolveStatus() {
  const layout = createAuthorityStateLayout(process.env.RN_DEV_AGENT_STATE_DIR);
  const registry = openSessionRegistry(layout.registry, { ownerStatus: inspectSessionOwner });
  const explicit = process.env.RN_DEV_AGENT_SESSION_ID;
  const source = resolveSourceIdentity(process.cwd(), {
    declaredRoot: process.env.RN_DEV_AGENT_DECLARED_ROOT,
    declaredManifests: process.env.RN_DEV_AGENT_DECLARED_MANIFESTS?.split(",").filter(Boolean)
  });
  const candidates = explicit ? [registry.getSessionStatus(explicit)].filter((status2) => status2 !== null) : registry.findSessionsByWorktree(source.worktreeKey).filter((status2) => status2.appRootKey === source.appRootKey);
  if (candidates.length !== 1) {
    registry.close();
    throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", candidates.length === 0 ? "no live session matches this canonical worktree and app root" : "multiple live sessions match this worktree and app root; set RN_DEV_AGENT_SESSION_ID");
  }
  const status = candidates[0];
  if (explicit && (status.worktreeKey !== source.worktreeKey || status.appRootKey !== source.appRootKey)) {
    registry.close();
    throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "explicit session belongs to a different canonical worktree or app root");
  }
  return Object.assign(status, {
    closeRegistry: () => registry.close(),
    registry,
    layout
  });
}
function readSigner(status) {
  const secret = JSON.parse(readFileSync10(join16(status.layout.sessions, status.sessionId, "secret.json"), "utf8"));
  if (typeof secret.signerCapability !== "string") {
    throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "session build signer is unavailable");
  }
  return secret.signerCapability;
}
function reconcileManagedMetroStatus(status) {
  const metro = status.bindings.metro;
  if (metro?.mode !== "managed")
    return status;
  const inspection = inspectManagedMetroLifecycle(metro, {
    sessionId: status.sessionId,
    signerCapability: readSigner(status)
  });
  if (inspection.status === "live")
    return status;
  const priorTargetId = status.bindings.bundle?.targetId;
  const metroPort = Number(status.bindings.metroPort);
  const session = { sessionId: status.sessionId, claimEpoch: status.claimEpoch };
  status.registry.updateBindings(session, {
    expectedAuthorityVersion: status.authorityVersion,
    state: status.bindings.install ? "device_bound" : status.bindings.device ? "device_claimed" : "source_bound",
    bindings: {
      metro: null,
      metroCleanup: metro,
      metroTerminal: {
        code: inspection.code,
        reason: inspection.reason,
        phase: status.bindings.bundle ? "after-bind" : "before-bind",
        observedAt: Date.now(),
        instanceId: metro.instanceId
      },
      bundle: null
    },
    releaseResources: typeof priorTargetId === "string" && Number.isSafeInteger(metroPort) ? [{ type: "target", key: `${metroPort}:${priorTargetId}` }] : []
  });
  const current = status.registry.getSessionStatus(status.sessionId);
  if (!current) {
    throw new SessionAuthorityError("SESSION_OWNER_LOST", "session disappeared during managed Metro reconciliation");
  }
  return Object.assign(current, {
    closeRegistry: status.closeRegistry,
    registry: status.registry,
    layout: status.layout
  });
}
function beginCliOperation(status, tool, profile) {
  const operation = status.registry.beginOperation({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, { operationId: randomUUID3(), tool, profile });
  if (operation.authorityVersion !== status.authorityVersion) {
    status.registry.cancelOperation(operation);
    throw new SessionAuthorityError("AUTHORITY_LOST_DURING_OPERATION", "session authority changed before CLI operation reservation");
  }
  return operation;
}
function writeMarker(status, input) {
  const appRoot = String(status.source.appRoot);
  const marker = buildSignedMetroMarker({
    sessionId: status.sessionId,
    metroInstanceId: input.metroInstanceId,
    worktreeKey: status.worktreeKey,
    appId: input.appId,
    platform: input.platform,
    buildGeneration: input.buildGeneration
  }, input.signerCapability);
  const agent = openBoundDirectory(join16(appRoot, ".rn-agent"));
  let integration;
  let primaryError;
  try {
    integration = openBoundSubdirectory(agent, "integration");
    writeBoundDirectoryFile(integration, "authority-marker.js", Buffer.from(createMetroAuthorityModule(marker)), 384);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    closeBoundDirectories([integration, agent], primaryError);
  }
}
async function ensureManagedMetro(status) {
  const device = status.bindings.device;
  if (device?.platform !== "ios" && device?.platform !== "android" || typeof device.appId !== "string") {
    throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "an exact device/app binding is required before managed Metro starts");
  }
  const platform = device.platform;
  const appId = device.appId;
  if (!inspectAuthorityMigration(status).packageIntegration.installed) {
    throw new SessionAuthorityError("BUNDLE_HANDSHAKE_UNAVAILABLE", "session package and Metro integration must be applied before managed Metro starts");
  }
  const signerCapability = readSigner(status);
  const existing = status.bindings.metro;
  const retainedCleanup = status.bindings.metroCleanup;
  const operation = beginCliOperation(status, "rn-session ensure-metro", "transition:ensure-metro");
  let currentOperation = operation;
  let startedBinding = null;
  let cleanupBindingCommitted = false;
  let bindingCommitted = false;
  try {
    await status.registry.runWithOperation(operation, async () => {
      if (retainedCleanup) {
        if (!verifyManagedMetroManagementProof(retainedCleanup, {
          sessionId: status.sessionId,
          signerCapability
        })) {
          throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "retained Metro cleanup is not authenticated managed authority; run rn_session stop_metro with confirmed=true for safe release or exact owner recovery");
        }
        if (!await stopManagedMetro(retainedCleanup, {
          sessionId: status.sessionId,
          signerCapability
        })) {
          throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "retained managed Metro cleanup is unresolved; run rn_session stop_metro");
        }
        status.registry.verifyOperation(currentOperation);
        currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
          bindings: { metroCleanup: null, bundle: null }
        });
      }
      if (existing && !verifyManagedMetroManagementProof(existing, {
        sessionId: status.sessionId,
        signerCapability
      })) {
        throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "existing Metro binding is not authenticated managed authority");
      }
      if (typeof existing?.pid === "number" && typeof existing.port === "number" && typeof existing.instanceId === "string" && typeof existing.buildGeneration === "number") {
        let isCurrent = false;
        try {
          await captureMetroBinding({
            port: existing.port,
            pid: existing.pid,
            instanceId: existing.instanceId,
            sourceRoot: String(status.source.contentRoot),
            buildGeneration: existing.buildGeneration
          });
          isCurrent = true;
        } catch {
        }
        if (isCurrent) {
          status.registry.verifyOperation(currentOperation);
          return;
        }
        if (!await stopManagedMetro(existing, {
          sessionId: status.sessionId,
          signerCapability
        })) {
          throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "existing external Metro binding is stale and cannot be replaced automatically");
        }
        status.registry.verifyOperation(currentOperation);
        currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
          bindings: { metro: null, bundle: null }
        });
      }
      const instanceId = randomUUID3();
      const buildGeneration = Math.max(Number(existing?.buildGeneration ?? 0), Number(retainedCleanup?.buildGeneration ?? 0), Number(status.bindings.install?.buildGeneration ?? 0)) + 1;
      writeMarker(status, {
        platform,
        appId,
        metroInstanceId: instanceId,
        buildGeneration,
        signerCapability
      });
      status.registry.verifyOperation(currentOperation);
      startedBinding = await startManagedMetro({
        appRoot: String(status.source.appRoot),
        runtimeRoot: sessionRuntimeDirectory(status.layout, status.sessionId),
        sourceRoot: String(status.source.contentRoot),
        sessionId: status.sessionId,
        port: Number(status.bindings.metroPort),
        instanceId,
        buildGeneration,
        signerCapability
      });
      currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
        bindings: { metroCleanup: startedBinding }
      });
      cleanupBindingCommitted = true;
      currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
        state: "device_claimed",
        bindings: {
          metro: startedBinding,
          metroCleanup: null,
          metroTerminal: null,
          bundle: null
        }
      });
      cleanupBindingCommitted = false;
      bindingCommitted = true;
    });
    status.registry.endOperation(currentOperation);
  } catch (error) {
    let failure = error;
    let cleanupProven = startedBinding === null || bindingCommitted;
    if (startedBinding && !bindingCommitted) {
      try {
        cleanupProven = await stopManagedMetro(startedBinding, {
          sessionId: status.sessionId,
          signerCapability
        });
        if (!cleanupProven) {
          failure = new AggregateError([
            failure,
            new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "uncommitted managed Metro replacement cleanup could not be proven")
          ]);
        }
      } catch (cleanupError) {
        cleanupProven = false;
        failure = new AggregateError([failure, cleanupError]);
      }
    }
    if (cleanupProven && cleanupBindingCommitted) {
      try {
        currentOperation = status.registry.replaceBindingsDuringOperation(currentOperation, {
          bindings: { metroCleanup: null }
        });
        cleanupBindingCommitted = false;
      } catch (cleanupPersistenceError) {
        cleanupProven = false;
        failure = new AggregateError([failure, cleanupPersistenceError]);
      }
    }
    if (cleanupProven)
      status.registry.cancelOperation(currentOperation);
    throw failure;
  }
}
async function main() {
  const command = process.argv[2] ?? "status";
  let status = resolveStatus();
  try {
    if (command === "status" || command === "feedback-json" || command === "prepare-build") {
      status = reconcileManagedMetroStatus(status);
    }
    if (command === "status") {
      process.stdout.write(`${JSON.stringify(projectPublicAuthorityStatus({ available: true, ...status }), null, 2)}
`);
      return;
    }
    if (command === "feedback-json") {
      process.stdout.write(`${JSON.stringify({
        sessionAvailable: true,
        authorityState: status.state,
        ownMetroAllocated: Number.isSafeInteger(Number(status.bindings.metroPort)),
        ownMetroBound: Boolean(status.bindings.metro),
        foreignSessionCount: status.registry.countOtherOperationalSessions(status.sessionId)
      })}
`);
      return;
    }
    if (command === "build-json") {
      const device = status.bindings.device;
      const metroPort = Number(status.bindings.metroPort);
      if (device?.platform !== "ios" && device?.platform !== "android" || typeof device.deviceId !== "string" || typeof device.appId !== "string" || !Number.isSafeInteger(metroPort)) {
        throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "device and allocated Metro port must be bound before a session build");
      }
      process.stdout.write(`${JSON.stringify({
        platform: device.platform,
        deviceId: device.deviceId,
        appId: device.appId,
        metroPort,
        sessionId: status.sessionId
      })}
`);
      return;
    }
    if (command === "ensure-metro") {
      await ensureManagedMetro(status);
      const current = status.registry.getSessionStatus(status.sessionId);
      process.stdout.write(`${JSON.stringify({
        metroBound: true,
        metroPort: current?.bindings.metroPort
      })}
`);
      return;
    }
    if (command === "prepare-build") {
      const platform = process.argv[3];
      const device = status.bindings.device;
      const metro = status.bindings.metro;
      if (platform !== "ios" && platform !== "android" || device?.platform !== platform || typeof device.deviceId !== "string" || typeof device.appId !== "string" || typeof metro?.instanceId !== "string") {
        throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "an exact device/app and live Metro binding are required before build");
      }
      const appId = device.appId;
      const metroInstanceId = metro.instanceId;
      const signerCapability = readSigner(status);
      const metroInspection = inspectManagedMetroLifecycle(metro, {
        sessionId: status.sessionId,
        signerCapability
      });
      if (metro.mode !== "managed" || metroInspection.status !== "live") {
        const recovery = metro.mode === "external" ? "stop external Metro through its owning process, then run rn_session stop_metro with confirmed=true" : "run rn_session stop_metro with confirmed=true for safe release or exact owner recovery";
        throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", metroInspection.status === "lost" ? `${metroInspection.reason}; ${recovery} before retrying` : "build requires authenticated managed Metro authority");
      }
      const buildGeneration = Math.max(Number(metro.buildGeneration ?? 0), Number(status.bindings.install?.buildGeneration ?? 0)) + 1;
      const buildToken = randomUUID3();
      const buildMetro = refreshManagedMetroBuildGeneration(metro, {
        sessionId: status.sessionId,
        buildGeneration,
        signerCapability
      });
      const runner = status.bindings.runner;
      const recorder = status.bindings.recorder;
      const releaseResources = [];
      if (recorder) {
        const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
        if (!status.claims.some((claim) => claim.type === "recorder" && claim.key === claimKey && claim.sessionId === status.sessionId && claim.claimEpoch === status.claimEpoch)) {
          throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "recorder cleanup claim no longer matches the authenticated binding");
        }
        releaseResources.push({ type: "recorder", key: claimKey });
      }
      if (runner) {
        const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`;
        if (!status.claims.some((claim) => claim.type === "runner" && claim.key === claimKey && claim.sessionId === status.sessionId && claim.claimEpoch === status.claimEpoch)) {
          throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "runner cleanup claim no longer matches the authenticated binding");
        }
        releaseResources.push({ type: "runner", key: claimKey });
      }
      const operation = beginCliOperation(status, "rn-session prepare-build", "transition:prepare-build");
      let currentOperation = operation;
      try {
        await status.registry.runWithOperation(operation, async () => {
          if (recorder) {
            await stopBoundRecorder(recorder);
            status.registry.verifyOperation(operation);
          }
          if (runner) {
            await stopBoundRunner(runner);
            status.registry.verifyOperation(operation);
          }
          writeMarker(status, {
            platform,
            appId,
            metroInstanceId,
            buildGeneration,
            signerCapability
          });
          status.registry.verifyOperation(operation);
          currentOperation = status.registry.replaceBindingsDuringOperation(operation, {
            releaseResources,
            bindings: {
              metro: buildMetro,
              pendingBuild: { buildToken, platform, buildGeneration },
              bundle: null,
              runner: null,
              recorder: null
            }
          });
        });
        status.registry.endOperation(currentOperation);
      } catch (error) {
        status.registry.cancelOperation(currentOperation);
        throw error;
      }
      process.stdout.write(`${JSON.stringify({
        platform,
        deviceId: device.deviceId,
        appId: device.appId,
        metroPort: Number(status.bindings.metroPort),
        sessionId: status.sessionId,
        buildToken,
        ...platform === "ios" ? { simulator: true } : {},
        ...typeof device.devClientUrl === "string" ? { devClientUrl: device.devClientUrl } : {}
      })}
`);
      return;
    }
    if (command === "complete-build") {
      const platform = process.argv[3];
      const buildToken = process.argv[4];
      const device = status.bindings.device;
      if (platform !== "ios" && platform !== "android" || device?.platform !== platform || typeof device.deviceId !== "string" || typeof device.appId !== "string" || typeof buildToken !== "string") {
        throw new SessionAuthorityError("SESSION_BUILD_IDENTITY_CONFLICT", "completed build does not match the exact claimed device and app");
      }
      const pending = status.bindings.pendingBuild;
      if (pending?.buildToken !== buildToken || pending.platform !== platform || !Number.isSafeInteger(pending.buildGeneration)) {
        throw new SessionAuthorityError("SESSION_BUILD_IDENTITY_CONFLICT", "build completion capability is stale or foreign");
      }
      const signerCapability = readSigner(status);
      const installed = captureInstalledArtifact({
        platform,
        deviceId: device.deviceId,
        appId: device.appId
      });
      const receipt = createBuildReceipt({
        sessionId: status.sessionId,
        sourceKey: status.sourceKey,
        worktreeKey: status.worktreeKey,
        appRootKey: status.appRootKey,
        platform,
        deviceId: device.deviceId,
        appId: device.appId,
        metroPort: Number(status.bindings.metroPort),
        artifactDigest: installed.artifactDigest,
        installGeneration: installed.installGeneration,
        buildGeneration: Number(pending.buildGeneration),
        ...typeof device.devClientUrl === "string" ? { devClientUrl: device.devClientUrl } : {}
      }, signerCapability);
      status.registry.claimResources({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, [{ type: "device", key: `${platform}:${device.deviceId}` }]);
      status.registry.updateBindings({ sessionId: status.sessionId, claimEpoch: status.claimEpoch }, {
        expectedAuthorityVersion: status.authorityVersion + 1,
        state: "device_bound",
        bindings: { install: receipt.payload, pendingBuild: null }
      });
      process.stdout.write(`${JSON.stringify(receipt)}
`);
      return;
    }
    if (command === "release") {
      const epoch = Number(process.env.RN_DEV_AGENT_CLAIM_EPOCH);
      if (process.env.RN_DEV_AGENT_SESSION_ID !== status.sessionId || epoch !== status.claimEpoch) {
        throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "release requires the exact session ID and claim epoch in the environment");
      }
      const signerCapability = readSigner(status);
      const recorder = status.bindings.recorder;
      if (recorder) {
        const claimKey = `${String(recorder.platform)}:${String(recorder.deviceId)}`;
        if (!status.claims.some((claim) => claim.type === "recorder" && claim.key === claimKey && claim.sessionId === status.sessionId && claim.claimEpoch === status.claimEpoch)) {
          throw new SessionAuthorityError("RECORDING_AUTHORITY_MISMATCH", "recorder cleanup claim no longer matches the authenticated binding");
        }
      }
      const runner = status.bindings.runner;
      if (runner) {
        const claimKey = `${String(runner.platform)}:${String(runner.deviceId)}:${String(runner.port)}`;
        if (!status.claims.some((claim) => claim.type === "runner" && claim.key === claimKey && claim.sessionId === status.sessionId && claim.claimEpoch === status.claimEpoch)) {
          throw new SessionAuthorityError("RUNNER_OWNERSHIP_MISMATCH", "runner cleanup claim no longer matches the authenticated binding");
        }
      }
      const observe2 = status.bindings.observe;
      if (observe2) {
        const port = String(observe2.port);
        if (status.bindings.observePort !== observe2.port || !status.claims.some((claim) => claim.type === "observe-port" && claim.key === port && claim.sessionId === status.sessionId && claim.claimEpoch === status.claimEpoch)) {
          throw new SessionAuthorityError("OBSERVE_AUTHORITY_MISMATCH", "Observe cleanup claim no longer matches the authenticated binding");
        }
      }
      const metro = status.bindings.metro;
      if (status.bindings.packageIntegration) {
        throw new SessionAuthorityError("SESSION_AUTHORITY_REQUIRED", "package integration must be restored before session release");
      }
      const operation = beginCliOperation(status, "rn-session release", "transition:release");
      let released = false;
      try {
        await status.registry.runWithOperation(operation, async () => {
          if (recorder) {
            await stopBoundRecorder(recorder);
            status.registry.verifyOperation(operation);
          }
          if (runner) {
            await stopBoundRunner(runner);
            status.registry.verifyOperation(operation);
          }
          if (observe2) {
            await stopBoundObserve(observe2);
            status.registry.verifyOperation(operation);
          }
          if (metro?.mode === "managed" && !await stopManagedMetro(metro, {
            sessionId: status.sessionId,
            signerCapability
          })) {
            throw new SessionAuthorityError("METRO_AUTHORITY_MISMATCH", "managed Metro could not be stopped with exact process authority");
          }
          status.registry.verifyOperation(operation);
          status.registry.releaseSession({ sessionId: status.sessionId, claimEpoch: epoch });
          released = true;
        });
      } finally {
        if (!released)
          status.registry.cancelOperation(operation);
      }
      process.stdout.write(`${JSON.stringify({ released: true })}
`);
      return;
    }
    throw new SessionAuthorityError("SESSION_BUILD_COMMAND_UNSUPPORTED", `unknown rn-session command: ${command}`);
  } finally {
    status.closeRegistry();
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
  process.exitCode = 2;
});
