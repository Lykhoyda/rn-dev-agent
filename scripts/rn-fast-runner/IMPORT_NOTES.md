# rn-fast-runner — Import Notes

This directory contains a Swift XCTest-based iOS automation runner imported
once (2026-05-15) from an MIT-licensed source. After import we renamed all
identifiers and dropped 3 modules we don't use. We treat this code as ours
going forward — no upstream-sync relationship is maintained.

## Imported

9 Swift source files providing:
- HTTP `POST /command` dispatcher
- Snapshot (XCUI accessibility tree → JSON)
- Interaction (tap, swipe, type, dismissKeyboard, back, scroll)
- Lifecycle (activate, terminate, state queries)
- System modal handling (alerts/permission dialogs)
- Transport (embedded FlyingFox HTTP server)

## Renamed at import time

All upstream identifiers (the project name, app/test targets, scheme, Swift
class names, bundle id, and splash text) were rewritten to the `RnFastRunner*`
namespace as a single import-time sweep. Final names:

| Concern | Value |
|---------|-------|
| Xcode project | `RnFastRunner.xcodeproj` |
| App target | `RnFastRunner` |
| UI test target | `RnFastRunnerUITests` |
| Swift test class | `RnFastRunnerTests` (with command/snapshot/etc. extensions) |
| Bundle id | `dev.lykhoyda.rndevagent.fastrunner` |
| Splash text | `rn-dev-agent fast runner` |

## Dropped at import time

- `RunnerTests+ScreenRecorder.swift` — our `device_record` uses `xcrun simctl io recordVideo` directly
- `RunnerTests+TvRemote.swift` — no Apple TV support in this plugin
- `RecordingScripts/` — supports ScreenRecorder, coupled

## License

See `LICENSE` for the MIT attribution required for the imported code.
