const DEV_CLIENT_HOST = 'expo-development-client';

export const DEV_MENU_NO_AUTO_LAUNCH_EXTRAS: readonly string[] = [
  '--ez',
  'EXDevMenuDisableAutoLaunch',
  'true',
];

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
