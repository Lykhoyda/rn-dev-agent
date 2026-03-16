# S6: Offline Banner with Network Detection — E2E Proof

**Date:** 2026-03-16
**Device:** iPhone 17 Pro (iOS 26.3, Simulator)
**Method:** CDP evaluate + store_state + simctl screenshots

## Flow

| Step | Screenshot | Action | Verification |
|------|-----------|--------|--------------|
| 1 | 01-initial-online.jpg | Navigate to Feed screen (already active) | Route confirmed: Tabs > HomeTab > Feed. `network.isOffline = false` |
| 2 | 02-offline-banner.jpg | `cdp_evaluate`: set `globalThis.__OFFLINE__ = true` | Red "No Connection" banner visible. Store: `network.isOffline = true` |
| 3 | 03-retry-offline.jpg | Confirm offline banner persists with Retry button | Banner still visible with "No Connection" text and "Retry" button |
| 4 | 04-after-retry.jpg | Simulate retry: clear `__OFFLINE__`, dispatch `setOnline` | Banner dismissed. Store: `network.isOffline = false` |

## Key State Snapshots

- Step 1 (initial): `network.isOffline = false`
- Step 2 (offline): `network.isOffline = true` — banner appeared
- Step 4 (after retry): `network.isOffline = false` — banner dismissed
- Error count after all steps: 0

## Deviations from Plan

- **Green "Back Online" toast not captured in screenshot**: The toast renders for 2s with LayoutAnimation easing. The `simctl screenshot` command latency (~200ms) combined with the 2s poll interval means the toast appears and auto-dismisses before a screenshot can be captured externally. The toast logic is verified by: (a) banner disappears after online transition, (b) store state transitions correctly, (c) code review confirmed the `showOnlineToast` state + 2s setTimeout logic. This is a limitation of screenshot-based proof for transient UI elements.
- **Retry simulated via CDP dispatch instead of UI tap**: `cdp_interact` is deprecated and agent-device CLI was not available for tap interaction. The retry handler logic (`__OFFLINE__ = false` + `dispatch(setOnline())`) was triggered via `cdp_evaluate` which exercises the same code path.

## Files

- `01-initial-online.jpg` — Feed screen in normal online state (no banner)
- `02-offline-banner.jpg` — Red "No Connection" banner at top with Retry button
- `03-retry-offline.jpg` — Offline state confirmed before retry
- `04-after-retry.jpg` — Banner dismissed after retry, back to normal state
