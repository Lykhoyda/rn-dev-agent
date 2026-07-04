// scripts/cdp-bridge/src/observability/mirror/target.ts

export interface MirrorTarget {
  platform: 'ios' | 'android';
  deviceId: string;
}

export type MirrorTargetResolution =
  | { ok: true; target: MirrorTarget }
  | { ok: false; reason: string; hint?: string };

export interface MirrorTargetDeps {
  getPlatform(): 'ios' | 'android' | null;
  getSessionDeviceId(): string | undefined;
  resolveIosUdid(): Promise<string | undefined>;
  listAndroidSerials(): Promise<string[]>;
}

export function buildMirrorTargetResolver(
  deps: MirrorTargetDeps,
): () => Promise<MirrorTargetResolution> {
  return async () => {
    const platform = deps.getPlatform();
    if (platform === null) {
      return {
        ok: false,
        reason: 'no active device session — run cdp_status or a device_* tool first',
      };
    }

    const sessionDeviceId = deps.getSessionDeviceId();
    if (sessionDeviceId) {
      return { ok: true, target: { platform, deviceId: sessionDeviceId } };
    }

    if (platform === 'ios') {
      const udid = await deps.resolveIosUdid();
      if (!udid) {
        return {
          ok: false,
          reason:
            'no single booted iOS simulator — boot exactly one or start a session with a deviceId',
        };
      }
      return { ok: true, target: { platform: 'ios', deviceId: udid } };
    }

    const serials = await deps.listAndroidSerials();
    if (serials.length === 0) {
      return { ok: false, reason: 'no Android device connected' };
    }
    if (serials.length > 1) {
      return {
        ok: false,
        reason: 'multiple Android devices — start a session with a deviceId',
      };
    }
    return { ok: true, target: { platform: 'android', deviceId: serials[0] } };
  };
}
