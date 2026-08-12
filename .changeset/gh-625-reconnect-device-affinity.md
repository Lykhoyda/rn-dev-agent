---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Reconnects now persist a pinned target's device and bundle identity so shared-Metro multi-simulator sessions re-bind the exact pinned device and fail closed with candidates listed instead of silently attaching to a sibling simulator.
