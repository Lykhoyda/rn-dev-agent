---
'rn-dev-agent-cdp': minor
'rn-dev-agent-plugin': minor
---

Story 05 (#386) self-healing taps: stale `@ref` taps re-resolve inline by identity signature (unique-match only; ambiguous/absent STALE_REF now lists candidates), swallowed taps retry exactly once via settle-hash change detection (`meta.reResolved` / `meta.tapRetried` / `meta.noUiChange`), 3 consecutive no-change taps on distinct targets surface a wedged-runtime hint, and `device_batch` testID resolution refuses ambiguous matches (`AMBIGUOUS_TESTID`). Opt-outs: `retryIfNoChange: false` per call, `RN_SELF_HEAL=0` global.
