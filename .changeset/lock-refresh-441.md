---
"rn-dev-agent-core": patch
---

Refresh the committed package-lock.json and major-cap the security-floor `overrides` (GH #441). Marketplace installs stopped consuming this lock when the dependency-free bundled host runtime shipped (`ensure-cdp-deps.sh` early-exits), but the lock remains a committed artifact: CI's packaged-artifact smoke installs against it, and any future npm resolve inherits the overrides. The stale v0.38-era resolution is refreshed with in-range updates (ws 8.21, yaml 2.9, hono 4.12.29, @hono/node-server 1.19.14, fast-uri 3.1.3), and the open-ended `>=` override floors are capped at each dependent's declared major — `>=1.19.13` alone resolved @hono/node-server 2.x against the MCP SDK's `^1.19.9` on a fresh regen. Re-staleness tripwires: a gh-441 unit test plus a sync-versions.sh check (CI) and `--fix` (release version bumps) keeping the lock's version fields tracking package.json.
