import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

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
export async function terminateApp(bundleId: string, platform: 'ios' | 'android'): Promise<void> {
  if (platform === 'ios') {
    await execFile('xcrun', ['simctl', 'terminate', 'booted', bundleId], {
      timeout: TERMINATE_TIMEOUT_MS, encoding: 'utf8',
    });
  } else {
    await execFile('adb', ['shell', 'am', 'force-stop', bundleId], {
      timeout: TERMINATE_TIMEOUT_MS, encoding: 'utf8',
    });
  }
}

/**
 * Launch the app. iOS: `xcrun simctl launch booted <bundleId>`. Android:
 * the standard MAIN/LAUNCHER intent (NOT `monkey`, which the brainstorm
 * flagged as flakier on Android 13+). Throws on failure.
 */
export async function launchApp(bundleId: string, platform: 'ios' | 'android'): Promise<void> {
  if (platform === 'ios') {
    await execFile('xcrun', ['simctl', 'launch', 'booted', bundleId], {
      timeout: LAUNCH_TIMEOUT_MS, encoding: 'utf8',
    });
  } else {
    await execFile(
      'adb',
      ['shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', bundleId],
      { timeout: LAUNCH_TIMEOUT_MS, encoding: 'utf8' },
    );
  }
}
