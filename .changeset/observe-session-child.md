---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Make Observe a read-only child of the session: `observe start` and `restart` now require only the live session (matching autostart's degraded mode) instead of the full device/Metro/bundle/runner authority chain, while the observe-port claim, capability and instance request authentication, fenced stop/cleanup chain, and the full authority gates on the E2E run and action panels all stay exactly as before.
