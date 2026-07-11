---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Story 14 (#407): runner transport recovery — every /command carries a commandId; on an ambiguous post-send failure the client issues one short status probe against the runner's outcome journal before invalidating. Recovered results return with meta.transportRecovery; mutating verbs are never auto-resent, eliminating double-fired taps; read-only verbs may be resent once. Unresolvable probes fall through to the existing invalidation path unchanged. Both native runners (iOS rn-fast-runner, Android rn-android-runner) gained a bounded command-outcome journal (32 entries, 8 KB UTF-8 body cap, snapshot/screenshot recorded state-only, error outcomes journaled) and the read-only `status` verb that replays a prior command's retained outcome.
