// M6 / Phase 112 (D669): test-recorder injected JS strings.
//
// Object.freeze interceptor that captures user-invoked handlers (onPress,
// onLongPress, onChangeText, onSubmitEditing, onScroll*) at the moment React
// freezes their props inside createElement. Adapted from metro-mcp
// (src/plugins/test-recorder.ts) with three deliberate deviations:
//
//   1. Finger-direction swipes (NOT metro-mcp's content-delta semantic).
//      contentOffset.y INCREASING means the user's finger swiped UP (content
//      scrolled UP through the viewport) — this is what Maestro's `swipeUp`
//      and Detox's `.swipe('up')` mean. metro-mcp emits the content-delta
//      direction which produces inverted YAML when replayed.
//
//   2. 500-event cap with priority eviction. Long sessions on scroll-heavy
//      screens can produce tens of thousands of events. We cap at 500 and
//      drop the oldest scroll/type pair on overflow (taps + navigates carry
//      higher information value). The `globalThis.__METRO_MCP_REC_TRUNCATED__`
//      flag bubbles up to `cdp_record_test_stop`'s envelope.
//
//   3. Route caching via the commit hook closure. metro-mcp expects the user
//      app to install `globalThis.__METRO_MCP_NAV_REF__`. We instead read
//      `__RN_AGENT.getNavState()` inside our `onCommitFiberRoot` patch (which
//      we install for navigate-event tracking anyway) and cache the active
//      route into a closure variable. The Object.freeze hot-path reads the
//      cached variable synchronously — zero CDP round-trips per event.
//      Mirrored to `globalThis.__METRO_MCP_NAV_REF_CACHE__` so the annotation
//      JS can reference the same value from a separate IIFE.
//
// Gating: cdp_record_test_start probes `__DEV__` first via DEV_CHECK_JS.
// Release builds pre-freeze props at Metro bundling time so the interceptor
// can never fire — better to fail fast than silently record nothing.
export const DEV_CHECK_JS = `(typeof __DEV__ !== 'undefined' && __DEV__ === true)`;
export const READ_EVENTS_JS = `JSON.stringify({
  active: !!globalThis.__METRO_MCP_REC_ACTIVE__,
  truncated: !!globalThis.__METRO_MCP_REC_TRUNCATED__,
  events: globalThis.__METRO_MCP_REC_EVENTS__ || []
})`;
export const START_RECORDING_JS = `(function() {
  var hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook || !hook.getFiberRoots) {
    return JSON.stringify({ ok: false, error: 'React DevTools hook not present' });
  }

  if (globalThis.__METRO_MCP_REC_ACTIVE__) {
    return JSON.stringify({ ok: true, alreadyRunning: true, activeRoute: globalThis.__METRO_MCP_NAV_REF_CACHE__ || null });
  }

  globalThis.__METRO_MCP_REC_EVENTS__ = [];
  globalThis.__METRO_MCP_REC_ACTIVE__ = true;
  globalThis.__METRO_MCP_REC_TRUNCATED__ = false;
  globalThis.__METRO_MCP_NAV_REF_CACHE__ = null;

  // Session token: protects against stale wrappers from a previous start-stop
  // cycle. Frozen props can't be mutated to clear obj.__mcpRecSession after
  // cleanup, so wrappers from session 1 still call when session 2 begins.
  // Each wrapper checks this token against the current global before pushing.
  var sessionId = String(Date.now()) + '_' + Math.random().toString(36).slice(2);
  globalThis.__METRO_MCP_REC_SESSION__ = sessionId;

  var MAX_EVENTS = 500;
  var __currentRoute = null;

  // Cap-with-eviction: drop oldest scroll/type pair before pushing #501.
  // Falls back to FIFO if no evictable event exists (all taps + navigates).
  function pushEvent(ev) {
    var evts = globalThis.__METRO_MCP_REC_EVENTS__;
    if (evts.length >= MAX_EVENTS) {
      var evicted = false;
      for (var i = 0; i < evts.length; i++) {
        if (evts[i].type === 'swipe' || evts[i].type === 'type') {
          evts.splice(i, 1);
          evicted = true;
          break;
        }
      }
      if (!evicted) evts.shift();
      globalThis.__METRO_MCP_REC_TRUNCATED__ = true;
    }
    evts.push(ev);
  }

  // Walk a React Navigation state object to its leaf route.
  function extractActiveRoute(state) {
    try {
      var s = state;
      var depth = 0;
      while (s && depth < 20) {
        if (typeof s.index === 'number' && Array.isArray(s.routes)) {
          var r = s.routes[s.index];
          if (!r) return null;
          if (r.state) { s = r.state; depth++; continue; }
          return r.name || null;
        }
        return null;
      }
    } catch (e) {}
    return null;
  }

  function readCurrentRoute() {
    try {
      if (globalThis.__RN_AGENT && globalThis.__RN_AGENT.getNavState) {
        var raw = globalThis.__RN_AGENT.getNavState();
        if (typeof raw === 'string') {
          var parsed = JSON.parse(raw);
          return extractActiveRoute(parsed);
        }
      }
    } catch (e) {}
    return null;
  }

  // --- Object.freeze interceptor (hot path) ---
  // React's createElement calls Object.freeze on the props object before
  // returning. We wrap matching handlers BEFORE the freeze so the wrapped
  // versions become the frozen ones. Idempotent via obj.__mcpRec.
  var origFreeze = Object.freeze;
  Object.freeze = function(obj) {
    if (globalThis.__METRO_MCP_REC_ACTIVE__ && obj && typeof obj === 'object' && !Array.isArray(obj) && !obj.__mcpRec) {
      var tid = obj.testID || null;
      var lbl = obj.accessibilityLabel || obj['aria-label'] || null;
      var wrapped = false;

      if (typeof obj.onPress === 'function') {
        var op = obj.onPress;
        obj.onPress = function(e) {
          if (globalThis.__METRO_MCP_REC_ACTIVE__ && globalThis.__METRO_MCP_REC_SESSION__ === sessionId) {
            pushEvent({ type: 'tap', testID: tid, label: lbl, route: __currentRoute, t: Date.now() });
          }
          return op.call(this, e);
        };
        wrapped = true;
      }
      if (typeof obj.onLongPress === 'function') {
        var olp = obj.onLongPress;
        obj.onLongPress = function(e) {
          if (globalThis.__METRO_MCP_REC_ACTIVE__ && globalThis.__METRO_MCP_REC_SESSION__ === sessionId) {
            pushEvent({ type: 'long_press', testID: tid, label: lbl, route: __currentRoute, t: Date.now() });
          }
          return olp.call(this, e);
        };
        wrapped = true;
      }
      if (typeof obj.onChangeText === 'function') {
        var oct = obj.onChangeText;
        obj.onChangeText = function(val) {
          if (globalThis.__METRO_MCP_REC_ACTIVE__ && globalThis.__METRO_MCP_REC_SESSION__ === sessionId) {
            pushEvent({ type: 'type', testID: tid, label: lbl, value: val, route: __currentRoute, t: Date.now() });
          }
          return oct.call(this, val);
        };
        wrapped = true;
      }
      if (typeof obj.onSubmitEditing === 'function') {
        var ose = obj.onSubmitEditing;
        obj.onSubmitEditing = function(e) {
          if (globalThis.__METRO_MCP_REC_ACTIVE__ && globalThis.__METRO_MCP_REC_SESSION__ === sessionId) {
            pushEvent({ type: 'submit', testID: tid, label: lbl, route: __currentRoute, t: Date.now() });
          }
          return ose.call(this, e);
        };
        wrapped = true;
      }

      // Scroll-container detection: probe for 7 RN ScrollView-specific props.
      // 'in' (not !== undefined) catches props explicitly set to undefined.
      var isScrollable =
        'scrollEventThrottle'            in obj ||
        'extraScrollHeight'              in obj ||
        'showsVerticalScrollIndicator'   in obj ||
        'showsHorizontalScrollIndicator' in obj ||
        'keyboardShouldPersistTaps'      in obj ||
        'keyboardDismissMode'            in obj ||
        'scrollEnabled'                  in obj ||
        typeof obj.onScrollBeginDrag === 'function' ||
        typeof obj.onScrollEndDrag   === 'function';
      if (isScrollable) {
        var scrollStart = { x: null, y: null };
        var origBegin       = obj.onScrollBeginDrag   || null;
        var origEnd         = obj.onScrollEndDrag     || null;
        var origMomentumEnd = obj.onMomentumScrollEnd || null;
        obj.onScrollBeginDrag = function(e) {
          scrollStart.x = e.nativeEvent.contentOffset.x;
          scrollStart.y = e.nativeEvent.contentOffset.y;
          if (origBegin) origBegin.call(this, e);
        };
        var emitSwipeIfMoved = function(e) {
          if (scrollStart.x !== null && globalThis.__METRO_MCP_REC_ACTIVE__) {
            var dx = e.nativeEvent.contentOffset.x - scrollStart.x;
            var dy = e.nativeEvent.contentOffset.y - scrollStart.y;
            if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
              // Finger-direction (NOT metro-mcp's content-delta — see header).
              // dy>0: contentOffset increased → finger went UP → 'up'.
              var dir = Math.abs(dx) > Math.abs(dy)
                ? (dx > 0 ? 'left'  : 'right')
                : (dy > 0 ? 'up'    : 'down');
              var evts = globalThis.__METRO_MCP_REC_EVENTS__;
              var last = evts[evts.length - 1];
              if (!(last && last.type === 'swipe' && Date.now() - last.t < 100)) {
                pushEvent({ type: 'swipe', direction: dir, testID: tid, route: __currentRoute, t: Date.now() });
              }
            }
            scrollStart.x = null;
          }
        };
        obj.onScrollEndDrag = function(e) {
          emitSwipeIfMoved(e);
          if (origEnd) origEnd.call(this, e);
        };
        obj.onMomentumScrollEnd = function(e) {
          emitSwipeIfMoved(e);
          if (origMomentumEnd) origMomentumEnd.call(this, e);
        };
        wrapped = true;
      }
      if (wrapped) obj.__mcpRec = true;
    }
    return origFreeze.call(this, obj);
  };

  // --- Re-render walk for already-mounted scroll containers ---
  // Object.freeze only fires on FUTURE renders. Existing ScrollViews missed
  // the interceptor. Force-render them so their props go through Object.freeze
  // again. M8 pattern: 1..5 renderer loop for fiber root resolution.
  (function() {
    var renderer = null;
    try {
      hook.renderers.forEach(function(r) { if (!renderer) renderer = r; });
    } catch (e) {}

    function isScrollFiber(fiber) {
      var cn = typeof fiber.type === 'string'
        ? fiber.type
        : (fiber.type && (fiber.type.displayName || fiber.type.name)) || '';
      if (cn === 'ScrollView' || cn === 'FlatList' || cn === 'SectionList' ||
          cn === 'VirtualizedList' || cn === 'FlashList' || cn === 'BigList' ||
          cn === 'RecyclerListView' || cn === 'MasonryFlashList') return true;
      if (/ScrollView|List/i.test(cn)) return true;
      var p = fiber.memoizedProps;
      return !!(p && typeof p === 'object' && (
        'scrollEventThrottle'            in p || 'extraScrollHeight'              in p ||
        'showsVerticalScrollIndicator'   in p || 'showsHorizontalScrollIndicator' in p ||
        'keyboardShouldPersistTaps'      in p || 'keyboardDismissMode'            in p ||
        'scrollEnabled'                  in p ||
        typeof p.onScrollBeginDrag === 'function' || typeof p.onScrollEndDrag === 'function'
      ));
    }

    var stack = [];
    for (var ri = 1; ri <= 5; ri++) {
      var roots = hook.getFiberRoots(ri);
      if (roots && roots.size > 0) {
        Array.from(roots).forEach(function(r) { stack.push({ f: r.current, d: 0 }); });
        break;
      }
    }
    while (stack.length) {
      var item = stack.pop(); var fiber = item.f; var depth = item.d;
      if (!fiber || depth > 200) continue;
      if (isScrollFiber(fiber) && fiber.memoizedProps && !fiber.memoizedProps.__mcpRec) {
        if (fiber.stateNode && typeof fiber.stateNode.forceUpdate === 'function') {
          try { fiber.stateNode.forceUpdate(); } catch (e) {}
        } else if (renderer && renderer.overrideProps) {
          try { renderer.overrideProps(fiber, ['__mcpInit'], 1); } catch (e) {}
        }
      }
      if (fiber.sibling) stack.push({ f: fiber.sibling, d: depth });
      if (fiber.child)   stack.push({ f: fiber.child,   d: depth + 1 });
    }
  })();

  // --- Commit hook: route cache + navigate events ---
  // Read the current route on every React commit (cheap relative to freeze
  // frequency), cache it for the freeze hot-path, and emit a navigate event
  // when it changes.
  var origCommit = hook.onCommitFiberRoot;
  var prevRoute = null;
  hook.onCommitFiberRoot = function(id, root) {
    if (globalThis.__METRO_MCP_REC_ACTIVE__ && globalThis.__METRO_MCP_REC_SESSION__ === sessionId) {
      var route = readCurrentRoute();
      if (route) {
        __currentRoute = route;
        globalThis.__METRO_MCP_NAV_REF_CACHE__ = route;
        if (prevRoute && prevRoute !== route) {
          pushEvent({ type: 'navigate', from: prevRoute, to: route, route: route, t: Date.now() });
        }
        prevRoute = route;
      }
    }
    if (origCommit) return origCommit.apply(this, arguments);
  };

  // Seed the route cache with one immediate read so events captured before
  // the first commit have a chance of getting a route attached.
  __currentRoute = readCurrentRoute();
  globalThis.__METRO_MCP_NAV_REF_CACHE__ = __currentRoute;
  prevRoute = __currentRoute;

  globalThis.__METRO_MCP_REC_CLEANUP__ = function() {
    globalThis.__METRO_MCP_REC_ACTIVE__ = false;
    hook.onCommitFiberRoot = origCommit;
    Object.freeze = origFreeze;
    delete globalThis.__METRO_MCP_REC_CLEANUP__;
  };

  return JSON.stringify({ ok: true, alreadyRunning: false, activeRoute: __currentRoute });
})()`;
export const STOP_RECORDING_JS = `(function() {
  try {
    if (globalThis.__METRO_MCP_REC_CLEANUP__) {
      globalThis.__METRO_MCP_REC_CLEANUP__();
    }
  } catch (e) {}
  var events = globalThis.__METRO_MCP_REC_EVENTS__ || [];
  var truncated = !!globalThis.__METRO_MCP_REC_TRUNCATED__;
  return JSON.stringify({ ok: true, events: events, truncated: truncated });
})()`;
// ADD_ANNOTATION_JS is a template — the calling handler interpolates the
// JSON-stringified note via a plain string concat. Keeping the JS as a string
// (not a function) lets cdp_evaluate execute it directly.
export function buildAnnotationJs(note) {
    return `(function() {
  if (!globalThis.__METRO_MCP_REC_ACTIVE__) {
    return JSON.stringify({ ok: false, error: 'Recording is not active' });
  }
  var route = globalThis.__METRO_MCP_NAV_REF_CACHE__ || null;
  globalThis.__METRO_MCP_REC_EVENTS__.push({
    type: 'annotation',
    note: ${JSON.stringify(note)},
    route: route,
    t: Date.now()
  });
  return JSON.stringify({ ok: true });
})()`;
}
