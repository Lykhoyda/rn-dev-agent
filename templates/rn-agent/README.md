# `.rn-agent/` — `rn-dev-agent` plugin home

This directory is the **plugin's home in your project**. Files here are
managed by the [`rn-dev-agent`](https://github.com/Lykhoyda/rn-dev-agent)
Claude Code plugin. One folder, one doctrine — the plugin's entire
footprint is `.rn-agent/` and it does not read or write anywhere else
in your project.

If your project also has a `.maestro/` folder for hand-authored E2E
tests, that's yours alone. The plugin doesn't read it.

> **One small exception:** if the agent lands on a login screen and
> finds a `.maestro/subflows/login.yaml` (or `sign_in.yaml`,
> `auth.yaml`, `register_user.yaml`, `flow_start.yaml`), it can use
> that subflow to log in. This is a read of *your* content, not plugin
> territory.

## Layout

```
.rn-agent/
├── README.md              ← this file (commit)
├── .gitignore             ← scoped ignores (commit)
├── .scaffold-version      ← plugin scaffold version (commit)
├── skeleton.yaml          ← semantic-name → testID map (commit)
├── nav-graph.yaml         ← cached navigation graph (commit, auto-managed)
├── actions/               ← saved replayable flows (commit)
│   └── *.yaml               each has a metadata header + state sidecar
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
Self-repair is bounded: max 3 attempts per action per 24h; failure codes
other than `SELECTOR_NOT_FOUND` escalate without auto-fix.

## Learn more

- [Actions guide](https://lykhoyda.github.io/rn-dev-agent/actions/) —
  what actions are and how the agent uses them
- [`/rn-dev-agent:list-learned-actions`](https://lykhoyda.github.io/rn-dev-agent/commands/list-learned-actions/) —
  see what's saved in this project
- [`/rn-dev-agent:run-action`](https://lykhoyda.github.io/rn-dev-agent/commands/run-action/) —
  replay a saved action
