# rn-dev-agent v2 — Claude Code Plugin for React Native

## Core Use Case

**After implementing a feature, the AI agent should fully test it**: navigate the app on a simulator/emulator, verify UI renders correctly, walk through the user flow, and confirm the app's internal state (component props, store data, network responses, navigation stack) matches expectations.

This is NOT a generic automation tool. It's a **feature verification pipeline** for an AI coding agent.

---

## What "Fully Test a Feature" Means

```
Developer: "Add a shopping cart — users can add items, see count badge, and checkout"

Agent workflow:
1. READ the implementation to understand what was built
2. VERIFY environment is ready (Metro running, app loaded, no errors)
3. NAVIGATE to the starting screen (deep link or Maestro flow)
4. INTERACT with the feature (tap buttons, fill inputs, scroll)
5. VERIFY UI after each step (screenshot + component tree)
6. VERIFY DATA at key checkpoints (store state, network calls, nav state)
7. TEST EDGE CASES (empty cart, network error, back navigation)
8. GENERATE a persistent Maestro test flow for CI
9. REPORT pass/fail with evidence
```

Every layer of the plugin serves this pipeline.

---

## Architecture

```
rn-dev-agent/
├── .claude-plugin/
│   └── plugin.json
├── skills/
│   ├── rn-device-control/         # CLI commands for simulators
│   │   └── SKILL.md
│   ├── rn-testing/                # Maestro patterns + test strategy
│   │   └── SKILL.md
│   └── rn-debugging/             # CDP usage + native log reading
│       └── SKILL.md
├── agents/
│   ├── rn-tester.md              # The primary "test a feature" agent
│   └── rn-debugger.md            # Diagnose + fix agent
├── commands/
│   ├── test-feature.md           # /rn-dev-agent:test-feature <description>
│   ├── debug-screen.md           # /rn-dev-agent:debug-screen
│   └── check-env.md             # /rn-dev-agent:check-env
├── hooks/
│   └── hooks.json                # SessionStart: detect RN project
├── .mcp.json                     # CDP bridge server config
└── scripts/
    └── cdp-bridge/               # MCP server (~400 lines TS)
        ├── package.json
        ├── tsconfig.json
        └── src/
            ├── index.ts          # MCP server entry + tool definitions
            ├── cdp-client.ts     # WebSocket connection + auto-reconnect
            ├── injected-helpers.ts  # JS helpers injected once into Hermes
            └── ring-buffer.ts    # Event buffer for console/network/errors
```

---

## The Test Workflow in Detail

### Phase 1: Environment Check

Before any testing, the agent calls `cdp_status` (one MCP call) to get:

```json
{
  "metro": { "running": true, "port": 8081 },
  "cdp": { "connected": true, "device": "iPhone 16 Pro", "pageId": 3 },
  "app": {
    "platform": "ios",
    "dev": true,
    "hermes": true,
    "rnVersion": "0.83.1",
    "dimensions": { "width": 393, "height": 852 },
    "hasRedBox": false,
    "isPaused": false,
    "errorCount": 0
  },
  "capabilities": {
    "networkDomain": true,
    "fiberTree": true,
    "networkFallback": false
  }
}
```

If not connected, `cdp_status` auto-discovers and connects.
If RedBox is active, it reports the error.
If debugger is paused, it auto-resumes.

### Phase 2: Navigate to Starting Point

The agent uses **deep links** (fastest) or **Maestro** (for complex navigation):

```bash
# Deep link (preferred — instant, deterministic)
xcrun simctl openurl booted "myapp://home"
# or
adb shell am start -a android.intent.action.VIEW -d "myapp://home"

# Maestro (when deep links aren't set up)
cat > /tmp/nav-to-home.yaml << 'EOF'
appId: com.example.app
---
- launchApp:
    clearState: true
- assertVisible: "Home"
EOF
maestro test /tmp/nav-to-home.yaml
```

Then verifies arrival:
```
Agent calls: cdp_navigation_state
Response: { "currentRoute": "Home", "stack": ["Home"], "tabs": { "active": "Home" } }
✓ Navigation confirmed
```

### Phase 3: Interact and Verify (The Core Loop)

For each step in the feature flow:

```
┌──────────────────────────────────────────────┐
│ 1. TAKE ACTION                               │
│    Maestro: tapOn id "add-to-cart-btn"       │
│    (bash: maestro test /tmp/step.yaml)       │
├──────────────────────────────────────────────┤
│ 2. WAIT FOR SETTLE                           │
│    Maestro assertVisible (preferred)         │
│    OR: sleep 500ms + cdp_evaluate            │
│    "await new Promise(r => requestAnimationFrame(r))" │
├──────────────────────────────────────────────┤
│ 3. VERIFY UI (what the user sees)            │
│    bash: screenshot → /tmp/after-add.png     │
│    MCP: cdp_component_tree(filter="CartBadge")│
│    → { component: "CartBadge", props: { count: 1 } } │
├──────────────────────────────────────────────┤
│ 4. VERIFY DATA (what the code holds)         │
│    MCP: cdp_store_state("cart.items")        │
│    → [{ id: "shoe-1", qty: 1, price: 99 }]  │
│    MCP: cdp_network_log(last=1)              │
│    → POST /api/cart/add → 200, 145ms         │
├──────────────────────────────────────────────┤
│ 5. DECIDE: pass or investigate               │
│    If mismatch → enter debug mode            │
│    If pass → next step                       │
└──────────────────────────────────────────────┘
```

