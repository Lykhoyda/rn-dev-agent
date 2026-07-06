---
'rn-dev-agent-plugin': patch
---

Nightly device-smoke fixes: (1) the iOS lane now shuts down any pre-booted simulators before booting exactly one, so `device_snapshot open` (which refuses on >1 booted iOS device) resolves deterministically. (2) The keyboard-guard step is platform-split: Android UiAutomator drops occluded views, so the occluded bottom button is absent from a post-fill snapshot — the driver now presses the pre-fill ref (its cached coords are under the keyboard) without re-snapshotting, exercising the Android dismiss contract; iOS keeps its re-snapshot + refusal-contract path (XCUITest reports occluded elements).
