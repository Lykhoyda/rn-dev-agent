# `.rn-agent/` — `rn-dev-agent` plugin home

This directory is the home for everything the
[`rn-dev-agent`](https://github.com/Lykhoyda/rn-dev-agent) Claude Code
plugin reads or writes in your project. One folder, one doctrine.

If your project has a `.maestro/` folder for hand-authored E2E tests,
that's yours alone — the plugin treats it as out of scope. The single
intentional carve-out is `cdp_auto_login`, which reads user-authored
login subflows from `<project>/.maestro/subflows/login.yaml` (and
`sign_in.yaml`, `auth.yaml`, `register_user.yaml`, `flow_start.yaml`)
when the app is on a login screen — that's a *read* of user-managed
content, not plugin territory. To migrate this carve-out into
`.rn-agent/`, see issue tracker; until then, login subflows live in
`.maestro/subflows/`.

## Layout

```
.rn-agent/
├── README.md              ← this file (commit)
├── .gitignore             ← scoped ignores (commit)
├── .scaffold-version      ← plugin scaffold version (commit)
├── skeleton.yaml          ← semantic-name → testID map (commit)
├── nav-graph.yaml         ← cached navigation graph (commit, auto-managed)
├── actions/               ← reusable Maestro flows (commit)
│   └── *.yaml               each carries an M7 metadata header + sidecar
├── fixtures/              ← seed data for replay (commit)
├── proposals/             ← repair proposals queued for review (commit)
├── state/                 ← runtime state per action (gitignore)
├── recordings/            ← cdp_record_test buffers (gitignore)
├── snapshots/             ← debugging captures (gitignore)
├── diag/                  ← debug logs (gitignore)
└── index.json             ← derived lookup; regenerated on demand (gitignore)
```

## Lifecycle of an action

1. **Discovery** — `cdp_record_test_start` → `…_stop` buffers events to
   `recordings/<id>.json`.
2. **Save** — `cdp_record_test_save_as_action` writes the paired
   `actions/<id>.yaml` + `state/<id>.state.json` (sidecar). The YAML is
   the executable test; the sidecar holds runtime metadata (revision,
   status, `runHistory[]`, `repairHistory[]`).
3. **Replay** — `/run-action <id>` (calls `cdp_run_action`) runs the
   flow and updates the sidecar.
4. **Self-heal** — on a `SELECTOR_NOT_FOUND` failure, `cdp_repair_action`
   uses live device introspection to patch the YAML in place, bumps the
   sidecar `revision`, and demotes `status` to `experimental` until the
   next clean replay.
5. **Compact** — `/rn-dev-agent:rn-agent-compact` periodically flags
   cold (90+ day), flaky (>50% fail), or high-churn actions for
   human review. Deletion is human-in-the-loop.

Self-repair is bounded: max 3 attempts per action per 24h; failure codes
other than `SELECTOR_NOT_FOUND` escalate without auto-fix.

## Cleanup

`/rn-dev-agent:rn-agent-compact` surfaces a corpus health report:

- Actions not run in 90+ days (cold storage candidates)
- Actions repaired 5+ times in 30 days (high-churn → consider redesign)
- Actions with `failureCount/totalRuns > 0.5` (flaky)
- Actions with overlapping `intent` (potential duplicates)

The report is informational; deletion stays a deliberate human gesture.

## Refs

- Workspace: `docs/DECISIONS.md` — D1208 (single-folder doctrine,
  supersedes D1207), D1206 (three-layer architecture)
- Plugin commands: `/rn-dev-agent:list-learned-actions`,
  `/rn-dev-agent:run-action`, `/rn-dev-agent:rn-agent-compact`,
  `/rn-dev-agent:rn-agent-export`, `/rn-dev-agent:rn-agent-import`
- Plugin: `scripts/learned-actions.mjs`,
  `scripts/cdp-bridge/src/domain/action-store.ts`
