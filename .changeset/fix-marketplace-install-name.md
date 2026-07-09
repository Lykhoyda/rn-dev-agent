---
"rn-dev-agent-plugin": patch
---

Fix the documented install command: the marketplace registers under the manifest name `rn-dev-agent`, so the correct command is `/plugin install rn-dev-agent@rn-dev-agent` — every doc previously said `rn-dev-agent@Lykhoyda-rn-dev-agent`, which fails with "Marketplace not found" (caught live on the first post-split install). Also corrects the stale `~/.claude/plugins/cache/Lykhoyda-rn-dev-agent` paths in troubleshooting docs.
