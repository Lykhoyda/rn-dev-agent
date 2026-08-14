---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Bound dead-Metro `cdp_status` to the discovery scan budget by skipping runner-spawning picker probes when no Metro is up, and absorb the fresh-simulator first-start rn-fast-runner transient with one bounded internal retry after the failed first spawn provably exits.
