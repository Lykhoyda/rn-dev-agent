// Single source of truth for the injected-helpers protocol version. Bump this
// whenever the injected surface changes; it flows into the IIFE's freshness
// check (__RN_AGENT.__v) AND the post-injection log line, so they can never
// drift (the log previously hard-coded a stale "v11").
export const HELPERS_VERSION = 36;
export const INJECTED_HELPERS = `
(function() {
  var __HELPERS_VERSION__ = ${HELPERS_VERSION};
  if (globalThis.__RN_AGENT && globalThis.__RN_AGENT.__v === __HELPERS_VERSION__) return;
  if (globalThis.__RN_AGENT) delete globalThis.__RN_AGENT;

  // Issue #126 — legacy renderer iteration cap. Hooks without an enumerable
  // renderers registry still fall back to numeric probing with this bound and
  // early-exit heuristic. Root-union scans prefer the hook's registered IDs so
  // sparse or higher IDs are not missed (GH #597).
  var MAX_RENDERER_IDS = 20;
  var EARLY_EXIT_EMPTY_STREAK = 3;

  // Reset by every root-iteration pass; only valid when read synchronously
  // after the pass that produced the tree (many helpers share the iterators).
  var lastRootScan = { rendererErrors: 0, probedUpTo: 0 };

  function computeUnscannedRendererIds() {
    try {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (!hook || !hook.renderers || typeof hook.renderers.forEach !== 'function') return [];
      var out = [];
      hook.renderers.forEach(function(_v, id) {
        if (typeof id === 'number' && id > lastRootScan.probedUpTo) out.push(id);
      });
      return out;
    } catch (_) { return []; }
  }

  // Read the renderer IDs React DevTools actually registered. Returning an
  // empty list intentionally selects the legacy numeric-probe fallback: some
  // hook shims expose getFiberRoots() but omit or incompletely implement the
  // renderers Map. A malformed iterator is isolated from root discovery.
  function getRegisteredRendererIds(hook) {
    try {
      if (!hook || !hook.renderers || typeof hook.renderers.keys !== 'function') return [];
      var iterator = hook.renderers.keys();
      if (!iterator || typeof iterator.next !== 'function') return [];
      var ids = [];
      var step;
      while (!(step = iterator.next()).done) {
        var id = step.value;
        if (typeof id === 'number' && ids.indexOf(id) === -1) ids.push(id);
      }
      return ids;
    } catch (_) {
      return [];
    }
  }

  function findActiveRenderer() {
    lastRootScan = { rendererErrors: 0, probedUpTo: 0 };
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || typeof hook.getFiberRoots !== 'function') return null;
    var emptyStreak = 0;
    for (var i = 1; i <= MAX_RENDERER_IDS; i++) {
      lastRootScan.probedUpTo = i;
      try {
        var roots = hook.getFiberRoots(i);
        if (roots && roots.size > 0) {
          return { rendererId: i, roots: roots };
        }
        emptyStreak++;
        if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && i >= 5) return null;
      } catch (_) {
        emptyStreak++;
        lastRootScan.rendererErrors++;
      }
    }
    return null;
  }

  // GH #126 Gap B — private primitive consolidating renderer-roots
  // iteration. Both forEachRootFiber and findAllRootFibers delegate
  // here. A truthy return from cb short-circuits iteration (matches
  // existing forEachRootFiber semantics — 0/false/'' continue).
  // Returns whatever cb returned, or null if cb never short-circuited.
  //
  // Per-renderer try/catch protects against one renderer's getFiberRoots
  // throwing during teardown/HMR/worklet init (Gemini A3, 2026-04-23,
  // conf 80) — a single bad renderer must not poison the union. The
  // extra-roots step (globalThis.__RN_AGENT_EXTRA_ROOTS__) runs AFTER the
  // native renderer loop so user-registered portals stay lower priority
  // than React's own registry.
  function iterateAllRoots(cb) {
    lastRootScan = { rendererErrors: 0, probedUpTo: 0 };
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && typeof hook.getFiberRoots === 'function') {
      var rendererIds = getRegisteredRendererIds(hook);
      var usingRegisteredIds = rendererIds.length > 0;
      if (!usingRegisteredIds) {
        for (var fallbackId = 1; fallbackId <= MAX_RENDERER_IDS; fallbackId++) {
          rendererIds.push(fallbackId);
        }
      }
      var emptyStreak = 0;
      for (var rii = 0; rii < rendererIds.length; rii++) {
        var ri = rendererIds[rii];
        if (ri > lastRootScan.probedUpTo) lastRootScan.probedUpTo = ri;
        try {
          var roots = hook.getFiberRoots(ri);
          if (roots && roots.size) {
            emptyStreak = 0;
            var it = roots.values();
            var v;
            while (!(v = it.next()).done) {
              if (v.value && v.value.current) {
                var result = cb(v.value.current, ri);
                if (result) return result;
              }
            }
          } else if (!usingRegisteredIds) {
            emptyStreak++;
            if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) break;
          }
        } catch (_) {
          if (!usingRegisteredIds) emptyStreak++;
          lastRootScan.rendererErrors++;
        }
      }
    }
    // GH #126 Gap B — extra-roots step. Runs AFTER the native renderer
    // loop (above) so user-registered portals are lower priority than
    // React's own registry. Independent try/catch from the per-renderer
    // try/catch above — one bad resolver should not poison results we
    // already collected from React's renderers. Negative rendererId
    // (-1) marks extra-roots so consumers can distinguish them by
    // metadata if needed; the cb still gets the same (rootFiber,
    // rendererId) signature.
    try {
      var extraResolver = globalThis.__RN_AGENT_EXTRA_ROOTS__;
      if (typeof extraResolver === 'function') {
        var instances = extraResolver();
        if (Array.isArray(instances)) {
          for (var i = 0; i < instances.length; i++) {
            var extraFiber = extractFiberFromInstance(instances[i]);
            if (extraFiber) {
              var extraResult = cb(extraFiber, -1);
              if (extraResult) return extraResult;
            }
          }
        }
      }
    } catch (_) {
      // swallow — resolver bug must not break iteration
      lastRootScan.rendererErrors++;
    }
    return null;
  }

  // Public generator-style iterator. Calls cb for each renderer-root
  // and extra-root; returns first truthy result, else null. See
  // iterateAllRoots() for the consolidated iteration logic.
  function forEachRootFiber(cb) {
    return iterateAllRoots(cb);
  }

  // B143: public collector returning Array<{rendererId, fiber}> across
  // EVERY registered React renderer. findActiveRenderer returns only the
  // first non-empty renderer — typically LogBox (a tiny shell). The main
  // app tree often lives on a later rendererID (common with Bridgeless +
  // Reanimated, which register their own secondary renderer). Query tools
  // that must reach all user components use this helper, not
  // findActiveRenderer. Delegates the iteration to iterateAllRoots; the
  // collector cb explicitly returns null to never short-circuit.
  function findAllRootFibers() {
    var out = [];
    iterateAllRoots(function(rootFiber, rendererId) {
      out.push({ rendererId: rendererId, fiber: rootFiber });
      return null; // explicit — keep collecting, never short-circuit
    });
    return out;
  }

  // GH #126 Gap B — convert a user-provided React component instance into
  // a fiber for iterateAllRoots() to walk. Three accepted shapes, tried
  // in order: (1) instance._reactInternals (modern React 16.8+ class
  // components and useImperativeHandle-exposed values), (2) instance.
  // _reactInternalFiber (legacy React), (3) already-a-fiber escape hatch
  // for advanced users — duck-typed by REQUIRING both 'return' and 'child'
  // as own/inherited keys (the dual requirement rejects generator-like
  // objects that only have .return). Returns null on any other input —
  // the caller treats null as "skip this entry," which is the silent
  // partial-failure isolation per spec §6.
  function extractFiberFromInstance(inst) {
    if (!inst || typeof inst !== 'object') return null;
    if (inst._reactInternals) return inst._reactInternals;
    if (inst._reactInternalFiber) return inst._reactInternalFiber;
    if ('return' in inst && 'child' in inst) return inst;
    return null;
  }

  // Sanitize an object by enumerating properties safely — getters that throw
  // (e.g. useNavigation context access outside NavigationContainer) would
  // normally crash JSON.stringify before the replacer runs.
  function sanitizeForSerialization(obj, seen, depth) {
    seen = seen || new WeakSet();
    depth = depth || 0;
    if (depth > 20) return '[MaxDepth]';
    if (obj === null || obj === undefined) return obj;
    var t = typeof obj;
    if (t === 'string' || t === 'number' || t === 'boolean') return obj;
    if (t === 'function') return '[Function]';
    if (t === 'symbol') return obj.toString();
    if (t !== 'object') return '[Unserializable:' + t + ']';
    if (seen.has(obj)) return '[Circular]';
    seen.add(obj);
    if (obj instanceof Error) return { message: obj.message, stack: obj.stack };
    if (Array.isArray(obj)) {
      var arr = [];
      for (var i = 0; i < obj.length && i < 200; i++) {
        try { arr.push(sanitizeForSerialization(obj[i], seen, depth + 1)); }
        catch(e) { arr.push('[GetterError:' + (e && e.message || 'unknown') + ']'); }
      }
      return arr;
    }
    var out = {};
    var keys;
    try { keys = Object.keys(obj); }
    catch(e) { return '[UnenumerableKeys]'; }
    for (var k = 0; k < keys.length && k < 100; k++) {
      var key = keys[k];
      try {
        var val = obj[key]; // Getter can throw here
        out[key] = sanitizeForSerialization(val, seen, depth + 1);
      } catch(e) {
        out[key] = '[GetterError:' + (e && e.message && e.message.slice(0, 60) || 'unknown') + ']';
      }
    }
    return out;
  }

  function safeStringify(obj, maxLen) {
    try {
      var limit = maxLen || 50000;
      // Pre-sanitize to handle throwing getters (B90 Tier 4 fix)
      var sanitized = sanitizeForSerialization(obj);
      var str = JSON.stringify(sanitized);
      if (str && str.length > limit) {
        return JSON.stringify({
          __agent_truncated: true,
          originalLength: str.length,
          hint: 'Use a filter or narrower path to reduce output size.'
        });
      }
      return str;
    } catch(e) {
      return JSON.stringify({ __agent_error: 'Serialization failed: ' + (e && e.message || String(e)) });
    }
  }

  // Fiber Tree Walker
  function getTree(opts) {
    opts = opts || {};
    var maxDepth = opts.maxDepth || 4;
    var filter = opts.filter || opts.testID || opts.type || null;

    // Story 16 (#409): quality verdict computed once at capture, from the same
    // pass that produced the tree — downstream tools render it, never re-derive.
    var walkQuality = { droppedSubtrees: 0, collapsedChildLists: 0 };
    function buildVerdict(path, o) {
      o = o || {};
      var reasons = [];
      if (o.noRenderer) reasons.push('no-renderer');
      if (lastRootScan.rendererErrors > 0) reasons.push('renderer-error');
      var unscanned = computeUnscannedRendererIds();
      if (unscanned.length > 0) reasons.push('renderers-unscanned');
      if (o.scanBudgetExhausted) reasons.push('scan-budget-exhausted');
      if (o.outputTruncated) reasons.push('output-truncated');
      var state = (o.noRenderer || o.failed) ? 'failed' : (reasons.length > 0 ? 'degraded' : 'ok');
      return {
        state: state,
        path: path,
        reasons: reasons,
        rootsSeeded: o.rootsSeeded || 0,
        scannedNodes: o.scannedNodes || 0,
        effectiveDepth: maxDepth,
        droppedSubtrees: walkQuality.droppedSubtrees,
        collapsedChildLists: walkQuality.collapsedChildLists,
        rendererErrors: lastRootScan.rendererErrors,
        unscannedRendererIds: unscanned
      };
    }

    var renderer = findActiveRenderer();
    if (!renderer) {
      return JSON.stringify({
        error: 'React DevTools hook not available or no fiber roots — app may still be loading',
        verdict: buildVerdict('none', { noRenderer: true })
      });
    }

    var visited = new WeakSet();
    var totalNodes = 0;

    function hasErrorOverlay(fiber, depth) {
      var current = fiber;
      while (current) {
        if ((depth || 0) > 15) return false;
        var name = current.type && (current.type.displayName || current.type.name);
        if (name === 'LogBox' || name === 'ErrorWindow' || name === 'RedBox') return true;
        if (current.child && hasErrorOverlay(current.child, (depth || 0) + 1)) return true;
        current = current.sibling;
      }
      return false;
    }

    // B143 A1 (Gemini, conf 85): check for RedBox/LogBox across ALL renderers,
    // not just the first. A user-code Error Boundary on the main renderer
    // would otherwise be silently missed while the filter path happily walks
    // past it. Performance is negligible — each root's hasErrorOverlay walk
    // is already depth-capped at 15.
    var overlayRoots = findAllRootFibers();
    var overlayFound = false;
    for (var oi = 0; oi < overlayRoots.length && !overlayFound; oi++) {
      if (hasErrorOverlay(overlayRoots[oi].fiber)) overlayFound = true;
    }
    if (overlayFound) {
      return JSON.stringify({
        warning: 'APP_HAS_REDBOX',
        message: 'App is showing an error screen. Use cdp_error_log to read the error, fix the code, then cdp_reload.'
      });
    }

    function getName(fiber) {
      if (!fiber || !fiber.type) return null;
      return fiber.type.displayName || fiber.type.name || null;
    }

    function walkSubtree(fiber, depth, limit, vis) {
      if (!fiber) return null;
      if (depth > limit) {
        // Depth-cap drop: expected under the requested cap, but must be
        // counted — a sparse-because-shallow tree previously looked identical
        // to a legitimately small one.
        walkQuality.droppedSubtrees++;
        return null;
      }
      if (vis.has(fiber)) return null;
      vis.add(fiber);
      totalNodes++;

      if (fiber.tag === 6 && typeof fiber.memoizedProps === 'string') {
        return { text: fiber.memoizedProps };
      }

      var name = getName(fiber);
      var testID = fiber.memoizedProps && (fiber.memoizedProps.testID || fiber.memoizedProps.nativeID);
      var accessibilityLabel = fiber.memoizedProps && fiber.memoizedProps.accessibilityLabel;
      var isUserComponent = name && !name.startsWith('RCT') && /^[A-Z]/.test(name);

      var children = [];
      var child = fiber.child;
      while (child) {
        var node = walkSubtree(child, isUserComponent ? depth + 1 : depth, limit, vis);
        if (node) children.push(node);
        child = child.sibling;
      }

      if (!isUserComponent && !testID) {
        if (children.length === 1) return children[0];
        if (children.length === 0) return null;
        return { _wrapper: true, children: children };
      }

      var result = { component: name };
      if (testID) result.testID = testID;
      if (accessibilityLabel) result.accessibilityLabel = accessibilityLabel;

      if (isUserComponent && fiber.memoizedProps) {
        var props = {};
        var propKeys = Object.keys(fiber.memoizedProps);
        for (var i = 0; i < propKeys.length; i++) {
          var k = propKeys[i];
          if (k === 'children' || k === 'testID' || k === 'style' || k === 'accessibilityLabel' || k === 'nativeID') continue;
          var v = fiber.memoizedProps[k];
          if (typeof v === 'function') { props[k] = '[Function]'; continue; }
          if (Array.isArray(v)) { props[k] = '[Array(' + v.length + ')]'; continue; }
          if (typeof v === 'object' && v !== null) {
            try {
              var objKeys = Object.keys(v);
              props[k] = objKeys.length > 5
                ? '{' + objKeys.slice(0, 5).join(', ') + ', ...(' + (objKeys.length - 5) + ' more)}'
                : '{' + objKeys.join(', ') + '}';
            } catch(e) { props[k] = '[Object]'; }
            continue;
          }
          try {
            var s = JSON.stringify(v);
            props[k] = s && s.length > 200 ? s.substring(0, 200) + '...' : v;
          } catch(e) { props[k] = '[Unserializable]'; }
        }
        if (Object.keys(props).length > 0) result.props = props;
      }

      if (isUserComponent && fiber.memoizedState !== null) {
        try {
          var hookState = fiber.memoizedState;
          var states = [];
          while (hookState) {
            if (hookState.queue && hookState.memoizedState !== undefined) {
              var hs = hookState.memoizedState;
              if (typeof hs === 'function') {
                states.push('[Function]');
              } else if (typeof hs === 'object' && hs !== null) {
                try { JSON.stringify(hs); states.push(hs); }
                catch(e) { states.push('[Circular]'); }
              } else {
                states.push(hs);
              }
            }
            hookState = hookState.next;
          }
          if (states.length > 0) result.hookStates = states.slice(0, 5);
        } catch(e) {}
      }

      if (children.length > 0) {
        if (children.length > 20) walkQuality.collapsedChildLists++;
        result.children = children.length > 20
          ? children.slice(0, 10).concat([{ _truncated: (children.length - 10) + ' more' }])
          : children;
      }

      return result;
    }

    // GH #321 (quick win #3): salient digest — a compact "what can I act on
    // here?" list of ONLY actionable nodes (+ their text), dropping props /
    // hookStates / nesting. Cuts the live-perception payload from ~thousands of
    // tokens (full tree) to hundreds. BFS over every renderer root like the
    // filter branch.
    if (opts.interactiveOnly) {
      var INTERACTIVE_NAMES = { Pressable: 1, TouchableOpacity: 1, TouchableHighlight: 1, TouchableWithoutFeedback: 1, TouchableNativeFeedback: 1, Button: 1, TextInput: 1, Switch: 1, Link: 1 };
      var INTERACTIVE_ROLES = { button: 1, link: 1, switch: 1, checkbox: 1, radio: 1, menuitem: 1, tab: 1, togglebutton: 1, imagebutton: 1, search: 1, adjustable: 1 };
      var HANDLER_PROPS = ['onPress', 'onPressIn', 'onLongPress', 'onChangeText', 'onValueChange', 'onChange', 'onSubmitEditing', 'onClick'];

      var isInteractiveFiber = function(fiber) {
        var props = fiber.memoizedProps;
        if (!props || typeof props !== 'object') return false;
        var nm = getName(fiber);
        if (nm && INTERACTIVE_NAMES[nm]) return true;
        var role = props.accessibilityRole;
        if (role && INTERACTIVE_ROLES[String(role).toLowerCase()]) return true;
        for (var hi = 0; hi < HANDLER_PROPS.length; hi++) {
          if (typeof props[HANDLER_PROPS[hi]] === 'function') return true;
        }
        return false;
      };

      var inferRole = function(nm, props) {
        if (props && props.accessibilityRole) return String(props.accessibilityRole).toLowerCase();
        if (nm === 'TextInput') return 'textinput';
        if (nm === 'Switch') return 'switch';
        if (nm === 'Link') return 'link';
        if (nm === 'Button' || nm === 'Pressable' || (nm && nm.indexOf('Touchable') === 0)) return 'button';
        if (props) {
          if (typeof props.onChangeText === 'function') return 'textinput';
          if (typeof props.onValueChange === 'function') return 'switch';
        }
        return 'button';
      };

      // Gather descendant text (capped), NOT recursing into nested interactive
      // nodes (they each get their own entry).
      var collectText = function(fiber, depth, acc) {
        if (!fiber || depth > 8 || acc.s.length >= 120) return;
        if (fiber.tag === 6 && typeof fiber.memoizedProps === 'string') {
          var t = fiber.memoizedProps.trim();
          if (t) acc.s += (acc.s ? ' ' : '') + t;
          return;
        }
        var c = fiber.child;
        while (c && acc.s.length < 120) {
          if (!isInteractiveFiber(c)) collectText(c, depth + 1, acc);
          c = c.sibling;
        }
      };

      var salient = [];
      var iRoots = findAllRootFibers();
      var iBudget = Math.min(5000, 2000 * Math.max(1, iRoots.length));
      var iQueue = [];
      for (var iri = 0; iri < iRoots.length; iri++) iQueue.push(iRoots[iri].fiber);
      var iSeen = new WeakSet();
      var iScanned = 0;
      var iStart = Date.now();
      while (iQueue.length > 0 && iScanned < iBudget && (Date.now() - iStart) < 3000 && salient.length < 200) {
        var ifiber = iQueue.shift();
        if (!ifiber || iSeen.has(ifiber)) continue;
        iSeen.add(ifiber);
        iScanned++;
        if (isInteractiveFiber(ifiber)) {
          var iprops = ifiber.memoizedProps;
          var entry = { role: inferRole(getName(ifiber), iprops) };
          var itid = iprops.testID || iprops.nativeID;
          if (itid) entry.testID = itid;
          var acc = { s: '' };
          collectText(ifiber, 0, acc);
          if (acc.s) entry.text = acc.s.length > 120 ? acc.s.substring(0, 120) : acc.s;
          else if (iprops.title) entry.text = String(iprops.title); // RN <Button title> has no child text fiber
          if (iprops.accessibilityLabel) entry.label = String(iprops.accessibilityLabel);
          if (iprops.placeholder) entry.placeholder = String(iprops.placeholder);
          // surface on/off state for toggles so the agent need not re-read before deciding
          if (entry.role === 'switch' && typeof iprops.value === 'boolean') entry.value = iprops.value;
          if (iprops.disabled === true || (iprops.accessibilityState && iprops.accessibilityState.disabled === true)) entry.disabled = true;
          salient.push(entry);
        }
        var ich = ifiber.child;
        while (ich) { iQueue.push(ich); ich = ich.sibling; }
      }
      // Signal truncation rather than silently dropping actionable nodes (a hit
      // cap leaves the queue non-empty). Mirrors the filter branch's truncated
      // flag — a clean-looking partial list would mislead the agent into
      // "nothing more to tap here."
      var iOut = { interactive: salient, totalNodes: iScanned, rootsSeeded: iRoots.length };
      if (iQueue.length > 0) {
        iOut.truncated = true;
        iOut.hint = 'More interactive elements exist beyond the cap — scope with filter or device_scrollintoview.';
      }
      iOut.verdict = buildVerdict('interactive', {
        rootsSeeded: iRoots.length,
        scannedNodes: iScanned,
        scanBudgetExhausted: iQueue.length > 0
      });
      return safeStringify(iOut, 999999);
    }

    // For filtered queries: BFS to find matches, then build compact subtrees.
    // B143: seed the BFS queue from EVERY renderer's root — not just the
    // first one findActiveRenderer picked. Apps with multiple React
    // renderers (LogBox + main Fabric, or main + Reanimated worklet) have
    // their user components spread across renderer IDs; walking only the
    // first found renderer misses the bulk of testIDs.
    if (filter) {
      var f = String(filter).toLowerCase();
      var matchFibers = [];
      var matchFiberSet = new WeakSet();
      var allRoots = findAllRootFibers();
      // Codex review (conf 82): scale the scan budget with the number of
      // seeded roots so later renderers aren't starved by earlier (typically
      // LogBox) ones. Hard cap at 5000 to stay under the 3s wall-clock
      // budget on Hermes.
      var scanBudget = Math.min(5000, 2000 * Math.max(1, allRoots.length));
      var queue = [];
      for (var qi = 0; qi < allRoots.length; qi++) queue.push(allRoots[qi].fiber);
      var seen = new WeakSet();
      var scanned = 0;
      var bfsStart = Date.now();
      function hasMatchedAncestor(f2) {
        var cur = f2.return;
        while (cur) {
          if (matchFiberSet.has(cur)) return true;
          cur = cur.return;
        }
        return false;
      }
      while (queue.length > 0 && scanned < scanBudget && (Date.now() - bfsStart) < 3000) {
        var fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        scanned++;
        var fname = getName(fiber);
        var ftid = fiber.memoizedProps && (fiber.memoizedProps.testID || fiber.memoizedProps.nativeID);
        var flabel = fiber.memoizedProps && fiber.memoizedProps.accessibilityLabel;
        var matchesName = fname && fname.toLowerCase().indexOf(f) >= 0;
        var matchesTestID = ftid && String(ftid).toLowerCase().indexOf(f) >= 0;
        var matchesLabel = flabel && String(flabel).toLowerCase().indexOf(f) >= 0;
        if ((matchesName || matchesTestID || matchesLabel) && !hasMatchedAncestor(fiber)) {
          matchFibers.push(fiber);
          matchFiberSet.add(fiber);
        }
        var ch = fiber.child;
        while (ch) {
          queue.push(ch);
          ch = ch.sibling;
        }
      }

      // Codex review (conf 80): field renamed from renderersScanned to
      // rootsSeeded to match actual semantic (roots pushed into the BFS
      // queue, not renderers walked 1..5).
      // A no-match verdict distinguishes "scanned everything, truly absent"
      // from "budget ran out mid-scan" — the sparse-vs-empty ambiguity #409
      // exists to kill.
      var filterBudgetHit = queue.length > 0;
      if (matchFibers.length === 0) {
        return JSON.stringify({
          tree: null,
          totalNodes: scanned,
          rootsSeeded: allRoots.length,
          verdict: buildVerdict('filter', {
            rootsSeeded: allRoots.length,
            scannedNodes: scanned,
            scanBudgetExhausted: filterBudgetHit
          })
        });
      }

      var matches = [];
      for (var mi = 0; mi < matchFibers.length && mi < 10; mi++) {
        var subtreeVis = new WeakSet();
        var subtree = walkSubtree(matchFibers[mi], 0, maxDepth, subtreeVis);
        if (subtree) matches.push(subtree);
      }
      totalNodes = scanned;
      var filterVerdictOpts = {
        rootsSeeded: allRoots.length,
        scannedNodes: scanned,
        scanBudgetExhausted: filterBudgetHit
      };
      var tree = matches.length === 1 ? matches[0] : { matches: matches };
      var output = safeStringify({ tree: tree, totalNodes: totalNodes, rootsSeeded: allRoots.length, verdict: buildVerdict('filter', filterVerdictOpts) }, 999999);
      if (output.length > 50000) {
        filterVerdictOpts.outputTruncated = true;
        return safeStringify({ tree: matches[0] || null, totalNodes: totalNodes, rootsSeeded: allRoots.length, truncated: true, verdict: buildVerdict('filter', filterVerdictOpts) });
      }
      return output;
    }

    // Unfiltered: walk EVERY renderer's root, not just the first renderer's
    // first root. findActiveRenderer() typically returns the LogBox shell on
    // Bridgeless + Reanimated apps, so the prior single-root walk returned the
    // shell instead of the app tree. Mirror the filtered branch's
    // findAllRootFibers() seeding (B143/B145); empty roots (e.g. LogBox) walk to
    // null and drop out, so the usual result is just the app tree.
    var allRootsU = findAllRootFibers();
    var trees = [];
    for (var ri = 0; ri < allRootsU.length; ri++) {
      var sub = walkSubtree(allRootsU[ri].fiber, 0, maxDepth, visited);
      if (sub) trees.push(sub);
    }
    var fullVerdictOpts = { rootsSeeded: allRootsU.length, scannedNodes: totalNodes };
    var tree = trees.length === 1 ? trees[0] : (trees.length === 0 ? null : { _wrapper: true, children: trees });
    var output = safeStringify({ tree: tree, totalNodes: totalNodes, rootsSeeded: allRootsU.length, verdict: buildVerdict('full', fullVerdictOpts) }, 999999);
    if (output.length > 50000) {
      fullVerdictOpts.failed = true;
      fullVerdictOpts.outputTruncated = true;
      return safeStringify({ error: 'Tree too large (' + output.length + ' chars). Use a filter parameter to scope the query.', verdict: buildVerdict('full', fullVerdictOpts) });
    }
    return output;
  }

  // Task 2 — live-fiber host-kind classifier. Ports RNTL host-component-names.ts
  // (isHostText/isHostTextInput/isHostImage/isHostSwitch/isHostScrollView/
  // isHostModal). RNTL keys off a STRING instance.type; live fibers carry the
  // host name as a raw string fiber.type OR as fiber.type.displayName/name for
  // native views, so we resolve a string name from both shapes via getName.
  // Name lists are widened to the native view names (RCTSinglelineTextInputView,
  // RCTImageView, RCTModalHostView, ...) per FIXED INTERFACES because the live
  // tree exposes the platform view name, not the JS component name. Returns null
  // for plain Views, user components, text nodes (tag 6) and null types.
  var HOST_KIND_NAMES = {
    text: ['Text', 'RCTText'],
    textinput: ['TextInput', 'RCTTextInput', 'RCTSinglelineTextInputView', 'RCTMultilineTextInputView', 'AndroidTextInput'],
    image: ['Image', 'RCTImageView', 'RCTImage'],
    switch: ['Switch', 'RCTSwitch'],
    scrollview: ['ScrollView', 'RCTScrollView'],
    modal: ['Modal', 'RCTModalHostView']
  };
  var HOST_KIND_LOOKUP = (function() {
    var map = {};
    var kinds = Object.keys(HOST_KIND_NAMES);
    for (var ki = 0; ki < kinds.length; ki++) {
      var names = HOST_KIND_NAMES[kinds[ki]];
      for (var ni = 0; ni < names.length; ni++) map[names[ni]] = kinds[ki];
    }
    return map;
  })();

  function hostKind(fiber) {
    if (!fiber || !fiber.type) return null;
    if (fiber.tag === 6) return null;
    var name = typeof fiber.type === 'string'
      ? fiber.type
      : (fiber.type.displayName || fiber.type.name || null);
    if (!name) return null;
    var kind = HOST_KIND_LOOKUP[name];
    return kind || null;
  }

  // Navigation State
  function getNavState() {
    try {
      var state = globalThis.__expo_router_state__;
      if (state) return safeStringify(state, 50000);
    } catch(e) {}

    try {
      var devtools = globalThis.__REACT_NAVIGATION_DEVTOOLS__;
      if (devtools && devtools.getNavState) return safeStringify(devtools.getNavState(), 50000);
    } catch(e) {}

    function isNavLike(obj) {
      return obj && Array.isArray(obj.routes) && typeof obj.index === 'number';
    }

    function findNavInHooks(memoizedState) {
      var hook = memoizedState;
      var depth = 0;
      while (hook && depth < 30) {
        if (hook.memoizedState && isNavLike(hook.memoizedState)) return hook.memoizedState;
        if (isNavLike(hook)) return hook;
        if (hook.queue && hook.queue.lastRenderedState && isNavLike(hook.queue.lastRenderedState)) return hook.queue.lastRenderedState;
        hook = hook.next;
        depth++;
      }
      return null;
    }

    function findNav(fiber, depth) {
      var current = fiber;
      while (current) {
        if ((depth || 0) > 30) return null;
        var name = current.type && (current.type.displayName || current.type.name);
        if (name === 'NavigationContainer' || name === 'ExpoRoot') {
          var found = findNavInHooks(current.memoizedState);
          if (found) return found;
        }
        var found = findNav(current.child, (depth || 0) + 1);
        if (found) return found;
        current = current.sibling;
      }
      return null;
    }

    // B145: walk every renderer's root — NavigationContainer may live on
    // the main Fabric renderer while LogBox shell occupies renderer 1.
    var navState = forEachRootFiber(function(rootFiber) {
      return findNav(rootFiber);
    });

    if (!navState) {
      var fallbackRef = findNavRef();
      if (fallbackRef && fallbackRef.getRootState) navState = fallbackRef.getRootState();
    }

    if (!navState) return JSON.stringify({ error: 'Navigation state not found. Is React Navigation or Expo Router installed?' });

    function simplify(s) {
      if (!s) return null;
      var r = {
        routeName: s.routes && s.routes[s.index] && s.routes[s.index].name,
        params: (s.routes && s.routes[s.index] && s.routes[s.index].params) || {},
        stack: (s.routes && s.routes.map(function(r) { return r.name; })) || [],
        index: s.index
      };
      var activeRoute = s.routes && s.routes[s.index];
      if (activeRoute && activeRoute.state) {
        r.nested = simplify(activeRoute.state);
      }
      return r;
    }

    return JSON.stringify(simplify(navState));
  }

  // Navigation Graph — full topology extraction
  function getNavGraph() {
    try {
      var navigators = [];
      var navIdCounter = 0;
      var containersFound = 0;
      var library = 'unknown';
      var rnVersion = null;
      var expoSdk = null;

      try {
        var RN = require('react-native');
        try { var rnV = require('react-native/Libraries/Core/ReactNativeVersion').version; rnVersion = rnV.major + '.' + rnV.minor + '.' + rnV.patch; } catch(e) {}
      } catch(e) {}
      try { var expoC = require('expo-constants'); if (expoC && expoC.default && expoC.default.expoConfig) expoSdk = expoC.default.expoConfig.sdkVersion || null; } catch(e) {}

      // Detect navigator kind from state.type + fiber heuristic
      function detectKind(stateType, fiberHint) {
        if (stateType === 'tab') return 'tab';
        if (stateType === 'drawer') return 'drawer';
        if (stateType === 'stack') {
          if (fiberHint && (fiberHint.indexOf('NativeStack') !== -1 || fiberHint.indexOf('native-stack') !== -1)) return 'native-stack';
          return 'stack';
        }
        return 'unknown';
      }

      // Build navigator ID
      function makeNavId(parentScreen, kind) {
        if (!parentScreen) return 'root' + (navIdCounter > 0 ? '-' + navIdCounter : '');
        return parentScreen + '/' + kind;
      }

      // Duck-type navigation state: must have routes array + routeNames array
      function isNavState(obj) {
        return obj && Array.isArray(obj.routes) && Array.isArray(obj.routeNames);
      }

      // Walk memoizedState linked list to find navigation state
      function findNavStateInHooks(memoizedState) {
        var current = memoizedState;
        var depth = 0;
        while (current && depth < 30) {
          if (current.memoizedState && isNavState(current.memoizedState)) return current.memoizedState;
          if (isNavState(current)) return current;
          // Check queue (useReducer stores state in .queue.lastRenderedState or .memoizedState)
          if (current.queue && current.queue.lastRenderedState && isNavState(current.queue.lastRenderedState)) return current.queue.lastRenderedState;
          current = current.next;
          depth++;
        }
        return null;
      }

      // Flatten linking config: { screens: { Name: 'path' | { path, screens } } }
      function flattenLinking(config, prefix) {
        var map = {};
        if (!config || !config.screens) return map;
        var screens = config.screens;
        var keys = Object.keys(screens);
        for (var i = 0; i < keys.length; i++) {
          var name = keys[i];
          var val = screens[name];
          if (typeof val === 'string') {
            map[name] = (prefix ? prefix + '/' : '') + val;
          } else if (val && typeof val === 'object') {
            var path = val.path !== undefined ? val.path : name;
            var fullPath = (prefix ? prefix + '/' : '') + path;
            map[name] = fullPath;
            if (val.screens) {
              var nested = flattenLinking({ screens: val.screens }, fullPath);
              var nk = Object.keys(nested);
              for (var j = 0; j < nk.length; j++) map[nk[j]] = nested[nk[j]];
            }
          }
        }
        return map;
      }

      // Extract params from path pattern like "/cart/:id/review/:reviewId"
      function extractParams(path) {
        if (!path) return null;
        var matches = path.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
        if (!matches || matches.length === 0) return null;
        return matches.map(function(m) { return m.slice(1); });
      }

      // Recursively walk navigation state, collecting navigators (read-only — no mutation)
      function walkState(state, parentScreen, linkingMap, fiberHint, depth) {
        if (!state || depth > 20) return;

        var kind = detectKind(state.type, fiberHint);
        var navId = makeNavId(parentScreen, kind);
        var seenIds = {};
        for (var si = 0; si < navigators.length; si++) {
          seenIds[navigators[si].id] = true;
        }
        if (seenIds[navId]) navId = navId + '-' + (++navIdCounter);

        var screenNames = state.routeNames || [];
        var routes = [];
        var activeIndex = typeof state.index === 'number' ? state.index : 0;
        var activeRouteName = state.routes && state.routes[activeIndex] ? state.routes[activeIndex].name : null;

        for (var i = 0; i < screenNames.length; i++) {
          var name = screenNames[i];
          var matchedRoute = null;
          if (state.routes) {
            for (var j = 0; j < state.routes.length; j++) {
              if (state.routes[j].name === name) { matchedRoute = state.routes[j]; break; }
            }
          }
          var isVisited = !!matchedRoute;
          var linkPath = linkingMap ? (linkingMap[name] !== undefined ? linkingMap[name] : null) : null;
          var params = extractParams(linkPath);

          routes.push({
            name: name,
            path: linkPath !== null ? linkPath : undefined,
            params_schema: params || undefined,
            is_initial: name === activeRouteName && activeIndex === 0,
            is_active: name === activeRouteName,
            is_visited: isVisited
          });
        }

        navigators.push({
          id: navId,
          kind: kind,
          parent_screen: parentScreen || null,
          routes: routes,
          active_route_name: activeRouteName,
          initial_route_name: screenNames[0] || undefined,
          is_visited: true,
          source: linkingMap && Object.keys(linkingMap).length > 0 ? 'both' : 'runtime'
        });

        // Recurse into all routes that have nested state
        if (state.routes) {
          for (var ri = 0; ri < state.routes.length; ri++) {
            var route = state.routes[ri];
            if (route.state && isNavState(route.state)) {
              walkState(route.state, route.name, linkingMap, null, depth + 1);
            }
          }
        }
      }

      // -- Primary path: __NAV_REF__.getRootState() --
      var rootState = null;
      var linkingMap = {};

      if (globalThis.__NAV_REF__ && globalThis.__NAV_REF__.getRootState) {
        var refState = globalThis.__NAV_REF__.getRootState();
        if (isNavState(refState)) {
          rootState = refState;
          containersFound = 1;
          library = 'react-navigation';
        }
      }

      // -- Expo Router fast path --
      if (!rootState && globalThis.__expo_router_state__) {
        try {
          var expoState = globalThis.__expo_router_state__;
          if (isNavState(expoState)) {
            rootState = expoState;
            containersFound = 1;
            library = 'expo-router';
          }
        } catch(e) {}
      }

      // -- Fallback: fiber walk --
      if (!rootState) {
        // B145: collect NavigationContainer/ExpoRoot fibers across every
        // renderer. Containers can live on any renderer — main Fabric
        // usually, but an Expo Dev Client + Reanimated app may register
        // more than one. Previously this only scanned renderer 1.
        var containerFibers = [];
        var allRoots = findAllRootFibers();
        for (var ar = 0; ar < allRoots.length; ar++) {
          (function findContainers(fiber, d) {
            if (!fiber || d > 30) return;
            var fname = fiber.type && (fiber.type.displayName || fiber.type.name);
            if (fname === 'NavigationContainer' || fname === 'ExpoRoot') {
              containerFibers.push(fiber);
            }
            findContainers(fiber.child, d + 1);
            if (fiber.sibling) findContainers(fiber.sibling, d);
          })(allRoots[ar].fiber, 0);
        }

        containersFound = containerFibers.length;
        for (var ci = 0; ci < containerFibers.length; ci++) {
          var cf = containerFibers[ci];
          var fiberState = findNavStateInHooks(cf.memoizedState);
          if (!fiberState && globalThis.__NAV_REF__ && globalThis.__NAV_REF__.getRootState) {
            fiberState = globalThis.__NAV_REF__.getRootState();
          }
          if (fiberState && isNavState(fiberState)) {
            if (!rootState) rootState = fiberState;
            // Harvest linking config from fiber props
            try {
              var linking = cf.memoizedProps && cf.memoizedProps.linking;
              if (!linking && cf.return) linking = cf.return.memoizedProps && cf.return.memoizedProps.linking;
              if (linking && linking.config) {
                linkingMap = flattenLinking(linking.config, '');
              }
            } catch(e) {}
            var fName = cf.type && (cf.type.displayName || cf.type.name);
            if (fName === 'ExpoRoot') library = 'expo-router';
            else library = 'react-navigation';
          }
        }
      }

      // Also try to harvest linking config from __NAV_REF__ if fiber didn't get it
      if (Object.keys(linkingMap).length === 0) {
        try {
          if (globalThis.__NAV_REF__ && globalThis.__NAV_REF__.getLinkingOptions) {
            var lo = globalThis.__NAV_REF__.getLinkingOptions();
            if (lo && lo.config) linkingMap = flattenLinking(lo.config, '');
          }
        } catch(e) {}
        // Expo Router auto-linking
        try {
          if (Object.keys(linkingMap).length === 0 && globalThis.__expo_router_linking__) {
            var erl = globalThis.__expo_router_linking__;
            if (erl.config) linkingMap = flattenLinking(erl.config, '');
          }
        } catch(e) {}
      }

      if (!rootState) return JSON.stringify({ error: 'No navigation state found. Is React Navigation or Expo Router installed?' });

      // Walk the state tree
      walkState(rootState, null, linkingMap, null, 0);

      return safeStringify({
        library: library,
        rn_version: rnVersion,
        expo_sdk: expoSdk,
        navigators: navigators,
        containers_found: containersFound
      }, 200000);

    } catch(e) {
      return JSON.stringify({ error: 'Nav graph extraction failed: ' + (e && e.message || String(e)) });
    }
  }

  // Store State
  function getStoreState(path, requestedType) {
    var state = null;
    var storeType = null;

    // B91 fix: Try fiber-walked store FIRST for Redux, then fall back to global.
    // After Dev Client rebuilds, __REDUX_STORE__ may reference the old store instance
    // while the fiber tree always reflects the current React context.
    if (!requestedType || requestedType === 'redux') {
      function findFiberReduxStore(fiber, depth) {
        var current = fiber;
        while (current) {
          if ((depth || 0) > 30) return null;
          var name = current.type && (current.type.displayName || current.type.name);
          if (name === 'Provider' && current.memoizedProps && current.memoizedProps.store && current.memoizedProps.store.getState) {
            return current.memoizedProps.store;
          }
          var found = findFiberReduxStore(current.child, (depth || 0) + 1);
          if (found) return found;
          current = current.sibling;
        }
        return null;
      }
      // B145: walk all renderers for the Redux Provider — first match wins.
      var fiberStore = forEachRootFiber(function(rootFiber) {
        return findFiberReduxStore(rootFiber);
      });
      if (fiberStore) {
        state = fiberStore.getState();
        storeType = 'redux';
      }
      if (!state && globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.getState) {
        state = globalThis.__REDUX_STORE__.getState();
        storeType = 'redux';
      }
    }
    if (!state && (!requestedType || requestedType === 'zustand')) {
      if (globalThis.__ZUSTAND_STORES__) {
        var result = {};
        var keys = Object.keys(globalThis.__ZUSTAND_STORES__);
        for (var i = 0; i < keys.length; i++) {
          var name = keys[i];
          var store = globalThis.__ZUSTAND_STORES__[name];
          result[name] = typeof store.getState === 'function' ? store.getState() : store;
        }
        state = result;
        storeType = 'zustand';
      }
    }
    if (!state && (!requestedType || requestedType === 'jotai')) {
      if (globalThis.__JOTAI_STORE__ && globalThis.__JOTAI_ATOMS__) {
        var jStore = globalThis.__JOTAI_STORE__;
        var jAtoms = globalThis.__JOTAI_ATOMS__;
        if (typeof jStore.get === 'function') {
          var result = {};
          var keys = Object.keys(jAtoms);
          for (var i = 0; i < keys.length; i++) {
            try { result[keys[i]] = jStore.get(jAtoms[keys[i]]); } catch(e) { result[keys[i]] = '<<error: ' + (e && e.message || String(e)) + '>>'; }
          }
          state = result;
          storeType = 'jotai';
        }
      }
    }

    if (!state) {
      function findStore(fiber, depth) {
        var current = fiber;
        while (current) {
          if ((depth || 0) > 30) return null;
          var name = current.type && (current.type.displayName || current.type.name);
          var props = current.memoizedProps;
          if (name === 'Provider' && props && props.store && props.store.getState) {
            return { store: props.store.getState(), type: 'redux' };
          }
          if (name === 'QueryClientProvider' && props && props.client && typeof props.client.getQueryCache === 'function') {
            try {
              var queries = props.client.getQueryCache().getAll();
              var mapped = {};
              for (var q = 0; q < queries.length; q++) {
                var key = JSON.stringify(queries[q].queryKey);
                mapped[key] = { data: queries[q].state.data, status: queries[q].state.status, dataUpdatedAt: queries[q].state.dataUpdatedAt };
              }
              return { store: mapped, type: 'react-query' };
            } catch(e) { /* fall through */ }
          }
          var found = findStore(current.child, (depth || 0) + 1);
          if (found) return found;
          current = current.sibling;
        }
        return null;
      }

      // B145: walk all renderers for Provider / QueryClientProvider.
      var found = forEachRootFiber(function(rootFiber) {
        return findStore(rootFiber);
      });
      if (found) { state = found.store; storeType = found.type; }
    }

    if (!state) {
      return JSON.stringify({
        __agent_error: 'No store found.',
        hint: 'For Zustand, add to app entry: if (__DEV__) global.__ZUSTAND_STORES__ = { myStore }',
        hint2: 'For Redux, the Provider is auto-detected. Check it is mounted.',
        hint3: 'For Jotai, add: if (__DEV__) { global.__JOTAI_STORE__ = store; global.__JOTAI_ATOMS__ = { count: countAtom } }'
      });
    }

    if (path) {
      var parts = path.split('.');
      var current = state;
      for (var i = 0; i < parts.length; i++) {
        var next = current && current[parts[i]];
        if (next === undefined && i === 0 && storeType === 'zustand') {
          var storeKeys = Object.keys(current);
          var lower = parts[0].toLowerCase().replace(/^use|store$/gi, '');
          for (var k = 0; k < storeKeys.length; k++) {
            var sk = storeKeys[k].toLowerCase().replace(/^use|store$/gi, '');
            if (sk === lower) { next = current[storeKeys[k]]; parts[0] = storeKeys[k]; break; }
          }
        }
        current = next;
        if (current === undefined) {
          return JSON.stringify({ __agent_error: 'Path not found: ' + path, availableKeys: Object.keys(state) });
        }
      }
      state = current;
    }

    return safeStringify({ type: storeType, state: state }, 30000);
  }

  // Console Capture — monkey-patch console to capture app-level logs
  // CDP Runtime.consoleAPICalled doesn't fire for RN Bridgeless app-level console calls
  if (!globalThis.__RN_AGENT_CONSOLE__) globalThis.__RN_AGENT_CONSOLE__ = [];
  var consoleBuf = globalThis.__RN_AGENT_CONSOLE__;
  var CONSOLE_BUF_MAX = 200;

  if (!globalThis.__RN_AGENT_CONSOLE_PATCHED__) {
    globalThis.__RN_AGENT_CONSOLE_PATCHED__ = true;
    var origConsole = {
      log: console.log, warn: console.warn, error: console.error,
      info: console.info, debug: console.debug
    };
    globalThis.__RN_AGENT_ORIG_CONSOLE__ = origConsole;

    function wrapConsole(level) {
      return function() {
        var text = '';
        for (var i = 0; i < arguments.length; i++) {
          if (i > 0) text += ' ';
          try { text += typeof arguments[i] === 'string' ? arguments[i] : JSON.stringify(arguments[i]); }
          catch(e) { text += String(arguments[i]); }
        }
        if (text.indexOf('__RN_NET__:') === 0) {
          origConsole[level].apply(console, arguments);
          return;
        }
        consoleBuf.push({ level: level, text: text, timestamp: new Date().toISOString() });
        if (consoleBuf.length > CONSOLE_BUF_MAX) consoleBuf.shift();
        origConsole[level].apply(console, arguments);
      };
    }

    console.log = wrapConsole('log');
    console.warn = wrapConsole('warn');
    console.error = wrapConsole('error');
    console.info = wrapConsole('info');
    console.debug = wrapConsole('debug');
  } else {
    consoleBuf = globalThis.__RN_AGENT_CONSOLE__;
  }

  function getConsole(opts) {
    opts = opts || {};
    var level = opts.level || 'all';
    var lim = opts.limit || 50;
    var entries = [];
    for (var i = 0; i < consoleBuf.length; i++) {
      if (level === 'all' || consoleBuf[i].level === level) {
        entries.push(consoleBuf[i]);
      }
    }
    return JSON.stringify(entries.slice(-lim));
  }

  function clearConsole() {
    consoleBuf.length = 0;
    return 'cleared';
  }

  // Error Tracking — use global array so reinjection doesn't lose buffered errors
  if (!globalThis.__RN_AGENT_ERRORS__) globalThis.__RN_AGENT_ERRORS__ = [];
  var errors = globalThis.__RN_AGENT_ERRORS__;

  try {
    if (globalThis.__RN_AGENT_ORIG_ERR_HANDLER__ === undefined) {
      globalThis.__RN_AGENT_ORIG_ERR_HANDLER__ = ErrorUtils.getGlobalHandler();
    }
    var origHandler = globalThis.__RN_AGENT_ORIG_ERR_HANDLER__;
    ErrorUtils.setGlobalHandler(function(error, isFatal) {
      errors.push({
        message: (error && error.message) || String(error),
        stack: error && error.stack && error.stack.split('\\n').slice(0, 8).join('\\n'),
        isFatal: isFatal,
        timestamp: new Date().toISOString()
      });
      if (errors.length > 50) errors.shift();
      if (origHandler) origHandler(error, isFatal);
    });
  } catch(e) {}

  if (!globalThis.__RN_AGENT_REJECTION_TRACKED__) try {
    if (globalThis.HermesInternal && globalThis.HermesInternal.enablePromiseRejectionTracker) {
      globalThis.__RN_AGENT_REJECTION_TRACKED__ = true;
      globalThis.HermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: function(id, error) {
          errors.push({
            message: (error && error.message) || String(error),
            type: 'unhandled_promise',
            timestamp: new Date().toISOString()
          });
          if (errors.length > 50) errors.shift();
        }
      });
    }
  } catch(e) {}

  function getErrors() { return JSON.stringify(errors); }
  function clearErrors() { errors.length = 0; return 'cleared'; }

  // UI Interaction
  function interact(opts) {
    opts = opts || {};
    var action = opts.action;
    var selector = opts.testID || opts.accessibilityLabel;
    var matchField = opts.testID ? 'testID' : 'accessibilityLabel';
    var isLabelMatch = matchField === 'accessibilityLabel';

    if (!action) return JSON.stringify({ error: 'action is required' });

    // Task 7 — ladder routing. When the caller passes a declarative selector
    // (role/name/text/placeholder) and NO testID/accessibilityLabel, resolve
    // via resolveLadder then press the found fiber or its nearest onPress
    // ancestor (walking .return). testID/accessibilityLabel keep the legacy
    // path below unchanged (including Task 6's fail-closed truncation).
    if (!selector && (opts.role || opts.name || opts.text || opts.placeholder)) {
      // Ladder selectors only support press in Phase 1 — fail closed for any
      // other action instead of silently pressing (Codex review).
      if (opts.action && opts.action !== 'press') {
        return JSON.stringify({
          error: 'Ladder selectors (role/name/text/placeholder) support only action:"press"',
          requestedAction: opts.action,
          hint: 'Use a testID or accessibilityLabel for longPress / typeText / scroll / setFieldValue.'
        });
      }
      var ladderResult = resolveLadder(JSON.stringify({
        role: opts.role, name: opts.name, text: opts.text,
        placeholder: opts.placeholder, exact: opts.exact, includeHidden: opts.includeHidden
      }));
      var parsed = JSON.parse(ladderResult);
      if (!parsed.found) return ladderResult;

      var targetFiber = __resolveLadderFiber(opts);
      if (!targetFiber) return JSON.stringify({ error: 'Component not found' });

      var pressFiber = targetFiber;
      while (pressFiber) {
        var pf = pressFiber.memoizedProps;
        if (pf && typeof pf.onPress === 'function') break;
        pressFiber = pressFiber.return;
      }
      if (!pressFiber) {
        return JSON.stringify({ error: 'Component has no onPress handler', bundle: parsed.bundle });
      }
      var pName = (pressFiber.type && (typeof pressFiber.type === 'string'
        ? pressFiber.type
        : (pressFiber.type.displayName || pressFiber.type.name))) || 'Unknown';
      try {
        pressFiber.memoizedProps.onPress({ nativeEvent: {} });
        return JSON.stringify({ success: true, action: 'press', component: pName, bundle: parsed.bundle });
      } catch (e) {
        return JSON.stringify({ error: 'onPress threw', message: e && e.message, component: pName });
      }
    }

    if (!selector) return JSON.stringify({ error: 'testID or accessibilityLabel is required' });

    var found = null;
    var findCount = 0;
    // Fail-closed truncation budget. Mirrors the salient-digest budget
    // (Math.min(cap, perRoot * roots)) and its wall-clock guard
    // (Date.now() - start < 3000). rootsSeeded is counted as roots are fed
    // into findFiber via forEachRootFiber below. On trip we set findTruncated
    // and unwind WITHOUT recording any match, so interact() returns a
    // structured "Resolution truncated" error and NEVER presses a partial pick.
    var findTruncated = false;
    var findStart = Date.now();
    var rootsSeeded = 0;
    var findBudget = 8000; // recomputed once rootsSeeded is known

    // B5/D684: testID stays strict + early-return (fast happy path).
    // accessibilityLabel uses tiered matching: exact === → normalized
    // (trim+collapse-ws+lowercase) → substring contains. Ambiguity in the
    // looser tiers surfaces as a structured error so we never silently pick
    // among multiple "Continue" buttons.
    function norm(v) {
      return String(v).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '').toLowerCase();
    }
    var normSelector = isLabelMatch ? norm(selector) : null;
    var exactMatches = [];
    var normMatches = [];
    var containsMatches = [];

    function findFiber(fiber) {
      var current = fiber;
      while (current) {
        if (findTruncated) return;
        findCount++;
        if (findCount > findBudget || (Date.now() - findStart) > 3000) {
          findTruncated = true;
          return;
        }
        var props = current.memoizedProps;
        if (props) {
          if (!isLabelMatch) {
            if (props[matchField] === selector) {
              found = current;
              return;
            }
          } else {
            var raw = props.accessibilityLabel;
            if (raw !== undefined && raw !== null && raw !== '') {
              if (raw === selector) {
                exactMatches.push(current);
              } else {
                var nv = norm(raw);
                if (nv === normSelector) {
                  normMatches.push(current);
                } else if (nv.indexOf(normSelector) >= 0) {
                  containsMatches.push(current);
                }
              }
            }
          }
        }
        if (current.child) findFiber(current.child);
        if (!isLabelMatch && found) return;
        current = current.sibling;
      }
    }

    // B145: walk root.current across every renderer until the testID is
    // found. Previously only the first renderer's roots were searched.
    // For label matching, walk ALL renderers (no short-circuit) so duplicate
    // labels split across renderers (LogBox vs Fabric) are detected.
    // First pass purely to size the budget by how many roots we'll seed,
    // so a multi-renderer tree (LogBox + Fabric + Reanimated) gets proportional
    // headroom — same shape as the digest's Math.min(cap, perRoot * roots).
    forEachRootFiber(function() { rootsSeeded++; return null; });
    findBudget = Math.min(40000, 8000 * Math.max(1, rootsSeeded));
    forEachRootFiber(function(rootFiber) {
      if (findTruncated) return found;
      if (!isLabelMatch && found) return found;
      findFiber(rootFiber);
      return isLabelMatch ? null : found;
    });

    // Fail-closed: a tripped budget means the scan is INCOMPLETE. Never fall
    // through to the tier[0] pick, the "Component not found" branch, or onPress
    // — any of those would act on a partial view of the tree.
    if (findTruncated) {
      return JSON.stringify({
        error: 'Resolution truncated',
        truncated: true,
        scanned: findCount,
        hint: 'increase budget or scope with a container/anchor'
      });
    }

    if (isLabelMatch) {
      var tier = exactMatches.length > 0
        ? exactMatches
        : (normMatches.length > 0 ? normMatches : containsMatches);
      if (tier.length === 0) {
        return JSON.stringify({
          error: 'Component not found',
          selector: selector,
          matchField: matchField,
          hint: 'Tried exact, case/whitespace-normalized, and substring match. Use cdp_component_tree filter:"' + selector + '" to verify the label is mounted, or pass a testID instead.'
        });
      }
      if (tier.length > 1) {
        var descriptors = [];
        for (var di = 0; di < tier.length && di < 10; di++) {
          var dp = tier[di].memoizedProps || {};
          var dt = (tier[di].type && (tier[di].type.displayName || tier[di].type.name)) || 'Unknown';
          descriptors.push({
            component: dt,
            testID: dp.testID,
            accessibilityLabel: dp.accessibilityLabel,
          });
        }
        return JSON.stringify({
          error: 'Ambiguous component match',
          selector: selector,
          matchField: matchField,
          count: tier.length,
          matches: descriptors,
          hint: 'Multiple components match this accessibilityLabel. Add a testID to the target component for unambiguous matching.'
        });
      }
      found = tier[0];
    }

    if (!found) {
      return JSON.stringify({
        error: 'Component not found',
        selector: selector,
        hint: 'Use cdp_component_tree to verify the component is mounted and the testID is correct.'
      });
    }

    var props = found.memoizedProps || {};
    var typeName = (found.type && (found.type.displayName || found.type.name)) || 'Unknown';

    try {
      if (action === 'press') {
        if (typeof props.onPress !== 'function') {
          return JSON.stringify({ error: 'Component has no onPress handler', component: typeName, testID: selector });
        }
        if (opts.value !== undefined) {
          props.onPress(opts.value);
        } else {
          props.onPress({ nativeEvent: {} });
        }
        var pressResult = { success: true, action: 'press', component: typeName, testID: selector };
        if (opts.value !== undefined) pressResult.value = opts.value;
        return JSON.stringify(pressResult);
      }

      if (action === 'typeText') {
        var text = opts.text !== undefined ? opts.text : '';

        // Issue #126 Fix A — typeText handler resolution.
        //
        // Path 1: matched fiber itself has onChangeText / onChange. SINGLE-
        // fire — pick onChangeText if present, else onChange. Avoids the
        // double-fire bug: when an RHF Controller wraps a TextInput via
        // <TextInput {...field} />, both onChangeText and onChange are bound
        // to field.onChange. Firing both ran field.onChange twice with
        // different argument shapes (string then {nativeEvent}), corrupting
        // the form state and double-triggering validators.
        //
        // Path 2: when matched fiber has no typeable handler, walk
        // descendants for a typeable child. Common case: design-system
        // TextField wraps TextInput in an outer Pressable/View; the wrapper
        // testID resolves to the wrapper fiber whose props don't carry
        // onChangeText. Walking down finds the inner TextInput. Bounds:
        // depth ≤ 16, visit cap 200 across both passes. Two-pass: pass 1
        // considers only onChangeText; pass 2 falls back to onChange (the
        // overloaded RN handler) only if no onChangeText descendant
        // exists. Within each pass: prefer fibers whose type matches a
        // TextInput-family fingerprint, then dedupe candidates that share
        // the same handler function reference (react-native-paper wraps
        // TextInputOutlined → TextInput → InternalTextInput each forwarding
        // the same onChangeText — pick the deepest leaf), and return
        // Ambiguous only when truly distinct typed handlers compete.
        var verify = opts.verify === true;
        var controlled = typeof props.value === 'string';
        var valueBefore = controlled ? props.value : null;

        if (typeof props.onChangeText === 'function' || typeof props.onChange === 'function') {
          var p1Handler;
          if (typeof props.onChangeText === 'function') {
            p1Handler = 'onChangeText';
            props.onChangeText(text);
          } else {
            p1Handler = 'onChange';
            props.onChange({ nativeEvent: { text: text } });
          }
          return JSON.stringify({
            success: true, action: 'typeText', component: typeName, testID: selector, text: text,
            handlerCalled: p1Handler, controlled: controlled, valueBefore: valueBefore,
            resolvedFrom: 'matched-fiber'
          });
        }

        // Anchored on TextInput-family names. Drops bare Input/Field
        // substrings to avoid false-positives on RadioGroupField,
        // InputAccessoryView, BottomSheetTextInput's wrapper, etc.
        var TYPEABLE_TYPE_RE = /(TextInput|TextField|EditText)/;
        var visited = 0;
        var DESCENDANT_DEPTH_CAP = 16;
        var DESCENDANT_VISIT_CAP = 200;

        function findHandlerDescendants(handlerName) {
          var matches = [];
          function walk(node, depth) {
            if (!node || depth > DESCENDANT_DEPTH_CAP || visited > DESCENDANT_VISIT_CAP) return;
            visited++;
            var nProps = node.memoizedProps || {};
            if (typeof nProps[handlerName] === 'function') {
              var nName = (node.type && (node.type.displayName || node.type.name)) || '';
              matches.push({
                fiber: node,
                props: nProps,
                name: nName,
                depth: depth,
                typeFingerprint: TYPEABLE_TYPE_RE.test(nName)
              });
            }
            if (node.child) walk(node.child, depth + 1);
            if (node.sibling) walk(node.sibling, depth);
          }
          if (found.child) walk(found.child, 1);
          return matches;
        }

        // Dedupe candidates that share the same handler function reference.
        // react-native-paper's TextInputOutlined → TextInput → InternalTextInput
        // chain each forwards the SAME onChangeText down — they're the same
        // logical handler, not three independent typeable fields. Keep the
        // deepest leaf so the call lands on the host-component fiber that
        // actually owns the input. (Codex M4 / multi-LLM review of issue #126.)
        function dedupeByHandlerIdentity(matches, handlerName) {
          var byFn = [];
          for (var i = 0; i < matches.length; i++) {
            var m = matches[i];
            var fn = m.props[handlerName];
            var existingIdx = -1;
            for (var j = 0; j < byFn.length; j++) {
              if (byFn[j].props[handlerName] === fn) { existingIdx = j; break; }
            }
            if (existingIdx === -1) {
              byFn.push(m);
            } else if (m.depth > byFn[existingIdx].depth) {
              // Same handler, deeper fiber — replace with the leaf.
              byFn[existingIdx] = m;
            }
          }
          return byFn;
        }

        function pickFromMatches(matches, handlerName) {
          if (matches.length === 0) return { kind: 'none' };
          var deduped = dedupeByHandlerIdentity(matches, handlerName);
          var typed = [];
          for (var i = 0; i < deduped.length; i++) if (deduped[i].typeFingerprint) typed.push(deduped[i]);
          if (typed.length === 1) return { kind: 'one', match: typed[0], handler: handlerName };
          if (typed.length > 1) return { kind: 'ambiguous', matches: typed, handler: handlerName };
          if (deduped.length === 1) return { kind: 'one', match: deduped[0], handler: handlerName };
          return { kind: 'ambiguous', matches: deduped, handler: handlerName };
        }

        var pass1 = pickFromMatches(findHandlerDescendants('onChangeText'), 'onChangeText');
        var picked = null;
        if (pass1.kind === 'one') {
          picked = pass1;
        } else if (pass1.kind === 'ambiguous') {
          return JSON.stringify({
            error: 'Ambiguous typeText resolution',
            testID: selector,
            handler: 'onChangeText',
            count: pass1.matches.length,
            candidates: pass1.matches.slice(0, 5).map(function(m) {
              return { component: m.name, testID: m.props.testID, typeFingerprint: m.typeFingerprint };
            }),
            hint: 'Multiple onChangeText descendants under testID "' + selector + '". Pass a more specific testID — ideally the inner TextInput itself.'
          });
        } else {
          // pass 2 — onChange fallback
          var pass2 = pickFromMatches(findHandlerDescendants('onChange'), 'onChange');
          if (pass2.kind === 'one') {
            picked = pass2;
          } else if (pass2.kind === 'ambiguous') {
            return JSON.stringify({
              error: 'Ambiguous typeText resolution',
              testID: selector,
              handler: 'onChange',
              count: pass2.matches.length,
              candidates: pass2.matches.slice(0, 5).map(function(m) {
                return { component: m.name, testID: m.props.testID, typeFingerprint: m.typeFingerprint };
              }),
              hint: 'Multiple onChange descendants under testID "' + selector + '". Pass a more specific testID — ideally the inner TextInput itself.'
            });
          }
        }

        if (!picked) {
          if (verify) {
            return JSON.stringify({ success: true, action: 'typeText', testID: selector, handlerCalled: false, controlled: controlled, valueBefore: valueBefore });
          }
          return JSON.stringify({
            error: 'Component has no onChangeText or onChange handler',
            component: typeName,
            testID: selector,
            hint: 'Walked up to ' + DESCENDANT_DEPTH_CAP + ' levels (' + visited + ' fibers) — no descendant has a typeable handler. The matched fiber may not contain a TextInput. Use cdp_component_tree to inspect, or pass the inner field testID directly.'
          });
        }

        // Single-fire — call only the picked handler. Avoids the
        // double-fire bug on RHF Controllers where field.onChange wired
        // to onChangeText + RN HostComponent onChange would each run
        // with different argument shapes.
        if (picked.handler === 'onChangeText') {
          picked.match.props.onChangeText(text);
        } else {
          picked.match.props.onChange({ nativeEvent: { text: text } });
        }

        var pickedControlled = typeof picked.match.props.value === 'string';
        return JSON.stringify({
          success: true, action: 'typeText', component: typeName, testID: selector, text: text,
          handlerCalled: picked.handler, controlled: pickedControlled,
          valueBefore: pickedControlled ? picked.match.props.value : valueBefore,
          resolvedFrom: picked.match.name + (picked.match.props.testID ? ' [testID="' + picked.match.props.testID + '"]' : ''),
          visitedFibers: visited
        });
      }

      if (action === 'setFieldValue') {
        // Issue #126 Gap A — explicit React Hook Form fallback. typeText's
        // handler chain walks DOWN looking for a TextInput descendant with
        // onChangeText/onChange. That works for wrapper-Pressable patterns
        // where the inner TextInput is reachable, but fails when the field's
        // value flows through field.onChange → FormProvider context →
        // setValue. There's no inner TextInput-shaped fiber to find, because
        // the design-system field calls field.onChange directly via a
        // Controller render prop.
        //
        // Resolution: walk UP from the matched fiber (the testID anchor)
        // looking for a Provider fiber whose memoizedProps.value duck-types
        // as a React Hook Form UseFormReturn. Then call value.setValue(
        // name, value, options). The closest ancestor wins (natural React
        // context resolution), so nested forms behave intuitively.
        var fieldName = opts.name;
        var fieldValue = opts.value;
        if (typeof fieldName !== 'string' || fieldName.length === 0) {
          return JSON.stringify({
            error: 'setFieldValue requires opts.name (the RHF field name)',
            testID: selector,
            hint: 'Pass the same \`name\` string you used in \`useController({ name })\` or \`<Controller name="..." />\`.'
          });
        }
        var shouldValidate = opts.shouldValidate !== false;
        var shouldDirty = opts.shouldDirty !== false;

        var ANCESTOR_DEPTH_CAP = 32;
        var ANCESTOR_VISIT_CAP = 100;
        function looksLikeUseFormReturn(v) {
          return (
            v && typeof v === 'object'
            && typeof v.setValue === 'function'
            && typeof v.getValues === 'function'
            && v.control && typeof v.control === 'object'
          );
        }
        var ancestor = found.return;
        var ancestorDepth = 0;
        var ancestorVisits = 0;
        var formReturn = null;
        while (ancestor && ancestorDepth < ANCESTOR_DEPTH_CAP && ancestorVisits < ANCESTOR_VISIT_CAP) {
          ancestorVisits++;
          var aProps = ancestor.memoizedProps;
          if (aProps && looksLikeUseFormReturn(aProps.value)) {
            formReturn = aProps.value;
            break;
          }
          ancestor = ancestor.return;
          ancestorDepth++;
        }
        if (!formReturn) {
          return JSON.stringify({
            error: 'setFieldValue: no FormProvider ancestor found',
            testID: selector,
            ancestorVisits: ancestorVisits,
            hint: 'No React Hook Form FormProvider ancestor with setValue+getValues+control was reachable within ' + ANCESTOR_DEPTH_CAP + ' levels. Either the form is not wrapped in <FormProvider {...methods}>, or the testID anchor sits outside the form subtree. If you only need to fire onChangeText/onChange, use action="typeText" instead.'
          });
        }
        var coercedToString = false;
        if (typeof fieldValue === 'number') {
          var currentValue;
          try { currentValue = formReturn.getValues(fieldName); } catch (e2) { currentValue = undefined; }
          if (typeof currentValue === 'string') {
            fieldValue = String(fieldValue);
            coercedToString = true;
          }
        }
        try {
          formReturn.setValue(fieldName, fieldValue, { shouldValidate: shouldValidate, shouldDirty: shouldDirty });
        } catch (e) {
          return JSON.stringify({
            error: 'setFieldValue: setValue threw: ' + (e && e.message ? e.message : String(e)),
            testID: selector,
            name: fieldName,
            hint: 'The form was found but its setValue rejected the call. Common causes: name does not exist on the form, value type mismatch, or the form is in a transitioning state.'
          });
        }
        return JSON.stringify({
          success: true,
          action: 'setFieldValue',
          testID: selector,
          name: fieldName,
          value: fieldValue,
          coercedToString: coercedToString,
          shouldValidate: shouldValidate,
          shouldDirty: shouldDirty,
          ancestorVisits: ancestorVisits
        });
      }

      if (action === 'scroll') {
        var x = opts.scrollX !== undefined ? opts.scrollX : 0;
        var y = opts.scrollY !== undefined ? opts.scrollY : 300;
        var animated = opts.animated !== false;
        var stateNode = found.stateNode;

        if (stateNode && typeof stateNode.scrollTo === 'function') {
          stateNode.scrollTo({ x: x, y: y, animated: animated });
          return JSON.stringify({ success: true, action: 'scroll', method: 'scrollTo', component: typeName, testID: selector, x: x, y: y });
        }

        if (typeof props.onScroll === 'function') {
          props.onScroll({
            nativeEvent: {
              contentOffset: { x: x, y: y },
              contentSize: { width: 0, height: 0 },
              layoutMeasurement: { width: 0, height: 0 }
            }
          });
          return JSON.stringify({ success: true, action: 'scroll', method: 'onScroll', component: typeName, testID: selector, x: x, y: y, note: 'Synthetic event — does not physically scroll the native view' });
        }

        return JSON.stringify({ error: 'Component has no scrollTo method or onScroll handler', component: typeName, testID: selector });
      }

      if (action === 'longPress') {
        if (typeof props.onLongPress !== 'function') {
          return JSON.stringify({ error: 'Component has no onLongPress handler', component: typeName, testID: selector });
        }
        props.onLongPress({ nativeEvent: {} });
        return JSON.stringify({ success: true, action: 'longPress', component: typeName, testID: selector });
      }

      return JSON.stringify({ error: 'Unknown action: ' + action });
    } catch(e) {
      return JSON.stringify({
        success: false, action_executed: true,
        handler_error: (e && e.message || String(e)),
        component: typeName, testID: selector,
        hint: 'The action was dispatched but the app handler threw — the screen may now be in an error state. Check cdp_error_log before continuing.'
      });
    }
  }

  function dispatchAction(opts) {
    opts = opts || {};
    var actionType = opts.action;
    var payload = opts.payload;
    var readPath = opts.readPath;

    if (!actionType) return JSON.stringify({ __agent_error: 'action is required (e.g. "tasks/softDelete")' });

    // B90 fix: Prefer fiber-walked store over __REDUX_STORE__ global.
    // After Dev Client rebuilds, the global may reference the OLD store instance
    // while the fiber tree always reflects the CURRENT React context.
    //
    // B125 fix: also check current.type.name as a fallback when displayName
    // is missing — common for minified/bundled Providers. Mirrors what
    // findFiberReduxStore already does for getStoreState. Without this,
    // cdp_store_state succeeds but cdp_dispatch fails on the same app.
    function findDispatchStore(fiber, depth) {
      var current = fiber;
      while (current) {
        if ((depth || 0) > 30) return null;
        var typeName = current.type && (current.type.displayName || current.type.name);
        if (typeName === 'Provider' && current.memoizedProps && current.memoizedProps.store && current.memoizedProps.store.dispatch) {
          return current.memoizedProps.store;
        }
        var found = findDispatchStore(current.child, (depth || 0) + 1);
        if (found) return found;
        current = current.sibling;
      }
      return null;
    }
    // B145: walk all renderers for the Redux Provider.
    var store = forEachRootFiber(function(rootFiber) {
      return findDispatchStore(rootFiber);
    });

    if (!store && globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.dispatch) {
      store = globalThis.__REDUX_STORE__;
    }

    if (!store) {
      return JSON.stringify({ __agent_error: 'No Redux store with dispatch found. Zustand stores do not support dispatch.' });
    }

    try {
      store.dispatch({ type: actionType, payload: payload });
    } catch(e) {
      return JSON.stringify({ __agent_error: 'Dispatch failed: ' + (e && e.message || String(e)) });
    }

    if (readPath) {
      var state = store.getState();
      var parts = readPath.split('.');
      var cur = state;
      for (var i = 0; i < parts.length; i++) {
        cur = cur && cur[parts[i]];
        if (cur === undefined) {
          return safeStringify({ dispatched: true, readError: 'Path not found: ' + readPath });
        }
      }
      return safeStringify({ dispatched: true, state: cur });
    }

    return JSON.stringify({ dispatched: true });
  }

  function findNavRef() {
    if (globalThis.__NAV_REF__ && globalThis.__NAV_REF__.navigate) return globalThis.__NAV_REF__;
    if (globalThis.__NAVIGATION_REF__ && globalThis.__NAVIGATION_REF__.navigate) return globalThis.__NAVIGATION_REF__;
    if (globalThis.navigationRef && globalThis.navigationRef.navigate) return globalThis.navigationRef;
    // B145: scan every renderer for a NavigationContainer fiber with a
    // navigate() ref. The fiber ref lives on the same renderer as the
    // container itself, so no cross-renderer lookup is needed — we just
    // have to reach the right renderer.
    //
    // GH #72: when the app renders <NavigationContainer> without a ref prop
    // (common in Expo Router and minimalist setups), neither fiber.ref nor
    // fiber.stateNode carry a navigate() function. React Navigation's
    // internal ref from useNavigationContainerRef() lives on the hooks
    // linked list at fiber.memoizedState. Walk that chain too — strict
    // match on { navigate, dispatch, getRootState } avoids picking up
    // unrelated refs in apps with multiple navigation libraries.
    return forEachRootFiber(function(rootFiber) {
      var localFound = null;
      var count = 0;
      var stack = [rootFiber];
      while (stack.length > 0 && !localFound && count < 5000) {
        var fiber = stack.pop();
        if (!fiber) continue;
        count++;
        var name = fiber.type && (fiber.type.displayName || fiber.type.name);
        if (name === 'NavigationContainer' || name === 'NavigationContainerInner') {
          var r = fiber.ref;
          if (r && typeof r === 'object' && r.current && typeof r.current.navigate === 'function') {
            localFound = r.current;
            break;
          }
          if (fiber.stateNode && typeof fiber.stateNode.navigate === 'function') {
            localFound = fiber.stateNode;
            break;
          }
          // GH #72: walk the hooks linked list for the internal ref.
          var hook = fiber.memoizedState;
          var hopGuard = 0;
          while (hook && hopGuard < 100) {
            hopGuard++;
            var hms = hook.memoizedState;
            if (hms && hms.current
                && typeof hms.current.navigate === 'function'
                && typeof hms.current.dispatch === 'function'
                && typeof hms.current.getRootState === 'function') {
              localFound = hms.current;
              break;
            }
            hook = hook.next;
          }
          if (localFound) break;
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
      return localFound;
    });
  }

  function navigateTo(screen, params) {
    var ref = findNavRef();
    // GH #72: error message updated to reflect the wider discovery surface.
    // findNavRef() now checks 3 globals + fiber.ref + fiber.stateNode +
    // fiber.memoizedState hooks chain. If all of those miss, the app is
    // likely on React Navigation < 6.x (no NavigationContainer fiber name)
    // or has wrapped the container in something unrecognized.
    if (!ref) return JSON.stringify({ __agent_error: 'Navigation ref not found. The plugin walks 3 globals (__NAV_REF__, __NAVIGATION_REF__, navigationRef), NavigationContainer fiber.ref + fiber.stateNode, and the useNavigationContainerRef() hooks chain. None matched. If you are on React Navigation 6+, ensure <NavigationContainer> is rendered. As a last resort, expose globalThis.__NAV_REF__ = navigationRef in your app entry.' });

    try {
      var state = ref.getRootState();
      if (!state) return JSON.stringify({ __agent_error: 'No navigation state' });

      if (state.routeNames && state.routeNames.indexOf(screen) !== -1) {
        ref.navigate(screen, params || undefined);
        return JSON.stringify({ navigated: true, screen: screen, method: 'direct' });
      }

      function findPath(navState, target, path) {
        if (!navState) return null;
        var names = navState.routeNames || [];
        if (names.indexOf(target) !== -1) {
          path.push(target);
          return path;
        }
        var routes = navState.routes || [];
        for (var i = 0; i < routes.length; i++) {
          var route = routes[i];
          var childState = route.state;
          if (!childState && navState.routeNames) {
            for (var j = 0; j < navState.routeNames.length; j++) {
              if (navState.routeNames[j] === route.name && route.state) {
                childState = route.state;
                break;
              }
            }
          }
          if (childState) {
            var result = findPath(childState, target, path.concat([route.name]));
            if (result) return result;
          }
        }
        return null;
      }

      var path = findPath(state, screen, []);
      if (path && path.length > 0) {
        var action = { screen: path[path.length - 1], params: params };
        for (var i = path.length - 2; i >= 0; i--) {
          action = { screen: path[i], params: action };
        }
        ref.dispatch({ type: 'NAVIGATE', payload: { name: action.screen, params: action.params } });
        return JSON.stringify({ navigated: true, screen: screen, method: 'nested-dispatch', path: path });
      }

      var tabsRoute = state.routes && state.routes.find(function(r) { return r.name === 'Tabs'; });
      var tabState = tabsRoute && tabsRoute.state;
      var tabNames = tabState && tabState.routeNames ? tabState.routeNames : [];
      for (var t = 0; t < tabNames.length; t++) {
        try {
          var beforeState = JSON.stringify(ref.getRootState());
          ref.navigate(tabNames[t], { screen: screen, params: params });
          var afterState = ref.getRootState();
          var activeRoute = afterState;
          var navDepth = 0;
          while (activeRoute.routes && activeRoute.index !== undefined && navDepth++ < 50) {
            activeRoute = activeRoute.routes[activeRoute.index].state || activeRoute.routes[activeRoute.index];
          }
          var activeName = activeRoute.name || (activeRoute.routes && activeRoute.routes[activeRoute.index] && activeRoute.routes[activeRoute.index].name);
          if (activeName === screen) {
            return JSON.stringify({ navigated: true, screen: screen, method: 'tab-scan', tab: tabNames[t] });
          }
        } catch(e2) { /* try next tab */ }
      }

      ref.navigate(screen, params || undefined);
      var afterFallback = ref.getRootState();

      // CDP-009: previously the fallback used a recursive checkRoute that
      // walked ALL routes including inactive tab branches and parent
      // history. A target sitting in an inactive tab's stack would
      // satisfy found=true and the helper would report success, but the
      // requested screen was NOT the visible leaf. Now we verify the
      // deepest ACTIVE route matches the target.
      function getDeepestActive(s) {
        if (!s) return null;
        if (s.routes && typeof s.index === 'number' && s.routes[s.index]) {
          var route = s.routes[s.index];
          if (route.state) return getDeepestActive(route.state);
          return route.name || null;
        }
        return s.name || null;
      }
      var deepestActive = getDeepestActive(afterFallback);
      if (deepestActive === screen) {
        return JSON.stringify({ navigated: true, screen: screen, method: 'fallback-navigate', deepest_active: deepestActive });
      }

      // Target may exist somewhere in the tree (inactive tab or parent of
      // current) — we report this as a failure but with metadata so the
      // caller can distinguish "not found at all" from "exists but not
      // the active leaf".
      var existsInTree = false;
      function checkRoute(rs) {
        if (!rs) return;
        if (rs.name === screen) { existsInTree = true; return; }
        if (rs.routes) {
          for (var ri = 0; ri < rs.routes.length; ri++) {
            checkRoute(rs.routes[ri]);
            if (rs.routes[ri].state) checkRoute(rs.routes[ri].state);
          }
        }
      }
      checkRoute(afterFallback);
      if (existsInTree) {
        return JSON.stringify({
          __agent_error: 'Navigate failed: screen "' + screen + '" exists in the navigation tree but is not the active leaf (currently: "' + deepestActive + '"). Likely covered by a stacked modal or parked in an inactive tab history.',
          arrived: false,
          deepest_active: deepestActive,
          arrived_via: 'inactive-or-covered',
        });
      }
      return JSON.stringify({ __agent_error: 'Navigate failed: screen "' + screen + '" not found in any navigator after dispatch. Check screen name spelling and that it is registered in a navigator.' });

    } catch(e) {
      return JSON.stringify({ __agent_error: 'Navigation failed: ' + (e && e.message || String(e)) });
    }
  }

  function getComponentState(testID) {
    if (!testID) return JSON.stringify({ __agent_error: 'testID is required' });
    var targetFiber = null;

    function findByTestID(fiber) {
      if (!fiber || targetFiber) return;
      var props = fiber.memoizedProps;
      if (props && (props.testID === testID || props.nativeID === testID)) {
        targetFiber = fiber;
        return;
      }
      var child = fiber.child;
      while (child) {
        findByTestID(child);
        child = child.sibling;
      }
    }

    // B145: search every renderer for the testID. Closure-mutated target-
    // Fiber lets the forEachRootFiber helper short-circuit as soon as any
    // renderer yields the match.
    forEachRootFiber(function(rootFiber) {
      findByTestID(rootFiber);
      return targetFiber;
    });
    if (!targetFiber) return JSON.stringify({ __agent_error: 'Component not found: ' + testID });

    var compName = targetFiber.type && (targetFiber.type.displayName || targetFiber.type.name) || null;

    var hooks = [];
    var hookState = targetFiber.memoizedState;
    var limit = 20;
    while (hookState && limit-- > 0) {
      var hs;
      try { hs = hookState.memoizedState; }
      catch(e) { hooks.push('[HookAccessError]'); hookState = hookState.next; continue; }

      if (typeof hs === 'function') {
        hooks.push('[Function]');
      } else if (typeof hs === 'object' && hs !== null) {
        try {
          if (hs.current !== undefined) {
            hooks.push({ ref: hs.current !== null ? typeof hs.current : null });
          } else if (hs._formValues && hs._formState) {
            hooks.push({
              __type: 'react-hook-form',
              values: sanitizeForSerialization(hs._formValues),
              errors: sanitizeForSerialization(hs._formState.errors),
              isDirty: hs._formState.isDirty,
              isValid: hs._formState.isValid,
              isSubmitting: hs._formState.isSubmitting
            });
          } else {
            // Use sanitizer directly to handle getters that throw (useNavigation etc.)
            hooks.push(sanitizeForSerialization(hs));
          }
        } catch(e) {
          hooks.push('[HookSerializeError:' + (e && e.message && e.message.slice(0, 60) || 'unknown') + ']');
        }
      } else {
        hooks.push(hs);
      }
      try { hookState = hookState.next; }
      catch(e) { break; }
    }

    var propsObj = {};
    if (targetFiber.memoizedProps) {
      var pkeys;
      try { pkeys = Object.keys(targetFiber.memoizedProps); }
      catch(e) { pkeys = []; }
      for (var i = 0; i < pkeys.length; i++) {
        try {
          var v = targetFiber.memoizedProps[pkeys[i]];
          propsObj[pkeys[i]] = typeof v === 'function' ? '[Function]' : sanitizeForSerialization(v);
        } catch(e) {
          propsObj[pkeys[i]] = '[PropAccessError]';
        }
      }
    }

    return safeStringify({
      component: compName,
      testID: testID,
      props: propsObj,
      hooks: hooks
    }, 100000);
  }

  function readInputValue(testID) {
    if (!testID) return JSON.stringify({ __agent_error: 'testID is required' });
    var target = null;
    function findByTestID(fiber) {
      if (!fiber || target) return;
      var p = fiber.memoizedProps;
      if (p && (p.testID === testID || p.nativeID === testID)) { target = fiber; return; }
      var child = fiber.child;
      while (child) { findByTestID(child); child = child.sibling; }
    }
    forEachRootFiber(function(rootFiber) { findByTestID(rootFiber); return target; });
    if (!target) return JSON.stringify({ __agent_error: 'Component not found: ' + testID });

    function valueOf(fiber) {
      var p = fiber && fiber.memoizedProps;
      return p && typeof p.value === 'string' ? p.value : null;
    }
    var direct = valueOf(target);
    if (direct !== null) return JSON.stringify({ value: direct, controlled: true });

    var found = [], visited = 0;
    (function walk(node, depth) {
      if (!node || depth > 16 || visited > 200 || found.length > 1) return;
      visited++;
      var v = valueOf(node);
      if (v !== null) found.push(v);
      if (node.child) walk(node.child, depth + 1);
      if (node.sibling) walk(node.sibling, depth);
    })(target.child, 1);

    if (found.length === 1) return JSON.stringify({ value: found[0], controlled: true });
    return JSON.stringify({ value: null, controlled: false });
  }

  // Task 8 — bounded fiber.return ancestor walk producing the bundle's
  // anchor trail. Mirrors the setFieldValue ancestor walk (cap + .return
  // chain) at the ANCESTOR_DEPTH_CAP loop, but records nearest-first
  // {testID, text, relation, depth, provenance} for any ancestor that
  // carries a testID/nativeID OR an explicit accessibility label. Provenance
  // is "authored-testID" when the ancestor has testID/nativeID, else "text"
  // (from __ariaLabel — aria-label / accessibilityLabel / labelledBy only,
  // NOT recursive child text, so bare host Text nodes are skipped). Bare
  // wrapper Views with no anchor signal are skipped automatically.
  function __collectAnchors(fiber) {
    var ANCHOR_DEPTH_CAP = 8;
    var anchors = [];
    if (!fiber) return anchors;
    var ancestor = fiber.return;
    var depth = 1;
    while (ancestor && depth <= ANCHOR_DEPTH_CAP) {
      var aProps = ancestor.memoizedProps;
      var testID = aProps && typeof aProps === 'object'
        ? (aProps.testID || aProps.nativeID)
        : undefined;
      var name;
      try { name = __ariaLabel(ancestor); } catch (_) { name = undefined; }
      if (testID || (name && name.length > 0)) {
        var entry = { relation: 'childOf', depth: depth };
        if (testID) {
          entry.testID = String(testID);
          entry.provenance = 'authored-testID';
        } else {
          entry.text = String(name);
          entry.provenance = 'text';
        }
        anchors.push(entry);
      }
      ancestor = ancestor.return;
      depth++;
    }
    return anchors;
  }

  // Task 7 — fiber-returning twin of resolveLadder. resolveLadder serializes
  // to JSON (no live fiber escapes); interact() needs the fiber itself to
  // press, so it re-resolves here under the SAME predicates and returns the
  // single match (or null when 0/>1 — interact() has already surfaced the
  // JSON error before calling this). Uses the internal hostKind() (the
  // public surface name is __hostKind, but inside the IIFE the function is
  // hostKind — same as __role's own call site).
  // matchDeepestOnly (RNTL parity; found by live-device testing): a real RN
  // element renders as a COMPOSITE fiber (Text/TextInput) AND its child HOST
  // fiber (RCTText/RCTSinglelineTextInputView), both of which pass
  // hostKind/byText/byPlaceholder — so every element would match twice and
  // fail-close as Ambiguous on-device. Drop any match that is an ancestor (via
  // .return) of another match, keeping the deepest. Genuinely-distinct siblings
  // are NOT collapsed (they stay legitimately Ambiguous).
  // Collapse only COMPOSITE+HOST duplicates of the SAME element — NOT arbitrary
  // ancestor/descendant matches. A real RN element is a composite fiber
  // (Text/TextInput/Pressable, object type) plus its host primitive
  // (RCTText/RCTSinglelineTextInputView/RCTView, string type); both can satisfy
  // the same selector. But two DISTINCT nested components (e.g. an outer card
  // button and an inner button both named "Settings") must stay AMBIGUOUS, not
  // silently collapse to the inner one (Codex review). Rule: for each HOST
  // match B, drop its NEAREST matching ancestor iff that ancestor is a composite
  // — i.e. B's own wrapper. A host-ancestor (distinct nested host) or a composite
  // with no host match below it is preserved, so real nested matches stay
  // ambiguous.
  function __deepestOnly(arr) {
    if (arr.length < 2) return arr;
    function tid(f) { var p = f.memoizedProps; return (p && (p.testID || p.nativeID)) || null; }
    var inSet = new WeakSet();
    for (var i = 0; i < arr.length; i++) inSet.add(arr[i]);
    var drop = new WeakSet();
    for (var j = 0; j < arr.length; j++) {
      var b = arr[j];
      var bHost = typeof b.type === 'string';
      var bTid = tid(b);
      var p = b.return;
      var guard = 0;
      while (p && guard++ < 10000) {
        if (inSet.has(p)) {
          // Nearest matching ancestor A of B. Drop A only when A and B are the
          // SAME element: (1) A is B's composite wrapper (A composite, B host),
          // or (2) A and B share the same testID/nativeID (one element whose id
          // propagated across nested fibers, e.g. a tab button). A distinct
          // nested match — a host ancestor, or a different id — is preserved so
          // real nested matches stay Ambiguous (Codex review).
          var aComposite = typeof p.type !== 'string';
          if ((aComposite && bHost) || (bTid && tid(p) === bTid)) drop.add(p);
          break;
        }
        p = p.return;
      }
    }
    var kept = [];
    for (var k = 0; k < arr.length; k++) {
      if (!drop.has(arr[k])) kept.push(arr[k]);
    }
    return kept;
  }

  // RNTL isAccessibilityElement: byRole only matches true accessibility
  // elements. A plain View with a role prop but accessible undefined is NOT
  // one — only Text/TextInput/Switch (and Image with alt) qualify by default;
  // anything else must opt in with accessible={true}. (Codex review.)
  function __isA11yElement(fiber) {
    if (!fiber) return false;
    var props = fiber.memoizedProps;
    var hk = hostKind(fiber);
    if (hk === 'image' && props && props.alt !== undefined) return true;
    if (props && props.accessible !== undefined) return props.accessible === true;
    return hk === 'text' || hk === 'textinput' || hk === 'switch';
  }

  function __resolveLadderFiber(spec) {
    var wantRole = typeof spec.role === 'string' ? normalizeRole(spec.role) : null;
    var wantName = typeof spec.name === 'string' ? spec.name : null;
    var wantText = typeof spec.text === 'string' ? spec.text : null;
    var wantPlaceholder = typeof spec.placeholder === 'string' ? spec.placeholder : null;
    var includeHidden = spec.includeHidden === true;
    var exact = spec.exact === true;

    function isCand(fiber) {
      if (typeof spec.testID === 'string') {
        var tpi = fiber.memoizedProps;
        return !!tpi && (tpi.testID === spec.testID || tpi.nativeID === spec.testID);
      }
      if (wantRole !== null) {
        // byRole only matches true accessibility elements (RNTL
        // isAccessibilityElement): excludes a plain View with a role prop but
        // accessible undefined, and honors accessible={false}. (Codex review.)
        if (!__isA11yElement(fiber)) return false;
        if (__role(fiber) !== wantRole) return false;
        if (wantName === null) return true;
        var an = __accessibleName(fiber);
        return an != null && __match(an, { value: wantName, exact: exact });
      }
      if (wantText !== null) {
        if (hostKind(fiber) !== 'text') return false;
        var tn = __refTextContent(fiber);
        return !!tn && __match(tn, { value: wantText, exact: exact });
      }
      if (wantPlaceholder !== null) {
        if (hostKind(fiber) !== 'textinput') return false;
        var p = fiber.memoizedProps;
        var ph = p && typeof p.placeholder === 'string' ? p.placeholder : null;
        return ph !== null && __match(ph, { value: wantPlaceholder, exact: exact });
      }
      return false;
    }

    var out = [];
    var n = 0;
    var lfTrunc = false;
    var lfRoots = 0;
    forEachRootFiber(function () { lfRoots++; return null; });
    var lfBudget = Math.min(40000, 8000 * Math.max(1, lfRoots));
    var lfStart = Date.now();
    forEachRootFiber(function (rootFiber) {
      (function walk(node) {
        var current = node;
        while (current) {
          n++;
          if (n > lfBudget || (Date.now() - lfStart) > 3000) { lfTrunc = true; return; }
          if (isCand(current) && (includeHidden || !__hidden(current))) out.push(current);
          if (current.child) walk(current.child);
          current = current.sibling;
        }
      })(rootFiber);
      return null;
    });
    if (lfTrunc) return null; // fail closed — never press a partial-walk pick
    var dedupOut = __deepestOnly(out);
    return dedupOut.length === 1 ? dedupOut[0] : null;
  }

  // Task 7 — declarative ladder resolver. Composes the pure helpers
  // (__match/__role/__accessibleName/__hidden/hostKind) into byRole,
  // byText and byPlaceholder predicates. COLLECT ALL matches across every
  // renderer (no early return) so duplicate targets surface as Ambiguous
  // rather than a silent pick — mirrors interact()'s label-tier ambiguous
  // shape (:1259-1266). bundle.bounds is null in Phase 1 (no in-page
  // measure primitive yet).
  function resolveLadder(specJson) {
    var spec;
    try {
      spec = typeof specJson === 'string' ? JSON.parse(specJson) : (specJson || {});
    } catch (e) {
      return JSON.stringify({ found: false, error: 'Invalid spec JSON' });
    }

    var wantRole = typeof spec.role === 'string' ? normalizeRole(spec.role) : null;
    var wantName = typeof spec.name === 'string' ? spec.name : null;
    var wantText = typeof spec.text === 'string' ? spec.text : null;
    var wantPlaceholder = typeof spec.placeholder === 'string' ? spec.placeholder : null;
    var includeHidden = spec.includeHidden === true;
    var exact = spec.exact === true;

    function nameMatches(fiber) {
      if (wantName === null) return true;
      var an = __accessibleName(fiber);
      if (an === undefined || an === null) return false;
      return __match(an, { value: wantName, exact: exact });
    }

    // byText: a host Text node whose own visible TEXT CONTENT __match-es — NOT
    // its accessible name (which gives accessibilityLabel/aria-label precedence
    // over the rendered text; Codex review). Use __refTextContent (the
    // getTextContent port); accessible names stay for byRole/name.
    function textContentMatches(fiber) {
      var tc = __refTextContent(fiber);
      if (!tc) return false;
      return __match(tc, { value: wantText, exact: exact });
    }

    function placeholderOf(fiber) {
      var p = fiber && fiber.memoizedProps;
      return p && typeof p.placeholder === 'string' ? p.placeholder : null;
    }

    function isCandidate(fiber) {
      if (typeof spec.testID === 'string') {
        var tpc = fiber.memoizedProps;
        return !!tpc && (tpc.testID === spec.testID || tpc.nativeID === spec.testID);
      }
      if (wantRole !== null) {
        // byRole only matches true accessibility elements (RNTL
        // isAccessibilityElement): excludes a plain View with a role prop but
        // accessible undefined, and honors accessible={false}. (Codex review.)
        if (!__isA11yElement(fiber)) return false;
        if (__role(fiber) !== wantRole) return false;
        return nameMatches(fiber);
      }
      if (wantText !== null) {
        if (hostKind(fiber) !== 'text') return false;
        return textContentMatches(fiber);
      }
      if (wantPlaceholder !== null) {
        if (hostKind(fiber) !== 'textinput') return false;
        var ph = placeholderOf(fiber);
        return ph !== null && __match(ph, { value: wantPlaceholder, exact: exact });
      }
      return false;
    }

    var matched = [];
    var visitCount = 0;
    var ladderTrunc = false;
    // Budget scales with renderer count + a wall-clock guard (mirrors the legacy
    // findFiber path). On trip we FAIL CLOSED instead of evaluating a partial
    // match set (Codex review: a duplicate past the cap could otherwise leave
    // matched.length===1 and silently press the wrong element).
    var ladderRoots = 0;
    forEachRootFiber(function () { ladderRoots++; return null; });
    var ladderBudget = Math.min(40000, 8000 * Math.max(1, ladderRoots));
    var ladderStart = Date.now();

    forEachRootFiber(function (rootFiber) {
      (function walk(node) {
        var current = node;
        while (current) {
          visitCount++;
          if (visitCount > ladderBudget || (Date.now() - ladderStart) > 3000) {
            ladderTrunc = true;
            return;
          }
          if (isCandidate(current)) {
            if (includeHidden || !__hidden(current)) matched.push(current);
          }
          if (current.child) walk(current.child);
          current = current.sibling;
        }
      })(rootFiber);
      return null; // collect-all — never short-circuit
    });

    if (ladderTrunc) {
      return JSON.stringify({
        found: false,
        error: 'Resolution truncated',
        truncated: true,
        scanned: visitCount,
        hint: 'Too many fibers scanned before a unique match — scope with a more specific selector or a container, or add a testID.'
      });
    }

    // matchDeepestOnly: collapse composite+host fiber pairs (see __deepestOnly)
    // so one on-device element is one match, not a false Ambiguous.
    matched = __deepestOnly(matched);

    function describe(fiber) {
      var props = fiber.memoizedProps || {};
      var dt = (fiber.type && (typeof fiber.type === 'string'
        ? fiber.type
        : (fiber.type.displayName || fiber.type.name))) || 'Unknown';
      return {
        component: dt,
        testID: props.testID,
        role: __role(fiber),
        accessibleName: __accessibleName(fiber),
      };
    }

    function hintFor() {
      var bits = [];
      if (wantRole !== null) bits.push('role="' + wantRole + '"');
      if (wantName !== null) bits.push('name="' + wantName + '"');
      if (wantText !== null) bits.push('text="' + wantText + '"');
      if (wantPlaceholder !== null) bits.push('placeholder="' + wantPlaceholder + '"');
      return bits.join(' ');
    }

    if (matched.length === 0) {
      return JSON.stringify({
        found: false,
        error: 'Component not found',
        hint: 'No accessible component matched ' + hintFor() +
          (includeHidden ? '' : ' (hidden elements excluded — pass includeHidden:true to include them)') +
          '. Use cdp_component_tree to verify it is mounted, or pass a testID.'
      });
    }

    if (matched.length > 1) {
      var descriptors = [];
      for (var di = 0; di < matched.length && di < 10; di++) descriptors.push(describe(matched[di]));
      return JSON.stringify({
        found: false,
        error: 'Ambiguous component match',
        count: matched.length,
        matches: descriptors,
        hint: 'Add a testID'
      });
    }

    var target = matched[0];
    var tprops = target.memoizedProps || {};
    var bundle = {
      testID: tprops.testID,
      text: hostKind(target) === 'text' ? __refTextContent(target) : undefined,
      accessibleName: __accessibleName(target),
      role: __role(target),
      placeholder: placeholderOf(target) || undefined,
      disabled: (tprops.disabled === true)
        || (tprops['aria-disabled'] === true)
        || !!(tprops.accessibilityState && tprops.accessibilityState.disabled),
      bounds: null,
      anchors: __collectAnchors(target)
    };
    return JSON.stringify({ found: true, bundle: bundle });
  }

  // Port of RNTL getDefaultNormalizer (matches.ts:37-47): trim + collapse
  // whitespace runs to a single space. Does NOT lowercase — case-insensitivity
  // for non-exact string matching lives in __match's compare (RNTL matches.ts:24),
  // NOT here. Kept deliberately separate from norm() (line ~1114) which DOES
  // lowercase for the legacy interact() label tiers.
  function __matchNormalize(v) {
    return String(v).replace(/^\\s+|\\s+$/g, '').replace(/\\s+/g, ' ');
  }

  // Port of RNTL matches() (matches.ts:9-30) collapsed to a single matcher
  // object: {value,exact?} for strings, {regexSource,regexFlags?} for regexes.
  // Returns false on non-string text or malformed matcher. Regex is compiled in
  // try/catch, the global flag is stripped so lastIndex never carries across
  // calls, and the candidate is length-capped to bound catastrophic backtracking.
  var __MATCH_MAX_LEN = 10000;
  function __match(text, matcher) {
    if (typeof text !== 'string') return false;
    if (!matcher || typeof matcher !== 'object') return false;
    var normalizedText = __matchNormalize(text);
    if (normalizedText.length > __MATCH_MAX_LEN) {
      normalizedText = normalizedText.slice(0, __MATCH_MAX_LEN);
    }
    if (typeof matcher.regexSource === 'string') {
      try {
        var flags = (matcher.regexFlags || '').replace(/g/g, '');
        var re = new RegExp(matcher.regexSource, flags);
        re.lastIndex = 0;
        return re.test(normalizedText);
      } catch (_) {
        return false;
      }
    }
    if (typeof matcher.value !== 'string') return false;
    var normalizedMatcher = __matchNormalize(matcher.value);
    if (matcher.exact) {
      return normalizedText === normalizedMatcher;
    }
    return normalizedText.toLowerCase().indexOf(normalizedMatcher.toLowerCase()) >= 0;
  }

  // ── Accessibility role (RNTL getRole + normalizeRole port) ──────────────
  // Port of react-native-testing-library accessibility.ts:117-146. Order:
  // explicit role prop → accessibilityRole (image→img) → host Text → none.
  // Deliberately NOT the digest inferRole (defaults Pressable/Touchable to
  // button); see gh-task3-role.test.js divergence guard.
  function normalizeRole(role) {
    if (role === 'image') return 'img';
    return role;
  }

  function __role(fiber) {
    if (!fiber) return 'none';
    var props = fiber.memoizedProps;
    var explicitRole = props && typeof props === 'object'
      ? (props.role != null ? props.role : props.accessibilityRole)
      : null;
    if (explicitRole) return normalizeRole(String(explicitRole));
    if (hostKind(fiber) === 'text') return 'text';
    return 'none';
  }

  // ── Task 4: accessible-name computation (port of RNTL accessibility.ts:152-318) ──
  // Whitespace normalizer that preserves case (distinct from norm() at the
  // interact() tier matcher which lowercases). Trim + collapse ws runs to one.
  function __anNorm(s) {
    return String(s).replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '');
  }

  // getAriaLabelledByIds: aria-labelledby (string) -> [id]; accessibilityLabelledBy
  // array -> as-is; accessibilityLabelledBy string -> [id]; else [].
  function __ariaLabelledByIds(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    var ariaLabelledBy = props['aria-labelledby'];
    if (typeof ariaLabelledBy === 'string') return [ariaLabelledBy];
    var accLabelledBy = props.accessibilityLabelledBy;
    if (Array.isArray(accLabelledBy)) return accLabelledBy;
    if (typeof accLabelledBy === 'string') return [accLabelledBy];
    return [];
  }

  // Find the first fiber in ANY root whose memoizedProps.nativeID === id.
  function __findByNativeID(id) {
    return forEachRootFiber(function(rootFiber) {
      var stack = [rootFiber];
      var guard = 0;
      while (stack.length) {
        if (++guard > 20000) return null;
        var f = stack.pop();
        if (!f) continue;
        if (f.memoizedProps && f.memoizedProps.nativeID === id) return f;
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
      return null;
    });
  }

  // DEVIATION from RNTL draft (port of getTextContent, NOT computeAccessibleName):
  // concatenate the referenced node's descendant host-text strings. A text node
  // carries its raw string as memoizedProps (harness) or has tag 6 (live fiber).
  // labelledBy refs resolve to THIS, never to __accessibleName — so a malformed
  // labelledBy cycle (A->B->A) cannot drive infinite recursion. The visit cap is
  // defense-in-depth against pathological / self-referential trees.
  function __refTextContent(fiber) {
    if (!fiber) return '';
    var parts = [];
    var visited = 0;
    (function collect(node, depth) {
      if (!node || depth > 40 || visited > 20000) return;
      visited++;
      if (typeof node.memoizedProps === 'string') {
        if (node.memoizedProps) parts.push(node.memoizedProps);
        return;
      }
      if (node.tag === 6 && typeof node.memoizedProps === 'string') {
        if (node.memoizedProps) parts.push(node.memoizedProps);
        return;
      }
      var child = node.child;
      while (child) { collect(child, depth + 1); child = child.sibling; }
    })(fiber, 0);
    return __anNorm(parts.join(' '));
  }

  // computeAriaLabel: labelledBy refs (resolved to TEXT CONTENT — see
  // __refTextContent) win; then explicit aria-label/accessibilityLabel; then
  // host image alt. A ref resolving to empty text is filtered out of labelTexts
  // (matches RNTL filtering undefined), so it falls through to the label branch.
  function __ariaLabel(fiber) {
    var ids = __ariaLabelledByIds(fiber);
    if (ids.length > 0) {
      var labelTexts = [];
      for (var i = 0; i < ids.length; i++) {
        var ref = __findByNativeID(ids[i]);
        if (ref) {
          var refText = __refTextContent(ref);
          if (refText) labelTexts.push(refText);
        }
      }
      if (labelTexts.length > 0) {
        return __anNorm(labelTexts.join(' '));
      }
    }

    var props = (fiber && fiber.memoizedProps) || {};
    var explicit = props['aria-label'];
    if (explicit === undefined || explicit === null) explicit = props.accessibilityLabel;
    if (explicit) return explicit;

    if (hostKind(fiber) === 'image' && props.alt) return props.alt;

    return undefined;
  }

  // joinAccessibleNameParts: inline host-text neighbours join with '' else ' '.
  function __joinNameParts(parts, inline) {
    var out = '';
    for (var i = 0; i < parts.length; i++) {
      if (i === 0) { out = parts[i].text; continue; }
      var prev = parts[i - 1];
      var sep = (inline && prev.isInlineText && parts[i].isInlineText) ? '' : ' ';
      out = out + sep + parts[i].text;
    }
    return out;
  }

  // computeAccessibleName: aria-label first; then host textinput placeholder
  // (root only); then recurse children, joining inline host-text with ''. The
  // child-name recursion below (correct RNTL behavior) stays — only labelledBy
  // ref resolution uses text content (see __ariaLabel / __refTextContent).
  function __accessibleName(fiber, root) {
    if (!fiber) return undefined;
    var label = __ariaLabel(fiber);
    if (label) return label;

    var props = fiber.memoizedProps || {};
    if (hostKind(fiber) === 'textinput' && props.placeholder && root !== false) {
      return props.placeholder;
    }

    var parts = [];
    var child = fiber.child;
    while (child) {
      // A text node's memoizedProps is the raw string (harness / live tag-6 fiber).
      if (typeof child.memoizedProps === 'string') {
        if (child.memoizedProps) {
          parts.push({ text: child.memoizedProps, isInlineText: true });
        }
      } else {
        var childLabel = __accessibleName(child, false);
        if (childLabel) {
          parts.push({ text: childLabel, isInlineText: hostKind(child) === 'text' });
        }
      }
      child = child.sibling;
    }

    var joined = __joinNameParts(parts, hostKind(fiber) === 'text');
    return joined ? joined : undefined;
  }

  // ── Task 5: accessibility "hidden" port (RNTL isHiddenFromAccessibility +
  // isSubtreeInaccessible). No StyleSheet.flatten in-page → flatten manually.
  // Walks fiber.return (live fibers) not instance.parent. opacity:0 is NOT
  // hidden (RNTL accessibility.ts:73). Per-call cache WeakMap dropped (YAGNI).
  function flattenStyle(style) {
    var out = {};
    if (style == null) return out;
    if (Array.isArray(style)) {
      for (var i = 0; i < style.length; i++) {
        var part = flattenStyle(style[i]);
        for (var k in part) if (part.hasOwnProperty(k)) out[k] = part[k];
      }
      return out;
    }
    if (typeof style === 'object') {
      for (var key in style) if (style.hasOwnProperty(key)) out[key] = style[key];
    }
    return out;
  }

  // True if \`fiber\` itself is an inaccessible-subtree root.
  function isSubtreeInaccessible(fiber) {
    var props = (fiber && fiber.memoizedProps) || {};
    if (props['aria-hidden']) return true;
    if (props.accessibilityElementsHidden) return true;
    if (props.importantForAccessibility === 'no-hide-descendants') return true;

    var flat = flattenStyle(props.style);
    if (flat.display === 'none') return true;

    // iOS: a host sibling marked aria-modal / accessibilityViewIsModal hides
    // this subtree. Siblings = children of fiber.return other than fiber.
    var parent = fiber && fiber.return;
    if (parent && parent.child) {
      for (var sib = parent.child; sib; sib = sib.sibling) {
        if (sib === fiber) continue;
        var sp = sib.memoizedProps;
        if (sp && (sp['aria-modal'] || sp.accessibilityViewIsModal)) return true;
      }
    }
    return false;
  }

  function __hidden(fiber) {
    if (fiber == null) return true;
    var current = fiber;
    var guard = 0;
    while (current && guard < 1000) {
      if (isSubtreeInaccessible(current)) return true;
      current = current.return;
      guard++;
    }
    return false;
  }

  // #379: JS-first keyboard dismissal for the KEYBOARD_OCCLUDED auto-heal.
  // Deterministic (no gestures, no QuickPath corruption): prefer the RN
  // Keyboard module; fall back to blurring the focused TextInput host
  // instance (RN attaches isFocused()/blur() to it), which resigns first
  // responder / hides the IME on both platforms.
  function dismissKeyboard() {
    try {
      var method = null;
      try {
        var RN = require('react-native');
        if (RN && RN.Keyboard && typeof RN.Keyboard.dismiss === 'function') {
          RN.Keyboard.dismiss();
          method = 'keyboard-module';
        }
      } catch (e) { /* require-by-name unavailable (bridgeless/Metro) */ }
      if (!method) {
        var blurred = 0;
        var scanned = 0;
        forEachRootFiber(function (rootFiber) {
          var stack = [rootFiber];
          while (stack.length) {
            if (++scanned > 20000) return true; // bounded walk, stop all roots
            var f = stack.pop();
            if (!f) continue;
            var sn = f.stateNode;
            if (sn && typeof sn.isFocused === 'function' && typeof sn.blur === 'function') {
              try {
                if (sn.isFocused()) {
                  sn.blur();
                  blurred++;
                }
              } catch (e) {}
            }
            if (f.child) stack.push(f.child);
            if (f.sibling) stack.push(f.sibling);
          }
          return null;
        });
        if (blurred > 0) method = 'blur-focused-input';
      }
      if (!method) {
        return JSON.stringify({
          dismissed: false,
          reason: 'no focused input found and Keyboard module unavailable'
        });
      }
      return JSON.stringify({ dismissed: true, method: method });
    } catch (e) {
      return JSON.stringify({ dismissed: false, error: (e && e.message) || String(e) });
    }
  }

  // Public API
  globalThis.__RN_AGENT = {
    __v: __HELPERS_VERSION__,
    dismissKeyboard: dismissKeyboard,
    getTree: getTree,
    getNavState: getNavState,
    getNavGraph: getNavGraph,
    navigateTo: navigateTo,
    getStoreState: getStoreState,
    getComponentState: getComponentState,
    readInputValue: readInputValue,
    dispatchAction: dispatchAction,
    getErrors: getErrors,
    clearErrors: clearErrors,
    getConsole: getConsole,
    clearConsole: clearConsole,
    interact: interact,
    resolveLadder: resolveLadder,
    __collectAnchors: __collectAnchors,
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
    __hidden: __hidden,
    __accessibleName: __accessibleName,
    __match: __match,
    __hostKind: hostKind,
    __role: __role,
    isReady: function() {
      // B145: ready when ANY renderer has at least one root fiber. The
      // single-renderer short-circuit from findActiveRenderer would return
      // true as soon as LogBox mounted — before the app tree was ready.
      return findAllRootFibers().length > 0;
    },
    getAppInfo: function() {
      try {
        var info = {
          __DEV__: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
          hermes: typeof HermesInternal !== 'undefined',
          platform: null,
          version: null,
          rnVersion: null,
          dimensions: null
        };
        // B44 fix: try TurboModule first (works in Bridgeless), then require() fallback
        try {
          if (typeof __turboModuleProxy === 'function') {
            var pc = __turboModuleProxy('PlatformConstants');
            if (pc) {
              info.platform = pc.OS || pc.interfaceIdiom || null;
              info.version = pc.osVersion || pc.Version || null;
              info.rnVersion = pc.reactNativeVersion || null;
            }
          }
        } catch(e) {}
        // Fallback: require() works in Classic bridge mode
        if (!info.platform) {
          try {
            var RN = require('react-native');
            info.platform = RN.Platform.OS;
            info.version = RN.Platform.Version;
            info.dimensions = RN.Dimensions.get('window');
          } catch(e) {}
        }
        if (!info.rnVersion) {
          try {
            info.rnVersion = require('react-native/Libraries/Core/ReactNativeVersion').version;
          } catch(e) {}
        }
        // Dimensions fallback via Dimensions module (may be available even when require fails)
        if (!info.dimensions) {
          try {
            if (typeof globalThis.nativeModuleProxy !== 'undefined') {
              var dims = globalThis.nativeModuleProxy.DeviceInfo && globalThis.nativeModuleProxy.DeviceInfo.Dimensions;
              if (dims && dims.window) info.dimensions = dims.window;
            }
          } catch(e) {}
        }
        // M10 / Phase 110: architecture detection. Fabric wins on "both present"
        // (transient interop state); __fbBatchedBridge alone → classic bridge;
        // neither → unknown. See docs/DECISIONS.md D667.
        try {
          var fabric = typeof globalThis.nativeFabricUIManager === 'object'
            && globalThis.nativeFabricUIManager !== null;
          var bridge = typeof globalThis.__fbBatchedBridge === 'object'
            && globalThis.__fbBatchedBridge !== null;
          info.architecture = fabric ? 'new' : (bridge ? 'old' : 'unknown');
        } catch (e) {
          info.architecture = 'unknown';
        }
        return JSON.stringify(info);
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    }
  };
})();
`;
export const NETWORK_HOOK_SCRIPT = `
(function() {
  if (globalThis.__RN_AGENT_NETWORK_HOOK__) return;
  globalThis.__RN_AGENT_NETWORK_HOOK__ = true;

  // D597: Response body cache for hook mode — enables cdp_network_body on RN < 0.83
  var bodyCache = new Map();
  var MAX_BODIES = 50;
  globalThis.__RN_AGENT_RESPONSE_BODIES__ = bodyCache;

  var origFetch = globalThis.fetch;
  globalThis.fetch = function(url, opts) {
    var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    var method = (opts && opts.method) || 'GET';
    var start = Date.now();

    if (globalThis.__RN_AGENT_NETWORK_CB__) {
      globalThis.__RN_AGENT_NETWORK_CB__('request', { id: id, method: method, url: String(url) });
    }

    try {
      return origFetch.apply(this, arguments).then(function(response) {
        if (globalThis.__RN_AGENT_NETWORK_CB__) {
          globalThis.__RN_AGENT_NETWORK_CB__('response', {
            id: id, status: response.status, duration_ms: Date.now() - start
          });
        }
        // Cache cloned response body for cdp_network_body
        try {
          response.clone().text().then(function(text) {
            if (bodyCache.size >= MAX_BODIES) {
              var oldest = bodyCache.keys().next().value;
              bodyCache.delete(oldest);
            }
            bodyCache.set(id, text);
          }).catch(function() {});
        } catch(e) {}
        return response;
      }).catch(function(err) {
        if (globalThis.__RN_AGENT_NETWORK_CB__) {
          globalThis.__RN_AGENT_NETWORK_CB__('response', {
            id: id, status: 0, duration_ms: Date.now() - start
          });
        }
        throw err;
      });
    } catch(syncErr) {
      if (globalThis.__RN_AGENT_NETWORK_CB__) {
        globalThis.__RN_AGENT_NETWORK_CB__('response', {
          id: id, status: 0, duration_ms: Date.now() - start
        });
      }
      throw syncErr;
    }
  };

  var OrigXHR = globalThis.XMLHttpRequest;
  if (OrigXHR) {
    var origOpen = OrigXHR.prototype.open;
    var origSend = OrigXHR.prototype.send;

    OrigXHR.prototype.open = function(method, url) {
      this.__rn_agent_method = method;
      this.__rn_agent_url = url;
      return origOpen.apply(this, arguments);
    };

    OrigXHR.prototype.send = function() {
      var self = this;
      var id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      var start = Date.now();
      var reported = false;

      function reportResponse(status) {
        if (reported) return;
        reported = true;
        if (globalThis.__RN_AGENT_NETWORK_CB__) {
          globalThis.__RN_AGENT_NETWORK_CB__('response', {
            id: id, status: status, duration_ms: Date.now() - start
          });
        }
      }

      if (globalThis.__RN_AGENT_NETWORK_CB__) {
        globalThis.__RN_AGENT_NETWORK_CB__('request', {
          id: id, method: self.__rn_agent_method || 'GET', url: String(self.__rn_agent_url || '')
        });
      }

      self.addEventListener('load', function() { reportResponse(self.status); });
      self.addEventListener('error', function() { reportResponse(0); });
      self.addEventListener('abort', function() { reportResponse(0); });
      self.addEventListener('timeout', function() { reportResponse(0); });

      return origSend.apply(this, arguments);
    };
  }
})();
`;
/**
 * Spec 2026-06-10-debugger-seat-optout Part 2: hook-mode network callback.
 * Pushes entries into an in-app ring buffer instead of console.log so the
 * shared console stream (Metro logs, user DevTools) stays clean. The bridge
 * drains the buffer on demand (cdp/net-hook-drain.ts). Idempotent: preserves
 * an existing buffer so reinjection doesn't lose undrained entries.
 */
