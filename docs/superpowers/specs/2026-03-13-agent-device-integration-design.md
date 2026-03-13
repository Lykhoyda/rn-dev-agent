# Agent-Device Integration Design

## Problem

The rn-dev-agent plugin struggles when both Android and iOS simulators are open. Root causes:
- CDP bridge auto-discovers Metro targets with no device affinity
- Maestro adds another layer of device selection ambiguity
- No session concept — each MCP tool call is stateless
- `xcrun simctl` uses "booted" (singular), `adb` auto-selects first device

## Solution

Integrate [agent-device](https://github.com/callstackincubator/agent-device) (v0.7.x) as a runtime dependency for all device interaction. Keep CDP bridge for React Native introspection. Keep maestro-runner for persistent YAML E2E tests.

## Architecture

### Three-Layer Model

| Layer | Tool | Role |
|-------|------|------|
| Device interaction | agent-device CLI (auto-installed) | Boot, screenshot, tap, swipe, fill, find, snapshot, UI hierarchy |
| App introspection | CDP bridge (existing MCP server) | Store state, navigation, fiber tree, console/network/error logs |
| E2E testing | maestro-runner (existing) | Persistent YAML test file generation and execution |

### Boundary Rule

- **agent-device** owns everything the user can see and touch (native UI layer)
- **CDP bridge** owns everything React knows internally (JS runtime)
- **maestro-runner** owns persistent test artifacts (YAML flows)

Preferred tool per task — not a hard isolation boundary. Some overlap exists (e.g., `cdp_component_tree` returns testIDs also visible in agent-device snapshots, `cdp_evaluate` can invoke native modules). The rule is: prefer agent-device for interaction, prefer CDP for React internals. `cdp_interact` is deprecated and replaced by agent-device commands.

## Auto-Install & Session Startup

### Installation

Dedicated script: `scripts/ensure-agent-device.sh` (mirrors `scripts/ensure-maestro-runner.sh`). Called from `hooks/detect-rn-project.sh`.

Steps:
1. Check if `agent-device` CLI exists in PATH
2. If missing, install via npm: `npm install -g agent-device` (verify actual install method against agent-device README at implementation time — may be npx, brew, or curl-based)
3. Verify with `agent-device --version`
4. Log installed version

### Session Startup Flow

1. Hook detects RN project, installs agent-device if needed
2. On first device interaction, agent-device daemon auto-starts (built-in behavior)
3. Plugin detects available devices: `agent-device list-devices`
4. If multiple devices found, pick based on user's specified platform (iOS/Android)
5. Create named session: `agent-device session start --name rn-dev --device <device-id>`
6. All subsequent commands use `--session rn-dev`

### Device Selection Logic

- User says "test on iOS" → pick booted iOS simulator
- User says "test on Android" → pick running Android emulator
- Ambiguous → ask user
- Active session name stored in MCP server memory (in-memory field on the server instance, like `CDPClient` today) + written to `/tmp/rn-dev-agent-session.json` for cross-process access by hooks/scripts

## MCP Tool Surface

### Tool Hosting

The 8 new `device_*` tools are added to the **existing `rn-dev-agent-cdp` MCP server** (`scripts/cdp-bridge/`). Rationale: one MCP server entry in `plugin.json`, shared session state in memory, simpler deployment. The server already mixes concerns (WebSocket CDP + HTTP status checks) — adding subprocess-based CLI calls is acceptable.

New files:
- `scripts/cdp-bridge/src/agent-device-wrapper.ts` — single module wrapping all agent-device CLI calls
- `scripts/cdp-bridge/src/tools/device-*.ts` — one file per tool (8 files), same pattern as existing `tools/` directory

### agent-device-wrapper.ts

Centralizes all CLI interaction. Isolates agent-device API surface so version changes only affect this file.

- **Subprocess**: uses `execFile` (not `exec`, to prevent shell injection) with 30s timeout
- **Session injection**: automatically appends `--session <name>` from server's in-memory state
- **JSON parsing**: all commands called with `--json`, output parsed and validated
- **Error handling**: maps agent-device error codes to MCP `failResult`/`warnResult` helpers from `utils.ts`
- **Exports**: `listDevices()`, `screenshot()`, `snapshot()`, `find()`, `press()`, `fill()`, `swipe()`, `back()`, `startSession()`, `stopSession()`

**Open question (resolve at implementation time):** Verify exact CLI flags by running `agent-device --help` and `agent-device <command> --help` for each command. The flags listed in this spec are based on research of v0.7.x source but may differ in the installed version.

### New Tools (wrapping agent-device CLI)

| Tool | agent-device command | Purpose |
|------|---------------------|---------|
| `device_list` | `agent-device list-devices --json` | List available simulators/emulators |
| `device_screenshot` | `agent-device screenshot --session rn-dev` | Capture screen |
| `device_snapshot` | `agent-device snapshot --session rn-dev --json` | Accessibility tree with @refs |
| `device_find` | `agent-device find "text" [action] --session rn-dev` | Find element by text/label/id. Optional action param: `click`, `long-press`, or omit for search-only |
| `device_press` | `agent-device press @e3 --session rn-dev` | Tap element by @ref |
| `device_fill` | `agent-device fill @e5 "text" --session rn-dev` | Type text with verification |
| `device_swipe` | `agent-device swipe up --session rn-dev` | Scroll/swipe |
| `device_back` | `agent-device back --session rn-dev` | System back button |

### Kept Unchanged (CDP bridge)

- `cdp_status` — health check
- `cdp_component_tree` — React fiber tree
- `cdp_navigation_state` — current route/stack
- `cdp_store_state` — Redux/Zustand state
- `cdp_network_log` — network requests
- `cdp_console_log` — console output
- `cdp_error_log` — JS errors
- `cdp_evaluate` — arbitrary JS execution
- `cdp_reload` — full reload with reconnect
- `cdp_dev_settings` — dev menu actions

### Deprecated

- `cdp_interact` — replaced by `device_press` / `device_find` / `device_fill`

### Typical Workflow

```
1. device_find "Sign In" click     → tap the button (native accessibility)
2. device_snapshot                  → verify UI changed (@refs)
3. cdp_store_state path="auth"     → verify React state updated
4. cdp_navigation_state            → verify navigated to home screen
```

## Skill & Agent Updates

### Skills

- **`rn-device-control/SKILL.md`** — Replace `xcrun simctl` / `adb` command references with agent-device equivalents. Keep native commands as fallback documentation.
- **`rn-testing/SKILL.md`** — Update interaction patterns: `device_find` / `device_press` for live verification, maestro-runner for persistent YAML tests only. Update timing rule: agent-device's `find "text" wait 5000` replaces the Maestro `assertVisible` → CDP pattern.
- **`rn-debugging/SKILL.md`** — Add `device_snapshot` as diagnostic tool alongside CDP. Accessibility tree reveals issues invisible to CDP (native overlay blocking touches, system dialogs).

### Agents

- **`rn-tester.md`** — Phase 2 (interact) switches from Maestro to agent-device. Phase 3 (verify state) stays CDP. New pattern: `device_snapshot` diff before/after interaction.
- **`rn-debugger.md`** — Add `device_snapshot` to evidence-gathering step.
- **`rn-code-architect.md`** — Update E2E proof flow templates to emit `device_press` / `device_find` / `device_fill` instead of `cdp_interact`.
- **`rn-code-explorer.md`** — Update interaction references from Maestro to agent-device where applicable.

### Commands

- **`rn-feature-dev.md`** — Phase 5.5 Step 3.5: rewrite `cdp_interact(testID=..., action="press")` to `device_find`/`device_press`. Phase 6 (live verification) uses agent-device for interaction, CDP for introspection. Phase 8 (E2E proof) still generates Maestro YAML via maestro-runner.
- **`test-feature.md`** — agent-device for interaction, maestro-runner for YAML generation.
- **`build-and-test.md`** — Delegates to rn-tester agent; no direct changes needed (inherits agent updates).
- **`debug-screen.md`** — Delegates to rn-debugger agent; no direct changes needed (inherits agent updates).
- **`check-env.md`** — Add agent-device health check: run `agent-device list-devices --json`, verify at least one device available. Show daemon status row in environment table. Fix suggestion: "Run `agent-device list-devices` to check connectivity."

### CDP-Session Synchronization

When an agent-device session is started targeting a specific platform, the CDP bridge must also target the correct Metro/Hermes instance:
- `device_list` output includes platform info per device
- When session starts, infer platform from the selected device
- Pass platform hint to `CDPClient.connect()` so it filters Hermes targets accordingly
- If agent-device targets Android but Metro only has iOS targets (or vice versa), `cdp_status` warns: "CDP connected to [platform] but agent-device session targets [other platform]"

### CLAUDE.md Update

After implementation, update CLAUDE.md architecture table to reflect the new three-layer model with agent-device.

## Implementation Phases

### Phase 1 — Foundation

- Auto-install agent-device in `detect-rn-project.sh`
- Add 8 new MCP tools wrapping agent-device CLI
- Session management helper: start/stop/detect active session
- Update `check-env.md` to verify agent-device

### Phase 2 — Skill & Agent Migration

- Update all 3 skills, 2 agents, 2 commands
- Deprecate `cdp_interact` (keep working but warn)
- Update timing rules: `device_find ... wait` replaces `assertVisible` → CDP pattern

### Phase 3 — Polish

- Remove `cdp_interact` entirely
- Snapshot diff integration (before/after verification)
- Error handling: daemon not running, device disconnected, session expired

## Out of Scope

- Cross-platform verification (run on iOS then Android)
- Maestro removal (kept for YAML E2E)
- Building custom XCUITest runner (agent-device handles this)

## Risk

**API instability:** agent-device is at v0.7.x — API may change. Mitigation: `agent-device-wrapper.ts` isolates all CLI calls so interface changes affect one file.

**Fallback if agent-device unavailable:** If agent-device fails to install or daemon crashes, the plugin falls back to existing behavior: Maestro/maestro-runner for interaction, direct `xcrun simctl`/`adb` for screenshots. Skills and agents should check `device_list` availability and gracefully degrade. This matches the existing maestro-runner → Maestro fallback pattern.
