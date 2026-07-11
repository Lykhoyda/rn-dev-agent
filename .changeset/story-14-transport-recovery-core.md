---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Story 14 (#407): runner transport recovery — every /command carries a commandId; on an ambiguous post-send failure the client issues one short status probe against the runner's outcome journal before invalidating. Recovered results return with meta.transportRecovery; mutating verbs are never auto-resent, eliminating double-fired taps; read-only verbs may be resent once. Unresolvable probes fall through to the existing invalidation path unchanged.
