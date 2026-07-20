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
- `docs/ROADMAP.md`: repo-local plugin roadmap. Workspace-side planning stays
  in the sibling workspace when explicitly requested.

The plugin repo ships user-visible code and docs. Internal proof artifacts,
bench reports, and project planning beyond the repo-local roadmap belong in
GitHub Issues, PRs, or the sibling workspace only when explicitly requested.

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

## Where To Make Changes

- Core MCP behavior: edit `packages/rn-dev-agent-core/src/`, then run
  `corepack yarn build:core` and `corepack yarn build:host-runtimes`.
- Claude-only host behavior: edit `packages/claude-plugin/`.
- Codex-only host behavior: edit `packages/codex-plugin/`.
- Host-neutral workflow knowledge: edit `packages/shared-agent-knowledge/`,
  mirror/adapt the affected files into both host packages, and run
  `bash scripts/check-agent-package-sync.sh`.
- Native runner behavior: edit `packages/rn-fast-runner/` or
  `packages/rn-android-runner/`, then run `corepack yarn build:host-runtimes`
  so both host packages carry fresh runner sources.
- Docs site content/build: edit `apps/docs-site/` or generated docs sources,
  then run `corepack yarn build:docs` for site changes.

`scripts/build-host-runtimes.ts` is the single writer for host package runtime
artifacts: bundled core runtime entries, observe web assets, runner manifests,
`CLAUDE-MD-TEMPLATE.md`, native runner copies, `record_proof.sh`, and Claude
helper scripts. If those outputs drift, edit the source and rerun:

```bash
corepack yarn build:host-runtimes
```

## Validation Commands

Use the smallest relevant set first, then broaden before pushing risky changes.

```bash
corepack yarn format:check
corepack yarn lint
bash scripts/check-agent-package-sync.sh
bash scripts/check-dist-fresh.sh
bash scripts/check-typescript-only.sh
corepack yarn test
corepack yarn build:docs
```

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
- Before app/device interaction, check `cdp_status`, inspect reusable actions
  with the learned-actions flow, and prefer `cdp_run_action` or `maestro_run`
  when a saved action already covers the setup path.
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

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
