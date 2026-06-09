// The two packages our in-tree Android runner installs (see
// rn-android-runner-client.ts:18 — INSTRUMENTATION). Force-stopping these frees
// the device-side UiAutomation slot for maestro-runner's UIAutomator2 server.
// We force-stop ONLY these — never a foreign UIAutomator2 package (that overreach
// is what killed the MCP server in the #237 repro's `pkill -f agent-device`).
export const OWNED_PACKAGES = [
  'dev.lykhoyda.rndevagent.androidrunner.test',
  'dev.lykhoyda.rndevagent.androidrunner',
] as const;

/**
 * Self-kill guard: never SIGTERM/SIGKILL our own process or our parent. The
 * legacy daemon PID is read from ~/.agent-device/daemon.json, which can hold a
 * stale, OS-recycled PID — without this guard a recycled PID matching our own
 * tree would kill the MCP server (the exact collateral of `pkill -f agent-device`).
 */
export function isProtectedPid(pid: number, selfPid: number, parentPid: number): boolean {
  return pid === selfPid || pid === parentPid;
}
