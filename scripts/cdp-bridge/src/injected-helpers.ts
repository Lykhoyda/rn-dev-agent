export const INJECTED_HELPERS = `
(function() {
  var __HELPERS_VERSION__ = 11;
  if (globalThis.__RN_AGENT && globalThis.__RN_AGENT.__v === __HELPERS_VERSION__) return;
  if (globalThis.__RN_AGENT) delete globalThis.__RN_AGENT;

  function findActiveRenderer() {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || hook.renderers.size === 0) return null;
    for (var entry of hook.renderers) {
      var id = entry[0];
      var roots = hook.getFiberRoots(id);
      if (roots && roots.size > 0) return { rendererId: id, roots: roots };
    }
    return null;
  }

  function safeStringify(obj, maxLen) {
    try {
      var seen = new WeakSet();
      var limit = maxLen || 50000;
      var str = JSON.stringify(obj, function(key, val) {
        try {
          if (typeof val === 'function') return '[Function]';
          if (typeof val === 'symbol') return val.toString();
          if (val instanceof Error) return { message: val.message, stack: val.stack };
          if (typeof val === 'object' && val !== null) {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
          }
          return val;
        } catch(e) { return '[Unserializable]'; }
      });
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

    if (hasErrorOverlay(root.current)) {
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

    // For filtered queries: BFS to find matches, then build compact subtrees
    if (filter) {
      var f = String(filter).toLowerCase();
      var matchFibers = [];
      var queue = [root.current];
      var seen = new WeakSet();
      var scanned = 0;
      var bfsStart = Date.now();
      while (queue.length > 0 && scanned < 2000 && (Date.now() - bfsStart) < 3000) {
        var fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        scanned++;
        var fname = getName(fiber);
        var ftid = fiber.memoizedProps && (fiber.memoizedProps.testID || fiber.memoizedProps.nativeID);
        var matchesName = fname && fname.toLowerCase().indexOf(f) >= 0;
        var matchesTestID = ftid && ftid.toLowerCase().indexOf(f) >= 0;
        if (matchesName || matchesTestID) matchFibers.push(fiber);
        var ch = fiber.child;
        while (ch) {
          queue.push(ch);
          ch = ch.sibling;
        }
      }

      if (matchFibers.length === 0) {
        return JSON.stringify({ tree: null, totalNodes: scanned });
      }

      var matches = [];
      for (var mi = 0; mi < matchFibers.length && mi < 10; mi++) {
        var subtreeVis = new WeakSet();
        var subtree = walkSubtree(matchFibers[mi], 0, maxDepth, subtreeVis);
        if (subtree) matches.push(subtree);
      }
      totalNodes = scanned;
      var tree = matches.length === 1 ? matches[0] : { matches: matches };
      var output = safeStringify({ tree: tree, totalNodes: totalNodes }, 999999);
      if (output.length > 50000) {
        return safeStringify({ tree: matches[0] || null, totalNodes: totalNodes, truncated: true });
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

    var renderer = findActiveRenderer();
    if (!renderer) return JSON.stringify({ error: 'No navigation state found' });

    var root = renderer.roots.values().next().value;

    function findNav(fiber, depth) {
      var current = fiber;
      while (current) {
        if ((depth || 0) > 30) return null;
        var name = current.type && (current.type.displayName || current.type.name);
        if (name === 'NavigationContainer' || name === 'ExpoRoot') {
          var s = current.memoizedState && current.memoizedState.memoizedState;
          if (s && s[0]) return s[0];
        }
        var found = findNav(current.child, (depth || 0) + 1);
        if (found) return found;
        current = current.sibling;
      }
      return null;
    }

    var navState = findNav(root && root.current);

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
        var renderer = findActiveRenderer();
        if (renderer) {
          var fiberRoot = renderer.roots.values().next().value;
          if (fiberRoot && fiberRoot.current) {
            var containerFibers = [];
            (function findContainers(fiber, d) {
              if (!fiber || d > 30) return;
              var fname = fiber.type && (fiber.type.displayName || fiber.type.name);
              if (fname === 'NavigationContainer' || fname === 'ExpoRoot') {
                containerFibers.push(fiber);
              }
              findContainers(fiber.child, d + 1);
              if (fiber.sibling) findContainers(fiber.sibling, d);
            })(fiberRoot.current, 0);

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

    if (!requestedType || requestedType === 'redux') {
      if (globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.getState) {
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

    if (!state) {
      var storeRenderer = findActiveRenderer();
      if (storeRenderer) {
        var root = storeRenderer.roots.values().next().value;

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

        var found = findStore(root && root.current);
        if (found) { state = found.store; storeType = found.type; }
      }
    }

    if (!state) {
      return JSON.stringify({
        __agent_error: 'No store found.',
        hint: 'For Zustand, add to app entry: if (__DEV__) global.__ZUSTAND_STORES__ = { myStore }',
        hint2: 'For Redux, the Provider is auto-detected. Check it is mounted.'
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

    if (!action) return JSON.stringify({ error: 'action is required' });
    if (!selector) return JSON.stringify({ error: 'testID or accessibilityLabel is required' });

    var renderer = findActiveRenderer();
    if (!renderer) {
      return JSON.stringify({ error: 'React DevTools hook not available or no fiber roots — app may still be loading' });
    }

    var found = null;
    var findCount = 0;

    function findFiber(fiber) {
      var current = fiber;
      while (current) {
        findCount++;
        if (findCount > 8000) return;
        var props = current.memoizedProps;
        if (props && props[matchField] === selector) {
          found = current;
          return;
        }
        if (current.child) findFiber(current.child);
        if (found) return;
        current = current.sibling;
      }
    }

    renderer.roots.forEach(function(root) {
      if (!found && root && root.current) findFiber(root.current);
    });

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
        if (typeof props.onChangeText === 'function') {
          props.onChangeText(text);
        }
        if (typeof props.onChange === 'function') {
          props.onChange({ nativeEvent: { text: text } });
        }
        if (typeof props.onChangeText !== 'function' && typeof props.onChange !== 'function') {
          return JSON.stringify({ error: 'Component has no onChangeText or onChange handler', component: typeName, testID: selector });
        }
        return JSON.stringify({ success: true, action: 'typeText', component: typeName, testID: selector, text: text });
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

    var store = null;
    if (globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.dispatch) {
      store = globalThis.__REDUX_STORE__;
    }

    if (!store) {
      var storeRenderer = findActiveRenderer();
      if (storeRenderer) {
        var storeRoot = storeRenderer.roots.values().next().value;
        function findDispatchStore(fiber, depth) {
          var current = fiber;
          while (current) {
            if ((depth || 0) > 30) return null;
            if (current.type && current.type.displayName === 'Provider' && current.memoizedProps && current.memoizedProps.store && current.memoizedProps.store.dispatch) {
              return current.memoizedProps.store;
            }
            var found = findDispatchStore(current.child, (depth || 0) + 1);
            if (found) return found;
            current = current.sibling;
          }
          return null;
        }
        store = findDispatchStore(storeRoot && storeRoot.current);
      }
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
    var renderer = findActiveRenderer();
    if (!renderer) return null;
    var found = null;
    renderer.roots.forEach(function(root) {
      if (found || !root || !root.current) return;
      var count = 0;
      var stack = [root.current];
      while (stack.length > 0 && !found && count < 5000) {
        var fiber = stack.pop();
        if (!fiber) continue;
        count++;
        var name = fiber.type && (fiber.type.displayName || fiber.type.name);
        if (name === 'NavigationContainer' || name === 'NavigationContainerInner') {
          var r = fiber.ref;
          if (r && typeof r === 'object' && r.current && typeof r.current.navigate === 'function') {
            found = r.current;
            break;
          }
          if (fiber.stateNode && typeof fiber.stateNode.navigate === 'function') {
            found = fiber.stateNode;
            break;
          }
        }
        if (fiber.sibling) stack.push(fiber.sibling);
        if (fiber.child) stack.push(fiber.child);
      }
    });
    return found;
  }

  function navigateTo(screen, params) {
    var ref = findNavRef();
    if (!ref) return JSON.stringify({ __agent_error: 'Navigation ref not found. Add globalThis.__NAV_REF__ = navigationRef in your app, or ensure NavigationContainer has a ref prop.' });

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
      return JSON.stringify({ navigated: true, screen: screen, method: 'fallback-navigate' });

    } catch(e) {
      return JSON.stringify({ __agent_error: 'Navigation failed: ' + (e && e.message || String(e)) });
    }
  }

  function getComponentState(testID) {
    if (!testID) return JSON.stringify({ __agent_error: 'testID is required' });
    var renderer = findActiveRenderer();
    if (!renderer) return JSON.stringify({ __agent_error: 'No active renderer' });
    var root = renderer.roots.values().next().value;
    if (!root || !root.current) return JSON.stringify({ __agent_error: 'No fiber root' });
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

    findByTestID(root.current);
    if (!targetFiber) return JSON.stringify({ __agent_error: 'Component not found: ' + testID });

    var compName = targetFiber.type && (targetFiber.type.displayName || targetFiber.type.name) || null;

    var hooks = [];
    var hookState = targetFiber.memoizedState;
    var limit = 20;
    while (hookState && limit-- > 0) {
      var hs = hookState.memoizedState;
      if (typeof hs === 'function') {
        hooks.push('[Function]');
      } else if (typeof hs === 'object' && hs !== null) {
        if (hs.current !== undefined) {
          hooks.push({ ref: hs.current !== null ? typeof hs.current : null });
        } else if (hs._formValues && hs._formState) {
          try {
            hooks.push({
              __type: 'react-hook-form',
              values: hs._formValues,
              errors: hs._formState.errors,
              isDirty: hs._formState.isDirty,
              isValid: hs._formState.isValid,
              isSubmitting: hs._formState.isSubmitting
            });
          } catch(e) { hooks.push('[RHF:unreadable]'); }
        } else {
          try { JSON.stringify(hs); hooks.push(hs); }
          catch(e) { hooks.push('[Circular]'); }
        }
      } else {
        hooks.push(hs);
      }
      hookState = hookState.next;
    }

    var propsObj = {};
    if (targetFiber.memoizedProps) {
      var pkeys = Object.keys(targetFiber.memoizedProps);
      for (var i = 0; i < pkeys.length; i++) {
        var v = targetFiber.memoizedProps[pkeys[i]];
        propsObj[pkeys[i]] = typeof v === 'function' ? '[Function]' : v;
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
    isReady: function() {
      return !!findActiveRenderer();
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
