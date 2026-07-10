---
'rn-dev-agent-core': patch
---

Fix #523: break the expensive iOS recovery chain. (1) `cdp_reload` that ends with zero targets now auto-chains `simctl terminate + launch` and reconnects instead of returning RECONNECT_TIMEOUT (`recovered_via: terminate_launch` in meta). (2) The last-connected bundleId is persisted per platform in `.rn-agent/state/last-bundle-ids.json`, so `cdp_restart hardReset:true` can relaunch even after a bridge worker restart wiped the in-memory cache. (3) `cdp_dismiss_dev_client_picker` now works on iOS (snapshot/press route through rn-fast-runner — the legacy-daemon guard was obsolete), also clears the stale-server "Error loading app" dialog, prefers the picker row matching the project's Metro port, and deprioritizes stale link-local (169.254.x) entries; `device_deeplink` auto-dismisses the picker on iOS too.
