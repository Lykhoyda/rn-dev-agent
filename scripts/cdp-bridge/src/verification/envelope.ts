import type { ToolResult } from '../utils.js';

// GH #61 / D688+: shared envelope-augmentation helper for verification-fidelity
// detectors. Mutates the JSON-stringified envelope inside `result.content[0]`
// to add `meta.verification_warning`. Pure: returns the original result on
// parse failure, malformed shape, or isError envelope so detectors can never
// break tools.
//
// v1: single-warning slot. When a future detector composes onto a tool that
// already carries a warning (e.g. B.2 suspect route-param + B.4 mutation-absence
// on cdp_navigate), this will need to migrate to a `verification_warnings`
// array. Keeping it singular for now since the active detectors (B.1
// device_deeplink + B.4 cdp_navigate/nav_state/proof_step) hit disjoint tools.

export interface BaseVerificationWarning {
  code: string;
  source: string;
  hint: string;
}

export function attachVerificationWarning<T extends BaseVerificationWarning>(
  result: ToolResult,
  warning: T,
): ToolResult {
  if (result.isError) return result;
  try {
    const text = result.content[0]?.text;
    if (!text) return result;
    const env = JSON.parse(text) as {
      ok?: boolean;
      data?: unknown;
      meta?: Record<string, unknown>;
    };
    env.meta = { ...env.meta, verification_warning: warning };
    return { content: [{ type: 'text' as const, text: JSON.stringify(env) }] };
  } catch {
    return result;
  }
}
