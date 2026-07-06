---
'rn-dev-agent-plugin': patch
---

Make the rn-fast-runner warm-launch ready gate overridable via `RN_FAST_RUNNER_READY_TIMEOUT_MS` (default 30s) so a slow CI simulator that needs longer to install+launch+attach the XCUITest runner is not a false `RN_FAST_RUNNER_DOWN`. The nightly iOS device-smoke lane also now reuses the image's already-booted (warm) simulator and shuts down only extras, instead of a blanket `shutdown all` that cold-boots the target and makes the runner launch time out.
