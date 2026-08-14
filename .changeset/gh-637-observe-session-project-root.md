---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Resolve the Observe actions/e2e project root from the bound session's declared app root (falling back to RN_PROJECT_ROOT, then heuristic discovery) and refuse truthfully on foreign, missing, ambiguous, or non-project roots instead of showing another checkout's actions or a silently empty panel.
