import type { NavGraph } from "./types.js";

/**
 * GH #186: structural route-drift detection. A saved action records the route
 * sequence it walked (M7 `expectedRouteSequence`). Two pure checks compare that
 * against reality:
 *
 *  - validateRouteSequenceAgainstGraph (PRE-flight): cheap, conservative —
 *    fails ONLY on a definite mismatch (an expected screen the nav graph no
 *    longer knows). It deliberately no-ops on an empty/unknown graph so an
 *    incomplete graph can't false-positive a healthy replay (per the review).
 *
 *  - classifyRouteDriftAfterFailure (POST-failure): stronger — when Maestro
 *    reports SELECTOR_NOT_FOUND, the live route being OFF the expected sequence
 *    means a screen was inserted/changed (the report's CouponCode case), which
 *    is structural drift, not selector churn — so callers should reclassify it
 *    as ROUTE_DRIFT and skip the fuzzy selector repair.
 */

export interface RouteSequenceCheck {
  ok: boolean;
  reason?: string;
  missing?: string[];
}

export function validateRouteSequenceAgainstGraph(
  graph: NavGraph | null | undefined,
  expected: string[] | undefined,
): RouteSequenceCheck {
  if (!expected || expected.length === 0) return { ok: true };
  const known = new Set(graph?.all_screens ?? []);
  // Empty/unknown graph → can't make a confident judgement; don't false-positive.
  if (known.size === 0) return { ok: true };
  const missing = expected.filter((s) => !known.has(s));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `action expects screen(s) the nav graph no longer has: ${missing.join(", ")}`,
      missing,
    };
  }
  return { ok: true };
}

export interface RouteDriftVerdict {
  isDrift: boolean;
  liveRoute: string | null;
  reason?: string;
}

export function classifyRouteDriftAfterFailure(input: {
  expectedSequence: string[] | undefined;
  liveRoute: string | null;
}): RouteDriftVerdict {
  const { expectedSequence, liveRoute } = input;
  if (!expectedSequence || expectedSequence.length === 0) return { isDrift: false, liveRoute };
  if (!liveRoute) return { isDrift: false, liveRoute };
  if (!expectedSequence.includes(liveRoute)) {
    return {
      isDrift: true,
      liveRoute,
      reason: `live route "${liveRoute}" is not in the action's expected sequence [${expectedSequence.join(" → ")}] — an unexpected screen appeared (structural drift, not a stale selector)`,
    };
  }
  return { isDrift: false, liveRoute };
}
