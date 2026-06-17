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
is invalidated by any screen-mutating verb (tap/press/fill/type/swipe/scroll/back/
longpress/pinch/keyboard/drag) at the `runNative` dispatch choke point, AND it must
be within the freshness budget. A tap that navigates therefore forces a fresh
snapshot — a cache is never reused against a screen it no longer describes. Only the
`device_find` handler opts in (`allowCache`); all other snapshot callers are
unchanged.