### Phase 4: Edge Case Testing

Agent generates additional Maestro flows for:
- Empty state (clear app data, verify empty cart message)
- Error state (disable network, verify error handling)
- Back navigation (go back, verify state preserved)
- Rapid interaction (add 5 items quickly, verify count = 5)

### Phase 5: Generate Persistent Test

After all steps pass, the agent writes a complete Maestro flow:

```yaml
# flows/cart-feature.yaml (committed to repo)
appId: com.example.app
---
- launchApp:
    clearState: true
- assertVisible: "Home"

# Add first item
- tapOn:
    id: "product-shoe-1"
- assertVisible: "Product Detail"
- tapOn:
    id: "add-to-cart-btn"
- assertVisible:
    id: "cart-badge"
    text: "1"

# Verify cart screen
- tapOn:
    id: "cart-tab"
- assertVisible: "Shopping Cart"
- assertVisible: "Air Max 90"
- assertVisible: "$99.00"

# Checkout flow
- tapOn:
    id: "checkout-btn"
- assertVisible: "Order Summary"
```

---

## MCP Server: CDP Bridge

### Design Principles (from Gemini review)

1. **Inject once, call many** — Helper functions are injected into Hermes on first connect via `Runtime.evaluate`. Subsequent calls use `Runtime.evaluate("__RN_AGENT.getTree()")` — small payloads.

2. **Every CDP call has a 5-second timeout** — Prevents the "hanging CDP promise" trap where `Runtime.evaluate` blocks forever on an unresolved promise or paused debugger.

3. **Ring buffers for events** — Console, network, and error events are stored in memory (200/100/50 entries). MCP is pull-based; events fire while the agent is thinking.

4. **Auto-reconnect** — WS close code 1001 (reload) → wait 1.5s → re-discover target → reconnect → re-inject helpers. WS close code 1006 (crash) → report to agent for native log investigation.

5. **Single CDP session awareness** — Hermes allows only ONE CDP client. If connection fails with 1006, agent is told to close RN DevTools/Flipper.

6. **RedBox detection** — Component tree queries check for error boundary components first and return a warning instead of the error overlay tree.

7. **Debugger.paused handling** — Listen for `Debugger.paused` events, auto-resume, report via `cdp_status`.

### Injected Helpers (loaded once on connect)

