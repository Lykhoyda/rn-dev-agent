---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

Fix a batch of bugs, regressions, and reliability issues surfaced by a multi-agent repo audit.

**Security**
- Redaction no longer leaks private-key material. `redactString` now applies secret patterns BEFORE truncating (a >2000-char PEM previously had its `-----END-----` marker severed by truncation so the key body passed through), and the PEM rule now matches multi-word labels like `RSA PRIVATE KEY` / `OPENSSH PRIVATE KEY` (the old single-word pattern never matched the most common headers).

**Device interaction**
- `device_scroll` no longer throws on Android (and on the iOS fast-runner fallback): a direction-form scroll is now converted to coordinates before dispatch, matching `device_swipe`.
- `device_batch` scroll steps no longer crash the whole batch on either platform (same root cause).
- A coordinate `device_swipe` with `--count`/`--pattern` but no `durationMs` no longer mis-parses the flag value as a 3 ms duration on iOS (the positional extractor now strips flag values, matching Android).
- The Android runner is no longer reused across emulators: `shouldReuseAndroidRunner` checks the bound `deviceId` (parity with iOS `shouldReuseRunner`), so a runner bound to one emulator can't silently drive another.
- A wedged-but-alive fast-runner is now reaped: `ensureFastRunner` probes tri-state liveness instead of PID-only, so a hung HTTP listener no longer makes every subsequent command burn the full timeout.
- `ensureSingleRunner` is now awaited at session-open so the stale-runner kill completes before the first interaction, and its `ps` failure surfaces as a warning instead of a silent no-op.

**Actions / Maestro**
- Actions now auto-promote `experimental → active` on the first clean replay (the documented lifecycle was defined + tested but never wired).
- The GH#186 route-drift guard is now active in production (`cdp_run_action` is wired with a CDP-backed live-route reader; it previously defaulted to a no-op).
- `maestro_test_all` and the inline Maestro fallback no longer mark passing flows as failed when app/console output merely contains `Error:`, and both now auto-resolve `--app-file` for iOS `clearState` flows (previously only `maestro_run` did). `clearState` detection also recognises the standalone `- clearState` command.
- All Maestro `execFile` calls raise `maxBuffer` to 10 MB so a large flow log can't kill the child and mask a passing run.
- `cdp_repair_action` `RUNNER_LEAK` refusals are now bucketed as `SNAPSHOT_FAILED` in MTTR telemetry instead of `INTERNAL_ERROR`.
- A bare-form `id:` repair now emits a quoted scalar, so a testID containing YAML-special characters can't corrupt the action.

**Reliability / correctness**
- `collect_logs` no longer double-shifts Android logcat timestamps by the host UTC offset (which corrupted both the time and the cross-source merge order).
- CDP freshness/dev probes attach a no-op catch to the raced `evaluate()` promise so a mid-probe WebSocket close can't surface as an unhandledRejection.
- The observability server keeps a small `headersTimeout` (slow-loris guard), broadcasts a `shutdown` event so the browser stops auto-reconnecting after stop, and `Recorder.clear()` notifies subscribers instead of orphaning live SSE streams.
- Action IDs now accept dots (`v2.0-login`) per their documented contract while still rejecting `..`.
- The post-edit health-check hook's "app not installed → skip" guard works again (`grep -c || echo "0"` produced a two-line `0\n0`).
- `learned-actions` resolves the project memory dir correctly for paths containing a dot, and its `${VAR}` extractor accepts digit-bearing keys.
- The injected-helpers version is a single source of truth (the post-injection log no longer reports a stale `v11`).
- `sync-versions.sh` drops a dead, misleading variable and documents that `rn-dev-agent-cdp` is independently versioned.

Hardened the previously flaky `proof_step` unit tests (they depended on a machine-global session file) with a dependency-injection seam, making the suite deterministic.
