---
'rn-dev-agent-plugin': patch
'rn-dev-agent-core': patch
---

Focused `device_fill` reports verified success only after a controlled React pre-read and a polled append match, and the iOS runner refuses when synthesized typing is unavailable instead of claiming an unchecked fallback typed.
