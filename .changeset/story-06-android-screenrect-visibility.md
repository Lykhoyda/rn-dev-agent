---
'rn-dev-agent-plugin': patch
---

Fix two Android device-control defects surfaced by the Story 06 Phase B smoke: (1) with interactive-windows snapshots (#370), the status bar precedes the app window, and the screen-rect heuristic took the first (0,0)-anchored node — so direction-based device_scroll/device_swipe computed gestures inside the status bar; it now picks the largest full-bleed rect. (2) The in-tree rn-android-runner could not re-foreground an app under test on API 30+ because its manifest lacked a package-visibility <queries> declaration (getLaunchIntentForPackage returned null → "No launch intent for package …"); a MAIN/LAUNCHER queries entry restores visibility.
