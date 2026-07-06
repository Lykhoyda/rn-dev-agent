---
'rn-dev-agent-cdp': patch
'rn-dev-agent-plugin': patch
---

Observe UI: make the right state pane fit its width, and slim the timeline
column.

The right pane is a fixed ~26% column (~340-450px), but the actions tab
rendered a 5-column table and the e2e tab 3- and 4-column tables. Tables
cannot shrink below their column content, so at typical window widths the
Status/Params/Run columns were clipped clean off the pane — the Run button
was unreachable — and action ids line-wrapped mid-word. Both tabs now render
stacked rows designed for a narrow column:

- **Actions**: one item per action — id (truncating, full value on hover) +
  status badge + Run on the first line, intent wrapped below (2-line clamp),
  param inputs flex-wrapping to the available width instead of fixed 110px
  columns, result/output underneath.
- **E2E**: suite results and run history as one-line rows — pass/fail mark,
  truncating test/run id, duration, classification badge or `2✓ 1✗` totals +
  verdict — with error excerpts wrapping below and the expanded run detail
  reusing the same row layout.
- Pane guards: `.pane.right` gets `min-width: 340px`, tabs wrap instead of
  overflowing, long live routes break instead of pushing the pane wide.
- Layout rebalance: the left timeline column drops from 40% to 33%
  (`min-width: 380px`; summaries already ellipsize), and the device pane no
  longer greedily takes all remaining width — the mirror is a portrait phone
  screen capped at ~100vh, so the pane is capped at 400px and the state pane
  absorbs the surplus instead.
