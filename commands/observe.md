---
command: observe
description: Show the observability web UI URL (it autostarts with the session); stop or restart it.
argument-hint: [stop|restart]
---

The observe web UI autostarts when the session begins in an RN project. Permanent opt-out:
`.rn-agent/config.json` → `{ "observe": { "autoStart": false } }` (port via `observe.port`,
default 7333; env `RN_AGENT_OBSERVE_AUTOSTART` / `RN_AGENT_OBSERVE_PORT` override config).

The user's argument: "$ARGUMENTS"

- If the argument is empty: call the `observe` MCP tool with `action: "status"`. If running,
  print the returned `url` prominently and tell the user to open it in a browser to watch the
  live tool-call timeline, device screenshot, and app state. If NOT running (autostart disabled
  or previously stopped), call `action: "start"` — an explicit /observe is an explicit request
  to see the UI — and print the URL.
- If the argument is `stop`: call with `action: "stop"`. The UI stays down for the rest of the
  session; mention the config opt-out if the user wants it permanent.
- If the argument is `restart`: call with `action: "restart"` and print the (possibly new) URL.
  The event timeline is preserved across restarts.
