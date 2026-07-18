import type { ToolResult } from '../utils.js';

/**
 * GH #579: live data path for the observe UI Route/Store/Tree panels. The
 * panels used to render only past cdp_navigation_state / cdp_store_state /
 * cdp_component_tree tool events, so a healthy session in which the agent
 * never ran those tools showed empty panels forever — and nothing recovered
 * them after a CDP target replacement. buildStateRead adapts the same
 * withConnection-wrapped tool handlers the MCP tools use into a
 * kind → parsed-envelope reader: every call resolves the current client, so
 * the panels recover exactly like the tool path does.
 */
export const STATE_KINDS = ['route', 'store', 'tree'] as const;
export type StateKind = (typeof STATE_KINDS)[number];

export interface StateReadInput {
  /** Refuse reads while a flow runs — a UI poll must never interleave CDP
   * evaluates with maestro_run / cdp_run_action driving the device. */
  isFlowActive: () => boolean;
  handlers: Record<StateKind, () => Promise<ToolResult>>;
}

/** Parsed tool envelope ({ok:true,data,…} | {ok:false,error,…}), or null for
 * an unknown kind (the server maps null to 404). Never rejects. */
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
