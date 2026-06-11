---
"rn-dev-agent-plugin": minor
---

New `creating-actions` skill — guided authoring of reusable Maestro actions.

Walks the agent through the full authoring contract: inventory-dedup scan before authoring (via `learned-actions.mjs`), creation-path choice (recorder vs direct YAML vs `maestro_generate`), selector grounding (never invent a testID), a **required ASCII flow diagram** of screens/transitions annotated with exact testIDs and `${PARAMS}` (embedded in the YAML header — glyph-first lines so the M7 parser can't misread a diagram line as metadata, which would otherwise silently overwrite fields like `status`), the M7 header contract, pre-replay validation (header round-trip through the inventory parser, placeholder↔params coverage, selector audit), and replay-to-promote via `cdp_run_action` (never hand-set `active`). Ships with a full M7 field reference (`references/m7-header-reference.md`) and a toolchain-validated worked example (`examples/add-product-to-cart.yaml` — verified against `parseM7Header`, `learned-actions.mjs`, and Maestro's syntax checker). Routed from `using-rn-dev-agent` (decision tree + skill map) and cross-linked from `rn-testing`'s M7 section.
