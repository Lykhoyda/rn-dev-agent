---
skill: setup
description: Check and install all rn-dev-agent prerequisites — Node.js, Metro, simulators, agent-device, maestro-runner, CDP bridge. Run this when tools fail or on first setup.
---

# Environment Setup & Dependency Check

You are helping a developer set up the rn-dev-agent plugin environment.
This skill checks every prerequisite and installs missing dependencies.

## When to use

- First time using the plugin
- After SessionStart shows WARNING messages about missing tools
- When `cdp_status` fails to connect
- When `device_*` tools fail with "session not open" or "command not found"
- When the user runs `/rn-dev-agent:setup`

## Checklist — run each check in order

### 1. Node.js version
```bash
node --version
```
**Required:** Node.js >= 22 LTS (even-numbered release).
If odd-numbered (e.g., v25) or < 22: warn the user to install Node 22.
- If `nvm` is installed (`command -v nvm`): `nvm install 22 && nvm use 22`
- If `fnm` is installed: `fnm install 22 && fnm use 22`
- Otherwise: download from https://nodejs.org/en/download/ or `brew install node@22`

### 2. CDP bridge dependencies
```bash
cd ${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge && npm ls --depth=0 2>&1 | head -5
```
If missing or showing WARN/ERR, run the ensure script:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-cdp-deps.sh
```
Then re-check: `cd ${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge && npm ls --depth=0 2>&1 | head -5`

If it still fails, give the user manual instructions:
1. `cd ${CLAUDE_PLUGIN_ROOT}/scripts/cdp-bridge && npm install`
2. If ENOENT: the plugin directory may be corrupt — reinstall: `/plugin install rn-dev-agent@Lykhoyda-rn-dev-agent`

### 3. agent-device CLI
```bash
command -v agent-device && agent-device --version
```
If missing, run the ensure script to attempt automatic installation:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-agent-device.sh
```
Then re-check: `command -v agent-device && agent-device --version`

If it still fails, give the user these manual instructions:
1. `npm install -g agent-device` — most common install method
2. If EACCES permission error: check if using nvm (`command -v nvm`). With nvm, global installs go to the user directory and don't need sudo. Without nvm: `sudo npm install -g agent-device`
3. If npm registry error: check internet connection, then `npm cache clean --force && npm install -g agent-device`
4. Verify: `agent-device --version` should print a version number

### 4. maestro-runner
```bash
command -v maestro-runner && maestro-runner --version
```
If missing, check the default install location first:
```bash
ls -la ~/.maestro-runner/bin/maestro-runner 2>/dev/null
```
If not there, run the ensure script to attempt automatic installation:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/ensure-maestro-runner.sh
```
Then re-check: `command -v maestro-runner || ~/.maestro-runner/bin/maestro-runner --version`

If it still fails, give the user these manual instructions:
1. `curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash` — downloads ~24MB binary
2. If curl fails: check internet, proxy settings, or firewall
3. After install, add to PATH: `export PATH="$HOME/.maestro-runner/bin:$PATH"` (add to `~/.zshrc` or `~/.bashrc`)
4. Fallback: install Maestro CLI instead: `brew install maestro` (slower but compatible)
5. Verify: `maestro-runner --version` should print a version number

### 5. iOS Simulator (if macOS)
```bash
xcrun simctl list devices booted 2>/dev/null | grep -i booted
```
If none booted: suggest opening Simulator.app or `xcrun simctl boot "iPhone 16"`

### 6. Android Emulator (if applicable)
```bash
adb devices 2>/dev/null | grep -v "List"
```
If none: check `$ANDROID_HOME/emulator/emulator -list-avds`

### 7. Metro dev server
```bash
curl -s http://127.0.0.1:8081/status 2>/dev/null
```
Should return `packager-status:running`. If not: suggest `npx expo start` or `npx react-native start`

### 8. CDP connection
Call `cdp_status` MCP tool. Should return `ok: true` with `cdp.connected: true`.
If it fails: check Metro is running, app is loaded on simulator, no other debugger connected.

### 9. ffmpeg (optional — for video recording)
```bash
command -v ffmpeg && ffmpeg -version 2>&1 | head -1
```
If missing: `brew install ffmpeg` (not critical — videos work without it, GIF conversion doesn't)

## Output format

Present results as a table:

| Check | Status | Action Needed |
|-------|--------|--------------|
| Node.js | OK (v22.15.0) | — |
| CDP bridge | OK | — |
| agent-device | MISSING | Run: npm install -g agent-device |
| maestro-runner | MISSING | Run: npm install -g maestro-runner |
| iOS Simulator | BOOTED (iPhone 16) | — |
| Android Emulator | NOT RUNNING | Boot an emulator |
| Metro | RUNNING (port 8081) | — |
| CDP connection | CONNECTED | — |
| ffmpeg | OK (v7.1) | — |

If any critical check fails (CDP bridge, agent-device, Metro, or simulator),
provide step-by-step instructions to fix it. Do not proceed with feature
development until all critical checks pass.

## After setup

Once all checks pass, tell the user:
"Environment is ready. You can now use `/rn-dev-agent:rn-feature-dev` to implement features."
