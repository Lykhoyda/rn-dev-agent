---
'rn-dev-agent-plugin': patch
---

`device_fill` gains `focused: true`, which types into the already focused iOS field through a synthesized text event and verifies through the React tree when the testID is known.
