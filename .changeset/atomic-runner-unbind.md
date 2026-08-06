---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Make runner unbind release its exclusive claim and clear the runner binding in one atomic registry transaction, so an interrupted device close or reacquire can no longer leave a divergent store whose dead session permanently vetoes `adopt_stale` with `RUNNER_OWNERSHIP_MISMATCH` (GH #692).
