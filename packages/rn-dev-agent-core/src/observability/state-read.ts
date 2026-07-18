import type { ToolResult } from '../utils.js';

// GH #579: kind → parsed-envelope reader for the observe UI panels; resolves the client per call so reads recover after target replacement like the tool path.
export const STATE_KINDS = ['route', 'store', 'tree'] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export interface StateReadInput {
  /** Refuse while a flow runs — a UI read must not interleave CDP evaluates with a driving flow. */
  isFlowActive: () => boolean;
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
    try {
      if (input.isFlowActive()) {
        return {
          ok: false,
          code: 'BUSY_FLOW_ACTIVE',
          error: 'a flow is running — live state read skipped',
        };
      }
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
    }
  };
}
