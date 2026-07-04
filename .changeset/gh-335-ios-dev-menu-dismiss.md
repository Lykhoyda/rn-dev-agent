---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`cdp_dev_settings` gains a `hideDevMenu` action that dismisses the iOS
expo-dev-client dev menu bottom sheet over CDP via `ExpoDevMenu.hideMenu()`
(#335). Because it runs through `client.evaluate` instead of a coordinate
tap/swipe, it never triggers the touch-induced Hermes detach the issue
describes — the JS thread stays attached and the in-memory store survives.
`cdp_reload` now also best-effort auto-dismisses the menu on iOS after
reconnect, so the agent lands on the app instead of behind the sheet. The
dismiss resolves the `ExpoDevMenu` native module through a multi-tier chain
(`globalThis.expo.modules` → `NativeModules` → TurboModule proxies) and is a
silent no-op on non-expo builds.
