---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Post-merge review fixes for the Phase B device-smoke surface (two independent reviewers, findings cross-validated): (1) the screen rect used by direction device_scroll/device_swipe and scrollintoview's viewport check is now a hittable-first union — off-screen mounted content (RN FlatList windowing keeps rows past the fold in the tree with real coords, marked hittable:false) can no longer inflate the viewport and push gestures off the physical screen; all-nodes union remains as fallback for snapshots without hittable data. (2) The three direct fastSwipe call sites fall back to resolveBundleId('ios') when a legacy session lacks appId, closing the reopened host-app-drag gap. (3) The nightly integrity lane captures zip listings before grepping (grep -q + pipefail could SIGPIPE-false-fail a successful match). (4) The smoke's counter assertion is anchored (/^count: 1$/) and the screenshot check documents its encoding-only scope.
