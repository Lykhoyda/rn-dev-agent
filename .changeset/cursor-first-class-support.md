---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Cursor Plugin launch on the Claude package: `${CURSOR_PLUGIN_ROOT}` supervisor spawn with `--no-lock`, skip the Claude process lock on Cursor and when the lock key is the user home, and host-neutral lock-conflict copy (GH #1038, #872). Device and session authority stay the singleton. Node.js remains >= 24.
