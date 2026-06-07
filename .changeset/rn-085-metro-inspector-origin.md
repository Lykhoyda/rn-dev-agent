---
"rn-dev-agent-plugin": patch
---

Fix CDP-bridge connection failure on React Native 0.85 / Expo SDK 56. RN 0.85's Metro inspector proxy (`@react-native/dev-middleware`) now enforces a WebSocket `Origin` allowlist (loopback hostnames only) as a CSRF defense and returns **HTTP 401** to the bridge's header-less `ws` clients — breaking `cdp_status` and all CDP introspection on the newest RN. A new `metroOrigin()` helper (`scripts/cdp-bridge/src/ws-origin.ts`) synthesizes a loopback `Origin` matching the dev-server port; it is now sent on all three Metro WebSocket clients (`cdp/connect.ts`, `cdp/multiplexer.ts`, `metro/events-client.ts`). Verified end-to-end: the handshake now succeeds against an RN 0.85 / SDK 56 app (proven: no-Origin → 401, loopback Origin → OPEN). (B177 / D1240)
