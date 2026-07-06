---
'rn-dev-agent-plugin': patch
---

Android device-smoke keyboard-guard step: accept both non-blocked guard outcomes (`dismissed` and `not_occluded`) instead of pinning `dismissed`. Which one fires depends on the emulator's exact keyboard geometry (whether the bottom button's tap point lands inside the IME frame or at/below its edge), which varies run-to-run. The smoke now verifies the guard evaluated on-device and did not wrongly block the tap; the precise `shouldDismiss` predicate stays unit-tested in `KeyboardGuardTest.kt`.
