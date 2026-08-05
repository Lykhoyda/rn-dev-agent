import { execFileSync } from 'node:child_process';

export interface ExpoAndroidDeviceBinding {
  deviceId: string;
  displayName: string;
}

export interface ExpoAndroidDeviceResolverDependencies {
  runAdb(args: readonly string[]): string;
}

interface AdbDevice {
  serial: string;
  state: string;
  details: string[];
}

const ANDROID_SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;

function identityError(message: string): Error {
  const error = new Error(`EXPO_DEVICE_IDENTITY_MISMATCH: ${message}`) as Error & {
    code: string;
  };
  error.code = 'EXPO_DEVICE_IDENTITY_MISMATCH';
  return error;
}

export function parseAdbDevices(output: string): AdbDevice[] {
  const devices: AdbDevice[] = [];
  const seen = new Set<string>();
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line === 'List of devices attached' || line.startsWith('* daemon')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const [serial, state, ...details] = parts as [string, string, ...string[]];
    if (!ANDROID_SERIAL_RE.test(serial)) continue;
    if (seen.has(serial)) throw identityError('adb enumerated a duplicate serial');
    seen.add(serial);
    devices.push({ serial, state, details });
  }
  return devices;
}

function emulatorDisplayName(output: string): string {
  const name = output
    .trim()
    .split(/[\r\n]+/, 1)[0]
    ?.trim();
  if (!name || name === 'OK' || name.startsWith('KO:')) {
    throw identityError('Expo emulator display name is unavailable');
  }
  return name;
}

function physicalDisplayName(device: AdbDevice): string {
  const model = device.details
    .find((detail) => detail.startsWith('model:'))
    ?.slice('model:'.length);
  return model || `Device ${device.serial}`;
}

function defaultDependencies(): ExpoAndroidDeviceResolverDependencies {
  return {
    runAdb: (args) =>
      execFileSync('adb', [...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 10_000,
      }),
  };
}

/**
 * Reproduces the Expo 55/56 Android CLI display-name boundary while retaining
 * the adb serial as authority. Every connected name is resolved so Expo's
 * name-only selection cannot silently choose the first duplicate.
 */
export function resolveExpoAndroidDevice(
  exactDeviceId: string,
  dependencies: ExpoAndroidDeviceResolverDependencies = defaultDependencies(),
): ExpoAndroidDeviceBinding {
  if (!ANDROID_SERIAL_RE.test(exactDeviceId)) {
    throw identityError('authority-bound adb serial is invalid');
  }

  const runAdb = (args: readonly string[], failure: string): string => {
    try {
      return dependencies.runAdb(args);
    } catch {
      throw identityError(failure);
    }
  };
  const devices = parseAdbDevices(runAdb(['devices', '-l'], 'adb device enumeration failed'));
  const exact = devices.filter(
    (device) => device.serial === exactDeviceId && device.state === 'device',
  );
  if (exact.length !== 1) {
    throw identityError('authority-bound adb serial is not uniquely connected');
  }

  const connected = devices.filter((device) => device.state === 'device');
  const bindings = connected.map((device) => ({
    deviceId: device.serial,
    displayName: device.serial.startsWith('emulator-')
      ? emulatorDisplayName(
          runAdb(
            ['-s', device.serial, 'emu', 'avd', 'name'],
            'Expo emulator identity probe failed',
          ),
        )
      : physicalDisplayName(device),
  }));
  const selectedName = bindings.find((binding) => binding.deviceId === exactDeviceId)?.displayName;
  const selected = bindings.filter((binding) => binding.displayName === selectedName);
  if (!selectedName || selected.length !== 1 || selected[0]?.deviceId !== exactDeviceId) {
    throw identityError(
      'Expo display name does not resolve uniquely to the authority-bound serial',
    );
  }
  return { deviceId: exactDeviceId, displayName: selectedName };
}
