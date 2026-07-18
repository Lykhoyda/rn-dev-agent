import type { ToolResult } from '../utils.js';

export const STATE_KINDS = ['route', 'store', 'tree'] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export type StateReadGate = { ok: true; release: () => void } | { ok: false; code?: string };

export interface StateReadInput {
  /** Acquires the device lease; on ok the lease is held until release() after the read. */
  acquire: () => StateReadGate;
  handlers: Record<StateKind, () => Promise<ToolResult>>;
}

/** Returns the parsed tool envelope, or null for an unknown kind (mapped to 404). Never rejects. */
export type StateReadFn = (kind: string) => Promise<unknown | null>;

function isStateKind(kind: string): kind is StateKind {
  return (STATE_KINDS as readonly string[]).includes(kind);
}

export function buildStateRead(input: StateReadInput): StateReadFn {
  return async (kind: string): Promise<unknown | null> => {
    if (!isStateKind(kind)) return null;
    let gate: StateReadGate;
    try {
      gate = input.acquire();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.code ?? 'BUSY_FLOW_ACTIVE',
        error: 'device is busy — live state read skipped',
      };
    }
    try {
      const result = await input.handlers[kind]();
      const text = result?.content?.[0]?.text;
      if (typeof text !== 'string') return { ok: false, error: 'empty tool result' };
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: 'non-JSON tool result' };
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      try {
        gate.release();
      } catch {
        /* release is best-effort */
      }
    }
  };
}
