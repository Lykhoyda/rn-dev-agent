---
"rn-dev-agent-android-runner": minor
---

Story 14 (#407): the Android rn-android-runner records every executed /command in a bounded, UTF-8-byte-capped outcome journal keyed by commandId and answers a new `status` verb that replays a prior command's retained outcome (including recorded error bodies). This lets the TS client recover a lost response after an ambiguous transport failure without re-sending mutating gestures. `status` joins the runner's REQUIRED command surface.
