---
'rn-dev-agent-plugin': patch
---

Make the nightly device-smoke keyboard-guard step iOS-only. iOS reliably tests the #370 verify-or-refuse contract (XCUITest reports the occluded button; the guard refuses with `KEYBOARD_OCCLUDED`/`dismiss_failed`). Android is skipped on-device because UiAutomator drops occluded views and its IME-frame containment check is edge-sensitive — the outcome (dismiss vs a tap swallowed at the frame edge) varies run-to-run. Android's `shouldDismiss` predicate stays precisely unit-tested in `KeyboardGuardTest.kt` (Phase A CI), so the on-device Android step added flake, not coverage.
