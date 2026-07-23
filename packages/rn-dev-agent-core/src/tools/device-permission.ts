import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { isValidBundleId } from '../domain/maestro-validator.js';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT = 10_000;

// CodeQL js/incomplete-sanitization (alerts #1 #2): the prior pattern
// `androidKey.replace(/\./g, '\\.')` only escaped dots. Production
// ANDROID_PERMISSIONS values are always `android.permission.X` so dot-only
// escaping was safe in practice — but defense in depth is cheap.
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const IOS_PERMISSIONS: Record<string, string> = {
  notifications: 'notifications',
  camera: 'camera',
  microphone: 'microphone',
  location: 'location',
  'location-always': 'location-always',
  photos: 'photos',
  contacts: 'contacts',
  calendar: 'calendars',
  reminders: 'reminders',
  all: 'all',
};

const ANDROID_PERMISSIONS: Record<string, string> = {
  notifications: 'android.permission.POST_NOTIFICATIONS',
  camera: 'android.permission.CAMERA',
  microphone: 'android.permission.RECORD_AUDIO',
  location: 'android.permission.ACCESS_FINE_LOCATION',
  'location-always': 'android.permission.ACCESS_BACKGROUND_LOCATION',
  photos: 'android.permission.READ_MEDIA_IMAGES',
  contacts: 'android.permission.READ_CONTACTS',
  calendar: 'android.permission.READ_CALENDAR',
  storage: 'android.permission.READ_EXTERNAL_STORAGE',
};

interface PermissionArgs {
  action: 'grant' | 'revoke' | 'reset' | 'query';
  permission: string;
  appId: string;
  platform?: string;
  deviceId?: string;
}