```typescript
// src/injected-helpers.ts
// This entire string is evaluated ONCE via Runtime.evaluate on connect.
// All subsequent tool calls invoke these functions by name.

export const INJECTED_HELPERS = `
(function() {
  if (globalThis.__RN_AGENT) return; // Already injected
  
  const seen = new WeakSet();
  
  function safeStringify(obj, maxLen) {
    const str = JSON.stringify(obj, (key, val) => {
      if (typeof val === 'function') return '[Function]';
      if (typeof val === 'symbol') return val.toString();
      if (val instanceof Error) return { message: val.message, stack: val.stack };
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    seen = new WeakSet(); // Reset for next call
    if (str && str.length > (maxLen || 50000)) {
      return str.substring(0, maxLen || 50000) + '...[TRUNCATED]';
    }
    return str;
  }
  
  // ─── Fiber Tree Walker ─────────────────────────────
  function getTree(maxDepth, filter) {
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook || !hook.renderers || hook.renderers.size === 0) {
      return JSON.stringify({ error: 'React DevTools hook not available' });
    }
    
    const rendererId = hook.renderers.keys().next().value;
    const roots = hook.getFiberRoots(rendererId);
    if (!roots || roots.size === 0) {
      return JSON.stringify({ error: 'No fiber roots — app may still be loading' });
    }
    
    const root = roots.values().next().value;
    const visited = new WeakSet();
    let totalNodes = 0;
    
    // Check for RedBox/LogBox first
    function hasErrorOverlay(fiber) {
      if (!fiber) return false;
      const name = fiber.type?.displayName || fiber.type?.name;
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
      
      const name = getName(fiber);
      const testID = fiber.memoizedProps?.testID || fiber.memoizedProps?.nativeID;
      const isUserComponent = name && !name.startsWith('RCT') && /^[A-Z]/.test(name);
      
      // Filter support
      if (filter) {
        const f = filter.toLowerCase();
        const matchesName = name?.toLowerCase().includes(f);
        const matchesTestID = testID?.toLowerCase().includes(f);
        // If filtering and this branch has no matches, still walk children
      }
      
      const children = [];
      let child = fiber.child;
      while (child) {
        const node = walk(child, isUserComponent ? depth + 1 : depth);
        if (node) children.push(node);
        child = child.sibling;
      }
      
      // Skip non-user wrapper components
      if (!isUserComponent && !testID) {
        if (children.length === 1) return children[0];
        if (children.length === 0) return null;
        return { _wrapper: true, children };
      }
      
      const node = { component: name };
      if (testID) node.testID = testID;
      
      if (isUserComponent && fiber.memoizedProps) {
        const props = {};
        for (const [k, v] of Object.entries(fiber.memoizedProps)) {
          if (k === 'children' || k === 'testID' || k === 'style') continue;
          if (typeof v === 'function') { props[k] = '[Function]'; continue; }
          try {
            const s = JSON.stringify(v);
            props[k] = s && s.length > 200 ? s.substring(0, 200) + '...' : v;
          } catch { props[k] = '[Unserializable]'; }
        }
        if (Object.keys(props).length > 0) node.props = props;
      }
      
      if (isUserComponent && fiber.memoizedState !== null) {
        try {
          // Extract hook state (simplified — first useState value)
          let hookState = fiber.memoizedState;
          const states = [];
          while (hookState) {
            if (hookState.queue && hookState.memoizedState !== undefined) {
              states.push(hookState.memoizedState);
            }
            hookState = hookState.next;
          }
          if (states.length > 0) node.hookStates = states.slice(0, 5); // Cap at 5
        } catch {}
      }
      
      if (children.length > 0) {
        node.children = children.length > 20 
          ? [...children.slice(0, 10), { _truncated: children.length - 10 + ' more' }]
          : children;
      }
      
      return node;
    }
    
    const tree = walk(root.current, 0);
    return JSON.stringify({ tree, totalNodes }, null, 2);
  }
  
  // ─── Navigation State ──────────────────────────────
  function getNavState() {
    // Try Expo Router (most common)
    try {
      const state = globalThis.__expo_router_state__;
      if (state) return JSON.stringify(state);
    } catch {}
    
    // Try React Navigation DevTools
    try {
      const devtools = globalThis.__REACT_NAVIGATION_DEVTOOLS__;
      if (devtools?.getNavState) return JSON.stringify(devtools.getNavState());
    } catch {}
    
    // Fallback: walk fiber for NavigationContainer
    const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
    if (!hook) return JSON.stringify({ error: 'No navigation state found' });
    
    const rendererId = hook.renderers.keys().next().value;
    const roots = hook.getFiberRoots(rendererId);
    const root = roots?.values().next().value;
    
    function findNav(fiber) {
      if (!fiber) return null;
      const name = fiber.type?.displayName || fiber.type?.name;
      if (name === 'NavigationContainer' || name === 'ExpoRoot') {
        // NavigationContainer stores state in a ref
        const state = fiber.memoizedState?.memoizedState?.[0];
        if (state) return state;
      }
      return findNav(fiber.child) || findNav(fiber.sibling);
    }
    
    const navState = findNav(root?.current);
    
    if (!navState) return JSON.stringify({ error: 'Navigation state not found. Is React Navigation or Expo Router installed?' });
    
    // Simplify the navigation state for the agent
    function simplify(state) {
      if (!state) return null;
      const result = {
        routeName: state.routes?.[state.index]?.name,
        params: state.routes?.[state.index]?.params || {},
        stack: state.routes?.map(r => r.name) || [],
        index: state.index,
      };
      // Recurse into nested navigators
      const activeRoute = state.routes?.[state.index];
      if (activeRoute?.state) {
        result.nested = simplify(activeRoute.state);
      }
      return result;
    }
    
    return JSON.stringify(simplify(navState));
  }
  
  // ─── Store State ───────────────────────────────────
  function getStoreState(path) {
    let state = null;
    let storeType = null;
    
    // 1. Try explicit dev-mode globals (recommended setup)
    if (globalThis.__REDUX_STORE__?.getState) {
      state = globalThis.__REDUX_STORE__.getState();
      storeType = 'redux';
    } else if (globalThis.__ZUSTAND_STORES__) {
      // User exposed stores: { auth: useAuthStore, cart: useCartStore }
      const result = {};
      for (const [name, store] of Object.entries(globalThis.__ZUSTAND_STORES__)) {
        result[name] = typeof store.getState === 'function' ? store.getState() : store;
      }
      state = result;
      storeType = 'zustand';
    }
    
    // 2. Try Redux DevTools extension
    if (!state && globalThis.__REDUX_DEVTOOLS_EXTENSION__) {
      // Some Zustand stores also register here
      storeType = 'redux-devtools';
    }
    
    // 3. Walk fiber tree for Redux Provider
    if (!state) {
      const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      if (hook) {
        const rendererId = hook.renderers.keys().next().value;
        const roots = hook.getFiberRoots(rendererId);
        const root = roots?.values().next().value;
        
        function findStore(fiber) {
          if (!fiber) return null;
          // Redux Provider
          if (fiber.type?.displayName === 'Provider' && fiber.memoizedProps?.store?.getState) {
            return { store: fiber.memoizedProps.store.getState(), type: 'redux' };
          }
          return findStore(fiber.child) || findStore(fiber.sibling);
        }
        
        const found = findStore(root?.current);
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
    
    // Apply path filter
    if (path) {
      const parts = path.split('.');
      let current = state;
      for (const part of parts) {
        current = current?.[part];
        if (current === undefined) {
          return JSON.stringify({ error: 'Path not found: ' + path, availableKeys: Object.keys(state) });
        }
      }
      state = current;
    }
    
    return safeStringify({ type: storeType, state }, 30000);
  }
  
  // ─── Error Tracking ────────────────────────────────
  const errors = [];
  
  // Hook global error handler
  try {
    const origHandler = ErrorUtils.getGlobalHandler();
    ErrorUtils.setGlobalHandler((error, isFatal) => {
      errors.push({
        message: error?.message || String(error),
        stack: error?.stack?.split('\\n').slice(0, 8).join('\\n'),
        isFatal,
        timestamp: new Date().toISOString(),
      });
      if (errors.length > 50) errors.shift();
      if (origHandler) origHandler(error, isFatal);
    });
  } catch {}
  
  // Hook promise rejections
  try {
    if (globalThis.HermesInternal?.enablePromiseRejectionTracker) {
      globalThis.HermesInternal.enablePromiseRejectionTracker({
        allRejections: true,
        onUnhandled: (id, error) => {
          errors.push({
            message: error?.message || String(error),
            type: 'unhandled_promise',
            timestamp: new Date().toISOString(),
          });
          if (errors.length > 50) errors.shift();
        }
      });
    }
  } catch {}
  
  function getErrors() { return JSON.stringify(errors); }
  function clearErrors() { errors.length = 0; return 'cleared'; }
  
  // ─── Public API ────────────────────────────────────
  globalThis.__RN_AGENT = {
    getTree,
    getNavState,
    getStoreState,
    getErrors,
    clearErrors,
    // Convenience: check if app is ready for queries
    isReady: () => {
      const hook = globalThis.__REACT_DEVTOOLS_GLOBAL_HOOK__;
      return !!(hook?.renderers?.size > 0 && hook.getFiberRoots);
    },
    // Get platform info
    getAppInfo: () => JSON.stringify({
      __DEV__: typeof __DEV__ !== 'undefined' ? __DEV__ : null,
      platform: require('react-native').Platform.OS,
      version: require('react-native').Platform.Version,
      rnVersion: require('react-native/Libraries/Core/ReactNativeVersion').version,
      hermes: typeof HermesInternal !== 'undefined',
      dimensions: require('react-native').Dimensions.get('window'),
    }),
  };
})();
`;
```

### MCP Tool Definitions

```typescript
// src/index.ts — complete tool list

// ─── CONNECTION ──────────────────────────────────────

server.tool("cdp_status",
  "Get full environment status. Auto-connects if not connected. Returns Metro status, CDP connection, app info, capabilities, active errors, and RedBox/paused state. Call this FIRST before any testing.",
  { metroPort: { type: "number", optional: true } },
  handler
);

// ─── INSPECTION (for verifying feature state) ────────

server.tool("cdp_component_tree",
  "Get React component tree. Returns components with props, state, testIDs. Use filter to scope to a specific subtree — NEVER request full tree unless necessary (saves tokens). Detects RedBox and warns.",
  {
    filter: { type: "string", description: "Component name or testID to scope query (e.g. 'CartBadge', 'product-list')", optional: true },
    depth: { type: "number", description: "Max depth (default 3, max 6)", default: 3 },
  },
  handler
);

server.tool("cdp_navigation_state",
  "Get current navigation state: active route, params, stack history, nested navigators, active tab. Works with React Navigation and Expo Router.",
  {},
  handler
);

server.tool("cdp_store_state",
  "Read app store state (Redux, Zustand, Jotai). Use path to query specific slice (e.g. 'cart.items', 'auth.user.name'). For Zustand: app must expose stores via global.__ZUSTAND_STORES__ in dev mode.",
  {
    path: { type: "string", description: "Dot-path into store state", optional: true },
  },
  handler
);

server.tool("cdp_network_log",
  "Get recent network requests. Shows method, URL, status, duration, timing. On RN 0.83+ uses CDP Network domain. On older versions uses injected fetch/XHR hooks (auto-detected).",
  {
    limit: { type: "number", default: 20 },
    filter: { type: "string", description: "Filter by URL substring", optional: true },
  },
  handler
);

server.tool("cdp_console_log",
  "Get recent console output. Buffered in ring buffer so logs from between agent calls are preserved.",
  {
    level: { type: "string", enum: ["all", "log", "warn", "error"], default: "all" },
    limit: { type: "number", default: 50 },
  },
  handler
);

server.tool("cdp_error_log",
  "Get unhandled JS errors and promise rejections. Hooked into ErrorUtils and Hermes rejection tracker. If empty but app crashed, the error is NATIVE — use bash logcat/simctl log.",
  {},
  handler
);

// ─── EXECUTION ───────────────────────────────────────

server.tool("cdp_evaluate",
  "Execute arbitrary JavaScript in Hermes runtime. Has 5-second timeout. Use for one-off checks not covered by other tools. Prefer specific tools over raw evaluate.",
  {
    expression: { type: "string" },
    awaitPromise: { type: "boolean", default: false },
  },
  handler
);

server.tool("cdp_reload",
  "Trigger hot reload (Fast Refresh) or full reload. After full reload, auto-reconnects to new Hermes target (waits for runtime ready). Returns when app is ready for queries again.",
  {
    full: { type: "boolean", description: "Full reload (true) or Fast Refresh (false)", default: false },
  },
  handler
);

server.tool("cdp_dev_settings",
  "Control React Native dev settings programmatically (no visual dev menu needed). Actions: reload, toggleInspector, togglePerfMonitor, dismissRedBox.",
  {
    action: { type: "string", enum: ["reload", "toggleInspector", "togglePerfMonitor", "dismissRedBox"] },
  },
  handler
);
```

### CDP Client with All Edge Case Handling

```typescript
// src/cdp-client.ts — key methods with edge case handling

export class CDPClient {
  private ws: WebSocket | null = null;
  private msgId = 0;
  private pending = new Map<number, { resolve: Function; reject: Function; timer: NodeJS.Timeout }>();
  private networkBuffer: RingBuffer<NetworkEntry>;
  private consoleBuffer: RingBuffer<ConsoleEntry>;
  private port: number;
  private reconnecting = false;
  private isPaused = false;
  private hasRedBox = false;
  private helpersInjected = false;
  private networkMode: 'cdp' | 'hook' | 'none' = 'none';

  constructor(port?: number) {
    this.port = port || 8081;
    this.networkBuffer = new RingBuffer(100);
    this.consoleBuffer = new RingBuffer(200);
  }

  // ─── Auto-Discovery ─────────────────────────────
  async autoConnect(): Promise<string> {
    // Find Metro
    const ports = [this.port, 8081, 8082, 19000, 19006];
    let metroPort: number | null = null;
    
    for (const p of [...new Set(ports)]) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const resp = await fetch(`http://localhost:${p}/status`, { signal: ctrl.signal });
        clearTimeout(timer);
        const text = await resp.text();
        if (text.includes('packager-status:running')) {
          metroPort = p;
          break;
        }
      } catch {}
    }
    
    if (!metroPort) throw new Error(
      'Metro not found. Is the dev server running? Try: npx expo start or npx react-native start'
    );
    this.port = metroPort;
    
    // Discover Hermes targets
    const targetsResp = await fetch(`http://localhost:${metroPort}/json/list`);
    const targets = await targetsResp.json();
    
    const validTargets = targets
      .filter((t: any) => t.vm === 'Hermes' && !t.title?.includes('Experimental'))
      .map((t: any) => ({
        ...t,
        // Normalize IPv6 → IPv4
        webSocketDebuggerUrl: t.webSocketDebuggerUrl
          ?.replace(/\[::1\]/g, 'localhost')
          ?.replace(/\[::\]/g, 'localhost'),
      }));
    
    if (validTargets.length === 0) {
      throw new Error(
        'No Hermes debug target found. Is the app running? Is Hermes enabled?'
      );
    }
    
    // Pick most recent target (highest page number to avoid zombie targets)
    const target = validTargets.reduce((a: any, b: any) => {
      const aPage = parseInt(a.id?.split('-')[1] || '0');
      const bPage = parseInt(b.id?.split('-')[1] || '0');
      return bPage > aPage ? b : a;
    });
    
    await this.connectToTarget(target);
    return `Connected to ${target.title} on port ${metroPort}`;
  }

  private async connectToTarget(target: any, retries = 5): Promise<void> {
    for (let i = 0; i < retries; i++) {
      try {
        await this._connect(target.webSocketDebuggerUrl);
        await this.setup();
        return;
      } catch (err: any) {
        if (err.message?.includes('1006') || err.message?.includes('refused')) {
          // Likely another CDP client is connected
          throw new Error(
            'CDP connection rejected (code 1006). Another debugger may be connected. ' +
            'Close React Native DevTools, Flipper, or Chrome DevTools and try again.'
          );
        }
        if (i < retries - 1) await this.sleep(2000);
      }
    }
    throw new Error(`Failed to connect after ${retries} attempts`);
  }

  private async setup(): Promise<void> {
    // Enable domains
    await this.send('Runtime.enable');
    await this.send('Debugger.enable'); // For pause detection
    
    // Try Network domain (RN 0.83+)
    try {
      await this.send('Network.enable');
      this.networkMode = 'cdp';
    } catch {
      this.networkMode = 'none'; // Will inject hooks after helpers
    }
    
    // Setup event handlers
    this.setupEventHandlers();
    
    // Wait for React to be ready
    await this.waitForReact(8000);
    
    // Inject helper functions
    await this.injectHelpers();
    
    // If CDP Network not available, inject fetch/XHR hooks
    if (this.networkMode === 'none') {
      await this.injectNetworkHooks();
      this.networkMode = 'hook';
    }
    
    // Setup reconnection
    this.setupReconnect();
    
    this.helpersInjected = true;
  }

  private setupEventHandlers(): void {
    this.onEvent('Runtime.consoleAPICalled', (params) => {
      this.consoleBuffer.push({
        level: params.type,
        text: params.args?.map((a: any) => a.value ?? a.description ?? '').join(' '),
        timestamp: new Date().toISOString(),
      });
    });
    
    this.onEvent('Network.requestWillBeSent', (params) => {
      this.networkBuffer.push({
        id: params.requestId,
        method: params.request?.method,
        url: params.request?.url,
        timestamp: new Date().toISOString(),
      });
    });
    
    this.onEvent('Network.responseReceived', (params) => {
      const entry = this.networkBuffer.findLast(e => e.id === params.requestId);
      if (entry) {
        entry.status = params.response?.status;
        entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
      }
    });
    
    // Debugger pause detection → auto-resume
    this.onEvent('Debugger.paused', async (params) => {
      this.isPaused = true;
      // Auto-resume to prevent agent from hanging
      try { await this.send('Debugger.resume'); } catch {}
      this.isPaused = false;
    });
  }

  private async waitForReact(timeout: number): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const result = await this.evaluate(
          'typeof __REACT_DEVTOOLS_GLOBAL_HOOK__ !== "undefined" && __REACT_DEVTOOLS_GLOBAL_HOOK__.renderers?.size > 0'
        );
        if (result === true) return;
      } catch {}
      await this.sleep(500);
    }
    // Don't throw — some tools work without React hook
  }

  private setupReconnect(): void {
    this.ws?.on('close', async (code) => {
      if (this.reconnecting) return;
      this.reconnecting = true;
      this.helpersInjected = false;
      
      if (code === 1006) {
        // Abnormal close — likely crash or another client stole the connection
        console.error('CDP: abnormal close (1006). App may have crashed.');
        this.reconnecting = false;
        return; // Don't auto-reconnect on crash — let agent investigate
      }
      
      // Normal close (1001) — reload in progress
      console.error('CDP: connection closed (reload). Reconnecting...');
      await this.sleep(1500);
      
      for (let i = 0; i < 10; i++) {
        try {
          await this.autoConnect();
          console.error('CDP: reconnected successfully');
          this.reconnecting = false;
          return;
        } catch {
          await this.sleep(1000);
        }
      }
      this.reconnecting = false;
    });
  }

  // ─── Core CDP Methods ────────────────────────────

  async evaluate(expression: string, awaitPromise = false): Promise<any> {
    const result = await this.sendWithTimeout('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
    }, 5000); // 5 second hard timeout
    
    if (result?.exceptionDetails) {
      return { error: result.exceptionDetails.text || result.exceptionDetails.exception?.description };
    }
    return result?.result?.value;
  }

  private sendWithTimeout(method: string, params: any, timeoutMs: number): Promise<any> {
    return Promise.race([
      this.send(method, params),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error(
          `CDP timeout (${timeoutMs}ms): ${method}. JS thread may be blocked, paused on a breakpoint, or waiting on an unresolved promise.`
        )), timeoutMs)
      ),
    ]);
  }

  private sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
}
```

---

## Agent: rn-tester.md (Primary Agent)

```markdown
---
name: rn-tester
description: |
  Tests React Native features on simulator/emulator. Verifies UI renders
  correctly, user flows work, and internal state matches expectations.
  Use when a feature has been implemented and needs verification.
  Triggers: "test this feature", "verify it works", "check the implementation",
  "test on simulator", "run on device", "does it work"
