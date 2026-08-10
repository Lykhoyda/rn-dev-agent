import {
  assertStableExpoAndroidDevice,
  expoAndroidDeviceIdentityError,
  resolveExpoAndroidDevice,
  type ExpoAndroidDeviceBinding,
} from './expo-android-device.js';

export interface SessionBuildBinding {
  platform: 'ios' | 'android';
  deviceId: string;
  appId?: string;
  metroPort: number;
  sessionId: string;
  devClientUrl?: string;
  simulator?: boolean;
}

interface BuildLaunchPlan {
  mode: 'passthrough' | 'session';
  command: string[];
  env: Record<string, string>;
  postInstall?: {
    command: string[];
    timeoutMs: number;
  };
}

function conflict(flag: string): never {
  throw new Error(`SESSION_BUILD_IDENTITY_CONFLICT: ${flag} contradicts the active session`);
}

function ensureValue(command: string[], flag: string, value: string): void {
  let found = false;
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === flag) {
      found = true;
      if (command[index + 1] !== value) conflict(flag);
    } else if (command[index]?.startsWith(`${flag}=`)) {
      found = true;
      if (command[index] !== `${flag}=${value}`) conflict(flag);
    }
  }
  if (!found) command.push(flag, value);
}

function translateExpoAndroidDevice(command: string[], serial: string, displayName: string): void {
  let found = false;
  for (let index = 0; index < command.length; index += 1) {
    if (command[index] === '--device') {
      found = true;
      if (command[index + 1] !== serial) {
        throw expoAndroidDeviceIdentityError(
          'a user-supplied --device does not equal the authority-bound adb serial',
        );
      }
      command[index + 1] = displayName;
    } else if (command[index]?.startsWith('--device=')) {
      found = true;
      if (command[index] !== `--device=${serial}`) {
        throw expoAndroidDeviceIdentityError(
          'a user-supplied --device does not equal the authority-bound adb serial',
        );
      }
      command[index] = `--device=${displayName}`;
    }
  }
  if (!found) command.push('--device', displayName);
}

function ensureFlag(command: string[], flag: string): void {
  if (!command.includes(flag)) command.push(flag);
}

// Expo CLI rejects --port with --no-bundler; the managed port travels via env and --initialUrl.
function removeManagedPortFlag(command: string[], value: string): void {
  for (let index = 0; index < command.length; ) {
    const part = command[index]!;
    const separator = part.indexOf('=');
    const flag = separator >= 0 ? part.slice(0, separator) : part;
    if (flag !== '--port' && flag !== '-p') {
      index += 1;
      continue;
    }
    const supplied = separator >= 0 ? part.slice(separator + 1) : command[index + 1];
    if (supplied !== value) conflict('--port');
    command.splice(index, separator >= 0 ? 1 : 2);
  }
}

export function managedMetroProxyUrl(session: SessionBuildBinding): string {
  if (session.platform === 'ios') {
    return `http://127.0.0.1:${session.metroPort}`;
  }
  if (/^emulator-\d+$/.test(session.deviceId)) {
    return `http://10.0.2.2:${session.metroPort}`;
  }
  if (!session.devClientUrl) {
    throw new Error(
      'DEV_CLIENT_ENDPOINT_NOT_FOUND: physical Android session requires an exact Dev Client URL',
    );
  }

  let metroUrl: URL;
  try {
    const encodedMetroUrl = new URL(session.devClientUrl).searchParams.get('url');
    if (!encodedMetroUrl) throw new Error('missing url parameter');
    metroUrl = new URL(encodedMetroUrl);
  } catch {
    throw new Error(
      'DEV_CLIENT_ENDPOINT_NOT_FOUND: Dev Client URL does not contain an exact managed Metro endpoint',
    );
  }
  if (
    !['http:', 'https:'].includes(metroUrl.protocol) ||
    Number(metroUrl.port) !== session.metroPort
  ) {
    throw new Error(
      'SESSION_BUILD_IDENTITY_CONFLICT: Dev Client URL contradicts the active managed Metro',
    );
  }
  return metroUrl.origin;
}

