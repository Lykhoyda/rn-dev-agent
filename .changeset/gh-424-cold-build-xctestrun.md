---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

iOS cold start persists a reusable `.xctestrun` (#424): `startFastRunner()` now
runs `xcodebuild build-for-testing` first when no test product exists and then
launches via the same `test-without-building` path as every warm start, instead
of a single bare `xcodebuild test` — which never writes a `.xctestrun`, so
self-built runners were permanently "not prebuilt" and every runner death cost
another multi-minute cold build. The build phase keeps the 360s cold timeout;
the launch phase uses the standard 30s ready window. The #418 stale-artifact
rebuild tier funnels through the same path, so it also leaves a reusable
artifact now.
