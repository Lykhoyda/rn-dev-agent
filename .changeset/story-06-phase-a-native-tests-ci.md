---
'rn-dev-agent-plugin': patch
---

Story 06 Phase A (#387): the native runner unit suites now execute in CI.
`native-tests.yml` runs `gradlew testDebugUnitTest` (ubuntu) and
`xcodebuild test` with a skip-list (macos-15, simulator) — path-filtered with
green skip notices on TS-only PRs, unconditional on pushes to main. Local
entry points: `npm run test:native:android` / `npm run test:native:ios`.
Also removes a dangling `RnFastRunnerTests` testable from the shared scheme.