tools: Bash, Read, Write, Edit, Glob, Grep, mcp__rn-dev-agent-cdp__*
model: sonnet
skills: rn-device-control, rn-testing, rn-debugging
---

You are a React Native feature testing agent. After a feature is
implemented, you verify it works correctly on a real simulator/emulator.

## Your Testing Protocol

### Step 0: Environment Check
Call `cdp_status`. If not connected, it auto-connects.
STOP if:
- Metro not running → tell user: "Start Metro with `npx expo start`"
- App has RedBox → read error with `cdp_error_log`, fix it first
- Debugger paused → `cdp_dev_settings` action=reload

### Step 1: Understand the Feature
Read the source code files that were changed. Identify:
- What screens/components were added or modified
- What testIDs exist (grep for `testID=`)
- What store slices are involved
- What API endpoints are called
- What navigation routes are used

### Step 2: Plan the Test
Write a brief test plan BEFORE executing:
- Starting state (what screen, what data)
- Steps to exercise the feature
- Expected outcome at each step (UI + data)
- Edge cases to verify

### Step 3: Navigate to Start
Use deep links when possible (fastest, most deterministic):
```bash
xcrun simctl openurl booted "myapp://home"
```
Then verify: `cdp_navigation_state` confirms you're on the right screen.

### Step 4: Execute and Verify (The Core Loop)

