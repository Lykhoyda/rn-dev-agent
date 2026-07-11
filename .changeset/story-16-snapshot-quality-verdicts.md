---
"rn-dev-agent-core": minor
"rn-dev-agent-plugin": minor
---

Story 16 (#409) — snapshot quality verdicts: degraded captures must say so.

Every tree/snapshot capture now carries a structured quality verdict computed
once at capture time, so a sparse or empty result caused by a degraded walk is
no longer indistinguishable from a legitimately empty screen:

- `cdp_component_tree` returns `meta.treeVerdict` (`state: ok|degraded|failed`,
  `path`, `reasons`, `rootsSeeded`, `scannedNodes`, `effectiveDepth`,
  `droppedSubtrees`, `collapsedChildLists`, `rendererErrors`,
  `unscannedRendererIds`). Previously-silent drop classes are now counted:
  per-renderer exception swallows, registered-but-unscanned renderers (the #126
  early-exit class), depth-cap subtree drops, scan-budget/wall-clock
  exhaustion, and output truncation. Requires injected helpers v34 — a stale
  bundle simply omits the verdict.
- `device_snapshot` (iOS + Android runners) returns `meta.snapshotVerdict`
  (`state`, `source`, `nodeCount`, `refMapUpdated`, `reasons`).
- Sparse captures never overwrite the last-known-good @ref map: a zero-node
  snapshot leaves refs bound to the last verified capture
  (`meta.snapshotVerdict.refMapUpdated: false`, reason `empty-capture`) instead
  of wiping the map self-healing taps depend on.
- Interactive consumers fail closed: `device_find` (exact + fuzzy) and
  `device_focus_next` refuse a zero-node capture with `SNAPSHOT_DEGRADED`
  rather than asserting NOT_FOUND / "nothing on screen" on evidence that
  cannot support it.
