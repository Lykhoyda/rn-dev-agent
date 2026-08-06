export interface TargetDeviceAssociation {
  platform: 'ios' | 'android';
  deviceId: string;
  targetDeviceName: string | null | undefined;
}

export interface TargetDeviceAssociations {
  platform: 'ios' | 'android';
  deviceId: string;
  targetDeviceNames: readonly (string | null | undefined)[];
}

export interface TargetDeviceAuthorityDependencies {
  execute(file: string, args: string[]): Promise<{ stdout: string }>;
  awaitWithinBoundary?<T>(operation: () => Promise<T>): Promise<T>;
}

function executeWithinBoundary(
  dependencies: TargetDeviceAuthorityDependencies,
  file: string,
  args: string[],
): Promise<{ stdout: string }> {
  const operation = () => dependencies.execute(file, args);
  return dependencies.awaitWithinBoundary
    ? dependencies.awaitWithinBoundary(operation)
    : operation();
}

export interface ExactDeviceTargetInput<T extends { deviceName?: string | null }> {
  platform: 'ios' | 'android';
  deviceId: string;
  targets: readonly T[];
}

export async function filterTargetsForExactDevice<T extends { deviceName?: string | null }>(
  input: ExactDeviceTargetInput<T>,
  dependencies: TargetDeviceAuthorityDependencies,
): Promise<T[]> {
  if (input.platform === 'ios') {
    const output = await executeWithinBoundary(dependencies, 'xcrun', [
      'simctl',
      'list',
      'devices',
      '--json',
    ]);
    const parsed = JSON.parse(output.stdout) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    const booted = Object.values(parsed.devices ?? {})
      .flat()
      .filter(
        (device): device is { udid: string; name: string; state: string } =>
          device.state === 'Booted' &&
          typeof device.udid === 'string' &&
          typeof device.name === 'string',
      );
    const exact = booted.find((device) => device.udid === input.deviceId);
    if (!exact || booted.filter((device) => device.name === exact.name).length !== 1) {
      throw new Error(
        'CDP_TARGET_AUTHORITY_MISMATCH: iOS target association is ambiguous or foreign',
      );
    }
    return input.targets.filter((target) => target.deviceName?.trim() === exact.name);
  }

  const devices = (await executeWithinBoundary(dependencies, 'adb', ['devices'])).stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] && parts[1] === 'device')
    .map((parts) => parts[0]!);
  if (!devices.includes(input.deviceId)) {
    throw new Error(
      'CDP_TARGET_AUTHORITY_MISMATCH: Android target association is ambiguous or foreign',
    );
  }
  const models = await Promise.all(
    devices.map(async (serial) => ({
      serial,
      model: (
        await executeWithinBoundary(dependencies, 'adb', [
          '-s',
          serial,
          'shell',
          'getprop',
          'ro.product.model',
        ])
      ).stdout.trim(),
    })),
  );
  const exact = models.find((entry) => entry.serial === input.deviceId);
  if (!exact?.model || models.filter((entry) => entry.model === exact.model).length !== 1) {
    throw new Error(
      'CDP_TARGET_AUTHORITY_MISMATCH: Android target association is ambiguous or foreign',
    );
  }
  return input.targets.filter((target) => {
    const name = target.deviceName?.trim();
    return name === exact.model || name?.startsWith(`${exact.model} -`) === true;
  });
}

export async function proveTargetDeviceAssociation(
  input: TargetDeviceAssociation,
  dependencies: TargetDeviceAuthorityDependencies,
): Promise<void> {
  return proveTargetDeviceAssociations(
    {
      platform: input.platform,
      deviceId: input.deviceId,
      targetDeviceNames: [input.targetDeviceName],
    },
    dependencies,
  );
}

export async function proveTargetDeviceAssociations(
  input: TargetDeviceAssociations,
  dependencies: TargetDeviceAuthorityDependencies,
): Promise<void> {
  const targetDeviceNames = new Set(
    input.targetDeviceNames
      .map((name) => name?.trim())
      .filter((name): name is string => Boolean(name)),
  );
  if (targetDeviceNames.size === 0) {
    throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: target does not expose device association');
  }
  if (input.platform === 'ios') {
    const output = await executeWithinBoundary(dependencies, 'xcrun', [
      'simctl',
      'list',
      'devices',
      '--json',
    ]);
    const parsed = JSON.parse(output.stdout) as {
      devices?: Record<string, Array<{ udid?: string; name?: string; state?: string }>>;
    };
    const matching = Object.values(parsed.devices ?? {})
      .flat()
      .filter(
        (device) =>
          device.state === 'Booted' &&
          typeof device.name === 'string' &&
          targetDeviceNames.has(device.name),
      );
    if (matching.length !== 1 || matching[0]?.udid !== input.deviceId) {
      throw new Error(
        'CDP_TARGET_AUTHORITY_MISMATCH: iOS target association is ambiguous or foreign',
      );
    }
    return;
  }

  const devices = (await executeWithinBoundary(dependencies, 'adb', ['devices'])).stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts[0] && parts[1] === 'device')
    .map((parts) => parts[0]!);
  const matching: string[] = [];
  for (const serial of devices) {
    const model = (
      await executeWithinBoundary(dependencies, 'adb', [
        '-s',
        serial,
        'shell',
        'getprop',
        'ro.product.model',
      ])
    ).stdout.trim();
    if (
      model &&
      [...targetDeviceNames].some(
        (targetDeviceName) =>
          targetDeviceName === model || targetDeviceName.startsWith(`${model} -`),
      )
    ) {
      matching.push(serial);
    }
  }
  if (matching.length !== 1 || matching[0] !== input.deviceId) {
    throw new Error(
      'CDP_TARGET_AUTHORITY_MISMATCH: Android target association is ambiguous or foreign',
    );
  }
}
