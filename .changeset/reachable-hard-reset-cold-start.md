---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Let `cdp_restart hardReset=true` complete the cold start it promises from a runner-bound session by classifying a terminated-but-unreaped process as absent rather than as an unreadable identity, and by escalating the bound runner's stop to SIGKILL after its SIGTERM grace once the pid is re-proven to carry that binding's exact birth token.
