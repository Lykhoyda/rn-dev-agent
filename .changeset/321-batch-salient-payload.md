---
"rn-dev-agent-plugin": patch
---

Live-sim speedup (GH #321, quick win #4): `device_batch` returns a **salient final
payload** by default and gains a `finalSnapshot` option (`salient` | `full` |
`none`).

`device_batch` already collapses N interactions into one MCP round-trip, but its
`final_snapshot` was always the full a11y node list (large) and it always took an
implicit trailing snapshot. Now:

- `salient` (default) — `final_snapshot` is compacted to only actionable nodes
  (Button/TextField/Switch/Slider/Cell/Link/…), each `{ ref, type, label,
  identifier, hittable? }`, with a `fullNodeCount`. Far fewer tokens; `@ref`s for
  actionable elements are preserved so follow-up `device_press(ref)` still works.
- `none` — skips the implicit trailing snapshot entirely (~1,450 ms saved) for
  action-only batches verified via `expect_*`/`cdp_store_state`.
- `full` — the legacy complete node list.

An explicit `snapshot` step or `screenshotOn:'end'` still populates the payload;
the option only governs the implicit trailing snapshot and its shape. `rn-tester`
now recommends a single `device_batch` for known multi-step sequences.
