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

No overlap. `cdp_interact` is deprecated and replaced by agent-device commands.

## Auto-Install & Session Startup

### Installation

In `hooks/detect-rn-project.sh`:
1. Check if `agent-device` CLI exists in PATH
2. If missing, `npm install -g agent-device`
3. Verify with `agent-device --version`
4. Same pattern as existing maestro-runner auto-install

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
- Active session name stored in plugin state so all tools know which device to target

## MCP Tool Surface

### New Tools (wrapping agent-device CLI)

| Tool | agent-device command | Purpose |
|------|---------------------|---------|
| `device_list` | `agent-device list-devices --json` | List available simulators/emulators |
| `device_screenshot` | `agent-device screenshot --session rn-dev` | Capture screen |
| `device_snapshot` | `agent-device snapshot --session rn-dev --json` | Accessibility tree with @refs |
| `device_find` | `agent-device find "text" click --session rn-dev` | Find element + optional action |
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
- **`rn-code-architect.md`** — No changes.

### Commands

- **`rn-feature-dev.md`** — Phase 6 (live verification) uses agent-device for interaction, CDP for introspection. Phase 8 (E2E proof) still generates Maestro YAML via maestro-runner.
- **`test-feature.md`** — agent-device for interaction, maestro-runner for YAML generation.
- **`check-env.md`** — Add agent-device daemon health check.

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

agent-device is at v0.7.x — API may change. Mitigation: wrap all CLI calls through a single helper module (`agent-device-wrapper.ts`) so interface changes are isolated to one file.
