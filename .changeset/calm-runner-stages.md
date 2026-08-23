---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Make maestro-runner pin installation idempotent with independently verified temporary stages and atomic publication so concurrent or interrupted installers cannot block the cache.
