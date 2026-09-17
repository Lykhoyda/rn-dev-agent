---
'rn-dev-agent-plugin': patch
---

`device_fill` gains `focused: true`, which types into the already focused iOS field through a synthesized text event and confirms the value through the React tree when it can, returning `typed: true, verified: false` when it cannot.
