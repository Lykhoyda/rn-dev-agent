---
command: observe
description: Show the Observe web UI URL, stop it, or restart it through the active MCP server.
argument-hint: "[stop|restart]"
---

# Observe

Treat the text after `$rn-dev-agent:observe` as the conceptual request. Accepted
values are empty, `stop`, or `restart`; reject anything else. Require the
`observe` MCP tool in the active task. If absent, stop and use the read-only
discovery diagnosis—do not start a substitute shell web server.

- Empty: call `observe` with `action:"status"`. If running, print its URL. If
  down, the explicit workflow invocation is consent to call `action:"start"`;
  print the returned URL.
- `stop`: call `action:"stop"` and explain the per-project permanent opt-out.
- `restart`: call `action:"restart"`, preserving the event timeline, and print
  the returned URL.

Observe normally autostarts for an RN project. Configuration lives at
`.rn-agent/config.json` under `observe.autoStart`, `observe.port`, and mirror
settings. Environment overrides are `RN_AGENT_OBSERVE_AUTOSTART` and
`RN_AGENT_OBSERVE_PORT`.
