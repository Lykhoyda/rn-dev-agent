const DEV_CLIENT_HOST = 'expo-development-client';

export const DEV_MENU_NO_AUTO_LAUNCH_EXTRAS: readonly string[] = [
  '--ez',
  'EXDevMenuDisableAutoLaunch',
  'true',
];

export function autoHidesDevMenu(
  platform: 'ios' | 'android',
  deviceId: string,
  setting: { simulators: boolean; devices: boolean } = { simulators: true, devices: true },
): boolean {
  return platform === 'ios' || /^emulator-\d+$/.test(deviceId) ? setting.simulators : setting.devices;
}

// Persistent app domain, unlike launch arguments, so bare relaunches stay popup-free too.
export function iosSimulatorDevMenuDefaultsArgs(deviceId: string, appId: string): string[][] {
  return (
    [
      ['EXDevMenuShowsAtLaunch', 'NO'],
      ['EXDevMenuIsOnboardingFinished', 'YES'],
    ] as const
  ).map(([key, value]) => ['simctl', 'spawn', deviceId, 'defaults', 'write', appId, key, '-bool', value]);
}

export function withDevMenuOnboardingDisabled(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const inner = parsed.host === DEV_CLIENT_HOST ? parsed.searchParams.get('url') : null;
  if (inner !== null) {
    parsed.searchParams.set('url', withDevMenuOnboardingDisabled(inner));
  } else {
    parsed.searchParams.set('disableOnboarding', '1');
  }
  return parsed.toString();
}
