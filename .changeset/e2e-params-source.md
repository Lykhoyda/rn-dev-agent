---
"rn-dev-agent-cdp": minor
---

feat(e2e): params source — `.rn-agent/e2e.config.json` supplies per-test param values (with shared `defaults` + secret redaction) so parameterized actions can be locked and run as e2e tests. `cdp_lock_e2e_test` now accepts a param-needing action when the config covers all its params (else `MISSING_PARAMS` listing the gaps); `cdp_run_e2e_suite` runs param tests with their resolved values (else skips with a clear reason). Secret param values (names in `secretParams`) are redacted to `***` in failure output and run records, and only an action's declared params are passed to Maestro (unrelated defaults never leak).
