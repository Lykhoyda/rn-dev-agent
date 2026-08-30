---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Reuse completed WebDriverAgent builds across maestro-runner spawns through a toolchain-fingerprinted persistent store with atomic publication, removing the ~75 s per-invocation WDA rebuild while keeping per-spawn cache isolation, corruption fallback, and cold-build behavior.
