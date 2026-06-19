---
"rn-dev-agent-plugin": minor
---

Bump the plugin manifest so installed users receive the recently-merged cdp-bridge work via `/plugin update`. Until now the changesets flow only versioned the internal `rn-dev-agent-cdp` package, leaving `plugin.json` / `marketplace.json` pinned at 0.55.5 — so the plugin's cache key never moved and updates never reached installs even though the bundled `dist/` had advanced.

This release ships, to installed users:
- **observe Regression "Run" reaches the device (#351):** the per-action Run resolves the connected app's project root via bundleId instead of falling back to `process.cwd()`, so clicking Run no longer fails with `NO_PROJECT_ROOT`.
- **iOS 26.x action replay (#353, Phase 2):** when WebDriverAgent reads an empty accessibility tree, `cdp_run_action` falls back to a CDP/JS transport so replays still drive the app.
- **Durable action store (#359, Phase 1):** run/repair history persists in a derived, gitignored node:sqlite store (dual-write mirror of the JSON sidecars; graceful degradation when node:sqlite is unavailable); `cdp_status` reports the active `actionStore` backend.
- **CI now runs nested unit test dirs (#340).**