async function iosPermission(
  action: string,
  permission: string,
  appId: string,
  deviceId: string,
): Promise<ToolResult> {
  const iosKey = IOS_PERMISSIONS[permission];
  if (!iosKey) {
    const valid = Object.keys(IOS_PERMISSIONS).join(', ');
    return failResult(`Unknown iOS permission: "${permission}". Valid: ${valid}`);
  }

  try {
    const args = ['simctl', 'privacy', deviceId, action, iosKey, appId];
    const { stdout, stderr } = await execFileAsync('xcrun', args, { timeout: EXEC_TIMEOUT });
    return okResult({
      platform: 'ios',
      action,
      permission: iosKey,
      appId,
      output: (stdout || stderr).trim(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failResult(`xcrun simctl privacy failed: ${msg}`);
  }
}

async function androidPermission(
  action: string,
  permission: string,
  appId: string,
  deviceId: string,
): Promise<ToolResult> {
  if (action === 'reset') {
    try {
      const { stdout } = await execFileAsync(
        'adb',
        ['-s', deviceId, 'shell', 'pm', 'reset-permissions', appId],
        { timeout: EXEC_TIMEOUT },
      );
      return okResult({ platform: 'android', action: 'reset', appId, output: stdout.trim() });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return failResult(`adb pm reset-permissions failed: ${msg}`);
    }
  }

  const androidKey = ANDROID_PERMISSIONS[permission];
  if (!androidKey) {
    const valid = Object.keys(ANDROID_PERMISSIONS).join(', ');
    return failResult(`Unknown Android permission: "${permission}". Valid: ${valid}`);
  }

  const adbAction = action === 'grant' ? 'grant' : 'revoke';
  try {
    const { stdout, stderr } = await execFileAsync(
      'adb',
      ['-s', deviceId, 'shell', 'pm', adbAction, appId, androidKey],
      { timeout: EXEC_TIMEOUT },
    );
    return okResult({
      platform: 'android',
      action: adbAction,
      permission: androidKey,
      appId,
      output: (stdout || stderr).trim(),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failResult(`adb pm ${adbAction} failed: ${msg}`);
  }
}

async function androidQueryPermission(
  permission: string,
  appId: string,
  deviceId: string,
): Promise<ToolResult> {
  if (permission === 'all') {
    try {
      const { stdout } = await execFileAsync(
        'adb',
        ['-s', deviceId, 'shell', 'dumpsys', 'package', appId],
        { timeout: EXEC_TIMEOUT },
      );
      if (stdout.includes('Unable to find package')) {
        return failResult(`Package "${appId}" not installed on device`);
      }
      const grantedPerms: string[] = [];
      const deniedPerms: string[] = [];

      for (const [key, androidKey] of Object.entries(ANDROID_PERMISSIONS)) {
        const re = new RegExp(`${escapeRegex(androidKey)}:.*granted=(true|false)`, 'i');
        const match = stdout.match(re);
        if (match) {
          (match[1] === 'true' ? grantedPerms : deniedPerms).push(key);
        }
      }

      return okResult({ platform: 'android', appId, granted: grantedPerms, denied: deniedPerms });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return failResult(`adb dumpsys failed: ${msg}`);
    }
  }

  const androidKey = ANDROID_PERMISSIONS[permission];
  if (!androidKey) {
    const valid = Object.keys(ANDROID_PERMISSIONS).join(', ');
    return failResult(`Unknown Android permission: "${permission}". Valid: ${valid}`);
  }

  try {
    const { stdout } = await execFileAsync(
      'adb',
      ['-s', deviceId, 'shell', 'dumpsys', 'package', appId],
      { timeout: EXEC_TIMEOUT },
    );
    if (stdout.includes('Unable to find package')) {
      return failResult(`Package "${appId}" not installed on device`);
    }
    const re = new RegExp(`${escapeRegex(androidKey)}:.*granted=(true|false)`, 'i');
    const match = stdout.match(re);

    if (match) {
      return okResult({
        platform: 'android',
        permission,
        android_permission: androidKey,
        appId,
        state: match[1] === 'true' ? 'granted' : 'denied',
      });
    }

    return okResult({
      platform: 'android',
      permission,
      android_permission: androidKey,
      appId,
      state: 'not_declared',
      note: 'Permission not found in app manifest. The app may not declare this permission.',
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return failResult(`adb dumpsys failed: ${msg}`);
  }
}

async function iosQueryPermission(permission: string, appId: string): Promise<ToolResult> {
  if (permission !== 'all' && !IOS_PERMISSIONS[permission]) {
    const valid = Object.keys(IOS_PERMISSIONS).join(', ');
    return failResult(`Unknown iOS permission: "${permission}". Valid: ${valid}`);
  }
  return okResult({
    platform: 'ios',
    permission,
    appId,
    state: 'unknown',
    note: 'iOS Simulator does not support permission state queries via CLI. Use device_permission action=reset to restore ask-again state.',
  });
}

export function createDevicePermissionHandler(): (args: PermissionArgs) => Promise<ToolResult> {
  return async (args) => {
    const platform = args.platform;
    if (platform !== 'ios' && platform !== 'android') {
      return failResult(
        `Invalid platform "${platform}". Supported values: "ios", "android".`,
        'INVALID_PLATFORM',
      );
    }

    // Phase 134.2 (deepsec HIGH): appId reaches `adb shell pm/dumpsys ...`
    // on Android, where the remote shell re-interprets argv. Reject any
    // appId that doesn't match the strict bundle-ID regex BEFORE it
    // touches adb. Validate for iOS too — simctl is less injection-prone
    // (no shell), but accepting nonsense bundle IDs there would just fail
    // downstream with a worse error message.
    if (!isValidBundleId(args.appId)) {
      return failResult(
        `Invalid appId "${String(args.appId).slice(0, 80)}" — must be reverse-DNS bundle identifier (e.g. com.example.app)`,
        'INVALID_APPID',
      );
    }
    if (!args.deviceId) {
      return failResult(
        'device_permission requires the exact authority-bound deviceId',
        'DEVICE_AUTHORITY_MISMATCH',
      );
    }

    if (args.action === 'query') {
      return platform === 'ios'
        ? iosQueryPermission(args.permission, args.appId)
        : androidQueryPermission(args.permission, args.appId, args.deviceId);
    }

    if (platform === 'ios') {
      return iosPermission(args.action, args.permission, args.appId, args.deviceId);
    }
    return androidPermission(args.action, args.permission, args.appId, args.deviceId);
  };
}
