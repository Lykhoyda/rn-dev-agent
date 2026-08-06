---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Project strict proof as an explicit opt-in `proofOverlay` (`active` only while a run is in flight between `begin_rehearsal` and `finalize`/`discard`) outside the grouped `session`/`target`/`runtime`/`automation` sub-objects, keeping the existing `proof` child flag and all redaction rules unchanged.
