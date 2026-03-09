---
name: check-env
description: Check if the React Native development environment is ready for testing
---

Check the environment readiness for React Native testing:

1. **Metro bundler**: Is it running?
   ```bash
   curl -s http://localhost:8081/status 2>/dev/null || curl -s http://localhost:8082/status 2>/dev/null || echo "Metro not running"
   ```

2. **Simulator/Emulator**: Is one booted?
   ```bash
   xcrun simctl list devices booted 2>/dev/null
   adb devices 2>/dev/null
   ```

3. **Test runner**: Is Maestro or maestro-runner available?
   ```bash
   command -v maestro-runner || command -v maestro || echo "No test runner found"
   ```

4. **CDP connection**: Can we connect to the app?
   Call `cdp_status` to verify end-to-end connectivity.

5. **App state**: Is the app loaded without errors?
   Check for RedBox, paused debugger, and error count.

Report the status of each check and suggest fixes for any failures.
