// rn-dev-agent dev-bridge
//
// In DEV builds, exposes a small object on `globalThis` that the
// rn-dev-agent plugin's MCP tools (cdp_navigate, cdp_navigation_state,
// cdp_store_state, etc.) read when their fast paths need a registered
// reference instead of walking the React fiber tree.
//
// Most apps don't need to call `getBridge()` at all — the plugin's CDP
// fallback finds <NavigationContainer>'s ref by walking the fiber tree
// and works without any registration. Two cases where explicit
// registration helps:
//
//   1. Class-component or pre-React-Navigation-6 roots where the fiber
//      walk can't locate the ref reliably.
//   2. Zustand stores — these have no fiber-walkable signal, so the
//      plugin needs `globalThis.__ZUSTAND_STORES__` to be populated.
//
// Production: every assignment is gated by `__DEV__`, so Metro tree-
// shakes the entire body. Zero runtime cost in release bundles.

const g = globalThis as Record<string, unknown>;

export interface DevBridge {
  /**
   * Set `globalThis.__NAV_REF__` for `cdp_navigate` /
   * `cdp_navigation_state` / `cdp_nav_graph`. Idempotent —
   * call once after creating your NavigationContainer ref.
   */
  registerNavRef(ref: unknown): void;
  /**
   * Set `globalThis.__ZUSTAND_STORES__` so `cdp_store_state` can read
   * Zustand state. Pass a flat record mapping short names to your
   * store hooks (e.g. `{ auth: useAuthStore, cart: useCartStore }`).
   */
  registerStores(stores: Record<string, unknown>): void;
}

if (__DEV__) {
  const bridge: DevBridge = {
    registerNavRef(ref) {
      g.__NAV_REF__ = ref;
    },
    registerStores(stores) {
      g.__ZUSTAND_STORES__ = stores;
    },
  };
  g.__RN_DEV_BRIDGE__ = bridge;
}

/**
 * Get the bridge in DEV builds; returns null in production. Idiomatic
 * usage from your app entry:
 *
 * ```ts
 * import { getBridge } from './.rn-agent/dev-bridge';
 *
 * const navigationRef = createNavigationContainerRef<RootStackParams>();
 * getBridge()?.registerNavRef(navigationRef);
 * getBridge()?.registerStores({ auth: useAuthStore });
 * ```
 *
 * The optional chain is intentional: it makes both branches (DEV with
 * bridge / prod without) compile and run with no extra checks at the
 * call site.
 */
export function getBridge(): DevBridge | null {
  if (!__DEV__) return null;
  return (g.__RN_DEV_BRIDGE__ ?? null) as DevBridge | null;
}
