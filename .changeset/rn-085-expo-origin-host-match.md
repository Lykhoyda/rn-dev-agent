---
"rn-dev-agent-plugin": patch
---

Fix B178: CDP introspection returning zero frames on Expo SDK 56 / RN 0.85. The B177 Origin fix used `localhost`, which clears `@react-native/dev-middleware`'s loopback gate (no 401) but trips Expo SDK 56's **second** origin gate in `createDebugMiddleware` (`isMatchingOrigin`): it requires the `Origin` host to equal the dev server's `serverBaseUrl` host (`127.0.0.1`), and a mismatch is force-closed via `socket.terminate()` → a **1006 abnormal close right after connect, before any CDP frame relays**. Switching `metroOrigin` to emit `127.0.0.1` clears **both** gates (and bare RN's single gate), fully restoring `cdp_status` / `cdp_component_tree` / `cdp_store_state` / `cdp_evaluate` on RN 0.85. Verified end-to-end against a live RN 0.85 app: `Runtime.evaluate` plus Redux / Zustand / navigation reads now relay. (B178 / D1242)
