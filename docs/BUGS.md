# Known Bugs & Issues

## Open

### B1: Network.enable may silently succeed on RN < 0.83
**Severity:** Medium
**Description:** Hermes accepts `Network.enable` without error on older RN versions, but doesn't emit events for JS fetch/XHR traffic. The bridge sets `networkMode = "cdp"` and skips the fallback hook, resulting in empty network logs.
**Workaround:** The fetch/XHR hook fallback (`NETWORK_HOOK_SCRIPT`) exists but is only injected when `Network.enable` throws. May need to always inject both and merge results.
**Status:** Open — needs testing with RN < 0.83

### B2: waitForReact timeout may be too short for cold starts
**Severity:** Low
**Description:** `REACT_READY_TIMEOUT_MS` is 8000ms. First Metro bundle can take 30-60s. If timeout fires, helpers inject into a non-ready environment.
**Workaround:** User can call `cdp_status` again after app finishes loading.
**Status:** Open — consider increasing to 30s or making configurable

## Resolved

(none yet)
