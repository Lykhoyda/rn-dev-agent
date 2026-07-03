---
'rn-dev-agent-plugin': patch
---

SessionStart hook no longer misleads after a plugin upgrade (GH #419): the upgrade notice now recommends the field-proven cheap recovery — `/mcp` → reconnect the rn-dev-agent server — before a full Claude Code restart; a new read-only lockfile probe (`scripts/mcp-bridge-probe.mjs`) explicitly flags a live bridge still running from a PREVIOUS plugin install (the cause of zero-tool sessions after marketplace upgrades) naming its PID and path; and the banner no longer asserts a static "76 MCP tools" count that can't reflect actual registration — it states the installed plugin version and tells the agent the reconnect recovery path when ToolSearch finds no cdp_*/device_* tools.
