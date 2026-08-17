---
name: sending-feedback
description: Use when the user wants to send feedback, report an rn-dev-agent bug, request a plugin feature, or says the rn-dev-agent MCP transport or tools are unavailable. Collects sanitized diagnostics and guides creation of a reviewed GitHub issue.
---

# sending-feedback — Report rn-dev-agent Issues Safely

Follow the complete workflow in `../../commands/send-feedback.md`.

Collect diagnostics with the plugin-owned `scripts/collect-feedback.sh`,
resolving the plugin root with the workflow's Step 2 snippet. In Claude Code
sessions `CLAUDE_PLUGIN_ROOT` points at the exact installed plugin version, so
the packaged collector at `scripts/collect-feedback.sh` under that root is the
supported surface. The `rn-collect-feedback` executable is a guarded legacy
fallback only — marketplace installs do not add global executables; it exists
solely for repo checkouts that put `bin/` on `PATH`.

The workflow's review gate is mandatory. Show the exact sanitized issue body
to the user and obtain confirmation before submitting it with `gh`.