For EACH step in the flow:

1. **Act**: Write a minimal Maestro flow and run it:
   ```bash
   cat > /tmp/step.yaml << 'EOF'
   appId: com.example.app
   ---
   - tapOn:
       id: "add-to-cart-btn"
   - assertVisible:
       id: "cart-badge"
   EOF
   maestro test /tmp/step.yaml
   ```

2. **Wait for settle**: Maestro's assertVisible handles this.
   If no assertion target, add `sleep 0.5` before CDP queries.

3. **Verify UI**: Take screenshot via bash, then query the specific
   component:
   ```
   cdp_component_tree(filter="CartBadge", depth=2)
   ```
   Check that props/state match expectations.

4. **Verify Data**: Check internal state:
   ```
   cdp_store_state(path="cart.items")
   cdp_network_log(limit=1, filter="/api/cart")
   ```

5. **Decide**: If all match → next step. If mismatch → investigate.

### Step 5: Edge Cases
Test at minimum:
- Empty/initial state
- Error state (if the feature has error handling)
- Back navigation (state preserved?)
- Multiple rapid interactions

### Step 6: Generate Persistent Test
After all steps pass, write a complete Maestro YAML flow file at
`flows/<feature-name>.yaml` that can run in CI.

### Step 7: Report
Summarize:
- ✅ Steps that passed (with evidence)
- ❌ Steps that failed (with screenshot + state dump)
- 📝 Maestro test file generated at: flows/<name>.yaml

