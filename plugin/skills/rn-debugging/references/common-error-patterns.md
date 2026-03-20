# Common Error Patterns

Diagnostic recipes for frequently encountered React Native errors.

## "Cannot read property X of undefined"

1. `cdp_component_tree` — find which component is rendering
2. `cdp_store_state` — check if data is in the store
3. Look for missing null checks or async data race

## "Invariant Violation: Element type is invalid"

Wrong export or circular import. Check `cdp_console_log(level="error")` for details.

## App Crashes With No CDP Error

Native crash. Check native logs:

```bash
# iOS (replace YourApp with actual binary name)
# Find binary name: ls $(xcrun simctl get_app_container booted <bundle-id>)
xcrun simctl spawn booted log stream \
  --predicate 'processImagePath ENDSWITH "/YourApp" AND logType == error'

# Android
adb logcat -b crash
```

For full native log command reference, see the **rn-device-control** skill.

## "[Circular]" or "[TRUNCATED]" in Results

Helpers use WeakSet for circular refs and cap output at 50KB.
Use the `path` parameter on `cdp_store_state` to drill into specific keys.

## Network Requests Not Appearing

1. RN < 0.83 — uses injected hooks. Check `cdp_status` → `capabilities.networkFallback`
2. Requests made before MCP connected — buffer only captures from connection time
