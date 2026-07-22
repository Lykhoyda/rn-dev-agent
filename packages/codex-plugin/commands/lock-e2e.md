---
command: lock-e2e
description: Promote a verified param-free action into a frozen e2e regression test after one strict replay.
argument-hint: "<action-name> [--relock]"
---

# Lock an e2e action

Treat the text after `$rn-dev-agent:lock-e2e` as a conceptual request. Parse one
required action ID and optional `--relock`. Reject missing/extra positionals,
duplicate flags, and unknown flags; never place raw request text in a shell.

Require `cdp_lock_e2e_test` in the active task. If absent, stop and use the
read-only discovery diagnosis.

1. Call `cdp_lock_e2e_test` with `{ actionId, relock }`.
2. On `STRICT_RUN_FAILED`, explain that the action must first pass without
   repair. Offer the separately confirmed repair/replay workflow, then retry
   only after it passes strict.
3. On `PARAMS_UNSUPPORTED`, explain that this lock version supports param-free
   actions only.
4. On success, report the frozen path and inclusion in `cdp_run_e2e_suite`.

Do not bypass strict replay, edit the frozen output directly, or substitute a
raw Maestro result.
