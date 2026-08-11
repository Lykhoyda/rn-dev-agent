---
name: rn-workflow
description: Validate and establish the proven rn-dev-agent operating sequence before a real React Native journey — read project instructions and the declared package manager, inventory sessions/Metro/devices read-only, establish one exclusive simulator/emulator via typed session actions, apply and verify package integration and managed Metro, bind device/install/bundle/runner authority, run only the requested proof, and perform reverse-order cleanup. Use BEFORE any device_*/cdp_* journey.
---

# rn-workflow — the proven operating sequence, in order

This domain skill owns the **sequencing** of a real React Native journey on
Codex. The authoritative content stays where it lives today: the `check-env`
playbook owns inventory, the `setup` playbook owns onboarding,
`capturing-proof` owns evidence gates, and the `rn_session` tool owns every
refusal. Execute the steps below in order; never reorder, skip, or re-derive
them from memory.

Each step is: one action → one authoritative readback → one bounded stop.
There is no internal state to track — the only state ever consulted is a fresh
`rn_session(action="status")` projection.

## Package identity

Resolve the package root from this exact `SKILL.md` path (`../..` from this
skill directory). The bundled checker lives INSIDE the installed package at
`<package-root>/rn-dev-agent-core/dist/workflow-check.js`. Never use a
plugin-root environment variable, marketplace source path, or cache scan.

## When to use

- Before any journey that will touch a simulator/emulator (build, test, proof).
- When asked to "get the app ready", "validate the setup", or after repeated
  session/device failures.

## When NOT to use

- Pure code reading or editing with no device work — no session is needed.
- Plugin installation diagnostics — that is the `doctor` playbook
  (`$rn-dev-agent:doctor`).
- Project onboarding — that is the `setup` playbook (`$rn-dev-agent:setup`;
  Step 0 stops and routes there if onboarding is missing).

## The contract

```
0 read instructions ─► 1 pkg-manager + deps ─► 2 read-only inventory
                                                      │
                                     2a classify ownership (status only)
                                                      ▼
3 one exact device ─► 4 integration + managed Metro ─► 5 bind + requested proof
                                                      │
                              6 truthful evidence ─► 7 reverse cleanup + postflight
```

### Step 0 — Read the authoritative local instructions

Read the project's injected agent-instruction block (for Codex projects the
`AGENTS.md` block between `<!-- rn-dev-agent:codex-template-start -->` and
`<!-- rn-dev-agent:codex-template-end -->`; a Claude-onboarded project carries
the equivalent CLAUDE.md block) and `.rn-agent/local/troubleshooting.md`.
If no injected block exists → stop: "project not onboarded — run
`$rn-dev-agent:setup`". Never start device work on an un-onboarded project.

### Step 1 — Package manager and dependencies

Run the deterministic checker:

```bash
node <package-root>/rn-dev-agent-core/dist/workflow-check.js preflight --project "$PWD"
```

It reports `packageManager` (the `packageManager` field wins, lockfile
inference is the fallback), the exact `installCommand`, `nodeModulesPresent`,
the onboarding block, and the private-state-root kind and existence, with at
most ONE actionable `stop`.

In a monorepo the checker resolves the package-manager facts from the nearest
ancestor that declares `packageManager` or holds a lockfile (bounded by the git
repository root); a declaration or lockfile beside the app always wins. The
`workspaceRoot` fact reports that directory relative to the app root (`.` when
they are the same), and the install command must be run there.

