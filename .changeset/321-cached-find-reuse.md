---
"rn-dev-agent-plugin": patch
---

Live-sim speedup (GH #321): `device_find` now reuses the snapshot it already
captured instead of issuing a redundant runner round-trip — but only while that
snapshot is still a faithful picture of the screen.

A snapshot cache already existed (`cacheSnapshot`) but nothing read it for
targeting, so every `device_find` re-snapshotted. On the live iOS test-app a warm
`device_find` measured ~1,449 ms — essentially one full XCUITest accessibility
snapshot (~1,435 ms) plus matching. Reusing a valid cache drops a repeated find on
an unchanged screen to ~0.004 ms (in-memory filter), saving ~1.45 s per avoided
find.

Correctness is gated on a two-condition validity check, not just a TTL: the cache
must be clean AND within the freshness budget. Invalidation is **fail-safe and
centralized at the MCP tool boundary** (`trackedTool`): every tool call that is not
on an explicit read allowlist marks the cache dirty — so JS-level mutations that
bypass the native dispatch path (`cdp_interact`, `cdp_navigate`, the `fastSwipe`
swipe/scroll path, `device_deeplink`, `cdp_dispatch`/`cdp_reload`/`maestro_run`, …)
all invalidate it, and any future tool defaults to "invalidate" until proven a pure
read. The native `runNative` choke point also marks dirty as defense-in-depth for
direct (intra-composite) handler calls. A tap or navigation therefore forces a
fresh snapshot — the cache is never reused against a screen it no longer describes.
Only the `device_find` handler opts in (`allowCache`); all other snapshot callers
are unchanged.
