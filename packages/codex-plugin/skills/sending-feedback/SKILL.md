---
name: sending-feedback
description: Use when the user wants to send feedback, report an rn-dev-agent bug, request a plugin feature, or says the rn-dev-agent MCP transport or tools are unavailable. Collects sanitized diagnostics and guides creation of a reviewed GitHub issue.
---

# sending-feedback — Report rn-dev-agent Issues Safely

Follow the complete workflow in `../../commands/send-feedback.md`.

`$rn-dev-agent:send-feedback` is the explicit native workflow adapter; this
domain skill owns implicit routing. Resolve the collector as
`../../scripts/collect-feedback.sh` from this exact `SKILL.md`. Never scan
caches, use a launcher-only environment variable, or assume a global
executable.

The workflow's review gate is mandatory. Show the exact sanitized issue body
to the user and obtain confirmation before submitting it with `gh`.
