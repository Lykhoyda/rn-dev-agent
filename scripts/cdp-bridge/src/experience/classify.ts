import type { FailureFamily, ClassificationResult, FailureFamilyMatch } from './types.js';

/**
 * Normalize an error message into a stable signature for grouping.
 * Strips volatile parts (hex addresses, line numbers, file paths, timestamps)
 * so that structurally identical errors produce the same signature.
 */
export function normalizeError(error: string): string {
  return error
    .replace(/0x[a-fA-F0-9]+/g, '[HEX]')
    .replace(/:\d+:\d+/g, ':[N]:[N]')
    .replace(/\b\d{4,}\b/g, '[N]')
    .replace(/\/[\w./_-]{3,}/g, '[PATH]')
    .replace(/\b\d+\.\d+\.\d+\b/g, '[VER]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Match a single FailureFamilyMatch rule against tool call context.
 */
function matchRule(
  rule: FailureFamilyMatch,
  error: string,
  normalizedError: string,
  toolName: string,
  meta: Record<string, unknown>,
): boolean {
  const target = rule.field === 'normalized_error' ? normalizedError
    : rule.field === 'error' ? error
    : rule.field === 'tool' ? toolName
    : String(meta[rule.field] ?? '');

  if (rule.type === 'exact') return target === rule.pattern;
  if (rule.type === 'regex') {
    try { return new RegExp(rule.pattern, 'i').test(target); } catch { return false; }
  }
  if (rule.type === 'signal') return target.toLowerCase().includes(rule.pattern.toLowerCase());
  return false;
}

/**
 * Classify an error against known failure families.
 *
 * Strategy (per Codex/Gemini review):
 * 1. If family has structured `match` rules, use those (highest confidence)
 * 2. Fall back to symptom substring matching (lower confidence)
 * 3. Return best match above confidence threshold (0.4)
 */
export function classifyError(
  error: string,
  toolName: string,
  families: FailureFamily[],
  meta: Record<string, unknown> = {},
): ClassificationResult | null {
  const normalizedError = normalizeError(error);
  let bestMatch: ClassificationResult | null = null;

  for (const family of families) {
    // Strategy 1: Structured match rules (higher confidence)
    if (family.match && family.match.length > 0) {
      const matched = family.match.filter(r => matchRule(r, error, normalizedError, toolName, meta));
      if (matched.length > 0) {
        const confidence = 0.6 + (0.4 * matched.length / family.match.length);
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            family_id: family.id,
            family_name: family.name,
            confidence: Math.min(confidence, 1.0),
            matched_symptom: matched[0].pattern,
            recovery_id: family.recovery_id,
            ghost_eligible: family.ghost_eligible,
          };
        }
      }
    }

    // Strategy 2: Symptom substring matching (lower confidence)
    for (const symptom of family.symptoms) {
      if (typeof symptom !== 'string') continue;
      const symptomLower = symptom.toLowerCase();
      const errorLower = error.toLowerCase();
      const normalizedLower = normalizedError.toLowerCase();

      if (errorLower.includes(symptomLower) || normalizedLower.includes(symptomLower)) {
        const confidence = 0.5 + (symptomLower.length / Math.max(errorLower.length, 1)) * 0.3;
        if (!bestMatch || confidence > bestMatch.confidence) {
          bestMatch = {
            family_id: family.id,
            family_name: family.name,
            confidence: Math.min(confidence, 0.85),
            matched_symptom: symptom,
            recovery_id: family.recovery_id,
            ghost_eligible: family.ghost_eligible,
          };
        }
      }
    }
  }

  if (bestMatch && bestMatch.confidence >= 0.4) return bestMatch;
  return null;
}