export const NETWORK_CB_BUFFERED_SCRIPT = `
(function() {
  globalThis.__RN_AGENT_NET_BUF__ = globalThis.__RN_AGENT_NET_BUF__ || [];
  var MAX = 100;
  globalThis.__RN_AGENT_NETWORK_CB__ = function(type, data) {
    try {
      var buf = globalThis.__RN_AGENT_NET_BUF__;
      if (!Array.isArray(buf)) { buf = []; globalThis.__RN_AGENT_NET_BUF__ = buf; }
      buf.push({ t: type, d: data, ts: Date.now() });
      if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    } catch (e) {}
  };
})();
`;
// M8: readiness probe for waitForReact — must mirror findActiveRenderer's
// guard shape in INJECTED_HELPERS so setup.ts stops gating on a stale
// renderers-map check. If either diverges the gate becomes a silent no-op.
export const REACT_READY_PROBE_JS = `(function() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || typeof h.getFiberRoots !== 'function') return false;
  // Scan the same legacy 1..20 rendererID range as findActiveRenderer and
  // iterateAllRoots' fallback. Root-union scans can additionally enumerate the
  // hook registry; this standalone readiness probe remains bounded.
  for (var i = 1; i <= 20; i++) {
    try {
      var r = h.getFiberRoots(i);
      if (r && r.size > 0) return true;
    } catch (_) { /* one throwing renderer must not abort the readiness scan */ }
  }
  return false;
})()`;
export const MAX_RENDERER_IDS = 20;
export const EARLY_EXIT_EMPTY_STREAK = 3;
export function findAllRootFibersForTest(hook) {
    if (!hook || typeof hook.getFiberRoots !== 'function')
        return [];
    const out = [];
    let rendererIds = [];
    try {
        if (hook.renderers && typeof hook.renderers.keys === 'function') {
            const iterator = hook.renderers.keys();
            let step = iterator.next();
            while (!step.done) {
                const id = step.value;
                if (typeof id === 'number' && !rendererIds.includes(id))
                    rendererIds.push(id);
                step = iterator.next();
            }
        }
    }
    catch {
        rendererIds = [];
    }
    const usingRegisteredIds = rendererIds.length > 0;
    if (!usingRegisteredIds) {
        rendererIds = Array.from({ length: MAX_RENDERER_IDS }, (_, index) => index + 1);
    }
    let emptyStreak = 0;
    for (const ri of rendererIds) {
        try {
            const roots = hook.getFiberRoots(ri);
            if (roots && roots.size) {
                emptyStreak = 0;
                const it = roots.values();
                let step = it.next();
                while (!step.done) {
                    const r = step.value;
                    if (r && r.current)
                        out.push({ rendererId: ri, fiber: r.current });
                    step = it.next();
                }
            }
            else if (!usingRegisteredIds) {
                emptyStreak++;
                if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5)
                    return out;
            }
        }
        catch {
            if (!usingRegisteredIds)
                emptyStreak++;
        }
    }
    return out;
}
