---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

Refuse orphaned integrated builds with exit code 2 and the supported `restore_integration` repair instead of starting an unmanaged bundler, and bound every stdio-capturing session-CLI wait so wedged CLIs fail typed; projects integrated by an earlier version must re-apply integration to refresh their on-disk adapter.
