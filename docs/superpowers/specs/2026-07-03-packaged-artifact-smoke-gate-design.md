# #432 — Packaged-artifact smoke gate: CI validates what users actually run

**Date:** 2026-07-03
**Issue:** [#432](https://github.com/Lykhoyda/rn-dev-agent/issues/432)
**Origin:** 2026-07-03 test-confidence audit (workspace ROADMAP entry) — P0-A of the prioritized gate plan
**Related escapes:** #419 (zero tools after upgrade), #424 (no `.xctestrun` after self-build), #361/#363 (delivery gap), pre-#356 "src change inert in installs"

## Problem

The artifact users run is not the artifact CI tests. Three divergences, none
gated today:

1. **Committed `dist/` vs rebuilt `dist/`.** Users load the git-tracked
   `scripts/cdp-bridge/dist/` via `plugin.json`'s
   `mcpServers.cdp = node …/dist/supervisor.js`. CI's `test` job runs
   `npm run build` (tsc) *before* every test step — so a stale committed
   `dist/` is silently repaired in CI and shipped broken to users. Only the
   observability SPA bundle has a freshness gate (`check-web-bundle.sh`);
   the ~200 compiled JS files have none.
2. **Production install vs dev install.** On user machines the SessionStart
   hook chain (`detect-rn-project.sh` → `ensure-cdp-deps.sh`) copies
   `package.json` **and the committed `scripts/cdp-bridge/package-lock.json`**
   (`ensure-cdp-deps.sh:25`) and installs with
   `npm install --production --ignore-scripts` into
   `$CLAUDE_PLUGIN_DATA/cdp-node_modules` — a **production-only,
   lockfile-pinned** tree. CI installs the root-workspace-locked tree
   **including devDependencies**. A runtime import of a devDependency passes
   every current gate and breaks every user install. (Corrected per Codex
   plan review 2026-07-04: an earlier revision of this spec claimed the
   install was unpinned. Separate pre-existing hygiene finding: the committed
   lock is stale — its `version` field says 0.38.23 vs package.json 0.53.0 —
   so the pin users receive is an old resolution; follow-up, not this gate's
   scope.)
3. **Registration vs static claims.** Nothing asserts what the spawned server
   actually registers. #419's symptom — the MCP worker comes up with **zero
   tools** while the SessionStart banner claims a hardcoded count — is
   invisible to module-level unit tests, which never complete a real MCP
   handshake against the packaged entrypoint.

## Goals

- A PR that stales, breaks, or under-registers the shipped artifact goes
  **red in CI**, with a failure message naming the broken layer.
- The gate exercises the **exact user runtime path**: committed `dist/`,
  production-only unpinned install, `supervisor.js` stdio spawn, MCP
  handshake, observe HTTP surface.
- Deliberate friction on tool-surface changes: adding/removing/renaming an
  MCP tool requires touching a committed golden (same philosophy as
  `require-changeset.sh`).

## Non-goals

- No changes to `ensure-cdp-deps.sh` or the user install flow itself.
- No simulator/device coverage (that is P2 of the audit plan).
- No golden-payload runner contract tests (P0-B, separate issue).
- No mid-session-upgrade simulation (#419's exact trigger); the gate covers
  the cold-registration invariant that #419's static banner violated.
- No changeset: nothing under `scripts/cdp-bridge/src/` changes; this is
  test/CI surface only.

## Design

### 1. `scripts/check-dist-fresh.sh` — dist-freshness gate

Modeled on `check-web-bundle.sh`, but clean-slate so orphans are caught:

1. Delete everything under `scripts/cdp-bridge/dist/` **except
   `observability/web-dist/`** (owned by `check-web-bundle.sh`; Vite, not tsc).
2. `npx tsc` in `scripts/cdp-bridge/` (deps already installed by the job's
   `npm ci`; deterministic given the root lockfile pins typescript).
3. `git status --porcelain -- scripts/cdp-bridge/dist` must be empty.
   - ` M` → committed file is stale (src changed without rebuild+commit)
   - `??` → tsc emits a file that was never committed
   - ` D` → orphan: committed file tsc no longer emits (plain `git diff`
     misses this class)
4. On failure: print the porcelain output plus the one-line fix
   (`cd scripts/cdp-bridge && npm run build && git add dist`), exit 1.

**CI placement:** replaces the `TypeScript build` step in the existing
`test` job (`ci.yml`) — the script's rebuild *is* the build, and leaves
`dist/` fresh for the test steps that follow. Runs on PR and push to main
(a stale merge is loud immediately). Guard test
`scripts/test/check-dist-fresh.test.sh` (house pattern: the CI gates are
themselves tested) covers: fresh tree passes; a doctored `dist` file fails;
an orphan file fails.

### 2. `test/integration/packaged-artifact-smoke.test.js` — user-path smoke

One test file, phases asserted in order with **typed failure prefixes**
(`SMOKE_INSTALL`, `SMOKE_SPAWN`, `SMOKE_HANDSHAKE`, `SMOKE_REGISTRY`,
`SMOKE_OBSERVE`, `SMOKE_SHUTDOWN`) so a red run names the broken layer.

**Setup (once per file):**
- `mkdtemp` → copy `dist/`, `package.json`, and (when present)
  `package-lock.json` — exactly the files `ensure-cdp-deps.sh:24-25` copies;
  no `src/`, no root workspace.
- `npm install --production --ignore-scripts --no-audit --no-fund` in the
  temp dir — byte-for-byte the `ensure-cdp-deps.sh` install (lockfile-pinned
  prod deps, matching user machines). One retry on failure (registry flake
  mitigation); ~15–30 s in CI with the npm cache.

**Phases:**
1. **Spawn:** `node <tmp>/dist/supervisor.js --no-lock`, `cwd` = temp dir
   (non-RN → no project detection side effects), env includes
   `RN_AGENT_OBSERVE_PORT=<ephemeral>`; stdio piped. Reuses the gh-264
   line-delimited JSON-RPC harness, **extracted** from
   `gh-264-supervisor-respawn.test.js` into
   `test/helpers/supervisor-harness.js` (gh-264 imports it back; no
   behavior change).
2. **Handshake:** real MCP `initialize` (protocolVersion, capabilities,
   clientInfo) + `notifications/initialized`. Assert a well-formed result.
3. **Registry:** `tools/list` → sorted name set must equal the committed
   golden `test/fixtures/tool-registry.json` **exactly**. Failure prints
   the add/remove diff and the fix command.
4. **Observe:** `tools/call observe {action:"start"}` → parse the URL →
   `GET /` → assert HTTP 200 and SPA markup (not the 503 "SPA bundle not
   built" branch). Proves `web-dist` ships inside `dist/` and the packaged
   layout's `readFileSync` path resolution holds.
5. **Shutdown:** SIGTERM → exit code 0.

Lives in `test/integration/` → runs in the existing CI `Integration tests`
step and in local `npm run test:integration`. The freshness gate (§1) runs
first in the job, so the smoke's "fresh dist" is provably identical to the
committed dist — the committed artifact is transitively validated.

### 3. `test/fixtures/tool-registry.json` + `scripts/update-tool-registry.mjs`

- Golden: sorted JSON array of all registered MCP tool names (78 at time of
  writing — a `trackedTool(` grep says 79, but one hit is the function
  definition itself; live `tools/list` returns 78).
- Updater: spawns the packaged server the same way the smoke does (helper
  shared), writes the sorted `tools/list` result back to the fixture.
  Regeneration is deliberate: run the script, review the diff, commit.

## Decisions (from brainstorm)

- **Golden committed list** over src-grep parity: catches accidental drops
  and silent renames; explicit-update friction matches house taste
  (require-changeset). Src-parity passes silently when a tool vanishes from
  both sides.
- **Full user-path replication** over in-repo spawn: the production-only,
  lockfile-pinned install is the only way to catch devDependency leaks —
  the class CI's root-workspace dev install is structurally blind to.
- **Existing `test` job** over a new workflow job: typed phase prefixes give
  failure attribution without more workflow surface.

## Risks & mitigations

- **Network flake** (production install hits the registry): single retry;
  failure message distinguishes `SMOKE_INSTALL` so a registry outage isn't
  misread as a product regression.
- **Install resolution matches users, not the PR author's tree**: the copied
  lockfile pins prod deps to what user machines resolve. Divergence from the
  root-workspace CI install is intentional signal; the
  `SMOKE_INSTALL`/runtime phase split keeps it diagnosable.
- **tsc nondeterminism**: version pinned by the root lockfile (`npm ci`),
  same guarantee `check-web-bundle.sh` relies on.
- **Supervisor lock contention in CI**: `--no-lock`, same as gh-264.

## Testing

- The smoke test is itself the integration coverage.
- `scripts/test/check-dist-fresh.test.sh` guards the freshness script
  (pass / stale-file fail / orphan fail).
- gh-264 keeps passing after the harness extraction (refactor-only).
