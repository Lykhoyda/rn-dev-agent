---
name: sending-feedback
description: Use when the user wants to send feedback, report an rn-dev-agent bug, request a plugin feature, or says the rn-dev-agent MCP transport or tools are unavailable. Collects sanitized diagnostics and guides creation of a reviewed GitHub issue.
---

# sending-feedback — Report rn-dev-agent Issues Safely

Follow the complete workflow in `../../commands/send-feedback.md`.

Collect diagnostics with the plugin-owned `scripts/collect-feedback.sh`,
resolving the plugin root with the workflow's Step 2 snippet — each host's
workflow document owns its own root resolution. The packaged collector at
`scripts/collect-feedback.sh` under the resolved plugin root is the supported
surface on every host. The `rn-collect-feedback` executable is a guarded
legacy fallback only — plugin installs do not add global executables; it
exists solely for repo checkouts that put `bin/` on `PATH`.

The workflow's review gate is mandatory. Show the exact sanitized issue body
to the user and obtain confirmation before submitting it with `gh`.
