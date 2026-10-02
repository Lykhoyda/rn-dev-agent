import {
  readRnAgentConfig,
  resolveAutoHideDevMenu,
  type AutoHideDevMenuResolution,
} from '../project-config.js';
import { autoHidesDevMenu, withDevMenuOnboardingDisabled } from './dev-client-onboarding.js';
import type { SessionStatus } from './registry.js';

export function sessionAutoHideDevMenu(status: SessionStatus): AutoHideDevMenuResolution {
  return resolveAutoHideDevMenu({
    readConfig: () => readRnAgentConfig(String(status.source.appRoot)),
  });
}

export function iosDevClientLaunchUrl(metroPort: number, hideDevMenu: boolean): string {
  const url = `http://127.0.0.1:${String(metroPort)}`;
  return hideDevMenu ? withDevMenuOnboardingDisabled(url) : url;
}

export function sessionIosDevClientLaunchUrl(status: SessionStatus): string | null {
  const device = status.bindings.device as { platform?: unknown; deviceId?: unknown } | undefined;
  const metroPort = (status.bindings.metro as { port?: unknown } | undefined)?.port;
  if (
    device?.platform !== 'ios' ||
    typeof device.deviceId !== 'string' ||
    typeof metroPort !== 'number' ||
    !Number.isSafeInteger(metroPort)
  ) {
    return null;
  }
  return iosDevClientLaunchUrl(
    metroPort,
    autoHidesDevMenu('ios', device.deviceId, sessionAutoHideDevMenu(status)),
  );
}
