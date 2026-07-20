---
name: sending-feedback
description: Use when the user wants to send feedback, report an rn-dev-agent bug, request a plugin feature, or says the rn-dev-agent MCP transport or tools are unavailable. Collects sanitized diagnostics and guides creation of a reviewed GitHub issue.
---

# sending-feedback — Report rn-dev-agent Issues Safely

Follow the complete workflow in `../../commands/send-feedback.md`.

In Codex, slash commands are playbooks rather than native commands: read that
file and execute each step with the available tools. Collect diagnostics with
the plugin-owned script at
`${CODEX_PLUGIN_ROOT}/scripts/collect-feedback.sh`; marketplace plugins do not
install a global `rn-collect-feedback` executable.

The workflow's review gate is mandatory. Show the exact sanitized issue body
to the user and obtain confirmation before submitting it with `gh`.
