---
"rn-dev-agent-cdp": minor
---

#317 Phase 2: when an action fails on iOS 26.x because WebDriverAgent is blind (empty accessibility tree), `cdp_run_action` now replays the action's id-based steps through the CDP/JS transport and returns a real pass/fail verdict — restoring action replay (and the observe Regression Run button) on iOS 26.x. The fallback fires on both observed blind failure modes — `SELECTOR_NOT_FOUND` (probe = the failed selector) and `UNKNOWN`/WDA-died-at-launch (probe = the action's first testID) — guarded by an exact-match CDP-tree oracle so genuine drift still routes to repair. Fallback verdicts are labeled `transport:'cdp-js'` (handler-level semantics) and failed replays record `failureCode:'TRANSPORT_BLIND'`; unsupported step types (e.g. text-based selectors) fail loudly rather than passing silently.
