---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

The observe web UI now autostarts when the MCP worker boots in an RN project, listening on a
stable default port (7333, `http://127.0.0.1:7333`) with an ephemeral fallback on collision.
New `.rn-agent/config.json` block `{ "observe": { "autoStart": boolean, "port": number } }`
plus `RN_AGENT_OBSERVE_AUTOSTART` env override (precedence env > config > default, matching
`cdp.autoConnect`). The `observe` tool gains a `restart` action; `stop` is session-scoped.
The live URL is recorded in a per-project state file and announced at SessionStart.
