// GH #628 — parked-entry invariants (single owner): a parked body bans app
// lifecycle transitions and must be fully inspectable; replay verifies the
// park anchor read-only before any step (run-action owns the probe).

import yaml from 'yaml';
import { detectEntryDeclaration } from './reusable-action.js';
import type { ActionEntryMode, M7Metadata } from './reusable-action.js';
import { renderRunFlowFileReference } from './maestro-validator.js';

export const PARKED_FORBIDDEN_COMMANDS = new Set(['launchApp', 'stopApp', 'killApp', 'clearState']);

/** Approved cause payload values for PARK_STATE_MISSING (captain decision C). */
export type ParkRefusalCause = 'anchor-missing' | 'route-mismatch' | 'app-backgrounded';

export type EntryModeResolution = { ok: true; mode: ActionEntryMode } | { ok: false; raw: string };

export type LearnedActionEntryCause =
  | { invalidEntry: string }
  | { parkedActionLifecycle: string }
  | { parkedRunFlowFile: string };

export type LearnedActionBodyInspection =
  | { commands: readonly unknown[] }
  | { runFlowFile: string }
  | null;

export type LearnedActionEntryRefusal =
  | { kind: 'invalid-entry'; raw: string; message: string; cause: LearnedActionEntryCause }
  | { kind: 'parked-body'; message: string; cause: LearnedActionEntryCause }
  | { kind: 'park-preflight-required'; message: string };

export interface LearnedActionAdmissionArgs {
  /** Original artifact text; bounded preamble entry detection on it is authoritative. */
  rawYaml: string;
  parkPreflightPassed: boolean;
  inspectBody: () => LearnedActionBodyInspection;
}

/**
 * GH #628 structural admission — the ONE identity-independent decision point
 * for entry declarations. Detection is bounded to the pre-body preamble, so a
 * partial header (entry without id/intent) still admits and body text never
 * can; metadata is never a source of entry here.
 */
export function learnedActionAdmissionRefusal(
  args: LearnedActionAdmissionArgs,
): LearnedActionEntryRefusal | null {
  const entry = detectEntryDeclaration(args.rawYaml) as M7Metadata['entry'];
  const resolved = resolveEntryMode({ entry });
  if (resolved.ok && resolved.mode === 'parked') {
    const violation = rawParkedBodyViolation(args.rawYaml);
    if (violation !== null) return parkedBodyRefusal(violation);
  }
  return learnedActionEntryRefusal({ entry }, args.parkPreflightPassed, args.inspectBody);
}

/** GH #628: the admission-authoritative entry mode for an original artifact text. */
export function declaredEntryMode(yamlText: string): EntryModeResolution {
  return resolveEntryMode({ entry: detectEntryDeclaration(yamlText) as M7Metadata['entry'] });
}

/** Absent means cold; an unknown declared value is refused, never downgraded. */
function resolveEntryMode(metadata: Pick<M7Metadata, 'entry'>): EntryModeResolution {
  const raw = metadata.entry;
  if (raw === undefined) return { ok: true, mode: 'cold' };
  if (raw === 'cold' || raw === 'parked') return { ok: true, mode: raw };
  return { ok: false, raw: String(raw) };
}

