---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Store the package-integration restoration manifest durably inside the session binding, let on-disk manifest bytes authorize only the current owner's restore_integration, and make stale adoption, handoff acceptance, and resumed cleanup validate their capability non-mutatingly — resumed handoff cleanup now re-proves the exact consumed handoff and its original token against a durable cleanup binding pinned to the accepting target session and claim epoch, so a stale-adoption transfer revokes the old handoff capability in favor of the adoption handle — and refuse before any transfer or mutation unless the binding itself carries a SHA-256-verified restoration manifest, reporting file-state diagnostics and the supported recovery step instead of auto-reconciling.
