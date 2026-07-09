---
"rn-dev-agent-plugin": minor
---

Make the Claude plugin package self-contained so marketplace installs work after the workspace split (fixes the release-blocking finding on PR #500). Claude Code copies ONLY the plugin source directory into `~/.claude/plugins/cache/…` — `${CLAUDE_PLUGIN_ROOT}/../…` references resolve to nothing in an installed plugin (docs-confirmed; the pre-split plugin worked only because the runtime lived inside the plugin root).

- The package now ships a bundled runtime at `rn-dev-agent-core/dist/{supervisor,index,learned-actions}.js` (same esbuild output as the Codex package, byte-identical by construction), the observe web bundle, native runner sources under `scripts/rn-fast-runner` + `scripts/rn-android-runner`, `runner-manifest.json`, and the helper scripts the SessionStart hook and skills invoke (`ensure-*`, `mcp-bridge-probe.mjs`, `check-physical-devices.sh`, `check-vercel-rules.mjs`).
- `plugin.json` MCP entry now spawns `${CLAUDE_PLUGIN_ROOT}/rn-dev-agent-core/dist/supervisor.js`; all agent/command/skill snippets and hooks resolve package-local paths (dev-checkout fallbacks preserved). `ensure-cdp-deps.sh` exits fast on the dependency-free bundled runtime.
- `scripts/build-codex-runtime.ts` → `scripts/build-host-runtimes.ts`: the single writer for every derived host-package artifact (both runtimes, runner copies, manifests, templates, helper scripts); `check-dist-fresh.sh` regenerates and porcelain-checks all of it, and `check-agent-package-sync.sh` asserts the Claude artifacts including byte-identity of the two host runtime bundles. The `runner-artifacts` release workflow now commits the Claude manifest copy too.
- The Codex launcher ships as plain `bin/cdp-supervisor.js` (was `.ts`) so `node <launcher>` cannot hard-fail on Node 22.x below 22.18 at the file-extension gate.
- New `.gitattributes` marks all generated trees `linguist-generated` (bundles additionally `-diff`) to collapse PR review noise; runner build output inside the package copies is now gitignored.
