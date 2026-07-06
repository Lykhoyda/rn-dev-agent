---
'rn-dev-agent-plugin': patch
---

Fix the nightly device-smoke workflow failing at setup: it ran `npm ci` inside `scripts/cdp-bridge`, which fights the root lockfile and triggers the root `prepare: husky` without husky installed (exit 127). Both lanes now install from the repo root (npm workspaces resolves the cdp-bridge deps) with `HUSKY=0`.
