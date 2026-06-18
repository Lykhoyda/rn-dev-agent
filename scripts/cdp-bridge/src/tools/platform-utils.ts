import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { getActiveSession } from "../agent-device-wrapper.js";

const execFile = promisify(execFileCb);
const PROBE_TIMEOUT_MS = 10_000;

export type Platform = "ios" | "android";

export async function detectPlatform(): Promise<Platform | null> {
  const session = getActiveSession();
  if (session?.platform === "ios" || session?.platform === "android") {
    return session.platform;
  }

  try {
    const { stdout } = await execFile("xcrun", ["simctl", "list", "devices", "booted"], {
      timeout: PROBE_TIMEOUT_MS,
    });
    if (stdout.includes("Booted")) return "ios";
  } catch {
    /* no iOS */
  }

  try {
    const { stdout } = await execFile("adb", ["devices"], { timeout: PROBE_TIMEOUT_MS });
    if (/\tdevice$/m.test(stdout)) return "android";
  } catch {
    /* no Android */
  }

  return null;
}
