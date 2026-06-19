# Action corpus persistence — durable, structured (node:sqlite) index + history

- **Date:** 2026-06-19
- **Status:** Approved design (brainstorming complete; awaiting spec review → writing-plans)
- **Related issues:** #357 (worktree corpus loss — partially subsumed by §5), #348 (project-root mis-resolution class), #356 (keyboard occlusion — *separate* spec, unblocked by this), #300 item 3 (origin of #357)
- **Tracking issue:** to be filed after spec review.

## 1. Problem

The action corpus (`.rn-agent/actions/<id>.yaml` + per-action JSON sidecars) is the plugin's
**compounding asset** — every verified walk becomes a replayable action, and the library's value
grows sub-linearly with use. But the corpus has three silent-loss / silent-unfound surfaces:

1. **Fresh git worktree** without `.rn-agent` → corpus absent, tools return an empty list with no
   signal (#357, from #300 item 3).
2. **Project-root mis-resolution** (the #348 class — `findProjectRoot` picking a stray sibling repo) →
   `listActions(wrongRoot)` returns `[]`, masquerading as "no actions".
3. **Sidecar fragility** — run/repair history lives in per-action JSON sidecars kept consistent with
   the YAML via an atomic pair-write (#101). This works but is hard to query, can drift, and scatters
   history across many small files.

We want the corpus to **persist reliably** (a missing/mismatched/misresolved corpus must fail *loud*,
never silently empty) and to gain a **structured store with queryable history**.

## 2. Goals / non-goals

**Goals**
- The corpus is **never silently lost or unfound** — missing/mismatched/misresolved state surfaces a
  loud diagnostic instead of an empty result.
- A **structured `node:sqlite` store** for the corpus index + run/repair history + telemetry,
  replacing the per-action JSON sidecars (kills sidecar drift; one queryable store).

**Non-goals (explicitly deferred)**
- Cross-project / machine-global action library.
- Team sharing / remote sync (git remote, cloud, service).
- Migrating action *definitions* out of git-tracked YAML (they stay diffable and PR-reviewed).

## 3. Key constraints (why the architecture is shaped this way)

- **Maestro executes a YAML file on disk.** The L3 runner shells out to a `.yaml`, so YAML can never be
  fully replaced by a DB — at minimum a YAML must exist to run. We keep YAML as the executed artifact.
- **Actions are git-tracked and diffable today** — reviewed in PRs, committed alongside the code they
  test. A binary SQLite file does not diff or merge, so the DB must **not** be the source of truth.
- **cdp-bridge ships pure-JS on a `node >=22` floor** — 4 pure-JS deps (`@modelcontextprotocol/sdk`,
  `ws`, `yaml`, `zod`), zero native addons (agent-device was *removed*). A native SQLite addon
  (`better-sqlite3`) would add per-platform/per-Node prebuild fragility, against the project's posture.
- **`node:sqlite` is built-in but version-gated** — available from Node 22.5+, emits an
  `ExperimentalWarning`, and needs `--experimental-sqlite` on Node 22.x. So the storage layer must
  **degrade gracefully** when it is unavailable.

## 4. Architecture — YAML-primary, SQLite-derived

- **Source of truth stays** `.rn-agent/actions/<id>.yaml` (git-tracked, unchanged). Maestro reads the
  YAML directly; no export step.
- **New derived store** `.rn-agent/state/actions.db` (`node:sqlite`, **gitignored** alongside the
  existing `.rn-agent/state/e2e-runs/`). It is **rebuildable from the YAML** — this single property is
  what makes "never lost" enforceable, degradation safe, and corruption trivially recoverable
  (delete `.db`, reconcile).
- A new `domain/action-db.ts` wraps `node:sqlite` behind a narrow interface and **feature-detects** at
  open. If `node:sqlite` is unavailable, it returns a fallback that keeps reading/writing the legacy
  sidecars so **actions never break**. (The wrapper loads `node:sqlite` via
  `createRequire(import.meta.url)` — the bridge builds to **ESM** (`"type":"module"`), so a bare
  `require` is undefined and a static `import 'node:sqlite'` throws un-catchably without the flag.)

- **Phase 1 is purely additive (post-review amendment).** The multi-LLM plan review (2026-06-19) showed
  that retiring sidecar writes before `reconcile()` exists would make deleting the gitignored DB — the
  documented recovery — *silently lose history*, and that the real load/save chokepoint is
  `domain/action-store.ts`, not the tool files. So in **Phase 1 the JSON sidecars remain the
  authoritative read/write path** and the DB is written as a **mirror** (dual-write) and exposed
  **read-only** for the structured index + history + `cdp_status`. **Phase 2** flips authority to the DB,
  adds `reconcile()`, and retires sidecar writes. This keeps Phase 1 net-safe (no split-brain, no loss,
  #101 pair-write preserved) while still delivering a populated, queryable structured store.

```
SOURCE OF TRUTH:  .rn-agent/actions/*.yaml   (git-tracked)
DERIVED (gitignored): .rn-agent/state/actions.db   (node:sqlite, rebuildable)
  - actions_index    (id → app_id, path, content_hash, status, revision, mtime_baseline)
  - run_records      (was sidecar)
  - repair_records   (was sidecar)
list/run → read DB index → cross-check live YAML → mismatch/missing = LOUD, not empty
maestro_run → reads the YAML file directly (unchanged)
```

## 5. Components

Existing domain modules already provide clean seams:

- **`domain/action-db.ts`** *(new)* — `open()`, `migrate()`, `reconcile()`, typed CRUD, transactions,
  graceful-degrade. Owns the `node:sqlite` handle and the feature-detect.
- **`domain/sidecar-io.ts` + `domain/reusable-action.ts`** — `appendRunRecord` / `saveAction`
  persistence redirected to the DB. The **#101 atomic pair-write becomes a DB transaction**: the YAML
  write + the DB upsert form one logical commit (YAML stays the durable artifact; DB row follows).
- **`domain/action-inventory.ts` + `scripts/learned-actions` (migrated to TypeScript)** — read the
  **DB index**, then **cross-check against the live YAML files**, emitting a loud diagnostic on
  mismatch. This module remains the single source of truth for `/list-learned-actions`, `/run-action`,
  and the agents' Step-0 artifact scans, so its read path must keep working in `degraded` mode. As part
  of this work the current `scripts/learned-actions.mjs` is **migrated from JavaScript to TypeScript**
  (see §12).
- **`cdp_status`** — new field `actionStore: 'sqlite' | 'legacy-files' | 'degraded'` so the active mode
  is visible before any action call.
- **Supervisor** (`dist/supervisor.js`) — spawns the worker with `--experimental-sqlite` via a
  version-gated `sqliteFlagForNode()` (§8) in the worker spawn args (it controls that spawn), so
  `node:sqlite` is enabled where it needs the flag without relying on the user's launch flags. The
  `workerSpawnArgs()` builder lives in a side-effect-free module so it is unit-testable without
  importing the supervisor's top-level (which spawns a worker / takes the lock).

## 6. Data model

> **Post-review amendment.** Stats are stored **explicitly** (a `stats_json` column or discrete
> columns) — they must NOT be recomputed from `run_records`, because `appendRunRecord` tracks a
> *cumulative* `totalRuns` while `runHistory` is capped at `HISTORY_LIMITS.RUN_HISTORY_MAX` (50);
> recomputing would collapse `totalRuns` to ≤ 50. `run_records.failure_detail` is preserved (the plan
> draft dropped it). `id`/`ts` types are reconciled below (autoincrement INTEGER PK, ISO-string `ts`).
> A state-only save must **not** null `app_id`/`path`/`content_hash`/`status` — use `COALESCE`/partial
> upsert so a save without `meta` preserves prior metadata.

```sql
actions_index(
  id            TEXT PRIMARY KEY,   -- action id (matches <id>.yaml)
  app_id        TEXT,               -- bundleId the action targets
  path          TEXT,               -- absolute path to the YAML
  content_hash  TEXT,               -- hash of YAML body (drift / reconcile key)
  status        TEXT,               -- experimental | active
  revision      INTEGER,
  stats_json    TEXT,               -- ActionStats (cumulative; NOT recomputed from capped history)
  created_at    INTEGER,
  updated_at    INTEGER,
  mtime_baseline INTEGER            -- the #101 human-edit baseline
);
run_records(
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id     TEXT REFERENCES actions_index(id),
  ts            TEXT,               -- ISO-8601 (matches RunRecord.timestamp)
  trigger       TEXT,               -- agent | ci | human
  status        TEXT,               -- pass | fail (matches RunRecord.status)
  failure_code  TEXT,
  failure_detail TEXT,              -- preserved (was dropped in the plan draft)
  transport     TEXT,               -- cdp-js | NULL (maestro)
  auto_repair_json TEXT,            -- embedded auto-repair telemetry
  duration_ms   INTEGER
);
repair_records(
  id            TEXT PRIMARY KEY,
  action_id     TEXT REFERENCES actions_index(id),
  ts            INTEGER,
  outcome       TEXT,               -- passed | failed | refused | skipped
  diff_json     TEXT,
  budget_window INTEGER             -- rolling-24h repair budget bookkeeping
);
-- indexes: run_records(action_id), repair_records(action_id), actions_index(app_id)
```

The 24h repair-budget check (`cdp_repair_action`) reads `repair_records` by `action_id` + time window
instead of scanning a sidecar.

## 7. "Never lost / never unfound" behavior (Phase 2)

- On open, **`reconcile()`** scans `.rn-agent/actions/*.yaml`, upserts the index by `content_hash`, and
  classifies each id:
  - **index row, no YAML on disk** → *possibly lost* → loud warning (surfaced via `cdp_status` and the
    inventory read), never a silent drop.
  - **YAML on disk, no index row** → newly added (or fresh checkout) → ingest into the index.
  - **hash mismatch** → human/agent edited the YAML → update index + reset `mtime_baseline`.
- **Resolution guard** (ties to #348 / #357): when the resolved `projectRoot` corpus is empty BUT the DB
  index holds actions for the connected `appId`, surface *"corpus may be misresolved or lost"* with the
  resolved root + expected appId, instead of returning `[]`. This is the loud-failure half of #357.

## 8. Migration + graceful degradation

- **Migration:** first DB open imports existing per-action JSON sidecars (RunRecords / RepairRecords /
  status / revision / mtime_baseline) into the tables. In Phase 1, sidecars stay authoritative and are
  mirrored to the DB on every save; Phase 2 makes the DB authoritative and retires sidecar writes.
- **Graceful degradation:** if `node:sqlite` cannot load (Node < 22.5, flag unavailable on
  22.5–23.5, or load error), `action-db.ts` returns a fallback that operates from the legacy sidecars
  and **never throws**. `cdp_status.actionStore` reports a **three-way** state via a *read-only*
  detector (must not open/migrate the DB as a side effect): `sqlite` | `legacy-files` |
  `degraded:<reason>` (`sqlite-unavailable` vs `open-failed`).
- **engines (post-review amendment): keep `node >=22.5` floor? No — keep `>=22`.** Raising the floor
  to `>=22.5` would strand Node 22.0–22.4 users *before* they reach the degraded path, defeating the
  point of graceful degradation. The floor stays **`>=22`**; degraded mode is the contract on older
  patch lines. The worker gets `--experimental-sqlite` only on the versions that need it via a
  version-gated `sqliteFlagForNode()` (flag on 22.5–23.5; no-op on Node ≥ 23.6 where it is on by
  default; omitted on < 22.5 where the module is absent and we degrade). The `RN_BRIDGE_SUPERVISOR=0`
  in-process path (launched without the flag) must degrade cleanly — verified by test. Bump
  `@types/node` to `^22.5`/`^24` (currently `^20`, predating the `node:sqlite` type declarations).

## 9. Testing (TDD)

All **source** is TypeScript (see §12). Test files follow the established `node:test` convention
(`test/unit/**/*.test.js`) — kept as `.js` so the CI globs from #340 run them unchanged.

- **Unit** (in `test/unit/domain/` — nested, now actually executed in CI as of #340):
  - `action-db` open / migrate / CRUD / transaction rollback.
  - `reconcile()` classifications (lost / new / hash-mismatch).
  - sidecar → DB migration fidelity (records round-trip).
  - degradation path with `node:sqlite` stubbed unavailable → `degraded` mode, no throw.
  - loud index/YAML-mismatch + empty-corpus-but-index-has-rows resolution-guard cases.
- **Device smoke:** record → save → `cdp_run_action` → assert a `run_records` row exists for the action.

## 10. Decomposition / phasing

- **Phase 1 PR (additive — net-safe)** — DB layer (`action-db.ts`, ESM `createRequire` loader,
  append+trim writes in `BEGIN IMMEDIATE` with `PRAGMA busy_timeout` + WAL, explicit stats) + one-time
  sidecar→DB migration + version-gated `node:sqlite` feature-detect / degraded mode + read-only
  `cdp_status.actionStore` (3-way). **`domain/action-store.ts` is made store-aware** (the real
  `loadAction`/`saveAction`/`saveActionWithCAS`/`acknowledgeExternalEdit` chokepoint — NOT just the
  three tool files), and in this phase it **dual-writes**: sidecars stay authoritative, the DB is a
  mirror + read surface. Delivers the **structured store + history** goal without regressing the loss
  surface. Engines floor stays `>=22`.
- **Phase 2 PR** (stacked) — flip authority to the DB, add `reconcile()` loud diagnostics + DB-CAS
  concurrency semantics, retire sidecar writes, and add the #348/#357 resolution guard. Delivers the
  **never lost / never unfound** goal and **subsumes #357**.
- **#356** (keyboard occlusion) — separate, smaller spec; resume after this is settled.

## 11. Open risks

- `node:sqlite` is experimental; API churn across Node minors is possible. Mitigated by the narrow
  `action-db.ts` wrapper (one place to adapt) and the degraded fallback.
- Engines floor stays `>=22`; 22.0–22.4 (and any environment where `node:sqlite` won't load) land in
  `degraded` mode (no DB, sidecars still work) rather than breaking.
- Transactional consistency: in Phase 1 the sidecar pair-write (#101) is unchanged and authoritative;
  the DB mirror is written after it. A failed DB mirror leaves the authoritative sidecar intact (logged,
  never thrown); the one-time migration / Phase 2 `reconcile()` re-ingests on next open. Phase 2's flip
  to DB-authoritative is where the YAML-then-DB ordering + `reconcile()` re-ingest becomes load-bearing.

## 12. Language conventions

- **All source is TypeScript.** New modules (`domain/action-db.ts`, the inventory/index read path) are
  `.ts` under `scripts/cdp-bridge/src/`, consistent with the rest of the bridge. No new `.js` / `.mjs`
  source is introduced. Use explicit type imports (`import type { ... }`).
- **`scripts/learned-actions.mjs` → TypeScript (post-review amendment: compile-to-`dist`).** This
  standalone module is invoked directly by node from `/list-learned-actions`, `/run-action`, and the
  agents' Step-0 scans. The plan-review rejected runtime type-stripping: `--experimental-strip-types`
  needs Node **22.6** (the engines floor is staying `>=22`), and type-stripping does **not** rewrite
  `./x.js` → `.ts` import specifiers, so a standalone `.ts` that imports sibling source would fail to
  resolve. **Decision:** author the module as `.ts` under `scripts/cdp-bridge/src/` and **compile it
  into `dist/`** as part of the existing build; the slash-command/agent invocations call the built
  `dist/` JS. No runtime flag, no engines bump for this script. Public behavior (the inventory it
  returns) is unchanged. A behavioral-parity test guards the port.
- **Tests** stay `.js` under `test/unit/**/*.test.js` (the `node:test` convention the #340 CI globs
  execute) — this is the one intentional exception to "source is TypeScript", since they are the test
  harness, not shipped source.
