# Versioning & Releases

This repo uses [Changesets](https://github.com/changesets/changesets) for
version management. Every PR that should ship in a release adds a small
`.changeset/<name>.md` file describing the change. At release time the
maintainer runs one command that consumes every queued changeset, bumps
the affected packages, regenerates each package's `CHANGELOG.md`, and
syncs the bumped version into `packages/claude-plugin/plugin.json`,
`packages/codex-plugin/.codex-plugin/plugin.json`, and
`packages/claude-plugin/marketplace.json`.

## Two version tracks

| Package | File | What it ships |
|---|---|---|
| `rn-dev-agent-core` | `packages/rn-dev-agent-core/package.json` | The MCP server and device-control runtime — the TypeScript binary the host plugins spawn. |
| `rn-dev-agent-plugin` | `packages/claude-plugin/package.json` (mirrored to `packages/claude-plugin/plugin.json`, `packages/codex-plugin/.codex-plugin/plugin.json`, and `packages/claude-plugin/marketplace.json`) | The agent plugin manifest version shared by Claude Code and Codex. |

The two tracks are **independent**. A bug fix in the CDP bridge may
patch-bump `rn-dev-agent-core` while `rn-dev-agent-plugin` stays
unchanged, and vice versa. Most user-facing features touch both, so
most changesets bump both.

## Adding a changeset (every feature PR)

From the repo root, with your branch checked out:

```bash
corepack yarn changeset
```

This launches an interactive prompt:

1. **Which packages should bump?** Pick `rn-dev-agent-core` if you
   touched `packages/rn-dev-agent-core/src/**` or related code; pick
   `rn-dev-agent-plugin` if you touched commands, hooks, agents,
   skills, or anything else under `packages/claude-plugin/`,
   `packages/codex-plugin/`, or `packages/shared-agent-knowledge/`.
   Pick both for a typical feature.
2. **Major / minor / patch?**
   - **major** — breaking changes (we haven't reached 1.0 yet, so use
     sparingly).
   - **minor** — new user-visible features.
   - **patch** — bug fixes, internal refactors, doc updates.
3. **Summary** — one sentence that will land in the CHANGELOG. Write it
   as the user-facing description, not the implementation detail.

The CLI writes a file like `.changeset/example-change.md`. Commit it
with your PR. **It will never conflict with anyone else's changeset
file** because the filename is randomly generated.

If you want to write the file by hand (e.g. for an empty `--allow-empty`
infra PR), the format is:

```markdown
---
"rn-dev-agent-core": patch
"rn-dev-agent-plugin": patch
---

One-sentence user-facing description.
```

## Releasing (maintainer only)

When you're ready to cut a release:

```bash
# From repo root, on main:
corepack yarn version-packages
```

This runs three steps:

1. `changeset version` — consumes every `.changeset/*.md`, bumps each
   listed package's `package.json` version, and prepends entries to that
   package's `CHANGELOG.md`. Consumed `.changeset/*.md` files are
   deleted.
2. `scripts/sync-plugin-manifest.mjs` — reads the new version from
   `packages/claude-plugin/package.json` and mirrors it into the Claude plugin
   manifest, the Codex plugin manifest, and the Claude marketplace file.
3. `scripts/sync-versions.sh --fix` — final guard that all plugin-side
   files agree (synthetic package, both plugin manifests, and
   marketplace.json). The script is also wired as a pre-commit hook so
   manual edits don't drift.

Review the diff, commit, push, open a "Version Packages" PR (or commit
directly to main if your workflow allows).

To publish the MCP server package (currently the plugin doesn't auto-
publish — manual publish from the core workspace):

```bash
corepack yarn release-core
```

## What if I forget a changeset?

You can add one after the fact:

```bash
corepack yarn changeset
```

…and amend it into your PR (or push as a follow-up commit). If you
genuinely have no user-facing change (e.g. fixing a typo in a comment),
you can ship a PR with no changeset — `changeset version` will simply
not bump anything for that PR.

## Why this matters

Before adopting changesets, every feature PR manually bumped versions
in 4 files (`plugin.json`, `marketplace.json`,
`packages/rn-dev-agent-core/package.json`, `CHANGELOG.md`). When more than one
PR was open simultaneously, they all claimed the same next version
slot, and merging them produced cascading conflicts on every version
file and on the top-of-CHANGELOG insertion point. A single 7-PR sweep
in May 2026 burned ~30 minutes of mechanical conflict resolution.

With changesets, the four version files are touched ONCE per release
(by the maintainer running `corepack yarn version-packages`), not N times
per PR. Each `.changeset/*.md` is its own file, so no two PRs ever
conflict on it.
