---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Add first-class Cursor Plugin manifests and `${CURSOR_PLUGIN_ROOT}` spawn on the Claude package, keep the process lock on Claude and Cursor spawns, make the lock-conflict message host-neutral without kill, lock-delete, or `--no-lock` advice, and resolve reused Claude command/skill helper paths through a host-neutral plugin-root fallback that includes `CURSOR_PLUGIN_ROOT` (GH #1038, #872).
