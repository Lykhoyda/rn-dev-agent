# `.rn-agent/` — `rn-dev-agent` plugin home

This directory is the **plugin's home in your project**. Files here are
managed by the [`rn-dev-agent`](https://github.com/Lykhoyda/rn-dev-agent)
plugin for Claude Code and Codex. One folder, one doctrine — the plugin's
entire footprint is `.rn-agent/` and it does not read or write anywhere else in
your project.

If your project also has a `.maestro/` folder for hand-authored E2E tests,
that's yours alone. Authentication prologues resolve the exact
`.rn-agent/actions/user-login.yaml` learned action and never infer a login flow
from `.maestro/` filenames. `cdp_login_prologue` is a navigation helper, not PR
proof; lock and run the login e2e on the exact candidate for formal proof.

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
├── state/                 ← unfenced compatibility runtime state (gitignore)
├── recordings/            ← cdp_record_test buffers (gitignore)
├── snapshots/             ← debugging captures (gitignore)
├── diag/                  ← debug logs (gitignore)
└── index.json             ← derived lookup; regenerated on demand (gitignore)
```

## Lifecycle of an action

1. **Discovery** — `cdp_record_test_start` → `…_stop` buffers events to
   `recordings/<id>.json`.
2. **Save** — `cdp_record_test_save_as_action` writes
   `actions/<id>.yaml`; mutable sidecar state follows the current runtime root.
   The YAML is the executable test; the sidecar holds revision,
   `runHistory[]`, `repairHistory[]`, and replay statistics.
3. **Replay** — `/run-action <id>` (calls `cdp_run_action`) runs the
   flow and updates the sidecar.
4. **Self-heal** — on a `SELECTOR_NOT_FOUND` failure, `cdp_repair_action`
   uses live device introspection to patch the YAML in place, bumps the
   sidecar `revision`, and demotes `status` to `experimental` until the
   next clean replay.
Self-repair is bounded: max 3 attempts per action per 24h; failure codes
other than `SELECTOR_NOT_FOUND` escalate without auto-fix.

In an authority-fenced session, the sidecar lives at
`<state-home>/v2/sessions/<sessionId>/runtime/state/<id>.state.json`
(`~/Library/Application Support/rn-dev-agent/v2/sessions/<sessionId>/runtime/state/<id>.state.json`
by default on macOS), not in this directory. `cdp_run_action` returns its exact
location as `data.writes.runtimeStatePath` on success or
`meta.writes.runtimeStatePath` on failure. A fresh fenced session starts at
revision 1 with empty run and repair history; revisions and promotion history
do not carry over, and a promotion earned in one session is invisible to the
next. The project-local `state/` path is only the unfenced compatibility
fallback.

## Linked Git worktrees

`git worktree add` populates a worktree from the commit only, so anything here
that is untracked never arrives. If you keep this directory **fully private**
(never committed), a fresh worktree starts with no learned actions at all.

The plugin supports that private setup as a first-class configuration, and it
shares **exactly one subpath**:

| Path | Shared? | Why |
|---|---|---|
| `actions/` | **read-only inheritance** | A linked worktree may inventory and replay only the verified same-repository primary corpus; it never falls through to another worktree. Each inventory or replay freezes the link, corpus, repository, and selected YAML identities, then refuses the whole operation without partial results if any identity changes; the next operation resolves afresh. Migration, generation, repair, promotion, and every other YAML mutation refuse through the inherited link; make those changes in the owning worktree. |
| `state/`, `recordings/`, `snapshots/`, `diag/`, `index.json`, `local/` | no | Per-worktree runtime state, including the action SQLite database and its WAL. The session runtime root must be a real directory. |
| `integration/` | no | Session integration refuses any symlinked component under it and fails closed on one. |
| `nav-graph.yaml`, `skeleton.yaml` | no | Derived from the app source on *this* branch; sharing them across branches serves stale data. |
| `config.json`, `e2e.config.json`, `fixtures/`, `proposals/`, `dev-bridge.ts`, `globals.d.ts`, `.scaffold-version` | no | Project scaffold and per-worktree output. |
| `.rn-agent/` itself | **never** | It is the mutable per-worktree security boundary. Session integration rejects a root symlink; setup can migrate the recognized legacy layout without copying integration, state, recordings, or runtime data. |

Because `actions/` is linked *inside* a real local `.rn-agent/` directory, the
common directory-form ignore rule (`.rn-agent/`) already hides it, so `git
status` stays clean. The link is a read-only replay source: runtime state stays
local and action YAML mutations fail closed. No other private instructions or
`.rn-agent` data are inherited.

Nothing is shared automatically without your consent. `/rn-dev-agent:doctor`
reports the state read-only; `/rn-dev-agent:setup` previews and asks per
resource, and can install a local `post-checkout` hook so ordinary `git worktree
add` prepares the context before an agent starts. That hook is untracked, scoped
to your repository, and never replaces an existing hook or a managed
`core.hooksPath`. `git worktree add --no-checkout`, and tools that bypass Git
hooks, still need `/rn-dev-agent:setup` in the new worktree.

If `.rn-agent/` is **committed** (the default team regime), none of this
applies: Git delivers `actions/` to every worktree and the plugin never inherits
or replaces a Git-managed path.

## Learn more

- [Actions guide](https://lykhoyda.github.io/rn-dev-agent/actions/) —
  what actions are and how the agent uses them
- [`/rn-dev-agent:list-learned-actions`](https://lykhoyda.github.io/rn-dev-agent/commands/list-learned-actions/) —
  see what's saved in this project
- [`/rn-dev-agent:run-action`](https://lykhoyda.github.io/rn-dev-agent/commands/run-action/) —
  replay a saved action
