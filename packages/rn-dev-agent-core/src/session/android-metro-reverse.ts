import { execFileSync } from 'node:child_process';

export interface AndroidMetroReverseBinding {
  platform: 'android';
  deviceId: string;
  metroPort: number;
  local: string;
  remote: string;
}

export interface AndroidMetroReverseDependencies {
  execute?(file: string, args: string[]): string;
}

export interface AndroidMetroReverseResult {
  binding: AndroidMetroReverseBinding | null;
  created: boolean;
  physical: boolean;
}

function execute(
  dependencies: AndroidMetroReverseDependencies,
  file: string,
  args: string[],
): string {
  if (dependencies.execute) return dependencies.execute(file, args);
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

function endpoint(port: number): string {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PHYSICAL_ANDROID_METRO_UNREACHABLE: authority-bound Metro port is invalid');
  }
  return `tcp:${port}`;
}

class AndroidDeviceDisconnectedError extends Error {}

const DEVICE_DISCONNECTED =
  /device\s+('[^']*'\s+)?not found|no devices\/emulators found|device offline/i;

function describeExecutionFailure(error: unknown): string {
  const parts: unknown[] =
    error && typeof error === 'object'
      ? [
          (error as { message?: unknown }).message,
          (error as { stderr?: unknown }).stderr,
          (error as { stdout?: unknown }).stdout,
        ]
      : [String(error)];
  return parts
    .map((part) =>
      typeof part === 'string' ? part : Buffer.isBuffer(part) ? part.toString('utf8') : '',
    )
    .filter((part) => part.length > 0)
    .join('\n');
}

function adb(
  deviceId: string,
  args: string[],
  dependencies: AndroidMetroReverseDependencies,
): string {
  try {
    return execute(dependencies, 'adb', ['-s', deviceId, ...args]);
  } catch (error) {
    const details = describeExecutionFailure(error);
    const message = `PHYSICAL_ANDROID_METRO_UNREACHABLE: adb could not configure Metro reachability on exact device ${deviceId}: ${
      details || String(error)
    }`;
    throw DEVICE_DISCONNECTED.test(details)
      ? new AndroidDeviceDisconnectedError(message)
      : new Error(message);
  }
}

function isPhysicalAndroid(
  deviceId: string,
  dependencies: AndroidMetroReverseDependencies,
): boolean {
  if (/^emulator-\d+$/.test(deviceId)) return false;
  return adb(deviceId, ['shell', 'getprop', 'ro.kernel.qemu'], dependencies).trim() !== '1';
}

interface ReverseForward {
  local: string;
  remote: string;
}

function listReverseForwards(
  deviceId: string,
  dependencies: AndroidMetroReverseDependencies,
): ReverseForward[] {
  return adb(deviceId, ['reverse', '--list'], dependencies)
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length >= 2)
    .map((parts) => ({
      local: parts[parts.length - 2]!,
      remote: parts[parts.length - 1]!,
    }))
    .filter((forward) => forward.local.startsWith('tcp:') && forward.remote.startsWith('tcp:'));
}

function assertBindingMatches(
  binding: AndroidMetroReverseBinding,
  deviceId: string,
  metroPort: number,
): void {
  const exact = endpoint(metroPort);
  if (
    binding.platform !== 'android' ||
    binding.deviceId !== deviceId ||
    binding.metroPort !== metroPort ||
    binding.local !== exact ||
    binding.remote !== exact
  ) {
    throw new Error(
      'PHYSICAL_ANDROID_METRO_UNREACHABLE: retained adb reverse authority does not match the exact device and Metro port',
    );
  }
}

function removeExactForwardAfterFailedSetup(
  deviceId: string,
  exact: string,
  dependencies: AndroidMetroReverseDependencies,
): void {
  try {
    const current = listReverseForwards(deviceId, dependencies).filter(
      (forward) => forward.local === exact,
    );
    if (current.length === 1 && current[0]!.remote === exact) {
      adb(deviceId, ['reverse', '--remove', exact], dependencies);
    }
  } catch (error) {
    if (error instanceof AndroidDeviceDisconnectedError) return;
    throw error;
  }
}

export function ensureAndroidMetroReverse(
  input: {
    deviceId: string;
    metroPort: number;
    binding?: AndroidMetroReverseBinding | null;
  },
  dependencies: AndroidMetroReverseDependencies = {},
): AndroidMetroReverseResult {
  const exact = endpoint(input.metroPort);
  if (!isPhysicalAndroid(input.deviceId, dependencies)) {
    if (input.binding) {
      throw new Error(
        'PHYSICAL_ANDROID_METRO_UNREACHABLE: emulator authority cannot retain a physical-device adb reverse binding',
      );
    }
    return { binding: null, created: false, physical: false };
  }
  if (input.binding) assertBindingMatches(input.binding, input.deviceId, input.metroPort);

  const matchingLocal = listReverseForwards(input.deviceId, dependencies).filter(
    (forward) => forward.local === exact,
  );
  if (matchingLocal.length > 0) {
    if (input.binding && matchingLocal.length === 1 && matchingLocal[0]!.remote === exact) {
      return { binding: input.binding, created: false, physical: true };
    }
    throw new Error(
      `PHYSICAL_ANDROID_METRO_UNREACHABLE: exact device ${input.deviceId} already has a foreign adb reverse for ${exact}; refusing to replace or adopt it`,
    );
  }

  let created = false;
  try {
    adb(input.deviceId, ['reverse', exact, exact], dependencies);
    created = true;
    const verified = listReverseForwards(input.deviceId, dependencies).filter(
      (forward) => forward.local === exact,
    );
    if (verified.length !== 1 || verified[0]!.remote !== exact) {
      throw new Error(
        `PHYSICAL_ANDROID_METRO_UNREACHABLE: adb did not verify ${exact} -> ${exact} on exact device ${input.deviceId}`,
      );
    }
    return {
      binding: {
        platform: 'android',
        deviceId: input.deviceId,
        metroPort: input.metroPort,
        local: exact,
        remote: exact,
      },
      created: true,
      physical: true,
    };
  } catch (error) {
    if (!created) throw error;
    try {
      removeExactForwardAfterFailedSetup(input.deviceId, exact, dependencies);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        'PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: failed setup left exact adb reverse cleanup unresolved',
      );
    }
    throw error;
  }
}

export function removeAndroidMetroReverse(
  binding: AndroidMetroReverseBinding,
  dependencies: AndroidMetroReverseDependencies = {},
): void {
  assertBindingMatches(binding, binding.deviceId, binding.metroPort);
  try {
    const matchingLocal = listReverseForwards(binding.deviceId, dependencies).filter(
      (forward) => forward.local === binding.local,
    );
    if (matchingLocal.length === 0) return;
    if (matchingLocal.length !== 1 || matchingLocal[0]!.remote !== binding.remote) {
      throw new Error(
        `PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: ${binding.local} on exact device ${binding.deviceId} changed to a foreign forward; refusing to remove it`,
      );
    }
    adb(binding.deviceId, ['reverse', '--remove', binding.local], dependencies);
    if (
      listReverseForwards(binding.deviceId, dependencies).some(
        (forward) => forward.local === binding.local,
      )
    ) {
      throw new Error(
        `PHYSICAL_ANDROID_METRO_CLEANUP_UNPROVEN: session-owned ${binding.local} remains on exact device ${binding.deviceId}`,
      );
    }
  } catch (error) {
    if (error instanceof AndroidDeviceDisconnectedError) return;
    throw error;
  }
}
