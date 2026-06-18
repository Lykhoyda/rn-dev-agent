---
"rn-dev-agent-cdp": minor
---

feat(e2e): regression runner engine — `cdp_lock_e2e_test` promotes a verified (param-free) action into a frozen, executable locked e2e test, and `cdp_run_e2e_suite` runs all locked tests strict (no auto-repair) on the booted sim, persisting a suite-run report with verdict, per-test classification (regression vs infra, params skipped), and a newly-failing-since-last-green diff. Engine only; observe page + CSRF HTTP trigger land in a follow-up.
