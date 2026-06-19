---
"rn-dev-agent-cdp": minor
---

#317 Phase 2: when an action fails on iOS 26.x because WebDriverAgent is blind (empty accessibility tree), cdp_run_action now replays the action's steps through the CDP/JS transport and returns a real pass/fail verdict — restoring the observe Regression Run button on iOS 26.x. Fallback verdicts are labeled transport:'cdp-js' (handler-level semantics); unsupported step types fail loudly.
