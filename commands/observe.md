---
command: observe
description: Start the read-only observability web UI and print the URL to watch the agent live.
---

Call the `observe` MCP tool with `action: "start"`. Print the returned `url` prominently and tell the user to open it in a browser to watch the live tool-call timeline, device screenshot, and app state. If it's already running, `observe status` returns the existing URL; to stop, call `observe` with `action: "stop"`.
