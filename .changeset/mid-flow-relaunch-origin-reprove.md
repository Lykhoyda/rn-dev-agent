---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Let a Maestro flow containing a mid-flow `launchApp` relaunch run to completion by re-proving the managed native origin once at flow end — reconnect-only, with no second cold start — instead of aborting between stages when the relaunched dev-client has not re-registered yet, so the flow's own post-launch steps can drive it back to the managed origin while a genuine authority mismatch still fails the run.
