---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Record a private per-attempt managed-Metro enforcement diagnostic capturing the preparation outcome, preflight flags, phase timings and a sanitized child stderr tail, so a sandbox downgrade can be diagnosed without changing any permission, timeout or fallback behavior.
