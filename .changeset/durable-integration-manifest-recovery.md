---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Store the package-integration restoration manifest durably inside the session binding and make stale adoption, handoff acceptance and resumed cleanup, and restore_integration refuse before any transfer or mutation when a binding lacks a SHA-256-verified manifest, reporting file-state diagnostics and the supported manifest-recovery step instead of auto-reconciling.
