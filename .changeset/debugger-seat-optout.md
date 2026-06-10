---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

Debugger-seat coexistence with React Native DevTools + silent hook-mode network capture.

- New opt-out for background auto-reconnect: `RN_CDP_AUTOCONNECT=0` or `.rn-agent/config.json` `{ "cdp": { "autoConnect": false } }`. In passive mode the bridge yields the single RN debugger seat to the visual DevTools and reconnects only on explicit tool calls. Resolved mode is visible in `cdp_status` → `autoConnect` and `/doctor`.
- Hook-mode network capture (RN < 0.83 fallback) no longer transports entries via `console.log("__RN_NET__:…")` — entries go to an in-app ring buffer drained on demand, so Metro logs and the user's DevTools console stay clean.
