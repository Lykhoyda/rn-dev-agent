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
  sidecars so **actions never break**.

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
- **Supervisor** (`dist/supervisor.js`) — spawns the worker with `--experimental-sqlite` in the worker
  `execArgv` (it controls that spawn), so `node:sqlite` is enabled on Node 22.5+ without relying on the
  user's launch flags.

## 6. Data model

```sql
actions_index(
  id            TEXT PRIMARY KEY,   -- action id (matches <id>.yaml)
  app_id        TEXT,               -- bundleId the action targets
  path          TEXT,               -- absolute path to the YAML
  content_hash  TEXT,               -- hash of YAML body (drift / reconcile key)
  status        TEXT,               -- experimental | active
  revision      INTEGER,
  created_at    INTEGER,
  updated_at    INTEGER,
  mtime_baseline INTEGER            -- the #101 human-edit baseline
);
run_records(
  id            TEXT PRIMARY KEY,
  action_id     TEXT REFERENCES actions_index(id),
  ts            INTEGER,
  trigger       TEXT,               -- agent | ci
  verdict       TEXT,               -- passed | failed | empty | ...
  transport     TEXT,               -- maestro | cdp-js
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
  status / revision / mtime_baseline) into the tables. Legacy sidecars are kept read-only as a safety
  net for one release, then removable.
- **Graceful degradation:** if `node:sqlite` cannot load (Node < 22.5, flag unavailable, or load error),
  `action-db.ts` returns a fallback that operates from YAML + legacy sidecars and **never throws**;
  `cdp_status.actionStore` reports `degraded` (or `legacy-files`). Actions keep working without the DB.
- **engines:** bump `scripts/cdp-bridge/package.json` to `node >=22.5.0`; document the experimental-API
  risk and the degraded path in CLAUDE.md / docs.

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

- **Phase 1 PR** — DB layer (`action-db.ts`) + sidecar→DB migration + `node:sqlite` feature-detect /
  degraded mode + `cdp_status.actionStore` + redirect `appendRunRecord` / repair-budget reads to the DB.
  Delivers the **structured store + history** goal.
- **Phase 2 PR** (stacked) — `reconcile()` loud diagnostics + the #348/#357 resolution guard. Delivers
  the **never lost / never unfound** goal and **subsumes #357**.
- **#356** (keyboard occlusion) — separate, smaller spec; resume after this is settled.

## 11. Open risks

- `node:sqlite` is experimental; API churn across Node minors is possible. Mitigated by the narrow
  `action-db.ts` wrapper (one place to adapt) and the degraded fallback.
- Raising the engines floor to `>=22.5` may strand users on 22.0–22.4 LTS patch lines; they land in
  `degraded` mode (no DB, YAML still works) rather than breaking — acceptable.
- Transactional consistency between the YAML write and the DB upsert must preserve the #101 guarantee
  (no half-written action). The wrapper performs the YAML write first (durable artifact), then the DB
  upsert; a failed upsert leaves a valid YAML that `reconcile()` re-ingests on next open.

## 12. Language conventions

- **All source is TypeScript.** New modules (`domain/action-db.ts`, the inventory/index read path) are
  `.ts` under `scripts/cdp-bridge/src/`, consistent with the rest of the bridge. No new `.js` / `.mjs`
  source is introduced. Use explicit type imports (`import type { ... }`).
- **`scripts/learned-actions.mjs` → TypeScript.** This standalone module (invoked directly by node from
  `/list-learned-actions`, `/run-action`, and the agents' Step-0 scans) is migrated off `.mjs`. It is
  *not* part of the compiled `dist/` bundle today, so the migration must pick a run mechanism:
  - **Recommended:** run the `.ts` directly via Node type-stripping (`--experimental-strip-types`,
    Node 22.6+). The engines floor is already rising to `>=22.5` for `node:sqlite`; bumping the
    *invocation* requirement to 22.6 for this script (or stripping-by-default on 23.6+) is a small,
    consistent step. The slash-command/agent invocations are updated to pass the flag (or rely on
    default stripping) when launching the script.
  - **Alternative:** compile the module into `dist/` as part of the existing build and invoke the
    built output from the commands/agents. Avoids the runtime flag but adds a second consumer of the
    build and an indirection from `scripts/` → `dist/`.
  - The chosen mechanism is settled in the implementation plan; either way the public behavior
    (the inventory it returns) is unchanged and must keep working in `degraded` mode.
- **Tests** stay `.js` under `test/unit/**/*.test.js` (the `node:test` convention the #340 CI globs
  execute) — this is the one intentional exception to "source is TypeScript", since they are the test
  harness, not shipped source.
