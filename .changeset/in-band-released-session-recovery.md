---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Resolve a fresh session for the next worker when the current one is released or proven stale, so `rn_session action=release` is no longer a `SESSION_OWNER_LOST` dead end and released or proven-stale rows never trigger a spurious `SESSION_AUTHORITY_REQUIRED: multiple live sessions`.
