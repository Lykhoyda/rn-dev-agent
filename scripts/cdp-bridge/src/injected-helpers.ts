export const INJECTED_HELPERS = `
(function() {
  if (globalThis.__RN_AGENT) return;

  function safeStringify(obj, maxLen) {
    var seen = new WeakSet();
    var str = JSON.stringify(obj, function(key, val) {
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'symbol') return val.toString();
      if (val instanceof Error) return { message: val.message, stack: val.stack };
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    if (str && str.length > (maxLen || 50000)) {
      return str.substring(0, maxLen || 50000) + '...[TRUNCATED]';
    }
    return str;
  }

  function getTree(maxDepth, filter) {
    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || hook.renderers.size === 0) {
      return JSON.stringify({ error: 'React DevTools hook not available' });
    }

    var rendererId = hook.renderers.keys().next().value;
    var roots = hook.getFiberRoots(rendererId);
    if (!roots || roots.size === 0) {
      return JSON.stringify({ error: 'No fiber roots — app may still be loading' });
    }

    var root = roots.values().next().value;
    var visited = new WeakSet();
    var totalNodes = 0;

    function hasErrorOverlay(fiber) {
      if (!fiber) return false;
      var name = fiber.type && (fiber.type.displayName || fiber.type.name);
      if (name === 'LogBox' || name === 'ErrorWindow' || name === 'RedBox') return true;
      return hasErrorOverlay(fiber.child);
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

    function walk(fiber, depth) {
      if (!fiber || depth > (maxDepth || 3) || visited.has(fiber)) return null;
      visited.add(fiber);
      totalNodes++;

      if (fiber.tag === 6 || typeof fiber.memoizedProps === 'string' || typeof fiber.memoizedProps === 'number') {
        return { text: String(fiber.memoizedProps) };
      }

      var name = getName(fiber);
      var testID = fiber.memoizedProps && (fiber.memoizedProps.testID || fiber.memoizedProps.accessibilityLabel || fiber.memoizedProps.nativeID);
      var isUserComponent = name && !name.startsWith('RCT') && /^[A-Z]/.test(name);

      var matchesFilter = true;
      if (filter) {
        var f = filter.toLowerCase();
        matchesFilter = (name && name.toLowerCase().indexOf(f) !== -1) ||
                        (testID && testID.toLowerCase().indexOf(f) !== -1);
      }

      var children = [];
      var child = fiber.child;
      while (child) {
        var node = walk(child, isUserComponent ? depth + 1 : depth);
        if (node) children.push(node);
        child = child.sibling;
      }

      if (!isUserComponent && !testID) {
        if (children.length === 1) return children[0];
        if (children.length === 0) return null;
        if (filter && !matchesFilter && children.length > 0) {
          return children.length === 1 ? children[0] : { _wrapper: true, children: children };
        }
        return { _wrapper: true, children: children };
      }

      if (filter && !matchesFilter && children.length === 0) return null;

      var result = { component: name };
      if (testID) result.testID = testID;

      if (isUserComponent && fiber.memoizedProps) {
        var props = {};
        var entries = Object.entries(fiber.memoizedProps);
        for (var i = 0; i < entries.length; i++) {
          var k = entries[i][0], v = entries[i][1];
          if (k === 'children' || k === 'testID' || k === 'style') continue;
          if (typeof v === 'function') { props[k] = '[Function]'; continue; }
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
              states.push(hookState.memoizedState);
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

    var tree = walk(root.current, 0);
    var output = JSON.stringify({ tree: tree, totalNodes: totalNodes });
    if (output.length > 50000) {
      return JSON.stringify({ error: 'Tree too large (' + output.length + ' bytes). Use a filter parameter to scope the query.' });
    }
    return output;
  }

  function getNavState() {
    try {
      var state = globalThis.__expo_router_state__;
      if (state) return JSON.stringify(state);
    } catch(e) {}

    try {
      var devtools = globalThis.__REACT_NAVIGATION_DEVTOOLS__;
      if (devtools && devtools.getNavState) return JSON.stringify(devtools.getNavState());
    } catch(e) {}

    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ error: 'No navigation state found' });

    var rendererId = hook.renderers.keys().next().value;
    var roots = hook.getFiberRoots(rendererId);
    var root = roots && roots.values().next().value;

    function findNav(fiber) {
      if (!fiber) return null;
      var name = fiber.type && (fiber.type.displayName || fiber.type.name);
      if (name === 'NavigationContainer' || name === 'ExpoRoot') {
        var s = fiber.memoizedState && fiber.memoizedState.memoizedState;
        if (s && s[0]) return s[0];
      }
      return findNav(fiber.child) || findNav(fiber.sibling);
    }

    var navState = findNav(root && root.current);
    if (!navState) return JSON.stringify({ error: 'Navigation state not found. Is React Navigation or Expo Router installed?' });

    function simplify(st) {
      if (!st) return null;
      var res = {
        routeName: st.routes && st.routes[st.index] && st.routes[st.index].name,
        params: (st.routes && st.routes[st.index] && st.routes[st.index].params) || {},
        stack: (st.routes && st.routes.map(function(r) { return r.name; })) || [],
        index: st.index
      };
      var activeRoute = st.routes && st.routes[st.index];
      if (activeRoute && activeRoute.state) {
        res.nested = simplify(activeRoute.state);
      }
      return res;
    }

    return JSON.stringify(simplify(navState));
  }

  function getStoreState(path) {
    var state = null;
    var storeType = null;

    if (globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.getState) {
      state = globalThis.__REDUX_STORE__.getState();
      storeType = 'redux';
    } else if (globalThis.__ZUSTAND_STORES__) {
      var result = {};
      var entries = Object.entries(globalThis.__ZUSTAND_STORES__);
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i][0], store = entries[i][1];
        result[name] = typeof store.getState === 'function' ? store.getState() : store;
      }
      state = result;
      storeType = 'zustand';
    }

    if (!state) {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook) {
        var rendererId = hook.renderers.keys().next().value;
        var roots = hook.getFiberRoots(rendererId);
        var root = roots && roots.values().next().value;

        function findStore(fiber) {
          if (!fiber) return null;
          if (fiber.type && fiber.type.displayName === 'Provider' &&
              fiber.memoizedProps && fiber.memoizedProps.store &&
              fiber.memoizedProps.store.getState) {
            return { store: fiber.memoizedProps.store.getState(), type: 'redux' };
          }
          return findStore(fiber.child) || findStore(fiber.sibling);
        }

        var found = findStore(root && root.current);
        if (found) { state = found.store; storeType = found.type; }
      }
    }

    if (!state) {
      return JSON.stringify({
        error: 'No store found.',
        hint: 'For Zustand, add to app entry: if (__DEV__) global.__ZUSTAND_STORES__ = { myStore }',
        hint2: 'For Redux, the Provider is auto-detected. Check it is mounted.'
      });
    }

    if (path) {
      var parts = path.split('.');
      var current = state;
      for (var i = 0; i < parts.length; i++) {
        current = current && current[parts[i]];
        if (current === undefined) {
          return JSON.stringify({ error: 'Path not found: ' + path, availableKeys: Object.keys(state) });
        }
      }
      state = current;
    }

    return safeStringify({ type: storeType, state: state }, 30000);
  }

  var errors = [];

  try {
    var origHandler = ErrorUtils.getGlobalHandler();
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

  try {
    if (globalThis.HermesInternal && globalThis.HermesInternal.enablePromiseRejectionTracker) {
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

  globalThis.__RN_AGENT = {
    getTree: getTree,
    getNavState: getNavState,
    getStoreState: getStoreState,
    getErrors: getErrors,
    clearErrors: clearErrors,
    isReady: function() {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      return !!(hook && hook.renderers && hook.renderers.size > 0 && hook.getFiberRoots);
    },
    getAppInfo: function() {
      try {
        var RN = require('react-native');
        return JSON.stringify({
          __DEV__: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
          platform: RN.Platform.OS,
          version: RN.Platform.Version,
          rnVersion: require('react-native/Libraries/Core/ReactNativeVersion').version,
          hermes: typeof HermesInternal !== 'undefined',
          dimensions: RN.Dimensions.get('window')
        });
      } catch(e) {
        return JSON.stringify({ error: e.message });
      }
    }
  };
})();
`;

