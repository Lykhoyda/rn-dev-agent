import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

// Safe by construction: argv arrays only, never shell strings.
// Shared lifecycle ops extracted from startup-replay.ts so device_reset_state
// can report per-step status (terminate vs launch) instead of one combined call.
const execFile = promisify(execFileCb);

const TERMINATE_TIMEOUT_MS = 10_000;
const LAUNCH_TIMEOUT_MS = 15_000;

/**
 * Force-stop the app. Idempotent on both platforms — exits 0 even if the app
 * wasn't running. iOS: `xcrun simctl terminate booted <bundleId>`. Android:
 * `adb shell am force-stop <bundleId>`. Errors are propagated so callers can
 * decide whether to abort or continue (a hung adb is more interesting than
 * an iOS app that wasn't running).
 */
export async function terminateApp(bundleId: string, platform: "ios" | "android"): Promise<void> {
  if (platform === "ios") {
    await execFile("xcrun", ["simctl", "terminate", "booted", bundleId], {
      timeout: TERMINATE_TIMEOUT_MS,
      encoding: "utf8",
    });
  } else {
    await execFile("adb", ["shell", "am", "force-stop", bundleId], {
      timeout: TERMINATE_TIMEOUT_MS,
      encoding: "utf8",
    });
  }
}

/**
 * CDP-004: build a package-scoped Android launch argv for `adb`.
 *
 * Why `-p` (not a bare trailing bundleId): the bare form was parsed by
 * `am start` as an intent URI, which let unrelated packages match the
 * implicit MAIN/LAUNCHER resolution. `-p <package>` restricts intent
 * resolution to the requested package. `-W` waits for launch so failures
 * surface as non-zero exits instead of being silently lost.
 *
 * Exported as a pure helper so the argv shape can be regression-tested
 * without spawning adb.
 */
export function buildAndroidLaunchArgv(bundleId: string): string[] {
  if (typeof bundleId !== "string" || bundleId.length === 0) {
    throw new Error("buildAndroidLaunchArgv: bundleId is required");
  }
  return [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.LAUNCHER",
    "-p",
    bundleId,
  ];
}

/**
 * Launch the app. iOS: `xcrun simctl launch booted <bundleId>`. Android:
 * the MAIN/LAUNCHER intent scoped to the package via `-p` (CDP-004).
 * Throws on failure.
 */
export async function launchApp(bundleId: string, platform: "ios" | "android"): Promise<void> {
  if (platform === "ios") {
    await execFile("xcrun", ["simctl", "launch", "booted", bundleId], {
      timeout: LAUNCH_TIMEOUT_MS,
      encoding: "utf8",
    });
  } else {
    await execFile("adb", buildAndroidLaunchArgv(bundleId), {
      timeout: LAUNCH_TIMEOUT_MS,
      encoding: "utf8",
    });
  }
}
