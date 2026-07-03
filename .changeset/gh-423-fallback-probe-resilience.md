---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

`cdp_run_action` no longer dead-ends in an opaque UNKNOWN when WDA dies at
launch (#423). Root cause chain from the field failure: the #317 CDP/JS replay
fallback covers this exact case, but its single tree probe ran while CDP was
mid-reconnect (the failed flow had just relaunched the app), was silently
swallowed, and the fallback never engaged. The probe now retries (bounded,
default 3×1.5s) until the probe testID is actually present — tolerating both a
reconnecting CDP and a still-mounting app — and every skip is surfaced as
`meta.cdpJsFallback: { attempted: false, reason }`
(`no-replay-deps | no-probe-testid | cdp-unreachable | testid-not-in-tree`).
A `cdp-unreachable` skip appends actionable guidance (check `cdp_status`,
reconnect, stop foreign XCUITest automation) instead of a bare
"failure not auto-repairable". Also (#422 hardening): the simctl UDID parsers
now only consider iOS runtimes (a booted paired watchOS/tvOS simulator can
neither win the screenshot UDID pick nor make the single iPhone look ambiguous
to `resolveIosUdid`), and raw captures bind to the open device session's UDID
when platforms match instead of picking the first booted device.
