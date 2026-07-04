---
'rn-dev-agent-cdp': minor
'rn-dev-agent-plugin': minor
---

Prebuilt runner artifacts (Story 01, #382): the iOS rn-fast-runner and Android
rn-android-runner now resolve from a verified prebuilt artifact — a SHA-256-checked
local cache, then a download of the release asset for the exact plugin version —
before falling back to the on-machine build. This removes the multi-minute cold
`xcodebuild` / Gradle build from the first `device_snapshot action=open` once a
release ships the artifacts. Resolution is fail-open: any missing manifest, offline
state, 404, checksum mismatch, or unsafe archive falls back to the local build with a
one-line `meta.note`, never a hard failure. `RN_RUNNER_BUILD=local` forces the local
build. `cdp_status` / `/doctor` now report runner provenance (`prebuilt v<X>` vs
`local-built`). Until a release ships the artifacts, builds resolve to `local` by
design.
