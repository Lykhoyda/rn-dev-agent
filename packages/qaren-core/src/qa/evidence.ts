import { keyboardCoversElement, type Screen } from './screen.js';

export type LiteralVerdict = 'pass' | 'unsure' | 'fail';

export interface LiteralEvidence {
  verdict: LiteralVerdict;
  // The occurrence was a merged accessibility label, not painted text.
  label?: true;
}

export function literalTextProjection(screen: Screen): Screen {
  if (screen.keyboardVisible === false || screen.uncoveredText === undefined) return screen;
  return {
    ...screen,
    elements: screen.elements.filter((e) => !keyboardCoversElement(e)),
    visibleText: screen.uncoveredText,
    paintedText: screen.uncoveredText,
    labelText: screen.uncoveredLabelText,
  };
}

// One rule for literal checks, quoted waits, scroll-until and replay text waits.
export function literalEvidence(
  screen: Screen,
  text: string,
  match: 'contains' | 'equals',
): LiteralEvidence {
  const hit = (line: string) => (match === 'contains' ? line.includes(text) : line === text);
  const projected = literalTextProjection(screen);
  if (projected.visibleText.some(hit)) return { verdict: 'pass' };
  if (projected.labelText?.some(hit)) return { verdict: 'pass', label: true };
  if (screen.unresolvedText?.some(hit)) return { verdict: 'unsure' };
  // Absence is proven only by a complete native snapshot.
  return {
    verdict:
      (screen.captureCoverage?.native ?? screen.coverage?.native) === 'complete'
        ? 'fail'
        : 'unsure',
  };
}
