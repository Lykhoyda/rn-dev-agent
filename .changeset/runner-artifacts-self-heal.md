---
'rn-dev-agent-plugin': patch
---

Make the Runner artifacts workflow self-healing (B258, second half): the gate
is now state-based — any trigger checks whether release `v<plugin.json version>`
already carries both runner zips + `runner-manifest.json` and builds only when
something is missing — and a 6-hourly scheduled sweep catches the releases the
push trigger structurally cannot see. release.yml merges Version Packages PRs
as `github-actions` with `GITHUB_TOKEN`, and GitHub's recursion guard suppresses
workflow triggers for `GITHUB_TOKEN`-initiated pushes, so under the normal
automated release path the artifact build NEVER fired (v0.64.4 and v0.64.5
both shipped artifact-less and needed manual `workflow_dispatch` backfills).
The state-based gate also heals partially failed builds: incomplete assets →
rebuild both runners, uploads `--clobber`.
