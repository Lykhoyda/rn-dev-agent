export async function proveTargetDeviceAssociation(input, dependencies) {
    const targetDeviceName = input.targetDeviceName?.trim();
    if (!targetDeviceName) {
        throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: target does not expose device association');
    }
    if (input.platform === 'ios') {
        const output = await dependencies.execute('xcrun', ['simctl', 'list', 'devices', '--json']);
        const parsed = JSON.parse(output.stdout);
        const matching = Object.values(parsed.devices ?? {})
            .flat()
            .filter((device) => device.state === 'Booted' && device.name === targetDeviceName);
        if (matching.length !== 1 || matching[0]?.udid !== input.deviceId) {
            throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: iOS target association is ambiguous or foreign');
        }
        return;
    }
    const devices = (await dependencies.execute('adb', ['devices'])).stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((parts) => parts[0] && parts[1] === 'device')
        .map((parts) => parts[0]);
    const matching = [];
    for (const serial of devices) {
        const model = (await dependencies.execute('adb', ['-s', serial, 'shell', 'getprop', 'ro.product.model'])).stdout.trim();
        if (model && (targetDeviceName === model || targetDeviceName.startsWith(`${model} -`))) {
            matching.push(serial);
        }
    }
    if (matching.length !== 1 || matching[0] !== input.deviceId) {
        throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: Android target association is ambiguous or foreign');
    }
}
