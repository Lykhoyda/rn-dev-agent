---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Detect a wildcard-bound Metro listener in the managed-Metro sandbox preflight by probing every local address shape, so a real Expo server that listens on all interfaces no longer reads as unoccupied and falls back to reported-v1.
