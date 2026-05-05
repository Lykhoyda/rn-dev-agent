// Issue #104 — pure parser for Maestro CLI / maestro-runner failure output.
//
// `maestro_run` returns the combined stdout+stderr in `data.output`. To
// auto-repair, we need to classify the failure and extract the failed
// selector. This module owns that classification — pure regex over the
// raw output text, no I/O, fully unit-testable.
//
// Maestro emits failures in a few canonical shapes (verified against
// Maestro 1.40+ output and maestro-runner 0.x):
//
//   - "Element with id 'X' not found"
//   - "Element with text 'X' not found"
//   - 'Assertion failed: "X" not visible'
//   - "Timed out waiting for element 'X'"
//   - "Element 'X' is not visible"  (assertion variant)
//
// The parser tries each known shape in order and returns the first
// match. If none match, returns `{ kind: 'UNKNOWN', raw }` so the caller
// can decide whether to surface it verbatim or escalate to the user.

export type MaestroFailure =
  | { kind: 'SELECTOR_NOT_FOUND'; selectorKind: 'id' | 'text' | 'unknown'; selector: string; raw: string }
  | { kind: 'TIMEOUT'; selector: string | null; raw: string }
  | { kind: 'ASSERTION_FAILED'; selector: string | null; raw: string }
  | { kind: 'UNKNOWN'; raw: string };

interface Pattern {
  re: RegExp;
  build: (m: RegExpExecArray, raw: string) => MaestroFailure;
}

// Order matters: more-specific patterns first.
const PATTERNS: Pattern[] = [
  {
    re: /Element with id ['"]([^'"]+)['"] (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: m[1], raw }),
  },
  {
    re: /Element with text ['"]([^'"]+)['"] (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'text', selector: m[1], raw }),
  },
  {
    re: /Element ['"]([^'"]+)['"] (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'unknown', selector: m[1], raw }),
  },
  {
    re: /Timed out waiting for element with id ['"]([^'"]+)['"]/i,
    build: (m, raw) => ({ kind: 'TIMEOUT', selector: m[1], raw }),
  },
  {
    re: /Timed out waiting for element ['"]([^'"]+)['"]/i,
    build: (m, raw) => ({ kind: 'TIMEOUT', selector: m[1], raw }),
  },
  {
    re: /Assertion failed: ['"]([^'"]+)['"] (?:is )?not visible/i,
    build: (m, raw) => ({ kind: 'ASSERTION_FAILED', selector: m[1], raw }),
  },
  {
    re: /Element ['"]([^'"]+)['"] is not visible/i,
    build: (m, raw) => ({ kind: 'ASSERTION_FAILED', selector: m[1], raw }),
  },
];

/**
 * Parse the full Maestro stdout+stderr text and classify the first
 * failure found. Returns `UNKNOWN` if nothing matches a known pattern.
 */
export function parseMaestroFailure(output: string): MaestroFailure {
  if (!output || typeof output !== 'string') {
    return { kind: 'UNKNOWN', raw: '' };
  }
  for (const { re, build } of PATTERNS) {
    const m = re.exec(output);
    if (m) return build(m, output);
  }
  return { kind: 'UNKNOWN', raw: output };
}

/**
 * Convenience predicate: is this a failure shape we know how to auto-
 * repair? Currently only `SELECTOR_NOT_FOUND` is in scope (per #104's
 * stated phase-1 contract).
 */
export function isAutoRepairable(failure: MaestroFailure): boolean {
  return failure.kind === 'SELECTOR_NOT_FOUND';
}
