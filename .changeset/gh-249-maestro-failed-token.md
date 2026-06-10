---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(#249): Maestro pass detection no longer flips passing flows to failed when app logs contain the substring `FAILED`. The exit-0 secondary guard in `maestro_run`, `maestro_test_all`, and the inline maestro fallback used a bare `output.includes('FAILED')` over combined stdout+stderr — app/console output like a `FETCH_FAILED` Redux action or a `LOGIN_FAILED` analytics event marked a genuinely passing flow as failed and triggered pointless auto-repair. All three call sites now share `outputIndicatesFlowFailure`, which keys on Maestro's own terminal status lines (`Test FAILED` / `Flow FAILED` / a `[FAILED]` step marker / a bare `FAILED` line) instead of a substring.
