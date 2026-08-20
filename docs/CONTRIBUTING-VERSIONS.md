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

Review the diff, commit, push, and open a "Version Packages" PR — `main`
is protected, so the bump lands only through a PR whose `Build & Test`
check is green, never a direct commit.

To publish the MCP server package (currently the plugin doesn't auto-
publish — manual publish from the core workspace):

```bash
corepack yarn release-core
```

## The runner trust root after a release

`runner-manifest.json` (mirrored into both host plugin packages) is the
client's offline SHA-256 trust root for the prebuilt runner zips. Clients
use a prebuilt runner only when `manifest.version` equals the installed
plugin version, so a manifest left behind by a release silently downgrades
every install to the slow local build.

`.github/workflows/runner-artifacts.yml` keeps it current. It checks two
things independently — whether release `v<version>` carries both runner
zips *still serving the SHA-256 the trust root describes*, and whether the
in-repo manifest matches the manifest published for that same version —
and re-runs every 6 hours, so a manifest that has not landed yet is
re-detected and re-delivered rather than silently skipped. The digest
check comes from the release API's own `digest`/`size` for each asset, so
a zip re-uploaded by a build job whose sibling failed cannot pass as
published just because the two manifests (copies of each other) still
agree.

A drifted zip — one whose served SHA-256 disagrees with what vouches for
it — is never adopted by re-hashing, because that would turn the client's
rejection of a substituted archive into a routine-looking bot PR. What
happens instead depends on what `main` already knows, because **`main` is
the only record an attacker cannot write**: the `runner-manifest.json`
asset on the release is an ordinary release asset, writable by anything
holding `contents: write` — the same permission needed to swap a zip.

- **`main` already carries the trust root for this version.** It is the
  authority; the release asset is not. A disagreement **stops the run**.
  Rebuilding would move the trust root onto bytes no merged PR has
  approved, and since only a merged PR can move it, the next sweep would
  rebuild again and rewrite the PR it is waiting on. Find out why the
  release changed, then dispatch `force_version` for the current version:
  that rebuilds both runners from source and delivers one trust-root PR.
- **`main` does not know this version yet** (the normal post-release
  window). There is no trust root to protect and the release's own
  manifest asset is the only record there is, so drift against it
  **rebuilds both runners from source**. That converges: the rebuilding
  run republishes the asset, so the next sweep sees agreement and opens
  no new commit.

The boundary is worth stating plainly: in that second window the evidence
is release-side and therefore writable by the same permission that can
swap a zip, so an actor who rewrites *both* the zip and the manifest asset
is not detectable here. That was equally true before this workflow existed
— publication has always hashed the release's own bytes — and closing it
needs build attestation, not more release-asset comparison. What the rules
above do guarantee is that a trust root `main` has already approved is
never rewritten from downloaded bytes: when nothing was rebuilt and the
in-repo manifest already targets this version, it is republished verbatim
rather than regenerated. Until drift is resolved, installs stay on the
local-build fallback — degraded, not compromised.

A release lookup that fails for any
reason other than a genuine 404 fails the run rather than being read as
"nothing is published", which would rebuild and re-upload zips the
release already serves correctly.

The manifest reaches `main` the same way everything else does: a
`chore/runner-manifest-v<version>` branch, a pull request, the required
`Build & Test` check, and auto-merge. It is never pushed to `main`
directly and never carries `[skip ci]` — a commit that skips CI can never
produce the required check, which is what stranded the trust root at
v0.75.2 while releases shipped through v0.76.7.

**Maintainer step after each release:** the manifest PR is opened by the
workflow with `GITHUB_TOKEN`, so its CI run parks at *action_required*.
Open the PR and click **Approve and run**; auto-merge lands it as soon as
`Build & Test` is green. Until it lands, installs keep working on the
local-build fallback. Reruns are safe — the branch name is derived from
the version, an already-open PR is reused, release uploads clobber, and a
manifest PR left over from an earlier version is closed as superseded so
two of them can never land in either order. That sweep runs on every
publish attempt, including one that finds the trust root already current
and opens no PR of its own — a superseded PR may already be armed, so
retiring it cannot depend on this run having something to deliver.

Every job checks out `main`, so a `workflow_dispatch` started from a
feature branch cannot smuggle unrelated commits into the auto-merging
manifest PR. `chore/runner-manifest-v<version>` is workflow-owned: a
rerun keeps its head — and the approval bound to that SHA — while the
branch still delivers nothing but the trust root, i.e. while comparing it
against `main` names no path outside `runner-manifest.json` and its two
host-plugin copies (those three are expected to appear; they are what the
PR delivers). That holds however many commits the workflow has made on
the branch, and `main` advancing underneath an open manifest PR does not
disturb it. A branch carrying anything else is deleted and cut again from
`main` — which closes its PR, so the replacement starts from a clean base
and gets a new PR — rather than carried into the PR a maintainer
approves.

The `force_version` input re-publishes the *current* plugin
version (skipping the missing-assets check); it will not accept a
historical one, because the runners are built from current source and a
backfill would both misattribute the binaries and downgrade the trust
root below what installed clients can use.

## What if I forget a changeset?

You can add one after the fact:

```bash
corepack yarn changeset
```

…and push it to the same PR as the change it describes. Do **not** open a
separate changeset-only PR: `scripts/require-changeset.sh` rejects a PR that
adds a changeset while changing nothing outside `.changeset/`, because such a
changeset mints a CHANGELOG entry for code that never shipped (the phantom
0.70.5 entry). Deleting or rewording a pending changeset is still allowed.

If you genuinely have no user-facing change (e.g. fixing a typo in a comment),
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
