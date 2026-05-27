export const INJECTED_HELPERS = `
(function() {
  var __HELPERS_VERSION__ = 22;
  if (globalThis.__RN_AGENT && globalThis.__RN_AGENT.__v === __HELPERS_VERSION__) return;
  if (globalThis.__RN_AGENT) delete globalThis.__RN_AGENT;

  // Issue #126 — renderer iteration cap. Was hard-coded 5; bumped to 20
  // with an early-exit-after-3-empty heuristic so the common case (1-3
  // renderers) still exits fast. Each getFiberRoots(N) call is a Map
  // lookup so iteration cost is negligible. Kept as a single constant
  // so all call sites stay in sync (multi-LLM review of issue #126
  // identified 5 hard-coded sites that previously drifted).
  var MAX_RENDERER_IDS = 20;
  var EARLY_EXIT_EMPTY_STREAK = 3;

  function findActiveRenderer() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || typeof hook.getFiberRoots !== 'function') return null;
    var emptyStreak = 0;
    for (var i = 1; i <= MAX_RENDERER_IDS; i++) {
      try {
        var roots = hook.getFiberRoots(i);
        if (roots && roots.size > 0) {
          return { rendererId: i, roots: roots };
        }
        emptyStreak++;
        if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && i >= 5) return null;
      } catch (_) {
        emptyStreak++;
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
  // conf 80) — a single bad renderer must not poison the union.
  //
  // Task 4 will add an extra-roots step here that consults
  // globalThis.__RN_AGENT_EXTRA_ROOTS__ AFTER the native renderer loop
  // so user-registered portals stay lower priority than React's own
  // registry. Not in this commit — refactor isolated from new behavior
  // for cleaner bisects.
  function iterateAllRoots(cb) {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (hook && typeof hook.getFiberRoots === 'function') {
      var emptyStreak = 0;
      for (var ri = 1; ri <= MAX_RENDERER_IDS; ri++) {
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
          } else {
            emptyStreak++;
            if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) break;
          }
        } catch (_) {
          emptyStreak++;
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
    } catch (_) { /* swallow — resolver bug must not break iteration */ }
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

    var renderer = findActiveRenderer();
    if (!renderer) {
      return JSON.stringify({ error: 'React DevTools hook not available or no fiber roots — app may still be loading' });
    }

    var root = renderer.roots.values().next().value;
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
      if (!fiber || depth > limit || vis.has(fiber)) return null;
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
        result.children = children.length > 20
          ? children.slice(0, 10).concat([{ _truncated: (children.length - 10) + ' more' }])
          : children;
      }

      return result;
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
      if (matchFibers.length === 0) {
        return JSON.stringify({ tree: null, totalNodes: scanned, rootsSeeded: allRoots.length });
      }

      var matches = [];
      for (var mi = 0; mi < matchFibers.length && mi < 10; mi++) {
        var subtreeVis = new WeakSet();
        var subtree = walkSubtree(matchFibers[mi], 0, maxDepth, subtreeVis);
        if (subtree) matches.push(subtree);
      }
      totalNodes = scanned;
      var tree = matches.length === 1 ? matches[0] : { matches: matches };
      var output = safeStringify({ tree: tree, totalNodes: totalNodes, rootsSeeded: allRoots.length }, 999999);
      if (output.length > 50000) {
        return safeStringify({ tree: matches[0] || null, totalNodes: totalNodes, rootsSeeded: allRoots.length, truncated: true });
      }
      return output;
    }

    // Unfiltered: standard walk with depth limit
    var tree = walkSubtree(root.current, 0, maxDepth, visited);
    var output = safeStringify({ tree: tree, totalNodes: totalNodes }, 999999);
    if (output.length > 50000) {
      return safeStringify({ error: 'Tree too large (' + output.length + ' chars). Use a filter parameter to scope the query.' });
    }
    return output;
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
    if (!selector) return JSON.stringify({ error: 'testID or accessibilityLabel is required' });

    var found = null;
    var findCount = 0;

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
        findCount++;
        if (findCount > 8000) return;
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
    forEachRootFiber(function(rootFiber) {
      if (!isLabelMatch && found) return found;
      findFiber(rootFiber);
      return isLabelMatch ? null : found;
    });

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
        props.onPress({ nativeEvent: {} });
        return JSON.stringify({ success: true, action: 'press', component: typeName, testID: selector });
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
            success: true,
            action: 'typeText',
            component: typeName,
            testID: selector,
            text: text,
            handlerCalled: p1Handler,
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

        return JSON.stringify({
          success: true,
          action: 'typeText',
          component: typeName,
          testID: selector,
          text: text,
          handlerCalled: picked.handler,
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
        success: true, action_executed: true,
        handler_error: (e && e.message || String(e)),
        component: typeName, testID: selector,
        hint: 'The action was dispatched but the handler threw. This may be intentional (e.g., error testing).'
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
          while (activeRoute.routes && activeRoute.index !== undefined) {
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

  // Public API
  globalThis.__RN_AGENT = {
    __v: __HELPERS_VERSION__,
    getTree: getTree,
    getNavState: getNavState,
    getNavGraph: getNavGraph,
    navigateTo: navigateTo,
    getStoreState: getStoreState,
    getComponentState: getComponentState,
    dispatchAction: dispatchAction,
    getErrors: getErrors,
    clearErrors: clearErrors,
    getConsole: getConsole,
    clearConsole: clearConsole,
    interact: interact,
    __extractFiberFromInstance: extractFiberFromInstance,
    __findAllRootFibers: findAllRootFibers,
    __forEachRootFiber: forEachRootFiber,
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

// M8: readiness probe for waitForReact — must mirror findActiveRenderer's
// guard shape in INJECTED_HELPERS so setup.ts stops gating on a stale
// renderers-map check. If either diverges the gate becomes a silent no-op.
export const REACT_READY_PROBE_JS = `(function() {
  var h = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!h || typeof h.getFiberRoots !== 'function') return false;
  for (var i = 1; i <= 5; i++) {
    var r = h.getFiberRoots(i);
    if (r && r.size > 0) return true;
  }
  return false;
})()`;

// B143: exported TS mirror of the in-IIFE `findAllRootFibers()` inside
// INJECTED_HELPERS. The in-IIFE copy MUST be kept in sync with this logic.
// Tests exercise this mirror; the IIFE version runs in Hermes as pure JS.
// See test/unit/component-tree-multi-renderer.test.js for the contract.
//
// Issue #126: bumped MAX_RENDERER_IDS from 5 → 20 with early-exit-after-3-empty
// heuristic so apps that register a renderer at id 6+ are no longer invisible.
export interface FiberLike { current?: unknown }
export interface RendererRootsLike {
  size: number;
  values(): Iterator<{ current?: unknown } | null | undefined>;
}
export interface DevToolsHookLike {
  getFiberRoots?: (rendererId: number) => RendererRootsLike | null | undefined;
}

export const MAX_RENDERER_IDS = 20;
export const EARLY_EXIT_EMPTY_STREAK = 3;

export function findAllRootFibersForTest(hook: DevToolsHookLike | null | undefined): Array<{ rendererId: number; fiber: unknown }> {
  if (!hook || typeof hook.getFiberRoots !== 'function') return [];
  const out: Array<{ rendererId: number; fiber: unknown }> = [];
  let emptyStreak = 0;
  for (let ri = 1; ri <= MAX_RENDERER_IDS; ri++) {
    try {
      const roots = hook.getFiberRoots(ri);
      if (roots && roots.size) {
        emptyStreak = 0;
        const it = roots.values();
        let step = it.next();
        while (!step.done) {
          const r = step.value;
          if (r && r.current) out.push({ rendererId: ri, fiber: r.current });
          step = it.next();
        }
      } else {
        emptyStreak++;
        if (emptyStreak >= EARLY_EXIT_EMPTY_STREAK && ri >= 5) return out;
      }
    } catch {
      emptyStreak++;
    }
  }
  return out;
}
