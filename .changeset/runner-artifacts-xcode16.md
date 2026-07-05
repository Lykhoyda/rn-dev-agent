---
'rn-dev-agent-plugin': patch
---

Fix the release-triggered iOS runner-artifact build (Runner artifacts workflow):
the `build-ios` job ran on `macos-14` (Xcode 15.4), which cannot open
`RnFastRunner.xcodeproj` in project format 77 — its first real invocation (the
v0.64.2 release push) failed with "future Xcode project file format (77)" and
the runner manifest was never generated, so installs kept resolving to local
builds. The job now runs on `macos-15` (Xcode 16.x), matching `native-tests.yml`
and `codeql.yml`, which already build this project green.
