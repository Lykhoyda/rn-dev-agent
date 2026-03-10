export const INJECTED_HELPERS = `
(function() {
  if (globalThis.__RN_AGENT) return;

  function safeStringify(obj, maxLen) {
    try {
      var seen = new WeakSet();
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
      if (str && str.length > (maxLen || 50000)) {
        return str.substring(0, maxLen || 50000) + '...[TRUNCATED]';
      }
      return str;
    } catch(e) {
      return JSON.stringify({ __agent_error: 'Serialization failed: ' + (e && e.message || String(e)) });
    }
  }

  // Fiber Tree Walker
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

    function walk(fiber, depth) {
      if (!fiber || depth > (maxDepth || 3) || visited.has(fiber)) return null;
      visited.add(fiber);
      totalNodes++;

      // Text node capture (tag 6)
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
        var node = walk(child, isUserComponent ? depth + 1 : depth);
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

      // Filter support
      if (filter) {
        var f = filter.toLowerCase();
        var matchesName = name && name.toLowerCase().indexOf(f) >= 0;
        var matchesTestID = testID && testID.toLowerCase().indexOf(f) >= 0;
        if (!matchesName && !matchesTestID && children.length === 0) return null;
      }

      return result;
    }

    var tree = walk(root.current, 0);
    var output = JSON.stringify({ tree: tree, totalNodes: totalNodes }, null, 2);
    if (output.length > 50000) {
      return JSON.stringify({ error: 'Tree too large (' + output.length + ' chars). Use a filter parameter to scope the query.' });
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

    var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ error: 'No navigation state found' });

    var rendererId = hook.renderers.keys().next().value;
    var roots = hook.getFiberRoots(rendererId);
    var root = roots && roots.values().next().value;

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

  // Store State
  function getStoreState(path) {
    var state = null;
    var storeType = null;

    if (globalThis.__REDUX_STORE__ && globalThis.__REDUX_STORE__.getState) {
      state = globalThis.__REDUX_STORE__.getState();
      storeType = 'redux';
    } else if (globalThis.__ZUSTAND_STORES__) {
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

    if (!state) {
      var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook) {
        var rendererId = hook.renderers.keys().next().value;
        var roots = hook.getFiberRoots(rendererId);
        var root = roots && roots.values().next().value;

        function findStore(fiber, depth) {
          var current = fiber;
          while (current) {
            if ((depth || 0) > 30) return null;
            if (current.type && current.type.displayName === 'Provider' && current.memoizedProps && current.memoizedProps.store && current.memoizedProps.store.getState) {
              return { store: current.memoizedProps.store.getState(), type: 'redux' };
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
        current = current && current[parts[i]];
        if (current === undefined) {
          return JSON.stringify({ __agent_error: 'Path not found: ' + path, availableKeys: Object.keys(state) });
        }
      }
      state = current;
    }

    return safeStringify({ type: storeType, state: state }, 30000);
  }

  // Error Tracking
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

  // Public API
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
        return JSON.stringify({
          __DEV__: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
          platform: require('react-native').Platform.OS,
          version: require('react-native').Platform.Version,
          rnVersion: require('react-native/Libraries/Core/ReactNativeVersion').version,
          hermes: typeof HermesInternal !== 'undefined',
          dimensions: require('react-native').Dimensions.get('window')
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

      if (globalThis.__RN_AGENT_NETWORK_CB__) {
        globalThis.__RN_AGENT_NETWORK_CB__('request', {
          id: id, method: self.__rn_agent_method || 'GET', url: String(self.__rn_agent_url || '')
        });
      }

      self.addEventListener('loadend', function() {
        if (globalThis.__RN_AGENT_NETWORK_CB__) {
          globalThis.__RN_AGENT_NETWORK_CB__('response', {
            id: id, status: self.status, duration_ms: Date.now() - start
          });
        }
      });

      return origSend.apply(this, arguments);
    };
  }
})();
`;
