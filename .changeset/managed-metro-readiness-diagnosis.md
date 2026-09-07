---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Make the managed-Metro startup refusal truthful and give a cold start room to listen (GH #992). When the readiness deadline expires, `METRO_START_UNAVAILABLE` now reports the launcher state and the Metro log tail as they were before the supervisor's own group SIGTERM, and names why the deadline expired (`readiness deadline N ms expired: listener absent … probes, probe unknown …, unowned listener …`). Previously both were read after the kill, so the loader's post-kill `EPIPE: broken pipe, write` and `launcher signal SIGTERM` — consequences of the cleanup — were presented as the cause. The single readiness budget is raised from 20 s to 90 s (`MANAGED_METRO_READINESS_TIMEOUT_MS`, provisional pending a cold-start measurement); the loop still returns the instant Metro is proven and still exits early when the launcher dies, so only a genuinely broken start waits longer. The pre-start `no-install-receipt` advisory is unchanged: it is expected on a session's first build and is not an independent failure.
