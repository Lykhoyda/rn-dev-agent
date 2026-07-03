---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

iOS `device_screenshot` honors the caller's `path` (#422): iOS pixels now route
to `xcrun simctl io screenshot` even with an rn-fast-runner session open — the
runner's screenshot verb writes inside its own sandbox and returns a relative
`tmp/…` path the host can never serve, which blanked the observe UI panel and
broke `sips` resizing (`meta.resize.reason: no-dimensions`). simctl was already
the flow-active and runner-down backend; it is now the sole iOS pixel path
("pixels → simctl", D1249). Android is unchanged (its runner honors `outPath`
host-side). Defense-in-depth: the observe recorder rejects relative screenshot
paths instead of resolving them against the bridge cwd.