export const NETWORK_HOOK_SCRIPT = `
(function() {
  if (globalThis.__RN_AGENT_NETWORK_HOOKED__) return;
  globalThis.__RN_AGENT_NETWORK_HOOKED__ = true;
  globalThis.__RN_AGENT_NETWORK_LOG__ = [];
  var MAX = 100;

  var origFetch = globalThis.fetch;
  globalThis.fetch = function(url, opts) {
    var entry = {
      id: 'f-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
      method: (opts && opts.method) || 'GET',
      url: typeof url === 'string' ? url : (url && url.url) || String(url),
      timestamp: new Date().toISOString()
    };
    globalThis.__RN_AGENT_NETWORK_LOG__.push(entry);
    if (globalThis.__RN_AGENT_NETWORK_LOG__.length > MAX) {
      globalThis.__RN_AGENT_NETWORK_LOG__.shift();
    }
    var start = Date.now();
    return origFetch.apply(this, arguments).then(function(resp) {
      entry.status = resp.status;
      entry.duration_ms = Date.now() - start;
      return resp;
    }).catch(function(err) {
      entry.status = 0;
      entry.error = err.message;
      entry.duration_ms = Date.now() - start;
      throw err;
    });
  };

  var XHR = globalThis.XMLHttpRequest;
  if (XHR) {
    var origOpen = XHR.prototype.open;
    var origSend = XHR.prototype.send;
    XHR.prototype.open = function(method, url) {
      this.__rn_agent = { method: method, url: url };
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function() {
      if (this.__rn_agent) {
        var entry = {
          id: 'x-' + Date.now() + '-' + Math.random().toString(36).substr(2, 5),
          method: this.__rn_agent.method,
          url: this.__rn_agent.url,
          timestamp: new Date().toISOString()
        };
        globalThis.__RN_AGENT_NETWORK_LOG__.push(entry);
        if (globalThis.__RN_AGENT_NETWORK_LOG__.length > MAX) {
          globalThis.__RN_AGENT_NETWORK_LOG__.shift();
        }
        var start = Date.now();
        var self = this;
        this.addEventListener('loadend', function() {
          entry.status = self.status;
          entry.duration_ms = Date.now() - start;
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
`;
