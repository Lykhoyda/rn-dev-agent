---
"rn-dev-agent-cdp": minor
"rn-dev-agent-plugin": minor
---

#202 Phase 5 / #264 — the bridge now survives Metro restarts (supervisor split).

The MCP entry point is now `dist/supervisor.js`: a thin stdio shim holding zero network sockets (immune to `lsof -ti tcp:8081 | xargs kill -9`, which used to SIGKILL the whole server and cost the session all 77 tools). It spawns the real bridge as a worker, and on worker death: errors in-flight calls with `-32000` ("retry the call"), respawns it (max 3 per rolling 60 s, then a terminal crash-loop error), and replays the cached MCP `initialize` handshake so the session continues seamlessly. Visibility: `cdp_status` → `bridge: { supervised, workerRestarts, lastWorkerExit }`. Opt out with `RN_BRIDGE_SUPERVISOR=0` (legacy single process). `SIGUSR2` now performs a real hot-reload (worker restart + handshake replay).
