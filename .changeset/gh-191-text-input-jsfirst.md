---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

fix(#191): JS-first text entry — `device_fill` now prefers the deterministic React `onChangeText` path when CDP is connected and the ref resolves to a testID (via its cached snapshot identifier), settle-polls the field value to verify it (defeating the debounced-`onChangeText` read race), and on the native fallback runs a bounded clear+retype (real `clearFirst` + per-character delay) when the value is corrupted, escalating to a verified maestro fallback before erroring. Adds best-effort iOS predictive-keyboard suppression at session-open and a new `TEXT_ENTRY_UNVERIFIED` error code for the exhausted-and-still-corrupted case. Additive `meta` only (`textEntryPath`, `verify`, `timings_ms`); no breaking change for existing callers. NOTE: `device_batch` fills are not yet JS-first (they call the runner directly) — tracked as a follow-up.
