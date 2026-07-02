# Story 08 — Token-efficient outputs: compact snapshot format + screenshot downscaling + deep-tree recovery

**Status:** Proposed (2026-07-02)
**Epic:** [Maestro adoption](README.md)
**Impact:** Direct token/latency/cost win on every session (snapshot is the most-called observation tool); makes huge RN trees snapshotable at all
**Effort:** M
**Depends on:** — (Story 06 Phase C evals are the regression gate for the format change)

## Problem

- `device_snapshot` returns the full interactive-node list every call, uncapped, with a rect per node (`mapRunnerNodesToFlat`); repeated calls in a session (and `device_scrollintoview`'s up-to-12 re-snapshots) multiply the cost. Truncation exists in ~20 other sites (component tree, network) but not here.
- Screenshots are returned at raw capture size from `simctl`/`screencap`.
- Very deep RN trees risk the same pathological XCTest snapshot failures Maestro hit (`kAXErrorIllegalArgument`); we have no depth-cap or recovery path.

## What Maestro does

**Hierarchy (`maestro-cli/.../mcp/tools/ViewHierarchyFormatters.kt`** — commit `8c99cae5` switched default to compact JSON "to reduce token cost for LLM callers"):
- Two top-level keys: `ui_schema` (one-time abbreviation legend + per-platform defaults) + `elements` — the legend is amortized once instead of repeating key names per node (`:202-275`).
- Abbreviated keys: `b`=bounds, `txt`=text, `rid`=resource-id, `a11y`, `hint`, `cls`, `val`, `scroll`, `c`=children.
- Boolean flags serialized **only when non-default** vs `ui_schema.defaults` (`:318-395`); Jackson NON_NULL so absent attrs cost zero.
- Zero-size nodes dropped; empty containers dropped with children hoisted up (`:283-316`) — wrapper Views collapse.

**Screenshots (`TakeScreenshotTool.kt:20-100`,** issue #2952): downscale so the longest side ≤ 2000 px ("Vision models (e.g. Claude) reject images whose longest side exceeds 2000px"), PNG→JPEG q0.9 with alpha flattened onto RGB, returned inline.

**Deep trees (runner-side, `ViewHierarchyHandler.swift`):** snapshot via tree-walk not `dictionaryRepresentation` (O(subtree) per call, `:304-337`); `snapshotMaxDepth = 60` with chunked per-subtree re-fetch when hit (`:143-160`); on `kAXErrorIllegalArgument` (thrown by *large RN hierarchies* specifically) swizzle `maxDepth` down, skip the app root, fetch keyboard/alert/window subtrees separately and stitch (`:161-214`); a depth-61 warning nudges RN users (`IOSDriver.kt:193-202`).

## Design

### Compact snapshot format (bridge-side, both platforms)

`device_snapshot` gains `format: 'compact' (default) | 'full'`:

```json
{
  "s": { "k": {"t":"testID","x":"text","l":"label","r":"role","b":"bounds [x,y,w,h]"},
          "d": {"enabled":true,"visible":true} },
  "e": [ {"ref":"e1","t":"submit-btn","x":"Continue","r":"button","b":[24,690,342,48]}, ... ],
  "omitted": {"zeroSize": 14, "offscreen": 9}
}
```

- Legend emitted once per response; keys single-letter; bounds as int arrays (ints, not floats — sub-pixel precision is noise).
- Omit-default booleans (`enabled`, `visible`, `selected`) exactly like Maestro's defaults table.
- Drop zero-size nodes; hoist children of wrapper-only nodes (no testID/text/label/interactivity, single child).
- **No silent caps:** if the list exceeds a soft ceiling (150 nodes, interactive-first ordering), emit the remainder count in `omitted` with a hint to use `device_find` — the "no silent caps → log what was dropped" rule.
- `@ref` assignment unchanged (refs are the API; only the serialization shrinks). `format:'full'` keeps today's shape for debugging.

### Screenshot downscaling (host-side)

- Pipeline: capture (existing tiers) → downscale longest side to **1568 px** default (Anthropic vision sweet spot; configurable `RN_SCREENSHOT_MAX_DIM`, hard cap 2000 per Maestro/#2952) → JPEG q0.8, alpha flattened.
- Implementation: `ffmpeg` first (already a plugin dependency for proof-capture: `scale='min(1568,iw)':-2`), `sips` fallback on macOS, passthrough-with-note if neither — zero new npm deps, keeps the "raw path never requires the runner" property (`tools/device-screenshot-raw.ts`).
- PNG stays available via `format: 'png'` param for pixel-exact needs (proof-capture keeps PNG/video untouched).

### Deep-tree resilience (rn-fast-runner)

- Port the depth-cap + chunked-subtree walk: cap 60, on overflow re-fetch children one subtree at a time; on `kAXErrorIllegalArgument` retry with reduced depth and stitch window/keyboard/alert subtrees separately. Include Maestro's snapshot-param swizzle (`XCAXClient_iOS+FBSnapshotReqParams.m:66-111`) to force `maxDepth` and `snapshotKeyHonorModalViews=0` (elements behind modals stay visible) — vendored alongside Story 03's swizzle in `ThirdParty/` with the same attribution discipline.
- Surface `meta.depthCapped: true` + a depth warning ≥ 61 pointing at view flattening (Maestro's exact nudge, useful RN advice regardless).

## Implementation steps

1. Pure `compactSnapshot(nodes): CompactPayload` in `runners/` + exhaustive unit tests (legend correctness, hoisting, omit-defaults, ceiling+omitted counts, ref stability vs full format).
2. Tool wiring + `format` param; update skills/docs that show snapshot output shapes.
3. Screenshot pipeline with capability probe (ffmpeg → sips → passthrough) + content-type from magic bytes (existing pattern, `index.ts:263-270`).
4. Runner deep-tree work (Swift) + fixture screen with a pathological 80-deep nested tree.
5. **Measurement gate:** token-count harness (tiktoken-style approximation is fine) comparing old/new payloads on 3 fixture screens; results table in the PR body. Target ≥ 60 % reduction on list-heavy screens.

## Acceptance criteria

- TaskWizard snapshot: ≥ 60 % serialized-size reduction, zero information loss for ref-based interaction (every previously-actionable element still gets a ref).
- Story 06 Phase C output-usability eval shows no regression in "model finds the right @ref from a described element."
- 80-deep fixture: snapshot succeeds (chunked path), `meta.depthCapped` set; today's behavior on that fixture (timeout/failure) documented as the before-state.
- Screenshot of a 3× retina sim: longest side ≤ 1568, JPEG, visually legible text in the observe UI; `format:'png'` returns original.

## Test plan

- Unit: compactor matrix; downscale argv construction; fallback ladder.
- Eval: Story 06 Phase C fixtures re-run against compact payloads (the merge gate).
- Live: before/after token counts + one full agent session driven purely on compact output.

## Risks & open questions

- **Agent confusion from abbreviated keys:** the legend-in-payload mitigates; Maestro additionally teaches the mapping in the tool description ("`a11y` is not a selector key…" — `InspectScreenTool.kt:14-29`) — copy that pattern into `device_snapshot`'s description (anti-hallucination text is Story 12 territory but this one line ships here).
- **Downstream consumers of the full shape** (observe UI panels): they consume the internal node list, not the MCP serialization — verify and pin with a test.
- **JPEG artifacts on text-dense screens:** q0.8 chosen above Maestro's diff-use q0.5; the `png` escape hatch covers pixel-perfect needs.
