# iOS contract fixture

Tiny SwiftUI app the nightly device smoke (`npm run smoke:ios`) drives through
the real bridge — a *contract* fixture, not a demo app (Story 06 Phase B, #387).
Single Swift file compiled with `swiftc`; no Xcode project, no JS toolchain.

| Element | accessibilityIdentifier | Golden-set role |
|---|---|---|
| Increment button | `fixture_button` | tap → observable state change |
| Count label | `fixture_count` | assert increment after `device_press` |
| Text field | `fixture_input` | `device_fill` + read-back verify |
| 100-row list | `fixture_list`, rows `fixture_row_<n>` | `device_scroll` / `device_scrollintoview` |
| Bottom bar field + button | `fixture_bottom_input`, `fixture_bottom_button` | keyboard-occlusion scenario (#370) |

`.ignoresSafeArea(.keyboard)` is load-bearing: it disables SwiftUI's keyboard
avoidance so the bottom bar stays genuinely occluded by the software keyboard.

## Build / install / launch

```bash
bash build.sh
xcrun simctl install booted build/Fixture.app
xcrun simctl launch booted dev.lykhoyda.rndevagent.fixture
```
