---
name: creating-actions
description: This skill should be used when the user asks to "create an action", "save this flow as an action", "make this replayable", "record a reusable action", "author a Maestro flow as an action", "add a login/setup action", or when a verified UI walk should be persisted under .rn-agent/actions/ so future sessions can replay it with maestro.
---

# creating-actions — Author a Reusable Maestro Action

An **action** is a parameterised Maestro flow at `<project>/.rn-agent/actions/<id>.yaml` with an M7 metadata header, replayable via `/rn-dev-agent:run-action` or `cdp_run_action` (auto-repair-aware). A well-authored action turns a ~minutes interactive walk into a ~seconds deterministic replay. Authoring one well means: **dedup first, ground every selector in evidence, design the flow as an ASCII diagram before writing YAML, validate, then replay to promote.**

## When to Use

- A verified flow is worth replaying: login, navigation prologue, multi-step setup, locale/theme switching, data seeding.
- `/rn-dev-agent:test-feature` verification passed and the walk should be persisted.
- The user asks to make a flow replayable / save an action.

**When NOT to author an action:**
- A one-off check — use `maestro_run` with `inlineYaml` and throw it away.
- An existing action already covers the flow — extend or parameterise it instead of forking a near-duplicate.
- The flow spans two apps — actions are single-`appId` by contract.

## Step 0 — Scan the Inventory First (dedup)

Before authoring anything, check what already exists:

```bash
node "${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/learned-actions.js" --json --section b \
  --workspace-root "$PWD" --memory-cwd "$PWD" --filter <keyword>
```

(or `/rn-dev-agent:list-learned-actions <keyword>`). If a match covers the goal, replay it. If a near-match exists (same flow, hardcoded values), parameterise THAT action with `${VAR}` placeholders rather than creating a sibling — duplicate actions rot independently and split the repair history.

## Step 1 — Pick the Creation Path

| Situation | Path |
|---|---|
| About to walk the flow live on a device anyway | **Recorder**: `cdp_record_test_start` → drive UI (`cdp_interact` / `device_*`) → `cdp_record_test_stop` → `cdp_record_test_save_as_action` (writes header + sidecar; pass `intent`/`tags`/`mutates`/`produces` yourself — the recorder cannot infer them) |
| Flow and selectors already known (prior exploration, existing test) | **Direct authoring** — Steps 2–6 below |
| Structured steps in hand, want generated YAML | `maestro_generate` — then verify the M7 header per Step 4 and continue with Steps 5–6 |

The recorder path still benefits from Steps 3 (diagram) and 5–6 (validate, replay to promote): add the diagram to the generated YAML's header before first replay.

## Step 2 — Ground Every Selector (never invent a testID)

Collect evidence for every element the flow will touch:

- `cdp_component_tree(filter="<screen-or-component>")` per screen — filtered, never the full tree
- `device_snapshot` for what is actually on the native screen
- `grep -r 'testID=' src/` for static discovery
- `cdp_nav_graph` / `cdp_navigation_state` for exact route names (used in `expectedRouteSequence`)

If an element the flow needs has **no testID, stop and add one to the app source first** (see the rn-testing skill for testID conventions). Text-based selectors break on i18n and copy edits; an action built on them generates repair churn.

## Step 3 — Draw the ASCII Flow Diagram (required, before any YAML)

Map the flow screen-by-screen with the exact selectors. This is the design-review artifact: parameter gaps, missing assertion anchors, and wrong start-state assumptions are cheap to fix here and expensive to fix after the YAML exists.

Canonical format — one `[RouteName]` box line per screen, `│`-arrow lines for interactions, each labelled with the exact selector; one **anchor** (the `assertVisible` proving arrival) per screen; `${PARAMS}` marked where caller data flows in:

```
[any screen]
     │ launchApp (stopApp: false)
     │ tapOn tab-home
     ▼
[Home]  anchor: product-list
     │ scrollUntilVisible product-card-${PRODUCT_ID}   (if off-screen)
     │ tapOn product-add-btn-${PRODUCT_ID}
     ▼
[Home]  cart-badge increments
     │ tapOn tab-cart
     ▼
[Cart]  anchor: cart-list
        verify: cart-item-${PRODUCT_ID}
```

Review the diagram against Step-2 evidence before continuing:
- [ ] Every selector in the diagram exists in the gathered tree/snapshot
- [ ] Every transition has an anchor on the destination screen
- [ ] Everything caller-variable is a `${PARAM}`; everything else is fixed
- [ ] The entry assumption is explicit (works from any screen? requires login?)

**Embed the diagram in the YAML header** (below the M7 block) so the action documents itself and repair reviews can see intended structure. Safety rules for embedding — the M7 parser trims each comment line and treats a leading `word: value` as metadata:

1. Every line starts with `#` — a fully blank line ends the header block.
2. Every diagram line's content starts with a **non-letter glyph** (`[`, `│`, `▼`, `(`, indentation is NOT enough). A line like `# status: shows spinner` would silently **overwrite the action's `status` metadata**.

## Step 4 — Write the YAML

```yaml
appId: com.example.shop
---
# id: add-product-to-cart
# intent: From any screen, add product PRODUCT_ID to the cart and verify it landed.
# tags: [cart, add, smoke]
# mutates: true
# status: experimental
# params: [PRODUCT_ID]
# appId: com.example.shop
#
# [diagram from Step 3 — every line #-prefixed, glyph-first]
- launchApp:
    stopApp: false
- tapOn:
    id: "tab-home"
- assertVisible:
    id: "product-list"
# ... steps mirror the diagram 1:1
```

