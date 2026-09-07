---
'rn-dev-agent-core': patch
'rn-dev-agent-plugin': patch
---

Login path corrections (#990, #993). Managed dev-client replay through `cdp_run_action` and `cdp_login_prologue` now refuses a flow containing `clearState` before any runner call (`DEV_CLIENT_CLEARSTATE_REFUSED`) instead of running the destructive relaunch and then reporting `METRO_ORIGIN_MISMATCH`; when a flow-owned `launchApp` relaunch does precede an origin failure, the error names that relaunch as the cause while keeping its code and axis. `cdp_auto_login` compares the whole route chain root→leaf (so `auth › intro` is an auth screen) and reports the observed chain on a negative. An unpinned action with regex text selectors gets the terminal regex refusal first instead of being sent to `migrate-actions`, which would refuse it. A linked worktree whose actions link is `LINK_FOREIGN` now gets a remediation that names the single accepted target and says whether it exists.
