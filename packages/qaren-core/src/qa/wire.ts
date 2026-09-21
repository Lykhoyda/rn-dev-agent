import { StringDecoder } from 'node:string_decoder';
import type { Ledger, LedgerRow } from './ledger.js';
import { ledgerWithoutResult } from './ledger.js';

export const WIRE_VERSION = 1 as const;

export type EnvelopeType = 'request' | 'row' | 'result' | 'cancel';

export interface Envelope<T = unknown> {
  v: typeof WIRE_VERSION;
  runId: string;
  seq: number;
  type: EnvelopeType;
  payload: T;
}

export interface WireTarget {
  deviceId: string;
  metroPort: number;
  metroUrlForDevice: string;
  worktree: string;
  adb?: { serverSocket?: string; serial: string };
}

export interface WireRequest {
  runId: string;
  t0: number;
  plan: string;
  platform: 'ios' | 'android';
  appId: string;
  runDir: string;
  lease: string;
  target: WireTarget;
}

export interface Refusal {
  verdict: 'REFUSED';
  code: string;
  message: string;
  lease: string;
}

export type ResultPayload = Ledger | Refusal;

export class WireError extends Error {}

// The result line and the exit code must agree: 0 PASS, 1 FAIL, 4 typed refusal.
export function exitCodeFor(result: ResultPayload): 0 | 1 | 4 {
  switch (result.verdict) {
    case 'PASS':
      return 0;
    case 'FAIL':
      return 1;
    default:
      return 4;
  }
}

export function verdictAgrees(verdict: string, exit: number): boolean {
  return (
    (verdict === 'PASS' && exit === 0) ||
    (verdict === 'FAIL' && exit === 1) ||
    (verdict === 'REFUSED' && exit === 4)
  );
}

// The first row the child writes, so a child that dies later always has a last row.
export const STARTUP_ROW_FIELDS = [
  'block',
  'line',
  'attempt',
  'kind',
  'resolvedBy',
  't',
  'outcome',
] as const;

export function startupRow(): LedgerRow {
  return {
    block: '',
    line: 0,
    text: 'startup',
    attempt: 1,
    kind: 'step',
    resolvedBy: 'exact',
    t: 0,
    outcome: 'pass',
  };
}

const TYPES: ReadonlySet<string> = new Set(['request', 'row', 'result', 'cancel']);

export function parseEnvelope(line: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const e = value as Record<string, unknown>;
  if (
    e.v !== WIRE_VERSION ||
    typeof e.runId !== 'string' ||
    typeof e.seq !== 'number' ||
    typeof e.type !== 'string' ||
    !TYPES.has(e.type) ||
    e.payload === undefined
  ) {
    return null;
  }
  return e as unknown as Envelope;
}

export function parseRequest(line: string): WireRequest {
  const envelope = parseEnvelope(line);
  if (!envelope) throw new WireError('the first stdin line is not a v1 wire envelope');
  if (envelope.type !== 'request')
    throw new WireError(`expected a request envelope, got ${envelope.type}`);
  if (envelope.seq !== 1) throw new WireError('the request must be seq 1');
  const p = envelope.payload as Partial<WireRequest> | null;
  const target = p?.target as Partial<WireTarget> | undefined;
  const adb = target?.adb as Partial<NonNullable<WireTarget['adb']>> | undefined;
  const bad =
    !p ||
    typeof p.runId !== 'string' ||
    !p.runId ||
    !Number.isSafeInteger(p.t0) ||
    typeof p.plan !== 'string' ||
    (p.platform !== 'ios' && p.platform !== 'android') ||
    typeof p.appId !== 'string' ||
    typeof p.runDir !== 'string' ||
    typeof p.lease !== 'string' ||
    !target ||
    typeof target.deviceId !== 'string' ||
    !Number.isInteger(target.metroPort) ||
    (target.metroPort as number) < 1 ||
    (target.metroPort as number) > 65535 ||
    typeof target.metroUrlForDevice !== 'string' ||
    typeof target.worktree !== 'string' ||
    (adb !== undefined &&
      (typeof adb !== 'object' ||
        adb === null ||
        typeof adb.serial !== 'string' ||
        (adb.serverSocket !== undefined && typeof adb.serverSocket !== 'string')));
  if (bad) throw new WireError('the request payload is missing required fields');
  if (p.runId !== envelope.runId) throw new WireError('the request payload names another run');
  return p as WireRequest;
}

export async function readRequest(input: AsyncIterable<Buffer | string>): Promise<WireRequest> {
  const decoder = new StringDecoder('utf8');
  let buffered = '';
  for await (const chunk of input) {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    const newline = buffered.indexOf('\n');
    if (newline >= 0) return parseRequest(buffered.slice(0, newline).trim());
  }
  const line = (buffered + decoder.end()).trim();
  if (!line) throw new WireError('stdin closed before a request arrived');
  return parseRequest(line);
}

export interface WireWriter {
  row(payload: LedgerRow): void;
  result(payload: ResultPayload): 0 | 1 | 4;
  readonly seq: number;
}

// seq 1 is the request the CLI wrote; everything the child writes counts up from 2.
export function createWriter(write: (line: string) => void, runId: string): WireWriter {
  let seq = 1;
  let closed = false;
  const send = (type: EnvelopeType, payload: unknown): void => {
    if (closed) throw new WireError('the result line was already written; nothing may follow it');
    seq += 1;
    const envelope: Envelope = { v: WIRE_VERSION, runId, seq, type, payload };
    write(`${JSON.stringify(envelope)}\n`);
  };
  return {
    row: (payload) => send('row', payload),
    result: (payload) => {
      send('result', payload);
      closed = true;
      return exitCodeFor(payload);
    },
    get seq() {
      return seq;
    },
  };
}

export function missingResult(rows: LedgerRow[], seen: string): Ledger {
  return ledgerWithoutResult(rows, seen);
}
