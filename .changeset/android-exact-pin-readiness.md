---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Give Android exact Dev Client pinning a bounded cold-start readiness window so a target that passes its initial CDP probe but stalls during setup can be disconnected and re-listed once it becomes responsive, while preserving exact Metro, app, and device filtering and the existing iOS timeout.
