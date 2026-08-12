---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

If the iOS idb live mirror stays alive without a first frame, Observe now fails that stream and falls back to the simctl screenshot loop on the same device instead of leaving a blank 0x0 image.
