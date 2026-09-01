---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Expose observed replay runtime-state writes with exact sidecar paths—session-private when fenced and project-local under `.rn-agent/state` for unfenced compatibility—and document that fresh fenced sessions start with isolated action history.
