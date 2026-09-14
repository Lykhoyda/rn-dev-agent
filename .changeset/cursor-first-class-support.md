---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Add first-class Cursor Plugin manifests and `${CURSOR_PLUGIN_ROOT}` spawn on the Claude package, keep the process lock on every host, and make the lock-conflict message host-neutral without kill, lock-delete, or `--no-lock` advice (GH #1038, #872).
