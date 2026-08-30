# M7 Metadata Header — Field Reference

The M7 header lives as `# key: value` comment lines above the Maestro YAML body. Maestro ignores comments; `packages/rn-dev-agent-core/src/learned-actions.ts` (compiled to `dist/learned-actions.js`, inventory CLI), `cdp_run_action` (replay pre-flight), and `cdp_repair_action` (self-repair) parse them. Single source of truth for the schema: `packages/rn-dev-agent-core/src/domain/reusable-action.ts` (`M7Metadata`, `parseM7Header`, `serializeM7Header`).

## Parser behavior (what the header may and may not contain)

`parseM7Header` walks the file line by line:

- Only `#`-prefixed lines are considered. Each is stripped of `# ` and **trimmed**, then matched against `^([a-zA-Z][\w-]*)\s*:\s*(.*)$`. Empty values are ignored except an explicit `# entry:`, which is preserved so replay refuses `BAD_RECORDING` instead of defaulting to cold.
- A matching line whose key is **recognized** (table below) sets that field — **later occurrences overwrite earlier ones**, except `entry`: replay admission uses one identity-independent bounded pre-body scanner, and duplicate `entry` declarations are invalid rather than last-write-wins. This is why embedded diagram/prose lines must never begin with a bare recognized key: `# status: shows spinner` would overwrite `status`.
- A matching line with an unrecognized key (e.g. `verify: cart-list`) is ignored — harmless but avoid relying on it.
- Lines whose content starts with a non-letter glyph (`[`, `│`, `▼`, `(`, `-`) can never match — the safe shape for diagram lines.
- A **fully blank line** (no `#`) after any metadata has been read ends the header. Keep the M7 block + diagram contiguous `#` lines.
- A non-comment line (the first flow step) also ends the header.
- `id` and `intent` are required — if either is missing the whole file fails to load as an action (`loadAction` returns null; the inventory and `cdp_run_action` won't see it). `id` falls back to the filename without `.yaml`.

Replay admission treats `entry` specially: it scans declarations only before the semantic start of the final YAML document's command sequence. Maestro top-section mappings, dividers, banner comments, and blank lines are tolerated, while comments inside or after the body can never declare an entry mode. If the YAML cannot be parsed, admission uses the same bounded lexical preamble as a conservative fallback; downstream validation still refuses the malformed body.

The `appId: <bundle>` + `---` **top section** above the comments is Maestro's own header, not part of M7 — both are needed.

## Fields

| Key | Required | Type / format | Semantics |
|---|---|---|---|
| `id` | yes | kebab-case slug `^[a-z0-9][a-z0-9-]*$` | Stable identifier; defaults to filename without `.yaml`. Set explicitly only to allow renaming the file later without breaking references. |
| `intent` | yes | one line of prose | The routing key: `/list-learned-actions` surfaces it verbatim; agents match tasks against it. Write it as the goal, not the mechanics. Use bare param names (`PRODUCT_ID`), never `${...}`. |
| `tags` | recommended | `[a, b, c]` lower-case kebab | Filter keywords. Conventions: feature area (`tasks`, `auth`, `cart`), operation (`create`, `update`, `delete`), markers (`smoke`, `regression`). |
| `mutates` | recommended | `true` / `false` | `true` if the flow leaves persistent residue (created rows, toggled settings). Drives the `/run-action` confirmation gate. Missing → rendered as `-` in the inventory (`pre-M7` when the whole header predates M7); `?` marks a present value that failed to parse. |
| `status` | yes (defaults `experimental`) | `experimental` \| `active` \| `deprecated` | Lifecycle. See transitions below. |
| `entry` | optional (defaults `cold`) | `cold` \| `parked` | GH #628 — declared start state. `parked` actions omit `launchApp`; lifecycle commands, including in inline subflows, and uninspectable or malformed file-form `runFlow` references refuse `BAD_RECORDING`. Replay verifies the first probeable pre-mutation anchor read-only and refuses `PARK_STATE_MISSING` when the park state is absent. Auto-repair is refused because its snapshot path relaunches the app. An unknown, empty, or duplicate declaration refuses instead of downgrading to cold. |
| `params` | when the body has `${VAR}` | `[KEY_A, KEY_B]`, keys `[A-Z_][A-Z0-9_]*` | The `-e KEY=VAL` surface. Auto-extracted from the body if absent, but declare explicitly so the replay pre-flight reports gaps clearly. |
| `appId` | strongly recommended | bundle id | Replay pre-flight refuses cross-app replays when the connected target's bundle differs. Duplicate of the top-section value on purpose. |
| `createdAt` | optional | ISO timestamp | Falls back to file ctime when absent. |
| `author` | optional | `auto` \| `human` \| `imported` | Provenance: `auto` = emitted by the recorder pipeline (`cdp_record_test_save_as_action`); `human` = hand-authored YAML (including agent-direct-authored); `imported` = landed via import. Drives diff-noise expectations and trust. |
| `produces` | optional | `{ key: value, ... }` single line, primitive values, no commas/newlines inside values | State postconditions a clean run establishes (e.g. `{ authenticated: true, route: home }`). Enables hybrid composition: an agent needing that state replays this action as a prologue. |
| `expectedRouteSequence` | optional | `[Route1, Route2]` | Ordered route names the flow walks (from `cdp_nav_graph` / nav events). Enables structural drift detection; for `entry: parked`, the preflight also verifies the first route when this field is present. Recorder-emitted parked actions seed the full recorded sequence when a start route is available, while hand-authored parked actions may omit it and rely on foreground-app plus anchor checks. |
| `enginePin` | required for replay | `maestro-runner@1.1.24` or newer | Session pin floor the action was migrated or recorded against. `cdp_run_action` refuses a missing field or any pin older than 1.1.24. New recordings stamp `maestro-runner@1.1.24`. Migrate with `maestro-runner-pin.js migrate-actions`. Regex text selectors are also refused before any UI mutation. |

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
| `PARK_STATE_MISSING` | An `entry: parked` action's read-only preflight found the park state absent (anchor/route missing, or the app backgrounded — cause `app-backgrounded`). Drive the app to the park state and retry; replay never launches or navigates for you. Non-proof replays persist the refusal RunRecord; `proofReplay` rehearsal preserves its no-sidecar/DB-write contract. |
| `TIMEOUT` | Flaky timing — add `waitForAnimationToEnd` / anchor asserts instead of sleeps |
