import type { Step, Target } from './plan.js';
import {
  type Element,
  type Screen,
  soleLabelTextOf,
  labelAncestorsOf,
  actionView,
  forwardedInputOf,
} from './screen.js';

export type IdentityTag = 'native' | 'react-only' | 'wrapper';

export interface Identity {
  element: Element;
  tag: IdentityTag;
}

export const PRESSABLE_SUFFIX = '-pressable';
export const withoutPressable = (id: string): string =>
  id.endsWith(PRESSABLE_SUFFIX) ? id.slice(0, -PRESSABLE_SUFFIX.length) : id;

export function named(
  e: Element,
  quoted: string,
  kind: Step['kind'],
  exact?: Target['exact'],
): boolean {
  if (exact) return exact === 'id' ? e.testID === quoted : e.label === quoted;
  // A fill names a text-entry candidate, or any element carrying the target's testID.
  if (kind === 'fill')
    return (
      e.testID === quoted ||
      (e.kind === 'input' && (e.label === quoted || e.placeholder === quoted))
    );
  return e.label === quoted || e.testID === quoted;
}

function forwardsInput(element: Element, matched: readonly Element[]): boolean {
  const id = forwardedInputOf(element);
  if (!id) return false;
  const native = matched.filter((e) => !e.ref.startsWith('react:') && e.kind === 'input');
  return native.length === 1 && native[0].testID === id;
}

export function echoControl(element: Element): Element | undefined {
  const text = element.kind === 'text' ? element : soleLabelTextOf(element);
  const control = text && actionView({ elements: [...labelAncestorsOf(text)] })[0];
  return control !== element ? control : undefined;
}

// The wrapper `id-pressable` stands for `id` only while both ends are observed.
export function wrapperEquivalence(screen: Screen, id: string): Element | undefined {
  const wrappers = screen.elements.filter((e) => e.testID === id + PRESSABLE_SUFFIX);
  const inner =
    screen.elements.some((e) => e.testID === id) ||
    !!screen.reactHostEvidence?.hosts.some((host) => host.testID === id);
  return wrappers.length === 1 && inner ? wrappers[0] : undefined;
}

// The React focus identity a tapped element stands for, never an invented suffix.
export function focusIdentityOf(screen: Screen, element: Element): string | undefined {
  const id = element.testID;
  if (!id) return undefined;
  const base = withoutPressable(id);
  return base !== id && wrapperEquivalence(screen, base) === element ? base : id;
}

// Distinct identities an exact target names, counted before disabled, offscreen or React-only filters.
export function exactIdentities(screen: Screen, target: Target, kind: Step['kind']): Identity[] {
  const quoted = target.quoted;
  if (quoted === undefined) return [];
  const matched = screen.elements.filter((e) => named(e, quoted, kind, target.exact));
  return matched
    .filter((e) => {
      const control = echoControl(e);
      return (!control || !matched.includes(control)) && !forwardsInput(e, matched);
    })
    .map((element) => ({
      element,
      tag: element.ref.startsWith('react:')
        ? 'react-only'
        : element.testID !== undefined && focusIdentityOf(screen, element) !== element.testID
          ? 'wrapper'
          : 'native',
    }));
}