- `DEPENDENCIES_MISSING` → run exactly the reported `installCommand`
  (e.g. `corepack pnpm install --frozen-lockfile` for a pnpm project,
  `corepack yarn install --immutable` for yarn). Never substitute a manager
  you prefer; never install for a project that declares neither field nor
  lockfile (`PACKAGE_MANAGER_UNDECLARED` is the user's to resolve).
- `PACKAGE_MANAGER_CONFLICT` → surface both facts and stop; do not guess.
- `PROJECT_MANIFEST_INVALID` / `PACKAGE_MANAGER_UNSUPPORTED` → surface the
  manifest defect and stop; lockfiles never override an invalid declaration.
- `LOCKFILE_MISSING` → the declared manager's lockfile is absent; commit it
  rather than running an unfrozen install.
- If the checker binary is absent (older installed plugin), perform the same
  reads manually with the same stop rules — the contract does not change.

### Step 2 — Read-only inventory

Execute the `check-env` playbook (`$rn-dev-agent:check-env`):
`rn_session(action="status")`, then passive `cdp_status`; `device_list` is
diagnostic inventory only. Then scan reusable automation via the
`list-learned-actions` playbook (`$rn-dev-agent:list-learned-actions`).

**Discovery is read-only.** The action listing is a filesystem scan; it works
even while the session is blocked and it grants nothing. A listed flow is
never runnable authority — replay happens only in Step 5, after device, Metro,
and runner authority are proven. Report only the redacted projections these
tools emit; never surface capability tokens, handles, or device identifiers
beyond what `status` itself projects.

### Step 2a — Classify prior ownership; follow only the typed recovery

If `status` reports `state: blocked`, classify using ONLY its
`recoveryRequirement` — **status is the sole reachable classifier**. A fresh
non-blocked operational projection proceeds directly to Step 3. From a blocked
contender every other `rn_session` action refuses, and gated-tool refusal text
may lag the current session model, so never take a remedy list from a refusal
message and never probe `device_*`/`maestro_run`/`cdp_run_action` "to see what
happens".

| `recoveryRequirement` | Prior owner | The ONLY next action |
|---|---|---|
| `attach` | live | Close the other session or work in a separate worktree. Never kill it, never adopt it. |
| `attach` | unknown | Unprovable identity is treated as live — same as above; re-run once its process state is observable. |
| `transport-restart` | proven dead (current sessions) | Restart the MCP transport; startup cleanup releases the dead owner itself. |
| `adoption` | proven dead (legacy sessions only) | `adopt_stale` with the advertised handle; a refusal (e.g. missing restoration manifest) is surfaced verbatim, not worked around. |
| outstanding stale-device journal | — | The identifier-free `release_stale_device` resume action named by status. |

Rules, non-negotiable:

1. Follow `recoveryRequirement.nextAction` **verbatim** — one typed action per
   status read.
2. After ANY recovery action, **re-read `rn_session status` and require a fresh
   non-blocked operational projection** (for example `source_bound`) before
   Step 3. Never chain two recovery mutations without a fresh status read
   between them.
3. **Bounded non-convergence stop:** at most ONE transport restart per
   identical blocked projection. If the same projection recurs after following
   the prescribed remedy, stop and report the observed non-convergence with
   the documented manual remedies (restore the exact integration manifest the
   refusal names; or, with no supervisor running, the state-root recovery in
   the session-authority docs). Surface them as facts — never auto-execute
   them, never loop restarts.
4. Never invent contender repair authority: a `SESSION_AUTHORITY_REQUIRED`
   refusal is an ownership condition, not UI drift — not fixable by
   auto-repair, flow edits, retries, or binding another device.

### Step 3 — One exact device, exclusivity proven

`rn_session(action="bind_device", platform, deviceId, appId)` for exactly one
device. If `device_list` shows multiple booted candidates and the user did not
name one, stop and ask — never pick the first available device, never shut
down ambient or foreign devices. Refusals pass through verbatim with their
typed alternatives: `DEVICE_CLAIM_CONFLICT` → hand off explicitly, adopt a
proven-stale owner, or bind a different free simulator — never force-steal;
`BUSY_FOREIGN_FLOW` → wait for its owner.

A `DEVICE_BUSY` refusal is a live device-lock holder on the exact device, not
an in-flight operation to wait out. It reports whether the holder is alive and
its heartbeat age bounded to 0–90s. It does not expose the holder PID, project path, or app ID,
and it does not mutate the holder.

From the holder worktree, run `device_snapshot action=close` to release it safely.

Alternatively, boot a dedicated simulator (or emulator), bind its exact ID with `rn_session action=bind_device`, run the normal managed build/install there, then select that exact ID with `device_snapshot action=open ... attachOnly=true` when the app is already running.

Dead holders self-heal on the next open attempt; live holders self-heal once their heartbeat is stale beyond the existing 90s recovery window.

A healthy live holder is never stolen or changed by this refusal.

### Step 4 — Integration, private state root, managed Metro

1. `rn_session(action="preview_integration")` → show the reversible edits.
2. `rn_session(action="apply_integration", confirmed: true)`.
3. Build/start ONLY through the literal integrated package script with the
   manager from Step 1 (`<pm> run ios` / `<pm> run android`). Never raw `expo start`,
   `expo run:*`, `xcodebuild`, or `adb install` — only the managed launcher
   produces the signed initial-bundle marker that authoritative tools require.
4. The checker already reported the private-state-root kind; any subprocess
   you spawn must inherit the same environment (`XDG_STATE_HOME` in
   particular). A state root that would fork between supervisor and shell is a
   stop, not a silent continue.

### Step 5 — Bind remaining authority; run only the requested proof

`pin_dev_client` (Expo dev-client) or the exact-app launch, then
`device_snapshot action=open` to bind the runner. Only now is replay
authorized — and only via `cdp_run_action` (never raw `maestro_run` for a
learned action): the core parks the runner and re-proves flow, device, and
runner authority itself. Run ONLY what the journey asked for — a saved action,
the `test-feature` playbook (`$rn-dev-agent:test-feature`), or
`capturing-proof` — by reference, never inlined.

**Success is re-read from authoritative tool state**: the tool-result envelope
and its postflight receipt, `expect_*` asserts, and `cdp_network_log` for
mutation-as-proof. Command exit codes and prose claims are never success.

### Step 6 — Truthful evidence

When proof artifacts are requested, follow the `capturing-proof` skill's hard
gates by reference. Always:

- Label every check **device-free** (lint, typecheck, unit tests, hermetic
  evals) or **native/device-bound** (runner interactions, screenshots,
  replays). Never present the former as the latter.
- Never demand expensive native validation (cold builds, device matrices)
  beyond the journey's accepted scope.
- State every shortcut (deep link, forced param, state reset) per the
  Verification Discipline in the project's injected instruction block, or
  report the verification as partial.

### Step 7 — Reverse-order cleanup and postflight

Exactly this order, each refusal surfaced verbatim:

1. `device_snapshot action=close` (release the runner)
2. `rn_session(action="stop_metro")` — `METRO_CLEANUP_PENDING` → retry once
   after managed launcher cleanup, then stop with the reported port facts
3. `rn_session(action="restore_integration", confirmed: true)`
4. `rn_session(action="release")`

Then verify residue:

```bash
node <package-root>/rn-dev-agent-core/dist/workflow-check.js postflight --project "$PWD"
```

Pass the redacted `status` JSON via `--status-file` — without it the runner,
Metro, and recorder bindings cannot be read at all. The verdict says which you
got:

- `pass` with `cleanupProven: true` — the status envelope proved every binding
  released and no integration residue remains.
- `pass-unproven` (also exit 0) — residue-only evidence: integration and
  recordings were inspected, session cleanup was NOT proven. Report it that
  way; never claim "clean" from silence.
- `stop` — the named binding or residue is still outstanding.

## Bounded stops (never work around these)

| Stop | Meaning | You may |
|---|---|---|
| `PROJECT_NOT_ONBOARDED` | No injected instruction block | Route to `$rn-dev-agent:setup` |
| `PROJECT_MANIFEST_INVALID` / `PACKAGE_MANAGER_UNSUPPORTED` | Manifest cannot grant package-manager authority | Repair `package.json`; never infer from lockfiles |
| `PACKAGE_MANAGER_CONFLICT` / `_UNDECLARED` | Ambiguous install authority | Report both facts; user resolves |
| `attach` (live/unknown owner) | Another session owns the worktree | Close it or use another worktree |
| Non-convergent `transport-restart` | Startup cleanup is refusing | Report the manual remedy facts |
| Multiple booted devices, none named | Ambient ambiguity | Ask the user to name one |
| `AUTOMATION_CLEANUP_UNPROVEN` | Process-group absence unproven | Run the returned manual command, retry once |

## This skill never

- Runs raw `expo start` / `xcodebuild` / `adb install` / `xcrun simctl` for
  anything a plugin tool or the integrated package script owns.
- Kills, adopts, or waits out an owner that is live or unprovable.
- Treats a listed action, an exit code, or prose as authority or success.
- Mirrors or caches session state — every decision re-reads `status`.
- Develops app features — route feature work to the `rn-feature-dev` playbook
  (`$rn-dev-agent:rn-feature-dev`), which composes these same steps.

## Verification — journey complete when

- [ ] Every step's readback (not its command exit) confirmed the step
- [ ] The proof that ran is exactly what the journey requested
- [ ] Evidence is labeled device-free vs native, shortcuts stated
- [ ] Postflight checker reports `pass` with `cleanupProven: true` (a
      `pass-unproven` verdict is residue-only evidence, and a stop was
      surfaced, not hidden)
