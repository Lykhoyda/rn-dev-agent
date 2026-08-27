import type { ConnectFilters } from '../cdp/connect.js';
import { androidTargetMatchesKind, targetMatchesBundleId } from '../cdp/discovery.js';
import type { HermesTarget } from '../types.js';

export function targetMatchesSession(
  target: HermesTarget | null,
  filters: ConnectFilters,
): boolean {
  if (!target) return false;
  if (
    filters.platform &&
    (target.platform !== filters.platform ||
      target.platformInference === 'defaulted' ||
      target.platformInference === 'ambiguous')
  )
    return false;
  if (filters.bundleId && !targetMatchesBundleId(target, filters.bundleId)) return false;
  if (
    filters.deviceKind === 'physical' &&
    !androidTargetMatchesKind(target.deviceName, filters.deviceKind)
  ) {
    return false;
  }
  return true;
}
