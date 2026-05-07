// Typed declarations for the rn-dev-agent dev-bridge globals. Without
// these, `globalThis.__NAV_REF__` requires a cast at every call site.
// With them, your IDE autocompletes and TypeScript catches typos.

export {};

declare global {
  /**
   * Set by `getBridge()?.registerNavRef(ref)` (see ./dev-bridge.ts).
   * Read by the rn-dev-agent plugin's MCP tools (`cdp_navigate`,
   * `cdp_navigation_state`, `cdp_nav_graph`).
   *
   * Type is `unknown` so the dev-bridge stays portable — your app can
   * pass a fully-typed `NavigationContainerRef<P>` and the plugin
   * reads it via duck-typing on `.navigate` / `.getRootState`.
   */
  // eslint-disable-next-line no-var
  var __NAV_REF__: unknown;

  /**
   * Set by `getBridge()?.registerStores({ name: useFooStore, ... })`.
   * Read by `cdp_store_state` for the Zustand fast path.
   */
  // eslint-disable-next-line no-var
  var __ZUSTAND_STORES__: Record<string, unknown> | undefined;

  /**
   * The dev-bridge object itself. DEV-only — undefined in production.
   * Prefer `getBridge()` over reading this directly; the function
   * returns null in production so call-site code doesn't need a guard.
   */
  // eslint-disable-next-line no-var
  var __RN_DEV_BRIDGE__: {
    registerNavRef: (ref: unknown) => void;
    registerStores: (stores: Record<string, unknown>) => void;
  } | undefined;
}
