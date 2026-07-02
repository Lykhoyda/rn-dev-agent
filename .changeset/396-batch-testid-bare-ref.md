---
"rn-dev-agent-cdp": patch
"rn-dev-agent-plugin": patch
---

fix(device_batch): testID steps failed with a misleading STALE_REF on the in-tree runners (#396). `findRefByTestID` passed the envelope's ref through verbatim; the in-tree iOS/Android runners emit `@`-prefixed refs (`@e68`), so the testID branches of `device_batch` (find+tap / press / fill) composed `@@e68`, which missed the ref-map (`lookupRef` strips exactly one `@`) and surfaced as `Element at ref @@e68 no longer hittable — UI re-rendered since snapshot` even though the snapshot was taken fresh that same step. `findRefByTestID` now returns the canonical bare id in both the flat-nodes and nested-tree envelope shapes, restoring the documented "re-resolve at execution time" contract; the GH #114 producer-consumer contract tests are updated to pin the bare-id contract for the in-tree producers.
