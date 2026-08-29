---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

maestro_run now emits a canonical per-attempt run ledger and attaches a ledger-derived `trailingVerification` qualifier block (`trailingVerificationOnly: true`, existing failureKind unchanged) to a still-failed flow whose mutating commands all provably completed while only a trailing wait/assert timed out, and cdp_run_action consumes it to refuse selector auto-repair and swap the simulator-reboot advice for verify-first guidance (final goal state stays unproven; genuine wedges keep the existing reboot hint).
