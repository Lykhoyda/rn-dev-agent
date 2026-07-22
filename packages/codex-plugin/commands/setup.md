---
command: setup
description: Onboard a Codex project with passive diagnostics, managed AGENTS.md instructions, optional nav/store instrumentation, and the rn-agent scaffold.
---

# Set up rn-dev-agent for Codex

This workflow has a strictly passive diagnosis phase followed by separately
previewed and consented project changes. Treat any trailing user text as context,
not shell input.

Resolve `<package-root>` from this workflow skill's exact `SKILL.md` path
(`../..` from the skill directory). Validate its `.codex-plugin/plugin.json`.
Never use a plugin-root environment variable, arbitrary cache scan, or
marketplace source path.

## Phase 1 — passive diagnosis

Run `<package-root>/bin/plugin-health.js --json` by exact path and follow the
passive `rn-setup` checks. Do not install/update/reinstall, build a runner, call
`cdp_status`, attach to a device/app, start Observe, or change any file/process
in this phase. Present independent host/install/materialization/MCP/schema/task
axes and ordered user-confirmed recovery commands.

Abort project onboarding for missing Node/runtime/package files. Device, Metro,
CDP, ffmpeg/idb, and runner build readiness may be deferred with exact
instructions. If recovery changes plugin state externally, require Codex
relaunch before continuing.

## Phase 2 — previewed project onboarding

Before every write, show the exact proposed content/diff and ask **"Apply this
change? [y/n]"**. A decline is recorded and never treated as consent for another
step.

### A. Managed Codex instructions in AGENTS.md

The package template is `<package-root>/AGENTS-MD-TEMPLATE.md`. Its managed body
runs from `<!-- rn-dev-agent:codex-template-start -->` through
`<!-- rn-dev-agent:codex-template-end -->`, inclusive.

- Never create, append, replace, or symlink `CLAUDE.md` or `CLAUDE.local.md`.
  Existing Claude files are left byte-identical.
- No `AGENTS.md`: preview a new file containing the managed body, then ask.
- Existing file without the start marker: preview appending the complete block
  with safe separating newlines, then ask.
- Both markers present once: extract only that range and compare it to the
  package body. If equal, skip. If different, show the block-only diff, warn
  that local edits inside the block will be replaced, then ask. Preserve every
  byte before/after it.
- Missing, reversed, or duplicate sentinels: stop rather than guess.
- Refuse to write through an `AGENTS.md` symlink unless the user explicitly
  identifies and approves the resolved target and preview.

This operation is idempotent: repeated setup with an in-sync block writes
nothing.

### B. Navigation reference instrumentation

1. If an app is already connected from a prior active workflow, a separately
   consented active probe may evaluate `__RN_AGENT.findNavRef()`. The passive
   health phase itself never performs this call.
2. If fiber discovery succeeds, make no source change.
3. Otherwise search app entry candidates for existing `globalThis.__NAV_REF__`
   or `getBridge()?.registerNavRef`; leave existing instrumentation intact.
4. Expo Router without a user-owned `NavigationContainer` is normally handled
   by fiber discovery; report a miss rather than rewriting `_layout` blindly.
5. For one React Navigation root, preview the minimal bridge import and
   `getBridge()?.registerNavRef(navigationRef)` registration. Handle module ref,
   hook ref, and missing-ref cases deliberately. For multiple roots, ask which
   is authoritative.

The bridge owns its `__DEV__` guard; do not add a second call-site guard.

### C. Zustand store exposure

1. Find Zustand imports outside generated/build directories.
2. If none, skip.
3. If `globalThis.__ZUSTAND_STORES__` or `getBridge()?.registerStores` already
   exists, leave it intact.
4. Otherwise preview imports plus one
   `getBridge()?.registerStores({ name: useNameStore, ... })` call in the app
   entry. Keep store imports in user source; do not generate a reverse-importing
   `.rn-agent/stores.ts`.

### D. `.rn-agent/` scaffold

The package source is `<package-root>/templates/rn-agent/` and contains the
version marker, README, `.gitignore`, skeleton, dev bridge, global types,
Vercel config, and empty action/fixture/proposal markers.

1. **Symlink guard:** if project `.rn-agent` is a symlink, validate the resolved
   target's scaffold version and `dev-bridge.ts`, then skip scaffold writes.
   Never partial-add through it. The per-worktree `tsconfig` check below still
   applies.
2. Existing directory/current version: write nothing.
3. Existing/stale directory: list only missing template files. Never overwrite
   user files. Ignore a missing `.gitkeep` when its directory already has real
   content. Preview the exact additions and version-marker update, then ask.
4. First setup: preview the complete file list and user-editable files. On
   consent, copy to a unique sibling temp directory with dotfiles included and
   atomically rename it. Clean only that owned temp directory on failure.
5. Assert `.gitignore` and `.scaffold-version` exist after an accepted copy.
6. If project `tsconfig.json` does not include `.rn-agent/dev-bridge.ts` and
   `.rn-agent/globals.d.ts`, preview the minimal include-array diff and ask.
7. Remind the user to replace skeleton `appId: REPLACE_ME` and populate screen
   test IDs. `nav-graph.yaml` is a separate artifact.

### E. Optional active verification

Only after project changes are complete, and only when the user wants active
app verification, call `cdp_status`. This is no longer passive diagnosis. If
Metro/device/app are unavailable, report the deferred setup action without
rolling back accepted project files.

## Summary

Report a table for passive diagnostics, AGENTS instructions, nav ref, stores,
scaffold, tsconfig, and optional active CDP verification. Include skipped/user-
declined states. End with `$rn-dev-agent:rn-feature-dev <description>` only when
onboarding is ready.

## Safety

- No write without exact preview and confirmation.
- No mutation during passive diagnosis.
- No duplicate managed block or scaffold overwrite.
- No write into a symlink-inherited corpus.
- No Claude instruction-file mutation from Codex.
- No raw `xcrun`/`adb` app interaction when MCP device tools are available.
