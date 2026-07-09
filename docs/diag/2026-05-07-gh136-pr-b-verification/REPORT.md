# GH #136 PR-B — Test App Verification Report

**Date:** 2026-05-07
**Branch:** `fix/gh-136-picker-reliability` (PR #139)
**Test app:** `rn-dev-agent-workspace/test-app` (com.rndevagent.testapp)
**Simulator:** iPhone 17 Pro (`FC78646A-56D5-4737-9CD0-A360D622F3B3`), iOS

## Constraint

Claude Code's MCP subprocess was started at session-begin with the **previous** `dist/` (cdp-bridge 0.38.22). Per `project_mcp_lifecycle`, `/reload-plugins` does NOT restart the subprocess — only a full Claude Code restart picks up the new dist (0.38.23, this PR). So MCP-driven calls in this session exercise the OLD code path, not the new one.

To verify within this constraint, two complementary checks were performed:

1. **Direct logic verification** against the freshly-compiled NEW dist
   (`packages/rn-dev-agent-core/dist/tools/dev-client-picker.js`) using a node script
   that imports `parseFirstServerEntry` and runs it against representative
   real-world picker snapshot text. Independent of the MCP subprocess.
2. **Environment health check** through OLD MCP — confirms Metro + simulator
   + test app are all wired up correctly for the upcoming end-to-end test
   that the user runs after Claude Code restart.

## 1. Logic verification — `verify-pr-b-logic.mjs`

```
PR-B picker logic verification — new dist

✓ Real LAN-IP picker from #136 reproducer
    expected: "192.168.1.5:8081"
    got:      "192.168.1.5:8081"
✓ Android emulator alias picker
    expected: "10.0.2.2:8081"
    got:      "10.0.2.2:8081"
✓ Localhost-only picker (the original "happy path")
    expected: "localhost:8081"
    got:      "localhost:8081"
✓ Real-world: picker with manifest name only (URL hidden)
    expected: "rn-dev-agent-test-app"
    got:      "rn-dev-agent-test-app"
✓ Decorative substring trap (Codex/Gemini caught this)
    expected: "192.168.1.5:8081"
    got:      "192.168.1.5:8081"
✓ Localized footer (Codex caught this)
    expected: "rn-dev-agent-test-app"
    got:      "rn-dev-agent-test-app"
✓ Version-banner trap (Gemini caught this)
    expected: "192.168.1.5:8081"
    got:      "192.168.1.5:8081"
✓ No picker — should return null
    expected: null
    got:      null
✓ host.local hostname with port
    expected: "antons-macbook.local:8081"
    got:      "antons-macbook.local:8081"

9/9 passed
```

### Why these cases matter

| Case | What it covers | Old behavior |
|---|---|---|
| #136 reproducer | The exact LAN-IP scenario that failed in field telemetry | OLD regex matched `192.168.1.5` (no port) — tap-by-text on incomplete string was unreliable |
| Manifest-only picker | Picker variant where URL is hidden, only manifest name visible | OLD: `dismissed: false` returned (no IP regex match); user had to tap manually |
| host.local hostname | Bonjour/mDNS dev-client setups | OLD: `dismissed: false`; literal-list missed it |
| Decorative substring trap | "Open localhost in browser" tooltip row | OLD: would have short-circuited to literal `localhost` and tapped the wrong row (multi-LLM review caught) |
| Localized footer | `ENTER URL MANUALLY` casing variant | OLD: case-sensitive deny-list leaked the footer through fallback (multi-LLM review caught) |
| Version-banner trap | Build-version row above the server row | OLD: would have matched `v1.2.3:1234` as host (multi-LLM review caught) |

## 2. Environment health (OLD MCP)

```
$ cdp_status platform=ios
{
  "ok": true,
  "data": {
    "metro": {"running": true, "port": 8081},
    "cdp": {
      "connected": true,
      "device": "React Native Bridgeless [C++ connection]",
      "pageId": "6f8d21a09d9242f3d184c343f36a761c7377e773-1",
      "platform": "ios",
      "bundleId": "com.rndevagent.testapp"
    },
    "app": {"dev": true, "hermes": true, "architecture": "new", "errorCount": 0},
    "capabilities": {"helpersInjected": true, "fiberTree": true}
  }
}
```

- Metro running on 8081 ✓
- iPhone 17 Pro simulator booted ✓
- `com.rndevagent.testapp` running ✓
- Bridgeless RN runtime ✓
- Helpers injected, fiber tree reachable ✓

Screenshot of clean test-app home screen captured at `01-test-app-home.jpg` —
proves agent-device → simulator → React fiber path is healthy under the new
runtime, so any failure during the end-to-end picker test will be specific
to the picker code path, not environmental.

## 3. End-to-end gap (requires Claude Code restart)

The remaining acceptance criterion from the PR — *"dev-client picker visible
→ cdp_status → connected in <5s"* — needs the NEW MCP subprocess to be
running. Reproduction steps after Claude Code restart:

```bash
# 1. Force the dev-client picker
xcrun simctl terminate FC78646A-56D5-4737-9CD0-A360D622F3B3 com.rndevagent.testapp

# 2. Use Maestro to re-launch with cleared keychain (clears cached server URL)
cat > /tmp/force-picker.yaml <<EOF
appId: com.rndevagent.testapp
---
- launchApp:
    stopApp: true
    clearKeychain: true
EOF
maestro test /tmp/force-picker.yaml
# (picker should now be visible on the simulator)

# 3. Inside Claude Code, call cdp_status — expect connected:true within 5s
# (was: 60s+ FAIL with "Already connecting to Metro... Dev Client picker
#  detected but could not find a server entry to tap")
```

If `cdp_status` returns `connected: true` in <5s, the fix is verified
end-to-end. Subsequent benchmark to record actual latency on the picker path
should land in the PR's manual-test section.

## Files

- `verify-pr-b-logic.mjs` — node script (run with `node verify-pr-b-logic.mjs`)
- `01-test-app-home.jpg` — clean home-screen screenshot from healthy session
- `REPORT.md` — this file
