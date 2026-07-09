import type { ToolResult } from '../utils.js';
import { attachVerificationWarning, type BaseVerificationWarning } from './envelope.js';

// GH #61 Option B.1 / D689: deep-link depth heuristic. The IX-2950 narrative
// in #61 was the agent reaching a "policy added" success sheet via a deep
// link with 3 path segments AND ending in a success-state word
// (`gtsf://main/wallet/policy-details/<id>/true`). Both signals are weak
// individually but together they reliably mark "you bypassed the user flow"
// in practice — at minimum worth a warning so a reviewer can see what was
// shortcut.
//
// Stateless detector — no rolling window or per-device state. Just inspects
// the URL the caller passed to device_deeplink. Composable with other
// verification detectors via the same `meta.verification_warning` envelope
// slot.

const SUCCESS_SUFFIX_REGEX = /(success|done|added|complete|completed|confirmation)$/i;

const DEPTH_THRESHOLD = 3;

export interface DeepLinkDepthWarning extends BaseVerificationWarning {
  code: 'DEEP_LINK_DEPTH';
  source: 'device_deeplink';
  url: string;
  segments: number;
  ends_with_success_word: boolean;
  trigger: 'depth' | 'success_suffix' | 'depth_and_success_suffix';
  hint: string;
}

export interface DeepLinkAnalysis {
  segments: number;
  endsWithSuccessWord: boolean;
  exceedsThreshold: boolean;
}

/**
 * Pure: parse a deep-link URL and report path segments + success-suffix flag.
 * Strips scheme, host, query, and fragment so only the path counts.
 *
 * Examples (depth threshold = 3):
 *   gtsf://main/wallet/policy-details/abc-123 → segments=4, exceeds=true
 *   gtsf://main/cart                          → segments=2, exceeds=false
 *   myapp://orders/123/confirmation           → segments=3, suffix=true
 *   /wallet/policy-details/abc/true           → segments=4, exceeds=true (path-only OK)
 */
export function analyzeDeepLinkUrl(url: string): DeepLinkAnalysis {
  if (typeof url !== 'string' || url.length === 0) {
    return { segments: 0, endsWithSuccessWord: false, exceedsThreshold: false };
  }

  // Strip scheme, query, and fragment. Count ALL remaining segments — for
  // app-scheme deep links (gtsf://main/wallet/...) the part the URL parser
  // would call "host" is actually a meaningful navigation segment in the
  // user's mental model. The reporter's bypass URL (gtsf://main/wallet/
  // policy-details/<id>/true) is meant to be a 5-segment deep link, not a
  // 4-segment one with "main" stripped as host. For https universal links
  // the same rule applies — example.com counts as a segment, but in practice
  // legitimate https deep links rarely deep-link past 3 segments either.
  let path = url;
  const hashIdx = path.indexOf('#');
  if (hashIdx >= 0) path = path.slice(0, hashIdx);
  const qIdx = path.indexOf('?');
  if (qIdx >= 0) path = path.slice(0, qIdx);
  const schemeMatch = path.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:(\/\/)?/);
  if (schemeMatch) {
    path = path.slice(schemeMatch[0].length);
  }

  const segments = path.split('/').filter((seg) => seg.length > 0);
  const last = segments.length > 0 ? segments[segments.length - 1] : '';
  const endsWithSuccessWord = SUCCESS_SUFFIX_REGEX.test(last);
  const exceedsThreshold = segments.length >= DEPTH_THRESHOLD;
  return { segments: segments.length, endsWithSuccessWord, exceedsThreshold };
}

/**
 * Annotate a successful device_deeplink result with `meta.verification_warning`
 * when the URL is suspiciously deep or ends with a success-state word.
 *
 * The `device_deeplink` tool's response already carries `data.url`, but we
 * pass it explicitly so callers can detect bypasses even when the response
 * shape changes.
 */
export function annotateDeepLinkDepth(result: ToolResult, ctx: { url: string }): ToolResult {
  const analysis = analyzeDeepLinkUrl(ctx.url);
  if (!analysis.exceedsThreshold && !analysis.endsWithSuccessWord) return result;

  const trigger: DeepLinkDepthWarning['trigger'] =
    analysis.exceedsThreshold && analysis.endsWithSuccessWord
      ? 'depth_and_success_suffix'
      : analysis.exceedsThreshold
        ? 'depth'
        : 'success_suffix';

  const reasons: string[] = [];
  if (analysis.exceedsThreshold) {
    reasons.push(`${analysis.segments} path segments (threshold: ${DEPTH_THRESHOLD}+)`);
  }
  if (analysis.endsWithSuccessWord) {
    reasons.push('ends with a success-state word');
  }

  const hint =
    `Deep link "${ctx.url}" matches a bypass-shape pattern (${reasons.join('; ')}). ` +
    `If this is meant to verify a user-flow, the tap-through path was likely skipped — the user does not ` +
    `manually navigate 3+ levels deep, and only post-mutation success screens use these route names. ` +
    `Use cdp_navigate sparingly here; prefer device_press + cdp_interact to drive the actual flow.`;

  const warning: DeepLinkDepthWarning = {
    code: 'DEEP_LINK_DEPTH',
    source: 'device_deeplink',
    url: ctx.url,
    segments: analysis.segments,
    ends_with_success_word: analysis.endsWithSuccessWord,
    trigger,
    hint,
  };

  return attachVerificationWarning(result, warning);
}
