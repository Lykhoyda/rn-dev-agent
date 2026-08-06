---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Capture the tap that initiates a navigation when the tapped control was already mounted at record start, so a recorded open/close walk saves as a flow that replays open → visibility assertion → close from its declared start route instead of beginning with an unreachable assertion.
