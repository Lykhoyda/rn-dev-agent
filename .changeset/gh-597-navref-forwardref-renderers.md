---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Fix `cdp_navigate`/`cdp_navigation_state`/`cdp_nav_graph` nav-ref discovery failing with "Navigation ref not found" on multi-renderer bridgeless apps: the fiber walk now resolves NavigationContainer names through React Navigation 7's forwardRef wrapper (`fiber.type.render`) on every registered renderer.
