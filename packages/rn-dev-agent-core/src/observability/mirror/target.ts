// packages/rn-dev-agent-core/src/observability/mirror/target.ts

export interface MirrorTarget {
  platform: 'ios' | 'android';
  deviceId: string;
}

export type MirrorTargetResolution =
  | { ok: true; target: MirrorTarget }
  | { ok: false; reason: string; hint?: string; code?: string };

export interface MirrorTargetDeps {
  getPlatform(): 'ios' | 'android' | null;
  getSessionDeviceId(): string | undefined;
  resolveIosUdid(): Promise<string | undefined>;
  listAndroidSerials(): Promise<string[]>;
  /**
   * GH #791: the PR #786 fence mapper — null permits legacy ambient inference,
   * {} means an authority session exists without a proven device binding.
   */
  getRegistryDeviceBinding?(): { platform?: string; deviceId?: string } | null;
}

function isMirrorPlatform(p: string | undefined): p is 'ios' | 'android' {
  return p === 'ios' || p === 'android';
}

export function buildMirrorTargetResolver(
  deps: MirrorTargetDeps,
): () => Promise<MirrorTargetResolution> {
  return async () => {
    const registry = deps.getRegistryDeviceBinding?.() ?? null;
    if (registry !== null) {
      if (isMirrorPlatform(registry.platform) && registry.deviceId) {
        return {
          ok: true,
          target: { platform: registry.platform, deviceId: registry.deviceId },
        };
      }
      return {
        ok: false,
        code: 'DEVICE_AUTHORITY_UNBOUND',
        reason: 'device authority is not bound — run rn_session bind_device',
        hint: 'Observe mirrors only the session-proven device while an authority session is present',
      };
    }

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
