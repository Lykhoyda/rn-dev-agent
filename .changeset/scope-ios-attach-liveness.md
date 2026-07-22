---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Scope iOS attach-only app liveness checks to the resolved simulator UDID instead of the ambiguous `booted` alias, and refuse when exact device identity is unavailable.
