import { normalizeSteps, UnsupportedStepError } from './cdp-flow-replay.js';

export type IosProofDomain = 'react-tree' | 'xctest-native';

export interface IosProofSegment {
  domain: IosProofDomain;
  commands: unknown[];
  sourceIndices: number[];
  initialReactFocusId?: string;
}

export type IosProofPlan =
  | { ok: true; segments: IosProofSegment[] }
  | { ok: false; sourceIndex: number; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function containsExactId(value: unknown, depth = 0): boolean {
  if (depth > 20) return true;
  if (Array.isArray(value)) return value.some((child) => containsExactId(child, depth + 1));
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) =>
      (key === 'id' && typeof child === 'string') || containsExactId(child, depth + 1),
  );
}

function commandName(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!isObject(command)) return null;
  const keys = Object.keys(command);
  return keys.length === 1 ? keys[0]! : null;
}

function commandTreeContains(value: unknown, names: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 20) return false;
  if (Array.isArray(value)) {
    return value.some((child) => commandTreeContains(child, names, depth + 1));
  }
  if (!isObject(value)) return false;
  return Object.entries(value).some(
    ([key, child]) => names.has(key) || commandTreeContains(child, names, depth + 1),
  );
}

function exactTapId(command: unknown, params: Record<string, string>): string | null {
  try {
    const step = normalizeSteps([command], params)[0];
    return step?.t === 'tap' ? step.id : null;
  } catch (error) {
    if (error instanceof UnsupportedStepError) return null;
    throw error;
  }
}

function commandDomain(
  command: unknown,
  params: Record<string, string>,
): IosProofDomain | 'neutral' | 'mixed' {
  const name = commandName(command);
  if (name === 'waitForAnimationToEnd' || name === 'inputText') return 'neutral';
  try {
    normalizeSteps([command], params);
    return name === 'launchApp' ? 'neutral' : 'react-tree';
  } catch (error) {
    if (!(error instanceof UnsupportedStepError)) throw error;
    return containsExactId(command) ? 'mixed' : 'xctest-native';
  }
}

export function planIosProofDomains(
  commands: unknown[],
  params: Record<string, string>,
): IosProofPlan {
  const classified = commands.map((command) => commandDomain(command, params));
  for (let index = 0; index < classified.length; index++) {
    if (classified[index] === 'mixed') {
      return {
        ok: false,
        sourceIndex: index,
        reason:
          'one command mixes an exact testID with native-only semantics; split it into separate React-tree and XCTest commands',
      };
    }
  }

  const segments: IosProofSegment[] = [];
  let focusedDomain: IosProofDomain | null = null;
  let focusedReactId: string | null = null;
  const tapCommands = new Set(['tapOn']);
  const lifecycleCommands = new Set(['launchApp', 'clearState', 'killApp', 'stopApp']);
  for (let index = 0; index < commands.length; index++) {
    const name = commandName(commands[index]);
    let domain = classified[index];
    if (domain === 'neutral') {
      domain =
        (name === 'inputText' ? focusedDomain : null) ??
        segments.at(-1)?.domain ??
        classified.slice(index + 1).find((candidate) => candidate !== 'neutral') ??
        'react-tree';
    }
    if (domain === 'mixed') continue;
    const prior = segments.at(-1);
    if (prior?.domain === domain) {
      prior.commands.push(commands[index]);
      prior.sourceIndices.push(index);
    } else {
      segments.push({
        domain,
        commands: [commands[index]],
        sourceIndices: [index],
        ...(domain === 'react-tree' && focusedReactId
          ? { initialReactFocusId: focusedReactId }
          : {}),
      });
    }
    if (name === 'tapOn') {
      focusedDomain = domain;
      focusedReactId = domain === 'react-tree' ? exactTapId(commands[index], params) : null;
    } else if (commandTreeContains(commands[index], tapCommands)) {
      focusedDomain = domain;
      focusedReactId = null;
    } else if (commandTreeContains(commands[index], lifecycleCommands)) {
      focusedDomain = null;
      focusedReactId = null;
    }
  }
  return { ok: true, segments };
}

export interface NativeProofSelector {
  kind: 'text';
  value: string;
}

export function selectorsVisibleInNativeSnapshot(
  selectors: NativeProofSelector[],
  nodes: Array<{ label?: string; identifier?: string; hittable?: boolean }>,
): NativeProofSelector[] {
  return selectors.filter((selector) =>
    nodes.some(
      (node) =>
        node.hittable === true &&
        (node.label === selector.value || node.identifier === selector.value),
    ),
  );
}

export function nativeSelectorsForCommands(commands: unknown[]): NativeProofSelector[] {
  const selectors = new Set<string>();
  const addSelector = (value: unknown): void => {
    if (typeof value === 'string') {
      selectors.add(value);
      return;
    }
    if (isObject(value) && typeof value.text === 'string') selectors.add(value.text);
  };
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 20) return;
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!isObject(value)) return;
    for (const [childKey, child] of Object.entries(value)) {
      if (childKey === 'tapOn' || childKey === 'assertVisible') addSelector(child);
      if (childKey === 'extendedWaitUntil' && isObject(child)) addSelector(child.visible);
      if (childKey === 'scrollUntilVisible' && isObject(child)) addSelector(child.element);
      if (childKey === 'when' && isObject(child)) addSelector(child.visible);
      if (childKey !== 'assertNotVisible' && childKey !== 'notVisible') visit(child, depth + 1);
    }
  };
  visit(commands);
  return [...selectors].slice(0, 20).map((value) => ({ kind: 'text', value }));
}

export function loginPostconditionId(commands: unknown[]): string | null {
  const last = commands.at(-1);
  if (!isObject(last)) return null;
  const command = last.assertVisible ?? last.extendedWaitUntil;
  if (!isObject(command)) return null;
  const visible = 'visible' in command ? command.visible : command;
  return isObject(visible) && typeof visible.id === 'string' ? visible.id : null;
}
