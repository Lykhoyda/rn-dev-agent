---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

An incomplete renderer-root scan (missing or malformed DevTools `renderers` registry plus the empty-ID early-exit) is no longer treated as proof the app is still mounting, so a live root on a sparse renderer ID above 5 keeps the legacy no-navigation result instead of `mounting: true`.
