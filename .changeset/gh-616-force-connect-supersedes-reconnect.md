---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

An explicit `cdp_connect force=true` issued while a supervised reconnect is in flight now deterministically supersedes the reconnect with the caller's exact target instead of dead-ending with "Already connecting to Metro...", and without force the refusal now says how to supersede.