function commandKind(command: readonly string[]): 'expo' | 'bare-ios' | 'bare-android' | null {
  const offset = command[0] === 'npx' ? 1 : 0;
  const executable = command[offset];
  const subcommand = command[offset + 1];
  if (executable === 'expo' && (subcommand === 'run:ios' || subcommand === 'run:android')) {
    return 'expo';
  }
  if (executable === 'react-native' && subcommand === 'run-ios') return 'bare-ios';
  if (executable === 'react-native' && subcommand === 'run-android') return 'bare-android';
  return null;
}

export function createBuildLaunchPlan(input: {
  platform: 'ios' | 'android';
  command: readonly string[];
  session: SessionBuildBinding | null;
  resolveExpoAndroidDevice?: (serial: string) => ExpoAndroidDeviceBinding;
}): BuildLaunchPlan {
  const command = [...input.command];
  if (!input.session) return { mode: 'passthrough', command, env: {} };
  if (input.session.platform !== input.platform) conflict('platform');

  const kind = commandKind(command);
  const expectedKind =
    input.platform === 'ios' ? new Set(['expo', 'bare-ios']) : new Set(['expo', 'bare-android']);
  if (!kind || !expectedKind.has(kind)) {
    throw new Error('SESSION_BUILD_COMMAND_UNSUPPORTED: command shape is not recognized');
  }

  if (kind === 'expo') {
    if (input.platform === 'android') {
      const resolveDevice = input.resolveExpoAndroidDevice ?? resolveExpoAndroidDevice;
      const initial = resolveDevice(input.session.deviceId);
      const verified = assertStableExpoAndroidDevice(
        initial,
        resolveDevice(input.session.deviceId),
      );
      if (verified.deviceId !== input.session.deviceId) {
        throw expoAndroidDeviceIdentityError(
          'the resolved Expo device does not equal the authority-bound adb serial',
        );
      }
      translateExpoAndroidDevice(command, input.session.deviceId, verified.displayName);
    } else {
      ensureValue(command, '--device', input.session.deviceId);
    }
    removeManagedPortFlag(command, String(input.session.metroPort));
    ensureFlag(command, '--no-bundler');
  } else if (kind === 'bare-ios') {
    ensureValue(command, '--udid', input.session.deviceId);
    ensureValue(command, '--port', String(input.session.metroPort));
    ensureFlag(command, '--no-packager');
  } else {
    ensureValue(command, '--deviceId', input.session.deviceId);
    ensureValue(command, '--port', String(input.session.metroPort));
    ensureFlag(command, '--no-packager');
  }

  const env = {
    ORG_GRADLE_PROJECT_reactNativeDevServerPort: String(input.session.metroPort),
    RCT_METRO_PORT: String(input.session.metroPort),
    RN_DEV_AGENT_SESSION_ID: input.session.sessionId,
    ...(kind === 'expo' && input.platform === 'android'
      ? { ANDROID_SERIAL: input.session.deviceId }
      : {}),
    ...(kind === 'expo' ? { EXPO_PACKAGER_PROXY_URL: managedMetroProxyUrl(input.session) } : {}),
  };
  const postInstall =
    kind === 'expo' && input.platform === 'ios' && input.session.simulator === true
      ? {
          command: [
            'xcrun',
            'simctl',
            'launch',
            '--terminate-running-process',
            input.session.deviceId,
            input.session.appId ?? conflict('appId is required for simulator Dev Client startup'),
            '--initialUrl',
            managedMetroProxyUrl(input.session),
          ],
          timeoutMs: 30_000,
        }
      : undefined;

  return {
    mode: 'session',
    command,
    env,
    ...(postInstall ? { postInstall } : {}),
  };
}