## Critical Rules

1. **Scoped tree queries**: NEVER call cdp_component_tree without a
   filter. Full tree dumps waste 10K+ tokens. Always scope to the
   component you're checking.

2. **Maestro assertVisible before CDP**: After any tap/interaction,
   always wait for Maestro's assertVisible to confirm the UI settled
   before querying CDP state. The React render cycle needs time.

3. **Native errors are invisible to CDP**: If cdp_error_log is empty
   but the app crashed, run:
    - Android: `adb logcat -s ReactNative:E ReactNativeJS:E --pid=$(adb shell pidof -s com.example.app)`
    - iOS: `xcrun simctl spawn booted log stream --predicate 'processImagePath contains "YourApp"' --level error`

4. **Fiber tree ≠ screen**: A component in the fiber tree may be
   off-screen, behind a modal, or invisible. Use Maestro's
   `assertVisible` for screen-level checks, CDP for data-level checks.

5. **One CDP session**: If cdp_connect fails with "1006", ask the user
   to close React Native DevTools, Flipper, or Chrome DevTools.

6. **After code changes**: Wait for Fast Refresh before testing.
   Hot reload is automatic when Claude Code saves a file. Wait 1-2s
   or call cdp_reload if needed.
```

---

## Skill Updates

### rn-testing/SKILL.md — Critical Additions

```markdown
## Timing: Maestro First, CDP Second

