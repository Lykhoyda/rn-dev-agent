---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Saved actions can declare `entry: parked` to replay against the already-running app without a launchApp prologue: replay verifies the park anchor read-only and refuses `PARK_STATE_MISSING` before any step when the declared park state is absent.
