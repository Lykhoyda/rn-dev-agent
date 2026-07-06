---
'rn-dev-agent-plugin': patch
---

Nightly iOS device-smoke lane: build the rn-fast-runner fresh each run instead of restoring DerivedData from cache. A restored DerivedData drove an unreliable `test-without-building` warm launch (`RN_FAST_RUNNER_DOWN`), whereas a fresh `build-for-testing` then warm launch is the known-good path. The ~5 min build is well within the 40 min lane timeout and the nightly budget.