After any UI interaction, React needs time to commit updates to the
Fiber tree. The agent MUST follow this sequence:

1. Maestro tap/input → 2. Maestro assertVisible → 3. CDP state query

WRONG (race condition):
  maestro tapOn "Submit" → immediately cdp_store_state → gets OLD state

RIGHT:
  maestro tapOn "Submit" → maestro assertVisible "Success" → cdp_store_state → gets NEW state

If no visual indicator exists after the action, add a delay:
  maestro tapOn "Submit" → bash: sleep 0.7 → cdp_store_state

## Dev Menu: Avoid the Visual Menu

NEVER open the visual dev menu during automated testing — it overlays
the entire screen and blocks Maestro interactions.

Instead, use `cdp_dev_settings` for programmatic control:
- Reload: cdp_dev_settings action=reload (or cdp_reload for auto-reconnect)
- Dismiss RedBox: cdp_dev_settings action=dismissRedBox
- Toggle inspector: cdp_dev_settings action=toggleInspector

If the visual dev menu appears unexpectedly during a Maestro flow:
```bash
# Android: press back to dismiss
adb shell input keyevent KEYCODE_BACK
# iOS: tap outside menu area (top of screen)
```

## Multi-Device Testing

When testing on both platforms:
```bash
# Check what's running
xcrun simctl list devices booted
adb devices

# Run Maestro on specific device
maestro --device booted test flow.yaml        # iOS (active simulator)
maestro --device emulator-5554 test flow.yaml  # Android

# Sequential cross-platform
maestro test --device booted flows/feature.yaml && \
maestro test --device emulator-5554 flows/feature.yaml
```

## Network Mocking (for API-dependent features)

For testing features that depend on specific API responses, the simplest
approach is to mock at the app level:

```typescript
// In the app code (dev only):
if (__DEV__ && global.__RN_AGENT_MOCKS__) {
  // Override fetch for specific URLs
  const mocks = global.__RN_AGENT_MOCKS__;
  const origFetch = global.fetch;
  global.fetch = (url, opts) => {
    if (mocks[url]) return Promise.resolve(new Response(JSON.stringify(mocks[url])));
    return origFetch(url, opts);
  };
}
```