function learnedActionEntryRefusal(
  metadata: Pick<M7Metadata, 'entry'>,
  parkPreflightPassed: boolean,
  inspectBody: () => LearnedActionBodyInspection,
): LearnedActionEntryRefusal | null {
  const entry = resolveEntryMode(metadata);
  if (!entry.ok) {
    return {
      kind: 'invalid-entry',
      raw: entry.raw,
      message: `Learned action declares unknown entry mode "${entry.raw}" — use "cold" or "parked".`,
      cause: { invalidEntry: entry.raw },
    };
  }
  if (entry.mode === 'parked') {
    const inspection = inspectBody() ?? null;
    if (inspection === null && parkPreflightPassed) {
      return {
        kind: 'park-preflight-required',
        message:
          'Learned action declares entry: parked but its body could not be inspected for the parked contract; refusing fail-closed.',
      };
    }
    const violation =
      inspection && 'commands' in inspection
        ? parkedBodyViolation(inspection.commands)
        : inspection && 'runFlowFile' in inspection
          ? { kind: 'runflow-file' as const, reference: inspection.runFlowFile }
          : null;
    if (violation) return parkedBodyRefusal(violation);
  }
  if (entry.mode === 'parked' && !parkPreflightPassed) {
    return {
      kind: 'park-preflight-required',
      message:
        'Learned action declares entry: parked and requires the read-only park preflight; replay it through cdp_run_action.',
    };
  }
  return null;
}

function parkedBodyRefusal(violation: ParkedBodyViolation): LearnedActionEntryRefusal {
  if (violation.kind === 'lifecycle') {
    return {
      kind: 'parked-body',
      message: `Learned action declares entry: parked but its body contains forbidden lifecycle command "${violation.command}".`,
      cause: { parkedActionLifecycle: violation.command },
    };
  }
  const reference = violation.reference.length > 0 ? violation.reference : '<empty>';
  return {
    kind: 'parked-body',
    message: `Learned action declares entry: parked but its body contains uninspectable runFlow file reference "${reference}".`,
    cause: { parkedRunFlowFile: reference },
  };
}

function commandName(command: unknown): string | null {
  if (typeof command === 'string') return command;
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const keys = Object.keys(command as Record<string, unknown>);
  return keys.length === 1 ? keys[0]! : null;
}

function forbiddenLifecycleCommand(command: unknown): string | null {
  if (typeof command === 'string') {
    return PARKED_FORBIDDEN_COMMANDS.has(command) ? command : null;
  }
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  return (
    Object.keys(command as Record<string, unknown>).find((key) =>
      PARKED_FORBIDDEN_COMMANDS.has(key),
    ) ?? null
  );
}

type CompositeShape =
  | {
      kind: 'inline';
      name: string;
      commands: unknown[];
      conditional: boolean;
      fileReference?: string;
    }
  | { kind: 'file'; reference: string; refuseBeforeLoad: boolean }
  | null;

