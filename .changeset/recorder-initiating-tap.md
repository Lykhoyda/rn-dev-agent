---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Capture navigation-initiating taps on controls mounted before recording starts without duplicating app handler calls, so saved open/close actions begin with the initiating tap instead of an unreachable visibility assertion.
