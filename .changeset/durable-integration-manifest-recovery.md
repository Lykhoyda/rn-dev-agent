---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Store the package-integration restoration manifest durably inside the session binding and let stale adoption and restore_integration reconcile or refuse a legacy binding whose manifest is unavailable, so an adopted session can always recover through supported apply/restore/release instead of deadlocking on an unrestorable integration fence.
