---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

The login prologue remains a fail-stop navigation helper: it requires a fresh user-login RunRecord, terminally blocks credential fallbacks, and coexists with locked e2e login proof. A passing helper is not PR proof.