Contract rules (violations break replay, repair, or inventory):

- **id / filename**: lower-case kebab-case `^[a-z0-9][a-z0-9-]*$`; file is `.rn-agent/actions/<id>.yaml`.
- **Header**: `id`, `intent`, `tags`, `mutates`, `status` are the 5 inventory keys — a missing `mutates` renders as `?` in `/list-learned-actions`. Always `status: experimental` at creation; promotion to `active` is earned by a clean replay, never hand-set. Full field glossary (incl. `produces`, `expectedRouteSequence`, `author`): `references/m7-header-reference.md`.
- **Params**: keys match `[A-Z_][A-Z0-9_]*`; every `${VAR}` in the steps is listed in `# params`, and vice versa. The inventory scanner counts `${...}` occurrences **anywhere in the file, comments included** — so the diagram may mark real step params as `${PRODUCT_ID}`, but prose (e.g. the `intent` line) uses bare names, and no comment may mention a `${VAR}` the steps don't use.
- **Body**: `launchApp: { stopApp: false }` self-bootstrap (works cold or warm, preserves login); conditional prologues via `runFlow: { when: { visible: ... } }`; `waitForAnimationToEnd` after transitions; the diagram's anchor `assertVisible` after each screen change; `scrollUntilVisible` for potentially off-screen targets.
- **Never `clearState: true`** on an Expo Dev Client build — it wipes the Metro URL and strands the launcher (GH #8).
- Do **not** hand-write the sidecar (`.rn-agent/state/<id>.state.json`) — it is created lazily on first load/replay.

Copy-adapt the complete worked example: `examples/add-product-to-cart.yaml`.

## Step 5 — Validate Before First Replay

1. **Header parses + inventory lists it**: re-run the Step-0 command with `--filter <id>` — confirm `intent`, `tags`, `mutates`, `status` come back exactly as written (not `?`). This also proves the embedded diagram didn't corrupt the header.
2. **Placeholder coverage**: `grep -o '\${[A-Z_]*}' <file>` over the steps ↔ `# params` list, both directions.
3. **Selector audit**: every `id:` in the YAML appears in the Step-2 evidence.
4. **Syntax**: if the maestro MCP server is connected, `check_flow_syntax` on the body; otherwise the first replay doubles as the syntax check.

## Step 6 — Replay to Promote

Replay through the orchestrator — not raw `maestro_run` — so the run is recorded and auto-repair-aware:

```
cdp_run_action({ actionId: "<id>", params: { PRODUCT_ID: "7" }, trigger: "agent" })
```

- First clean pass auto-promotes `experimental → active` and materialises the sidecar.
- Verify the outcome by **state, not pixels**: `cdp_store_state`, `expect_redux` / `expect_route` / `expect_visible_by_testid`.
- `mutates: true` actions leave residue — clean up between runs or use timestamp-suffixed param values so repeated replays stay deterministic.
- Exercise the variable branch (e.g. one on-screen and one off-screen `PRODUCT_ID`) before trusting the action.
- **No device available?** Leave `status: experimental` and say so explicitly — never hand-promote.

After any later auto-repair or manual selector edit, **update the embedded diagram** to match — a stale diagram misleads the next repair review.

## Quick Reference

| What | Where / Rule |
|---|---|
| Action file | `<project>/.rn-agent/actions/<id>.yaml` |
| Sidecar (auto-created) | `<project>/.rn-agent/state/<id>.state.json` |
| id regex | `^[a-z0-9][a-z0-9-]*$` |
| param key regex | `[A-Z_][A-Z0-9_]*` |
| Inventory / dedup | `packages/rn-dev-agent-core/src/learned-actions.ts` (built → `dist/learned-actions.js`) or `/rn-dev-agent:list-learned-actions` |
| Replay | `cdp_run_action` / `/rn-dev-agent:run-action <id> -e KEY=VAL` |
| Lifecycle | `experimental` → (clean replay) → `active`; repair demotes back to `experimental`; `deprecated` = never replay |
| Repair budget | 3 auto-repairs per rolling 24h per action |

## Common Mistakes

| Mistake | Consequence |
|---|---|
| Skipping the Step-0 inventory scan | Duplicate actions that drift apart; repair history split |
| Inventing a testID that "should" exist | `SELECTOR_NOT_FOUND` on first replay; wasted repair budget |
| Hardcoding values instead of `${PARAMS}` | Action only replays one scenario; near-duplicates multiply |
| `status: active` at creation | Unvalidated flow treated as production-quality by replay-first routing |
| Diagram line starting with a bare `word:` | Silently overwrites M7 metadata (e.g. `status`) |
| Blank (non-`#`) line inside the header | Parser stops early; later M7 keys ignored |
| `${VAR}` in a comment that no step uses | Inventory synthesizes a phantom `-e VAR=...`; replay pre-flight demands a param the flow ignores |
| `clearState: true` on Dev Client | App strands on the Dev Client launcher (GH #8) |
| Raw `maestro_run` for a saved action | No RunRecord, no auto-repair, no promotion |
| Hand-writing the sidecar | Stale `lastSeenMtimeMs` → false `EXTERNAL_EDIT` repair refusals |

## Related

- **rn-testing skill** — Maestro step patterns, timing rules, testID conventions, auth/permission pre-flights
- **`references/m7-header-reference.md`** — every M7 field with semantics, parser behavior, lifecycle transitions
- **`examples/add-product-to-cart.yaml`** — complete worked example with embedded diagram
- **`/rn-dev-agent:run-action`** — replay-side pre-flight (mutates confirmation, appId match, param coverage)
