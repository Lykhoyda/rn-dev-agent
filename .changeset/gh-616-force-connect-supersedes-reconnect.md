---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

The legacy ambient connect handler exported by `rn-dev-agent-core` no longer dead-ends an explicit force reconnect while a supervised reconnect is in flight (it now supersedes it, with a new `CONNECT_IN_FLIGHT` refusal code for non-force callers); the registered `cdp_connect` tool was already safe and is unchanged.
