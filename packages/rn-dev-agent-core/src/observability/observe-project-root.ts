// Ownership boundary: bound-session app root > RN_PROJECT_ROOT > heuristic,
// re-read per call (last bind wins); unprovable roots refuse truthfully.

export type ObserveRootOrigin = 'session' | 'env' | 'heuristic';

export type ObserveRootResolution =
  | { ok: true; root: string; origin: ObserveRootOrigin }
  | { ok: false; reason: string };

export class ObserveRootUnavailableError extends Error {
  readonly code = 'PROJECT_ROOT_UNAVAILABLE';

  constructor(reason: string) {
    super(reason);
    this.name = 'ObserveRootUnavailableError';
  }
}

export interface ObserveRootDeps {
  /** Bound session's declared source app root, or null when no session is bound. */
  sessionAppRoot(): string | null;
  /** Bound session's app bundle id, or null when no app authority exists. */
  sessionAppId(): string | null;
  /** Raw RN_PROJECT_ROOT value, or null when unset. */
  explicitEnvRoot(): string | null;
  /** Heuristic discovery (cwd walk-up > sibling scan), bundleId-preferring. */
  heuristicRoot(bundleId?: string): string | null;
  /** All discoverable RN projects whose declared bundle id matches, canonicalized. */
  matchingRoots(bundleId: string): string[];
  /** True when the directory is a React Native/Expo project. */
  isProject(dir: string): boolean;
  /** Declared bundle id of a project directory, or null when undeclared. */
  projectBundleId(dir: string): string | null;
}

export function createObserveRootResolver(deps: ObserveRootDeps): () => ObserveRootResolution {
  return () => {
    const declared = deps.sessionAppRoot();
    if (declared && deps.isProject(declared)) {
      return { ok: true, root: declared, origin: 'session' };
    }
    const envRoot = deps.explicitEnvRoot();
    if (envRoot) {
      if (!deps.isProject(envRoot)) {
        return {
          ok: false,
          reason: `RN_PROJECT_ROOT is not a React Native project (${envRoot})`,
        };
      }
      return { ok: true, root: envRoot, origin: 'env' };
    }
    const appId = deps.sessionAppId();
    const discovered = deps.heuristicRoot(appId ?? undefined);
    if (!discovered) {
      return {
        ok: false,
        reason: declared
          ? `session app root is not a React Native project (${declared}) and heuristic discovery found none`
          : 'no React Native project root: no bound session app root and heuristic discovery found none',
      };
    }
    if (appId) {
      const discoveredId = deps.projectBundleId(discovered);
      if (discoveredId && discoveredId !== appId) {
        return {
          ok: false,
          reason: `discovered project ${discovered} declares ${discoveredId}, not the bound app ${appId}`,
        };
      }
      if (discoveredId === appId) {
        const matches = deps.matchingRoots(appId);
        if (matches.length > 1) {
          return {
            ok: false,
            reason: `multiple checkouts declare the bound app ${appId}: ${matches.join(', ')}; set RN_PROJECT_ROOT to choose one`,
          };
        }
      }
    }
    return { ok: true, root: discovered, origin: 'heuristic' };
  };
}
