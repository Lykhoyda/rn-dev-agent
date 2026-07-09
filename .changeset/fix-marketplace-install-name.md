---
"rn-dev-agent-plugin": patch
---

Fix the documented install command: the marketplace registers under the manifest name `rn-dev-agent`, so the correct command is `/plugin install rn-dev-agent@rn-dev-agent` — every doc previously said `rn-dev-agent@Lykhoyda-rn-dev-agent`, which fails with "Marketplace not found" (caught live on the first post-split install). Also corrects the stale `~/.claude/plugins/cache/Lykhoyda-rn-dev-agent` paths in troubleshooting docs.

Also adds the missing Codex install path: the repo now ships a Codex marketplace manifest (`.agents/plugins/marketplace.json`) resolving `packages/codex-plugin`, so `codex plugin marketplace add Lykhoyda/rn-dev-agent` + `codex plugin add rn-dev-agent@rn-dev-agent` works (validated live: marketplace add, plugin add, and an MCP handshake through the installed launcher). Install instructions documented in the README, docs-site getting-started, and the Codex package README; the package-sync guard asserts the manifest.
