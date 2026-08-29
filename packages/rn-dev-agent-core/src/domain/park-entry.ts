// GH #628 — parked-entry invariants (single owner): a parked body bans app
// lifecycle transitions and must be fully inspectable; replay verifies the
// park anchor read-only before any step (run-action owns the probe).

import type { ActionEntryMode, M7Metadata } from './reusable-action.js';

export const PARKED_FORBIDDEN_COMMANDS = new Set(['launchApp', 'stopApp', 'killApp', 'clearState']);

/** Approved cause payload values for PARK_STATE_MISSING (captain decision C). */
export type ParkRefusalCause = 'anchor-missing' | 'route-mismatch' | 'app-backgrounded';

export type EntryModeResolution = { ok: true; mode: ActionEntryMode } | { ok: false; raw: string };

/** Absent means cold; an unknown declared value is refused, never downgraded. */
export function resolveEntryMode(metadata: Pick<M7Metadata, 'entry'>): EntryModeResolution {
  const raw = metadata.entry;
  if (raw === undefined) return { ok: true, mode: 'cold' };
  if (raw === 'cold' || raw === 'parked') return { ok: true, mode: raw };
  return { ok: false, raw: String(raw) };
}

function commandName(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const keys = Object.keys(command as Record<string, unknown>);
  return keys.length === 1 ? keys[0]! : null;
}

type CompositeShape =
  | { kind: 'inline'; name: string; commands: unknown[]; conditional: boolean }
  | { kind: 'file'; reference: string }
  | null;

// Any single-key command nesting a `commands` array is a traversable
// composite (runFlow, repeat, retry, …); only runFlow can reference an
// external file, which hides its command graph and must fail closed.
function compositeShape(command: unknown): CompositeShape {
  const name = commandName(command);
  if (name === null || typeof command === 'string') return null;
  const value = (command as Record<string, unknown>)[name];
  if (name === 'runFlow') {
    if (typeof value === 'string') return { kind: 'file', reference: value };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'file', reference: String(value) };
    }
    const record = value as Record<string, unknown>;
    if (typeof record.file === 'string') return { kind: 'file', reference: record.file };
    return {
      kind: 'inline',
      name,
      commands: Array.isArray(record.commands) ? record.commands : [],
      conditional: record.when !== undefined,
    };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.commands)) return null;
  return {
    kind: 'inline',
    name,
    commands: record.commands,
    conditional: record.when !== undefined,
  };
}

export type ParkedBodyViolation =
  | { kind: 'lifecycle'; command: string }
  | { kind: 'runflow-file'; reference: string };

/**
 * First rule-1/rule-2 violation in a parked body (inline subflows included,
 * execution order), or null when the body is clean and fully inspectable.
 */
export function parkedBodyViolation(commands: readonly unknown[]): ParkedBodyViolation | null {
  for (const command of commands) {
    const name = commandName(command);
    if (name !== null && PARKED_FORBIDDEN_COMMANDS.has(name)) {
      return { kind: 'lifecycle', command: name };
    }
    const composite = compositeShape(command);
    if (composite?.kind === 'file') return { kind: 'runflow-file', reference: composite.reference };
    if (composite?.kind === 'inline') {
      const nested = parkedBodyViolation(composite.commands);
      if (nested !== null) return nested;
    }
  }
  return null;
}

const ANCHOR_COMMANDS = new Set(['assertVisible', 'extendedWaitUntil', 'tapOn']);

function anchorIdOf(name: string, value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (name === 'extendedWaitUntil') {
    const visible = record.visible;
    return visible && typeof visible === 'object' && !Array.isArray(visible)
      ? anchorIdOf('assertVisible', visible)
      : null;
  }
  return typeof record.id === 'string' && record.id.length > 0 ? record.id : null;
}

function substituteParams(id: string, params: Record<string, string>): string {
  return id.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, key: string) => params[key] ?? whole);
}

export type ParkAnchorResolution =
  | { ok: true; anchorId: string }
  | { ok: false; reason: string; unresolvedParam?: true };

function firstAnchorId(commands: readonly unknown[]): string | null {
  for (const command of commands) {
    const name = commandName(command);
    if (name !== null && ANCHOR_COMMANDS.has(name)) {
      const id = anchorIdOf(name, (command as Record<string, unknown>)[name]);
      if (id !== null) return id;
      continue;
    }
    const composite = compositeShape(command);
    // Only an unconditional inline runFlow can supply the park anchor — a
    // conditional or repeating composite may not run first (or at all).
    if (composite?.kind === 'inline' && composite.name === 'runFlow' && !composite.conditional) {
      const nested = firstAnchorId(composite.commands);
      if (nested !== null) return nested;
    }
  }
  return null;
}

/**
 * The park anchor is the first assertVisible / extendedWaitUntil / tapOn id in
 * execution order — the screen evidence the action itself relies on. Text-only
 * selectors cannot be probed through the React-tree oracle, so an action
 * without an id-bearing opening command refuses rather than guesses.
 */
export function deriveParkAnchor(
  commands: readonly unknown[],
  params: Record<string, string> = {},
): ParkAnchorResolution {
  const id = firstAnchorId(commands);
  if (id === null) {
    return {
      ok: false,
      reason: 'no id-bearing assertVisible/extendedWaitUntil/tapOn opens the body',
    };
  }
  const substituted = substituteParams(id, params);
  if (/\$\{[A-Z_][A-Z0-9_]*\}/.test(substituted)) {
    return {
      ok: false,
      reason: `park anchor "${id}" references a parameter with no supplied value`,
      unresolvedParam: true,
    };
  }
  return { ok: true, anchorId: substituted };
}
