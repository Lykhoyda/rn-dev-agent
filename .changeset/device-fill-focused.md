---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

`device_fill` gains `focused: true`, which types into the already focused iOS field through a synthesized text event and confirms the value through the React tree only when that named field is the focused responder, returning `typed: true, verified: false` when it cannot.
