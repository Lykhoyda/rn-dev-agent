---
'rn-dev-agent-plugin': patch
---

Fix device_scroll/device_swipe silently no-oping on iOS: the drag /command body omitted the target appBundleId, so the runner cleared its target, activated its own RnFastRunner host app, and dragged on a blank screen — every coordinate scroll/swipe returned ok:true with zero movement while foreground-stealing from the app under test. All fastSwipe dispatch sites now forward the active session's appId. Found by the Story 06 Phase B golden-set smoke before it ever reached CI.
