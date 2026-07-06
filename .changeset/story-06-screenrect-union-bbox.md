---
'rn-dev-agent-plugin': patch
---

Fix direction `device_scroll`/`device_swipe` computing a no-op gesture on Android when no snapshot node spans the full window. The screen rect (used to size direction gestures) was picked as the largest `(0,0)`-anchored node; on some Android snapshots that is a ~128px top-chrome strip while the scrollable content sits below it, so scrolls dragged ~50px in the status bar and never moved the list. The screen rect is now the union bounding box of all node rects (max extent), recovering the true viewport on both platforms.
