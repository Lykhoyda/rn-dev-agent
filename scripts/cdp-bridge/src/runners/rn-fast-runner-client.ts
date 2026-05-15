import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';
import { getFastRunnerState } from '../fast-runner-session.js';

export interface RunIOSArgs {
  command:
    | 'snapshot'
    | 'tap'
    | 'swipe'
    | 'type'
    | 'dismissKeyboard'
    | 'screenshot'
    | 'back'
    | 'scroll'
    | 'pressHome'
    | 'appState'
    | 'activate'
    | 'terminate';
  bundleId?: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  text?: string;
  durationMs?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  interactiveOnly?: boolean;
  compact?: boolean;
  depth?: number;
  scope?: string;
}

interface RunnerResponse {
  ok: boolean;
  data?: unknown;
  error?: { message: string; code?: string };
}

let fetchImpl: typeof fetch = globalThis.fetch;

export function _setFetchForTest(fn: typeof fetch): void {
  fetchImpl = fn;
}

async function postCommand(body: object): Promise<RunnerResponse> {
  const state = getFastRunnerState();
  if (!state) {
    throw new Error('rn-fast-runner not started — open a device session first');
  }
  const resp = await fetchImpl(`http://127.0.0.1:${state.port}/command`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp.json() as Promise<RunnerResponse>;
}

export async function runIOS(args: RunIOSArgs): Promise<ToolResult> {
  const body: Record<string, unknown> = { command: args.command };
  if (args.bundleId) body.appBundleId = args.bundleId;
  if (args.x !== undefined) body.x = args.x;
  if (args.y !== undefined) body.y = args.y;
  if (args.x1 !== undefined) body.x1 = args.x1;
  if (args.y1 !== undefined) body.y1 = args.y1;
  if (args.x2 !== undefined) body.x2 = args.x2;
  if (args.y2 !== undefined) body.y2 = args.y2;
  if (args.text !== undefined) body.text = args.text;
  if (args.durationMs !== undefined) body.durationMs = args.durationMs;
  if (args.direction !== undefined) body.direction = args.direction;
  if (args.interactiveOnly !== undefined) body.interactiveOnly = args.interactiveOnly;
  if (args.compact !== undefined) body.compact = args.compact;
  if (args.depth !== undefined) body.depth = args.depth;
  if (args.scope !== undefined) body.scope = args.scope;

  const resp = await postCommand(body);
  if (!resp.ok) {
    const message = resp.error?.message ?? 'runner returned !ok with no error';
    const code = resp.error?.code;
    if (code) {
      return failResult(message, code as Parameters<typeof failResult>[1]);
    }
    return failResult(message);
  }
  return okResult(resp.data ?? {});
}