The agent can then inject mocks via CDP:
```
cdp_evaluate: global.__RN_AGENT_MOCKS__ = {
  "https://api.example.com/products": [{ id: 1, name: "Test Product" }]
}
```

For more complex mocking, use MSW (Mock Service Worker) with React Native.

## Zustand Store Inspection

Zustand v4+ uses `useSyncExternalStore`, NOT React Context.
Fiber tree walking cannot detect Zustand stores.

The recommended pattern (1 line in app entry, zero production cost):
```typescript
// app/_layout.tsx or App.tsx
if (__DEV__) {
  global.__ZUSTAND_STORES__ = {
    auth: useAuthStore,
    cart: useCartStore,
    settings: useSettingsStore,
  };
}
```

Then the agent can query: `cdp_store_state(path="cart.items")`

Without this, the agent can still read Zustand data from component
memoizedState, but cannot dispatch actions or get a clean store snapshot.
```

### rn-debugging/SKILL.md — Critical Additions

```markdown
## Error Types and Where to Find Them

| Error Type | Where to Look | Tool |
|-----------|--------------|------|
| JS runtime error | cdp_error_log | MCP |
| Unhandled promise | cdp_error_log | MCP |
| React render error | cdp_component_tree (RedBox detection) | MCP |
| Console.error() | cdp_console_log(level="error") | MCP |
| Native crash (iOS) | xcrun simctl spawn booted log stream | bash |
| Native crash (Android) | adb logcat -b crash | bash |
| Metro bundle error | curl localhost:8081/status | bash |
| Network failure | cdp_network_log (status=0 or missing) | MCP |

Key rule: **If CDP shows no errors but the app is broken, the problem
is native.** Always check native logs as a fallback.

## Connection Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| cdp_status: Metro not found | Dev server not running | `npx expo start` or `npx react-native start` |
| cdp_status: No Hermes target | App not loaded yet | Wait, then retry |
| cdp_connect: code 1006 | Another debugger is connected | Close RN DevTools / Flipper / Chrome DevTools |
| cdp_evaluate: timeout | JS thread blocked or paused | Check for `debugger;` statements, long sync operations |
| cdp_component_tree: "hook not available" | Release build or non-Hermes engine | Only works in __DEV__ with Hermes |
| cdp_component_tree: APP_HAS_REDBOX | App showing error screen | Read cdp_error_log, fix code, cdp_reload |

## Post-Reload Readiness

After a full reload (cdp_reload with full=true), the MCP server
auto-reconnects. But the app's React tree may not be mounted yet.

The MCP server handles this internally (polls for React readiness),
but if you call cdp_component_tree immediately after reload and get
"No fiber roots", wait 2 seconds and retry.
```

---

## Summary of Changes from v1 → v2

| Area | v1 | v2 |
|------|----|----|
| **Focus** | Generic debugging tool | Feature verification pipeline |
| **Injected helpers** | Large JS string per call | Inject once on connect, call by name |
| **CDP timeout** | None (could hang forever) | 5s hard timeout on every call |
| **Reconnect** | Basic retry | Differentiates reload (1001) vs crash (1006) |
| **RedBox** | Not detected | Auto-detected in component_tree, warns agent |
| **Debugger.paused** | Not handled | Auto-resume + status reporting |
| **Network capture** | CDP only | CDP (0.83+) → fetch/XHR hook fallback |
| **Store detection** | global.__REDUX_STORE__ | Fiber walk for Redux + explicit Zustand pattern |
| **Fiber serialization** | Naive | WeakSet + 50KB cap + zombie target avoidance |
| **Multi-device** | Not addressed | Documented in skill + target selection |
| **Session conflict** | Silent failure | Clear error message about other debuggers |
| **Test output** | Ephemeral only | Generates persistent Maestro YAML for CI |
| **Agent workflow** | Freeform | Strict 7-step protocol with timing rules |
| **Maestro→CDP race** | Not addressed | Mandatory "assertVisible before CDP query" rule |
| **Zustand** | Broken (fiber walk fails) | Documented pattern for dev-mode global exposure |
| **Token efficiency** | Full tree dumps | Mandatory filter parameter, scoped queries |

---

## Implementation Priority

| Phase | What | Effort | Enables |
|-------|------|--------|---------|
| **1** | MCP server: cdp_status, cdp_connect, cdp_evaluate, cdp_reload | 2 days | Basic connectivity + arbitrary inspection |
| **2** | Injected helpers: component tree, nav state, error tracking | 2 days | Feature verification (UI + navigation) |
| **3** | Network + store + console tools | 2 days | Data verification (the full picture) |
| **4** | Skills (3 SKILL.md files) | 1 day | Claude Code knows the right commands |
| **5** | Agents + Commands | 1 day | Orchestrated test workflows |
| **6** | Hooks + edge case hardening | 1 day | Polish (session detect, zombie targets) |

**Total: ~9 days to production-quality MVP**