function compositeShape(command: unknown): CompositeShape {
  if (!command || typeof command !== 'object' || Array.isArray(command)) return null;
  const commandRecord = command as Record<string, unknown>;
  const keys = Object.keys(commandRecord);
  if (Object.prototype.hasOwnProperty.call(commandRecord, 'runFlow')) {
    const value = commandRecord.runFlow;
    const refuseBeforeLoad = keys.length !== 1;
    if (typeof value === 'string') {
      return { kind: 'file', reference: renderRunFlowFileReference(value), refuseBeforeLoad };
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { kind: 'file', reference: renderRunFlowFileReference(value), refuseBeforeLoad };
    }
    const record = value as Record<string, unknown>;
    const commands = Array.isArray(record.commands) ? record.commands : null;
    const hasFile = Object.prototype.hasOwnProperty.call(record, 'file');
    if (commands !== null) {
      return {
        kind: 'inline',
        name: 'runFlow',
        commands,
        conditional: record.when !== undefined,
        ...(hasFile ? { fileReference: renderRunFlowFileReference(record.file) } : {}),
      };
    }
    return {
      kind: 'file',
      reference: renderRunFlowFileReference(hasFile ? record.file : '<malformed runFlow>'),
      refuseBeforeLoad,
    };
  }
  const name = commandName(command);
  if (name === null) return null;
  const value = commandRecord[name];
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

type ParkedBodyScanResult =
  | ParkedBodyViolation
  | { kind: 'deferred-runflow-file'; reference: string }
  | null;

function scanParkedBody(
  commands: readonly unknown[],
  deferInspectableFiles: boolean,
): ParkedBodyScanResult {
  for (const command of commands) {
    const lifecycle = forbiddenLifecycleCommand(command);
    if (lifecycle !== null) {
      return { kind: 'lifecycle', command: lifecycle };
    }
    const composite = compositeShape(command);
    if (composite?.kind === 'file') {
      return deferInspectableFiles && !composite.refuseBeforeLoad
        ? { kind: 'deferred-runflow-file', reference: composite.reference }
        : { kind: 'runflow-file', reference: composite.reference };
    }
    if (composite?.kind === 'inline') {
      const nested = scanParkedBody(composite.commands, deferInspectableFiles);
      if (nested !== null && nested.kind !== 'deferred-runflow-file') return nested;
      if (composite.fileReference !== undefined) {
        return { kind: 'runflow-file', reference: composite.fileReference };
      }
      if (nested !== null) return nested;
    }
  }
  return null;
}

function rawParkedBodyViolation(rawYaml: string): ParkedBodyViolation | null {
  try {
    const body = yaml.parseAllDocuments(rawYaml, { strict: true }).at(-1)?.toJS();
    if (!Array.isArray(body)) return null;
    const violation = scanParkedBody(body, true);
    return violation?.kind === 'deferred-runflow-file' ? null : violation;
  } catch {
    return null;
  }
}

/**
 * First rule-1/rule-2 violation in a parked body (inline subflows included,
 * execution order), or null when the body is clean and fully inspectable.
 */
export function parkedBodyViolation(commands: readonly unknown[]): ParkedBodyViolation | null {
  const violation = scanParkedBody(commands, false);
  return violation?.kind === 'deferred-runflow-file'
    ? { kind: 'runflow-file', reference: violation.reference }
    : violation;
}

const ANCHOR_COMMANDS = new Set(['assertVisible', 'extendedWaitUntil', 'tapOn']);
const PARKED_READ_ONLY_COMMANDS = new Set([
  'assertVisible',
  'assertNotVisible',
  'extendedWaitUntil',
  'waitForAnimationToEnd',
]);

export function parkedCommandMayMutate(command: unknown): boolean {
  const name = commandName(command);
  const composite = compositeShape(command);
  if (composite?.kind === 'file') return true;
  if (composite?.kind === 'inline') {
    if (composite.fileReference !== undefined) return true;
    return composite.commands.some((nested) => parkedCommandMayMutate(nested));
  }
  return name === null || !PARKED_READ_ONLY_COMMANDS.has(name);
}

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

type AnchorSearchResult =
  | { kind: 'anchor'; id: string }
  | { kind: 'continue' }
  | { kind: 'blocked' };

function firstAnchorId(
  commands: readonly unknown[],
  canSupplyAnchor: boolean = true,
): AnchorSearchResult {
  for (const command of commands) {
    const name = commandName(command);
    if (name !== null && ANCHOR_COMMANDS.has(name)) {
      const id = anchorIdOf(name, (command as Record<string, unknown>)[name]);
      if (id !== null && canSupplyAnchor) return { kind: 'anchor', id };
      if (name === 'tapOn') return { kind: 'blocked' };
      continue;
    }
    const composite = compositeShape(command);
    if (composite?.kind === 'inline') {
      if (composite.fileReference !== undefined) return { kind: 'blocked' };
      const suppliesAnchor =
        canSupplyAnchor && composite.name === 'runFlow' && !composite.conditional;
      const nested = firstAnchorId(composite.commands, suppliesAnchor);
      if (nested.kind !== 'continue') return nested;
      continue;
    }
    if (name !== null && PARKED_READ_ONLY_COMMANDS.has(name)) continue;
    return { kind: 'blocked' };
  }
  return { kind: 'continue' };
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
  const anchor = firstAnchorId(commands);
  if (anchor.kind !== 'anchor') {
    return {
      ok: false,
      reason: 'no id-bearing assertVisible/extendedWaitUntil/tapOn opens the body',
    };
  }
  const id = anchor.id;
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
