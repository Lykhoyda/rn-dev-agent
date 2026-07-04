---
"rn-dev-agent-plugin": patch
---

SessionStart auto-installs idb in the background (`brew install idb-companion && pipx install fb-idb`) for the observe live mirror's 20-30fps fast path — never blocks session start (detached worker, pidfile guard, 24h failure backoff). `/doctor` and `/setup` gain an idb row: OK / INSTALLING (background) / MISSING with the manual command.
