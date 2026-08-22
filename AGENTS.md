# Repository Guide For Agents

This file is for coding agents working in this repository. Keep it current and
practical. Do not paste session memory, issue histories, or one-off debugging
notes here.

## Repository Map

- Root workspace: Yarn 4 workspace, managed by `package.json` and `yarn.lock`.
  Use `corepack yarn ...` from the repository root.
- `packages/rn-dev-agent-core/`: TypeScript MCP server, CDP bridge, device
  tools, learned actions, observability server, and committed `dist/` output.
- `packages/claude-plugin/`: Claude Code host package. Owns Claude manifests,
  hooks, commands, agents, skills, templates, helper scripts, packaged native
  runners, runner manifest, and bundled core runtime.
- `packages/codex-plugin/`: Codex host package. Owns `.codex-plugin/`,
  `.mcp.json`, `bin/cdp-supervisor.js`, commands, agents, skills, templates,
  packaged native runners, runner manifest, and bundled core runtime. Codex
  does not consume Claude hooks; "No plugin hooks" is expected.
- `packages/shared-agent-knowledge/`: canonical host-neutral workflow knowledge
  for skills, commands, agents, and `templates/rn-agent/`.
- `packages/rn-fast-runner/`: source iOS XCTest native runner.
- `packages/rn-android-runner/`: source Android UiAutomator native runner.
- `apps/docs-site/`: deliverable documentation site workspace.
- Engineering processes, plans, stories/specifications, diagnostics, comparisons,
  and research live in the workspace [`docs/`](https://github.com/Lykhoyda/rn-dev-agent-workspace/tree/main/docs/);
  never add a top-level `docs/` tree here. Captain-approved architecture records
  belong in Anton Factory `architect-docs`; link to either owner instead of copying.

The plugin repo ships user-visible code and docs. Internal proof artifacts,
bench reports, and project planning belong in GitHub Issues, PRs, or the
sibling workspace only when explicitly requested.

## Editing Rules

- New source and test code must be TypeScript: `.ts` or `.tsx`. Existing
  grandfathered `.js`/`.mjs` files are tracked in
  `scripts/js-migration-baseline.txt`; do not grow that baseline casually.
- Keep the MCP server key `cdp` stable. Commands, docs, and session state rely
  on that name.
- Do not commit generated local artifacts: `.playwright-mcp/`, root
  `observe-*.png`, simulator screenshots, temporary logs, or proof captures.
- Do not add or restore `BUGS.md`. Bugs are tracked in GitHub Issues.
- Do not create compatibility symlinks for legacy root paths. Host package
  outputs must be real directories/files, not symlinks.
- Do not hand-edit generated host runtime or packaged native-runner copies.
  Regenerate them from sources.
- Keep zod `.describe()` strings in tool schemas short enough to stay on one
  line after formatting: `apps/docs-site/scripts/generate-tool-docs.mjs` only
  parses a quote immediately after `describe(`, so a prettier-wrapped string
  silently drops the description from the generated tool docs.
- Code in `src/injected-helpers.ts` is evaluated via CDP inside an
  already-bundled Metro/Hermes runtime: `require('<package-name>')` throws
  there (Metro resolves only exact dev verboseNames). Prove "is X bundled?"
  with Metro's dev registry (`globalThis.__r.getModules()`, per-module
  `verboseName`) or fiber/render evidence, bounded and fail-closed.

## Where To Make Changes

- Core MCP behavior: edit `packages/rn-dev-agent-core/src/`, then run
  `corepack yarn build:core` and `corepack yarn build:host-runtimes`.
- The registered `cdp_connect` tool is `createRegisteredConnectHandler`
  (`src/session/registered-connect.ts` → `rn_session` `pin_dev_client` →
  `pinSessionDevClient`/`connectExactSessionTarget` in `src/index.ts`);
  `createConnectHandler` in `src/tools/connection.ts` is the unregistered
  ambient compat connector, tree-shaken out of host bundles but still pinned
  by contract tests.
- Observe actions/e2e panels resolve their project root through
  `createObserveRootResolver` (`src/observability/observe-project-root.ts`):
  bound-session `source.appRoot` > `RN_PROJECT_ROOT` > heuristic discovery,
  refusing truthfully (HTTP 503 `PROJECT_ROOT_UNAVAILABLE`) instead of
  falling back to another checkout. Exception: `POST /api/e2e/actions/run`
  keeps its `ok:false` result contract and reports the same reason as
  HTTP 500. `POST /api/e2e/run` must resolve the root before entering
  `authorityGate.wrap`, which converts throws into `ok:false` values —
  but must not pass it as a gate argument, since `bindSourcePaths` fences
  a supplied `projectRoot` to `status.source.appRoot` and would refuse the
  sibling-workspace primary checkout.
- Claude-only host behavior: edit `packages/claude-plugin/`.
- Codex-only host behavior: edit `packages/codex-plugin/`.
- Host-neutral workflow knowledge: edit `packages/shared-agent-knowledge/`,
  mirror/adapt the affected files into both host packages, and run
  `bash scripts/check-agent-package-sync.sh`. That gate compares Claude copies
  byte-for-byte but Codex commands and adapted domain skills by file set only,
  so a stale Codex adaptation passes silently — diff it yourself and re-apply
  the edit in Codex's own wording (`$rn-dev-agent:` invocation form, no
  `allowed-tools`). Recurring cross-file doctrine gets one canonical section
  plus pointers, never copies — session-ownership recovery is owned by
  `skills/using-rn-dev-agent/SKILL.md` § "Session ownership recovery".
