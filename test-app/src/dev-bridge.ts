const BRIDGE_VERSION = 1;
const g = globalThis as Record<string, unknown>;

if (typeof __DEV__ !== 'undefined' && __DEV__ && !g.__RN_DEV_BRIDGE__) {
  const MAX_CONSOLE = 200;
  const MAX_ERRORS = 50;
  let consoleBuffer: Array<{ level: string; message: string; timestamp: number }> = [];
  let errors: Array<{ message: string; stack: string | null; timestamp: number; type: string }> = [];

  const SENTINEL = '__RN_DEV_BRIDGE_CONSOLE_PATCHED__';
  if (!g[SENTINEL]) {
    g[SENTINEL] = true;
    for (const level of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      const orig = (console as unknown as Record<string, Function>)[level];
      if (typeof orig !== 'function') continue;
      (console as unknown as Record<string, Function>)[level] = (...args: unknown[]) => {
        consoleBuffer.push({
          level,
          message: args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '),
          timestamp: Date.now(),
        });
        if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer = consoleBuffer.slice(-MAX_CONSOLE);
        orig.apply(console, args);
      };
    }
  }

  if (typeof (g as { ErrorUtils?: { getGlobalHandler: () => Function; setGlobalHandler: (h: Function) => void } }).ErrorUtils?.setGlobalHandler === 'function') {
    const eu = g.ErrorUtils as { getGlobalHandler: () => Function; setGlobalHandler: (h: Function) => void };
    const prev = eu.getGlobalHandler();
    eu.setGlobalHandler((error: Error, isFatal?: boolean) => {
      errors.push({ message: `${isFatal ? '[FATAL] ' : ''}${error.message}`, stack: error.stack ?? null, timestamp: Date.now(), type: 'exception' });
      if (errors.length > MAX_ERRORS) errors = errors.slice(-MAX_ERRORS);
      prev(error, isFatal);
    });
  }

  let _navRef: { getRootState: () => unknown; navigate: Function; dispatch: Function } | null = null;
  const _stores = new Map<string, { type: string; getState: () => unknown; dispatch?: Function }>();

  function simplify(state: unknown): unknown {
    if (!state || typeof state !== 'object') return null;
    const s = state as { routes?: unknown[]; index?: number };
    if (!Array.isArray(s.routes) || typeof s.index !== 'number') return null;
    const route = s.routes[s.index] as { name?: string; params?: unknown; state?: unknown } | undefined;
    if (!route) return null;
    const result: Record<string, unknown> = { routeName: route.name, params: route.params ?? {}, stack: (s.routes as Array<{ name: string }>).map((r) => r.name), index: s.index };
    if (route.state) result.nested = simplify(route.state);
    return result;
  }

  function safeStr(obj: unknown, max = 50000): string {
    try {
      const seen = new WeakSet();
      const str = JSON.stringify(obj, (_k, v) => { if (typeof v === 'function') return '[Function]'; if (typeof v === 'object' && v !== null) { if (seen.has(v)) return '[Circular]'; seen.add(v); } return v; });
      return str && str.length > max ? JSON.stringify({ __agent_truncated: true, originalLength: str.length }) : (str ?? 'null');
    } catch (e) { return JSON.stringify({ __agent_error: String(e) }); }
  }

  function resolvePath(obj: unknown, path: string): unknown {
    let cur = obj;
    for (const p of path.split('.')) { if (cur == null || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[p]; }
    return cur;
  }

  g.__RN_DEV_BRIDGE__ = {
    __v: BRIDGE_VERSION,
    registerNavRef(ref: typeof _navRef) { _navRef = ref; },
    registerStore(reg: { name: string; type: string; getState: () => unknown; dispatch?: Function }) { _stores.set(reg.name, reg); },
    getNavState() {
      const ref = _navRef ?? g.__NAV_REF__ as typeof _navRef;
      if (!ref) return JSON.stringify({ error: 'No navigation ref' });
      try { return safeStr(simplify(ref.getRootState())); } catch (e) { return JSON.stringify({ error: String(e) }); }
    },
    navigateTo(screen: string, params?: unknown) {
      const ref = _navRef ?? g.__NAV_REF__ as typeof _navRef;
      if (!ref) return JSON.stringify({ error: 'No navigation ref' });
      try { ref.navigate(screen, params); return JSON.stringify({ navigated: true, screen }); } catch (e) { return JSON.stringify({ error: String(e) }); }
    },
    getStoreState(path?: string, type?: string) {
      if (_stores.size === 0) {
        if (g.__REDUX_STORE__ && typeof (g.__REDUX_STORE__ as { getState: () => unknown }).getState === 'function') {
          const rs = g.__REDUX_STORE__ as { getState: () => unknown; dispatch?: Function };
          _stores.set('redux', { type: 'redux', getState: () => rs.getState(), dispatch: rs.dispatch?.bind(rs) });
        }
        if (g.__ZUSTAND_STORES__ && typeof g.__ZUSTAND_STORES__ === 'object') {
          for (const [k, s] of Object.entries(g.__ZUSTAND_STORES__ as Record<string, { getState: () => unknown }>)) {
            if (typeof s.getState === 'function') _stores.set(`zustand:${k}`, { type: 'zustand', getState: () => s.getState() });
          }
        }
      }
      if (_stores.size === 0) return JSON.stringify({ error: 'No stores' });
      for (const [, reg] of _stores) {
        if (type && reg.type !== type) continue;
        let state = reg.getState();
        if (path) state = resolvePath(state, path);
        return safeStr({ type: reg.type, state });
      }
      return JSON.stringify({ error: 'No matching store' });
    },
    dispatchAction(opts: { action: string; payload?: unknown; readPath?: string }) {
      for (const reg of _stores.values()) {
        if (reg.type === 'redux' && reg.dispatch) {
          reg.dispatch({ type: opts.action, payload: opts.payload });
          if (opts.readPath) return safeStr({ dispatched: true, action: opts.action, state: resolvePath(reg.getState(), opts.readPath) });
          return JSON.stringify({ dispatched: true, action: opts.action });
        }
      }
      return JSON.stringify({ error: 'No Redux store' });
    },
    getConsole(opts?: { level?: string; limit?: number }) {
      const level = opts?.level ?? 'all';
      const limit = opts?.limit ?? 50;
      let filtered = consoleBuffer;
      if (level !== 'all') filtered = consoleBuffer.filter((e) => e.level === level);
      const entries = filtered.slice(-limit);
      return JSON.stringify({ entries, total: filtered.length, shown: entries.length });
    },
    clearConsole() { consoleBuffer = []; return JSON.stringify({ cleared: true }); },
    getErrors() { return JSON.stringify(errors); },
    clearErrors() { errors = []; return JSON.stringify({ cleared: true }); },
  };
}

export {};
