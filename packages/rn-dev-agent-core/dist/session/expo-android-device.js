import { execFileSync } from 'node:child_process';
const ANDROID_SERIAL_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE = 'EXPO_DEVICE_IDENTITY_MISMATCH';
export function expoAndroidDeviceIdentityError(message) {
    const error = new Error(`${ERROR_CODE}: ${message}`);
    error.code = ERROR_CODE;
    return error;
}
export function parseAdbDevices(output) {
    const devices = [];
    const seen = new Set();
    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line ||
            line === 'List of devices attached' ||
            line.startsWith('* daemon') ||
            /\.cpp:\d+/.test(line)) {
            continue;
        }
        const [serial, state, ...details] = line.split(/\s+/);
        if (!serial || !state || !ANDROID_SERIAL_RE.test(serial))
            continue;
        if (seen.has(serial)) {
            throw expoAndroidDeviceIdentityError('adb returned duplicate records for one serial; disconnect stale transports and retry');
        }
        seen.add(serial);
        devices.push({
            serial,
            state,
            details,
            network: line.includes('_adb-tls-connect.'),
        });
    }
    return devices;
}
function emulatorDisplayName(output) {
    const name = output
        .trim()
        .split(/[\r\n]+/, 1)[0]
        ?.trim();
    if (!name || name === 'OK' || name.startsWith('KO:')) {
        throw expoAndroidDeviceIdentityError('the connected emulator AVD name is unavailable; restart that exact emulator and retry');
    }
    return name;
}
function isAuthorized(device) {
    if (device.state !== 'device')
        return false;
    // Expo 55/56 considers an adb-tls transport authorized only once model metadata is visible.
    return !device.network || device.details.some((detail) => detail.startsWith('model:'));
}
function physicalDisplayName(device) {
    const model = device.details
        .find((detail) => detail.startsWith('model:'))
        ?.slice('model:'.length);
    return model || `Device ${device.serial}`;
}
function defaultDependencies() {
    return {
        runAdb: (args) => execFileSync('adb', [...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 10_000,
        }),
    };
}
/**
 * Reproduces the Expo 55/56 Android display-name shape while retaining the adb
 * serial as sole authority. Every connected and authorized device is named so
 * Expo's name-only resolver can never silently select an ambiguous device.
 */
export function resolveExpoAndroidDevice(exactDeviceId, dependencies = defaultDependencies()) {
    if (!ANDROID_SERIAL_RE.test(exactDeviceId)) {
        throw expoAndroidDeviceIdentityError('the authority-bound adb serial is invalid; bind one exact adb serial and retry');
    }
    const runAdb = (args, failure) => {
        try {
            return dependencies.runAdb(args);
        }
        catch {
            throw expoAndroidDeviceIdentityError(failure);
        }
    };
    const devices = parseAdbDevices(runAdb(['devices', '-l'], 'adb device enumeration failed; verify adb is available, then reconnect and authorize the exact device'));
    const exactRecords = devices.filter((device) => device.serial === exactDeviceId);
    if (exactRecords.length !== 1 || !isAuthorized(exactRecords[0])) {
        throw expoAndroidDeviceIdentityError('the authority-bound adb serial is missing, offline, or unauthorized; reconnect and authorize that exact device');
    }
    const connected = devices.filter(isAuthorized);
    const bindings = connected.map((device) => ({
        deviceId: device.serial,
        displayName: device.serial.startsWith('emulator-')
            ? emulatorDisplayName(runAdb(['-s', device.serial, 'emu', 'avd', 'name'], 'an Expo emulator identity probe failed; verify every connected emulator has a readable AVD name'))
            : physicalDisplayName(device),
    }));
    const names = new Map();
    for (const binding of bindings) {
        const previous = names.get(binding.displayName);
        if (previous !== undefined && previous !== binding.deviceId) {
            throw expoAndroidDeviceIdentityError('an Expo display name maps to multiple adb serials; disconnect duplicate models or AVD names and retry');
        }
        names.set(binding.displayName, binding.deviceId);
    }
    const selected = bindings.find((binding) => binding.deviceId === exactDeviceId);
    if (!selected || names.get(selected.displayName) !== exactDeviceId) {
        throw expoAndroidDeviceIdentityError('the Expo display name does not map uniquely to the authority-bound adb serial');
    }
    return selected;
}
export function assertStableExpoAndroidDevice(initial, immediatePreSpawn) {
    if (!initial.deviceId ||
        !initial.displayName ||
        !immediatePreSpawn.deviceId ||
        !immediatePreSpawn.displayName ||
        initial.deviceId !== immediatePreSpawn.deviceId ||
        initial.displayName !== immediatePreSpawn.displayName) {
        throw expoAndroidDeviceIdentityError('the serial-to-display-name mapping changed immediately before Expo; reconnect the exact device and retry');
    }
    return immediatePreSpawn;
}
