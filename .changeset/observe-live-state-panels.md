---
"rn-dev-agent-plugin": patch
"rn-dev-agent-core": patch
---

Fix observe UI Route/Store/Tree panels staying empty while the device mirror shows the running app (#579): the panels now auto-read live state through a new `GET /api/state/(route|store|tree)` endpoint that resolves the CDP client at call time — so they populate on a healthy connection without the agent having run the introspection tools and recover after a reload/reconnect — plus a manual "read live" refresh button in each panel.