- Native runner behavior: edit `packages/rn-fast-runner/` or
  `packages/rn-android-runner/`, then run `corepack yarn build:host-runtimes`
  so both host packages carry fresh runner sources.
- Docs site content/build: edit `apps/docs-site/` or generated docs sources,
  then run `corepack yarn build:docs` for site changes.

`scripts/build-host-runtimes.ts` is the single writer for host package runtime
artifacts: bundled core runtime entries, observe web assets, runner manifests,
`CLAUDE-MD-TEMPLATE.md`, native runner copies, `record_proof.sh`, shared host
helper scripts (`collect-feedback.sh`, copied into both host packages), and
Claude helper scripts. If those outputs drift, edit the source and rerun:

```bash
corepack yarn build:host-runtimes
```

A new core CLI entry point ships to host packages only if its compiled name is
listed in `RUNTIME_ENTRIES` in `scripts/build-host-runtimes.ts`; otherwise it
exists in `packages/rn-dev-agent-core/dist/` and is silently absent from every
marketplace install.

## Validation Commands

Use the smallest relevant set first, then broaden before pushing risky changes.
Unit tests import the committed `dist/`, not `src/`, so run `corepack yarn
build:core` after any source edit or the suite silently tests the old build.

```bash
corepack yarn format:check
corepack yarn lint
bash scripts/check-agent-package-sync.sh
bash scripts/check-dist-fresh.sh
bash scripts/check-typescript-only.sh
corepack yarn test
corepack yarn build:docs
```

Live device verification against the sibling `rn-dev-agent-workspace/test-app`
cannot use this repo's own MCP session (Metro serving-root pinning refuses an
app outside the source worktree). Spawn the worktree build directly instead —
`node packages/claude-plugin/rn-dev-agent-core/dist/supervisor.js` with cwd set
to the test-app and drive it over stdio JSON-RPC. The auto-started observe
server yields the device axis on the first `bind_device` (the result reports
`observeYielded` with the stopped port), so no manual `observe action=stop` is
needed; an observe server you started yourself — or one you brought back with
`observe action="start"` or `"restart"`, either of which forfeits the automatic
yield — still refuses and must be stopped.

Native runner checks:

```bash
corepack yarn test:native:ios
corepack yarn test:native:android
```

Docs and generated docs:

```bash
corepack yarn docs:generate
corepack yarn build:docs
```

## Changesets And Versions

- A changeset must land in the same PR as the change it describes. A
  changeset-only PR is rejected by `scripts/require-changeset.sh` (phantom
  0.70.5 post-mortem: a merged release declaration produced a changelog claim
  with no shipped code).
- Changes under `packages/rn-dev-agent-core/src/` are shippable source changes.
  They require a changeset that bumps `rn-dev-agent-plugin` so marketplace
  installs receive the updated bundled runtime. Usually bump
  `rn-dev-agent-core` in the same changeset when the core package changes.
- `packages/claude-plugin/package.json` is the plugin version source consumed
  by changesets. `corepack yarn version-packages` syncs host manifests and runs
  `corepack yarn build:host-runtimes`.
- Docs, tests, CI-only changes, and generated-artifact cleanup do not need a
  changeset unless they alter shippable behavior.

## Codex Operating Notes

- Claude slash commands are not native Codex commands. For a workflow named
  `/rn-dev-agent:<command>`, read `packages/codex-plugin/commands/<command>.md`
  and execute the protocol with available tools.
- Claude subagents do not map 1:1 to Codex. Treat Codex agent markdown files as
  playbooks to execute in the current session.
- Before app/device interaction, check `rn_session(action="status")` and
  `cdp_status`, inspect reusable actions with the learned-actions flow, and
  replay a covering saved action through `cdp_run_action` — not raw
  `maestro_run`.
- If working on installed-plugin behavior, remember that marketplace installs
  copy only the host package directory. Runtime dependencies, scripts, native
  runner sources, and templates must exist inside the relevant host package.

## Release Boundaries

- Claude Code surface: `packages/claude-plugin/`.
- Codex surface: `packages/codex-plugin/`.
- Shared doctrine and reusable workflow guidance:
  `packages/shared-agent-knowledge/`.
- Core MCP/device implementation: `packages/rn-dev-agent-core/`.
- Native runner source of truth: `packages/rn-fast-runner/` and
  `packages/rn-android-runner/`.
- Deliverable docs app: `apps/docs-site/`.
- `main` is protected and its only required check is `Build & Test` (`ci.yml`).
  Nothing reaches `main` except a PR carrying that check green — never a direct
  push, never a `[skip ci]` commit, which by construction can never produce it.
- A PR opened by a workflow with `GITHUB_TOKEN` parks its CI run at
  `action_required`; a maintainer must "Approve and run" before the required
  check registers. Release automation must arm auto-merge and wait, never
  assume the check appears on its own.
- Keeping the runner trust root current after a release:
  [`CONTRIBUTING-VERSIONS.md`](https://github.com/Lykhoyda/rn-dev-agent-workspace/blob/main/docs/CONTRIBUTING-VERSIONS.md).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
