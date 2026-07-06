---
'rn-dev-agent-plugin': patch
---

Story 06 Phase B: add a nightly device-smoke workflow that drives the golden device_* command set through the real bridge (MCP over stdio) against tiny native contract fixtures (test-fixtures/{ios,android}-fixture) on a booted simulator/emulator, plus a release-artifact-integrity lane and 2-consecutive-red tracking-issue alerting. Local `npm run smoke:ios` / `smoke:android` run the same golden set against a developer's own device.
