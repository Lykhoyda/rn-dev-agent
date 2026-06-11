# M7 Metadata Header — Field Reference

The M7 header lives as `# key: value` comment lines above the Maestro YAML body. Maestro ignores comments; `scripts/learned-actions.mjs` (inventory), `cdp_run_action` (replay pre-flight), and `cdp_repair_action` (self-repair) parse them. Single source of truth for the schema: `scripts/cdp-bridge/src/domain/reusable-action.ts` (`M7Metadata`, `parseM7Header`, `serializeM7Header`).

## Parser behavior (what the header may and may not contain)

`parseM7Header` walks the file line by line:

- Only `#`-prefixed lines are considered. Each is stripped of `# ` and **trimmed**, then matched against `^([a-zA-Z][\w-]*)\s*:\s*(.+)$`.
- A matching line whose key is **recognized** (table below) sets that field — **later occurrences overwrite earlier ones**. This is why embedded diagram/prose lines must never begin with a bare recognized key: `# status: shows spinner` would overwrite `status`.
- A matching line with an unrecognized key (e.g. `verify: cart-list`) is ignored — harmless but avoid relying on it.
- Lines whose content starts with a non-letter glyph (`[`, `│`, `▼`, `(`, `-`) can never match — the safe shape for diagram lines.
- A **fully blank line** (no `#`) after any metadata has been read ends the header. Keep the M7 block + diagram contiguous `#` lines.
- A non-comment line (the first flow step) also ends the header.
- `id` and `intent` are required — if either is missing the whole file fails to load as an action (`loadAction` returns null; the inventory and `cdp_run_action` won't see it). `id` falls back to the filename without `.yaml`.

The `appId: <bundle>` + `---` **top section** above the comments is Maestro's own header, not part of M7 — both are needed.

## Fields

| Key | Required | Type / format | Semantics |
|---|---|---|---|
| `id` | yes | kebab-case slug `^[a-z0-9][a-z0-9-]*$` | Stable identifier; defaults to filename without `.yaml`. Set explicitly only to allow renaming the file later without breaking references. |
| `intent` | yes | one line of prose | The routing key: `/list-learned-actions` surfaces it verbatim; agents match tasks against it. Write it as the goal, not the mechanics. Use bare param names (`PRODUCT_ID`), never `${...}`. |
| `tags` | recommended | `[a, b, c]` lower-case kebab | Filter keywords. Conventions: feature area (`tasks`, `auth`, `cart`), operation (`create`, `update`, `delete`), markers (`smoke`, `regression`). |
| `mutates` | recommended | `true` / `false` | `true` if the flow leaves persistent residue (created rows, toggled settings). Drives the `/run-action` confirmation gate. Missing → rendered as `?` in the inventory. |
| `status` | yes (defaults `experimental`) | `experimental` \| `active` \| `deprecated` | Lifecycle. See transitions below. |
| `params` | when the body has `${VAR}` | `[KEY_A, KEY_B]`, keys `[A-Z_][A-Z0-9_]*` | The `-e KEY=VAL` surface. Auto-extracted from the body if absent, but declare explicitly so the replay pre-flight reports gaps clearly. |
| `appId` | strongly recommended | bundle id | Replay pre-flight refuses cross-app replays when the connected target's bundle differs. Duplicate of the top-section value on purpose. |
| `createdAt` | optional | ISO timestamp | Falls back to file ctime when absent. |
| `author` | optional | `auto` \| `human` \| `imported` | Provenance: `auto` = emitted by the recorder pipeline (`cdp_record_test_save_as_action`); `human` = hand-authored YAML (including agent-direct-authored); `imported` = landed via import. Drives diff-noise expectations and trust. |
| `produces` | optional | `{ key: value, ... }` single line, primitive values, no commas/newlines inside values | State postconditions a clean run establishes (e.g. `{ authenticated: true, route: home }`). Enables hybrid composition: an agent needing that state replays this action as a prologue. |
| `expectedRouteSequence` | optional | `[Route1, Route2]` | Ordered route names the flow walks (from `cdp_nav_graph` / nav events). Enables structural drift detection: a live route off this sequence reclassifies `SELECTOR_NOT_FOUND` as `ROUTE_DRIFT`, which correctly refuses fuzzy selector repair. |

## Lifecycle transitions (enforced in code — do not hand-set)

```
experimental ──(first clean cdp_run_action replay)──▶ active
active ──(auto-repair patches the YAML)──▶ experimental   (re-validation required)
any ──(manual archival)──▶ deprecated                      (never auto-routed or replayed)
```

- Promotion happens inside `cdp_run_action` (`shouldAutoPromoteToActive`); hand-setting `active` skips the validation the status claims.
- Demotion after repair is intentional: a patched selector is a hypothesis until a replay proves it.

## Sidecar (`.rn-agent/state/<id>.state.json`) — never hand-write

Created lazily by `loadOrInitSidecar` on first load. Holds `runHistory` (cap 50), `repairHistory` (cap 25), `stats`, `revision`, and `lastSeenMtimeMs`. That last field powers external-edit detection: hand-writing or pre-creating the sidecar desynchronizes it and triggers false `EXTERNAL_EDIT` repair refusals. Repair budget: 3 successful auto-repairs per rolling 24h per action; exceeding it returns `BUDGET_EXHAUSTED` and escalates to the user.

## Failure codes seen at replay (what they mean for the author)

| Code | Authoring implication |
|---|---|
| `SELECTOR_NOT_FOUND` | A testID in the YAML isn't on screen — stale selector (repairable) or wrong anchor assumption |
| `ROUTE_DRIFT` | Live navigation diverged from `expectedRouteSequence` — structural change; repair is refused on purpose |
| `STATE_MISMATCH` | Flow ran but produced wrong state — real regression, not an authoring bug |
| `MUTATE_PRECONDITION_FAILED` | Entry assumption violated (e.g. not logged in) — make the prologue conditional or compose with a login action |
| `TIMEOUT` | Flaky timing — add `waitForAnimationToEnd` / anchor asserts instead of sleeps |
