# Expo/EAS Build Integration

Two scripts handle building, installing, and launching Expo apps automatically.

## Decision Table

| Situation | Action |
|-----------|--------|
| App already running + Metro connected | Skip — proceed to testing |
| Metro not running, app not on device | `expo_ensure_running.sh` (local build mode) |
| Want to test a specific EAS build | `eas_resolve_artifact.sh` → `expo_ensure_running.sh --artifact` |
| No `eas.json` in project | Local build only (no EAS path) |

## Script 1: eas_resolve_artifact.sh

Resolves an EAS build artifact through three tiers: local cache → EAS server → manual.

```bash
# Auto-select profile, download artifact
bash scripts/eas_resolve_artifact.sh ios
bash scripts/eas_resolve_artifact.sh android

# Specify profile explicitly
bash scripts/eas_resolve_artifact.sh ios development
bash scripts/eas_resolve_artifact.sh android preview
```

### Exit codes

| Code | Meaning | Agent action |
|------|---------|-------------|
| 0 | Artifact found, JSON with path on stdout | Pass path to `expo_ensure_running.sh --artifact` |
| 1 | General failure | Report error to user |
| 2 | Ambiguous profiles, JSON with list on stdout | Ask user which profile, re-run with choice |
| 3 | EAS CLI not available | Tell user: `npm install -g eas-cli` |
| 4 | No eas.json | Use local build instead |

### Stdout (exit 0)

```json
{"status":"ok","path":"/tmp/rn-eas-builds/development-ios.tar.gz","source":"cache"}
```

### EAS profile auto-selection rules

- iOS: profile must have `"ios": { "simulator": true }` in eas.json
- Android: profile must have `"android": { "buildType": "apk" }` (AAB cannot sideload)
- If exactly one profile matches → use it
- If zero match → fall back to `"development"` profile
- If multiple match → exit 2 with list, agent asks user

## Script 2: expo_ensure_running.sh

Ensures the app is installed, launched, and Metro is running.

```bash
# Local dev build (builds from source, starts Metro)
bash scripts/expo_ensure_running.sh ios
bash scripts/expo_ensure_running.sh android

# Install EAS artifact
bash scripts/expo_ensure_running.sh ios --artifact /tmp/rn-eas-builds/dev-ios.tar.gz
bash scripts/expo_ensure_running.sh android --artifact /tmp/rn-eas-builds/dev-android.apk

# With explicit bundle ID and Metro port
bash scripts/expo_ensure_running.sh ios --bundle-id com.example.app --metro-port 8081
```

### Exit codes

| Code | Meaning | Agent action |
|------|---------|-------------|
| 0 | App running, Metro up, JSON on stdout | Proceed to `cdp_status` |
| 1 | No simulator/emulator | Tell user to boot one |
| 2 | Metro failed to start | Check `/tmp/rn-dev-agent/metro.log` |
| 3 | Install failed | Report artifact may be corrupt |
| 4 | Local build failed | Check build log, may need manual fix |

### Stdout (exit 0)

```json
{"status":"ok","metro_port":8081,"platform":"ios","installed_fresh":true}
```

### Artifact handling

- iOS `.tar.gz`: extracts, finds `.app` directory inside, `xcrun simctl install booted`
- iOS `.app`: copies and installs directly
- Android `.apk`: `adb install -r`
- Android `.aab`: rejected (cannot sideload, exit 3)

## Combined Workflow Example

```bash
# Full EAS workflow: resolve artifact, then install and run
RESULT=$(bash scripts/eas_resolve_artifact.sh ios development)
ARTIFACT=$(echo "$RESULT" | jq -r '.path')
bash scripts/expo_ensure_running.sh ios --artifact "$ARTIFACT"

# Simple local build: just build and run
bash scripts/expo_ensure_running.sh android
```

## Metro Start Behavior

Both scripts check ports 8081, 8082, 19000, 19006 (same as the MCP server).
If Metro is not running, `expo_ensure_running.sh` starts it in the background
with output logged to `/tmp/rn-dev-agent/metro.log`. Metro survives after the
script exits — it is not killed on cleanup.
