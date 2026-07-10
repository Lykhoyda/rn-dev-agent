---
'rn-dev-agent-core': patch
---

Refresh the stale `package-lock.json` users install against (GH #441): the shipped lock still said v0.38.23 while the package was v0.61.5, so `ensure-cdp-deps.sh`'s `npm install --production` resolved user installs against a months-old pin. Regenerated cleanly from `package.json` (minor/patch transitive bumps; `@hono/node-server` 1.x→2.x within the MCP SDK's declared range), validated end-to-end by the packaged-artifact smoke test, and guarded by a new unit-test tripwire that fails whenever the lock's version or dependency ranges drift from `package.json`.
