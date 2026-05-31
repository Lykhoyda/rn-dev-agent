import { z } from 'zod';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { ObservabilityServer } from '../observability/server.js';
import { recorder } from '../observability/recorder.js';

export const observeSchema = {
  action: z.enum(['start', 'stop', 'status']).default('status')
    .describe('start = launch the web UI and return its URL; stop = tear it down; status = report whether it is running'),
};

export interface ObserveArgs {
  action?: 'start' | 'stop' | 'status';
}

let server: ObservabilityServer | null = null;

export async function observeHandler(args: ObserveArgs): Promise<ToolResult> {
  const action = args.action ?? 'status';
  try {
    if (action === 'start') {
      if (!server) server = new ObservabilityServer(recorder);
      const pinned = process.env.RN_AGENT_OBSERVE_PORT ? Number(process.env.RN_AGENT_OBSERVE_PORT) : undefined;
      const { url, port } = await server.start(pinned);
      return okResult({ url, port, running: true, hint: `Open ${url} to watch the agent live.` });
    }
    if (action === 'stop') {
      await server?.stop();
      server = null;
      return okResult({ running: false });
    }
    if (server) {
      const { url, port } = await server.start();
      return okResult({ running: true, url, port });
    }
    return okResult({ running: false });
  } catch (e) {
    return failResult(e instanceof Error ? e.message : String(e));
  }
}
