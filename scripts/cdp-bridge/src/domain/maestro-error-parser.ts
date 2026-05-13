// Issue #104 — pure parser for Maestro CLI / maestro-runner failure output.
//
// `maestro_run` returns the combined stdout+stderr in `data.output`. To
// auto-repair, we need to classify the failure and extract the failed
// selector. This module owns that classification — pure regex over the
// raw output text, no I/O, fully unit-testable.
//
// Maestro emits failures in a few canonical shapes (verified against
// Maestro 1.40+ output, maestro-runner 0.x, and maestro-runner 1.0.9):
//
//   - "Element with id 'X' not found"
//   - "Element with text 'X' not found"
//   - 'Assertion failed: "X" not visible'
//   - "Timed out waiting for element 'X'"
//   - "Element 'X' is not visible"  (assertion variant)
//   - "Element not found: id='X'"   (maestro-runner 1.0.x shape — issue #105)
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
//
// Matched-quote pattern `(['"])((?:(?!\1).)+)\1` captures a testID
// surrounded by quotes (single OR double) AND allows the OPPOSITE quote
// inside the captured value. Multi-LLM review of PR #115 caught that
// the prior `[^'"]+` capture broke on testIDs like "user's-tasks" or
// `say-"hi"` — Maestro outputs the literal id verbatim, and React
// Native testIDs are not constrained to kebab-case ASCII. The new
// pattern uses a back-reference to require the same opening + closing
// quote, with `(?!\1).` allowing every character that isn't the
// matching closer.
//
// Group 1 = the quote character (consumed but unused);
// Group 2 = the actual selector value.
const PATTERNS: Pattern[] = [
  {
    re: /Element with id (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: m[2], raw }),
  },
  {
    re: /Element with text (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'text', selector: m[2], raw }),
  },
  // maestro-runner 1.0.x shape — issue #105.
  // "Element not found: id='X'" or "Element not found: text='X'".
  {
    re: /Element not found:\s*id=(['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'id', selector: m[2], raw }),
  },
  {
    re: /Element not found:\s*text=(['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'text', selector: m[2], raw }),
  },
  {
    re: /Element (['"])((?:(?!\1).)+)\1 (?:was )?not found/i,
    build: (m, raw) => ({ kind: 'SELECTOR_NOT_FOUND', selectorKind: 'unknown', selector: m[2], raw }),
  },
  {
    re: /Timed out waiting for element with id (['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'TIMEOUT', selector: m[2], raw }),
  },
  {
    re: /Timed out waiting for element (['"])((?:(?!\1).)+)\1/i,
    build: (m, raw) => ({ kind: 'TIMEOUT', selector: m[2], raw }),
  },
  {
    re: /Assertion failed: (['"])((?:(?!\1).)+)\1 (?:is )?not visible/i,
    build: (m, raw) => ({ kind: 'ASSERTION_FAILED', selector: m[2], raw }),
  },
  {
    re: /Element (['"])((?:(?!\1).)+)\1 is not visible/i,
    build: (m, raw) => ({ kind: 'ASSERTION_FAILED', selector: m[2], raw }),
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
