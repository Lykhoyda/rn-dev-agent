import type { Check, Step, Target } from './plan.js';
import { type Element, type Screen, assertionView, describe } from './screen.js';

export type Resolution =
  | { ref: string; element: Element }
  | { scroll: 'down' | 'up' }
  | { refuse: string; reason: string };

// A fill target is an input; a press target is anything hittable. Labels, testIDs and (for inputs) placeholders match exactly.
function matches(e: Element, quoted: string, kind: Step['kind']): boolean {
  if (kind === 'fill') {
    return (
      e.kind === 'input' && (e.label === quoted || e.testID === quoted || e.placeholder === quoted)
    );
  }
  return e.label === quoted || e.testID === quoted;
}

// Quoted → exact unique hittable match; one off-screen hit → scroll; else refuse.
// Phrase targets and ambiguity arrive with Jev in a later phase.
export function resolveTarget(step: Step, screen: Screen): Resolution {
  const target: Target | undefined =
    step.kind === 'back' || step.kind === 'dialog'
      ? undefined
      : step.kind === 'scroll'
        ? step.until
        : step.target;
  if (!target) return { refuse: 'NO_TARGET', reason: 'this step has no target to resolve' };
  if (target.quoted === undefined) {
    return {
      refuse: 'PHRASE_TARGET_UNSUPPORTED',
      reason: `"${target.phrase}" is not quoted; phrase targets arrive with Jev in a later phase`,
    };
  }
  const quoted = target.quoted;
  const onscreen = screen.elements.filter(
    (e) => !e.offscreen && e.hittable && !e.disabled && matches(e, quoted, step.kind),
  );
  if (onscreen.length === 1) return { ref: onscreen[0].ref, element: onscreen[0] };
  if (onscreen.length > 1) {
    return {
      refuse: 'AMBIGUOUS_TARGET',
      reason: `${onscreen.length} elements match "${quoted}": ${onscreen.map(describe).join('; ')}`,
    };
  }
  const offscreen = screen.elements.filter((e) => e.offscreen && matches(e, quoted, step.kind));
  if (offscreen.length === 1) return { scroll: 'down' };
  if (offscreen.length > 1) {
    return {
      refuse: 'AMBIGUOUS_TARGET',
      reason: `${offscreen.length} off-screen elements match "${quoted}": ${offscreen.map(describe).join('; ')}`,
    };
  }
  const unhittable = screen.elements.find((e) => !e.offscreen && matches(e, quoted, step.kind));
  return {
    refuse: 'TARGET_NOT_FOUND',
    reason: unhittable
      ? `"${quoted}" is on screen but not hittable: ${describe(unhittable)}`
      : `no element labelled or identified "${quoted}" is on screen`,
  };
}

// Wait and scroll targets are elements: an exact label or testID on screen, or an exact visible text entry.
export function targetVisible(target: Target, screen: Screen): boolean {
  if (target.quoted === undefined) return false;
  const quoted = target.quoted;
  return (
    screen.elements.some((e) => !e.offscreen && (e.label === quoted || e.testID === quoted)) ||
    assertionView(screen).some((t) => t === quoted)
  );
}

// literal → the quoted phrase is in the assertion view, no model; phrase → unsure until Jev.
export function judgeCheck(check: Check, screen: Screen): 'pass' | 'fail' | 'unsure' {
  if (!check.literal) return 'unsure';
  return assertionView(screen).some((t) => t.includes(check.text)) ? 'pass' : 'fail';
}
