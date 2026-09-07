---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Report the managed-Metro readiness failure from the pre-kill launcher state and log tail, and raise the budget to a 90 s default configurable via `.rn-agent/config.json` → `metro.readinessTimeoutMs` (GH #992).
