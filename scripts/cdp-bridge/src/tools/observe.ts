import { z } from 'zod';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { ObservabilityServer } from '../observability/server.js';
import type { E2eServerDeps } from '../observability/server.js';
import { recorder } from '../observability/recorder.js';
import { resolveObservePort } from '../project-config.js';

// Back-compat alias: parsePinnedPort predates the shared resolver (spec
// 2026-07-02); the validation now lives in project-config.parsePort.
export { parsePort as parsePinnedPort } from '../project-config.js';

export const observeSchema = {
  action: z
    .enum(['start', 'stop', 'restart', 'status'])
    .default('status')
    .describe(
      'start = launch the web UI and return its URL; stop = tear it down for the rest of the session; restart = stop then start fresh (keeps the event timeline); status = report whether it is running',
    ),
};

export interface ObserveArgs {
  action?: 'start' | 'stop' | 'restart' | 'status';
}

let server: ObservabilityServer | null = null;
let e2eDeps: E2eServerDeps | undefined;

export function setObserveE2eDeps(d: E2eServerDeps): void {
  e2eDeps = d;
}

/**
 * Start (or return) the module-global observability server on the resolved
 * port (env RN_AGENT_OBSERVE_PORT > .rn-agent/config.json observe.port > 7333).
 * Exported as the autostart entry point so `observe status/stop` sees the
 * autostarted instance.
 */
export async function startObserveServer(): Promise<{ url: string; port: number }> {
  if (!server) server = new ObservabilityServer(recorder, e2eDeps);
  const { port } = resolveObservePort();
  return server.start(port);
}

async function stopObserveServer(): Promise<void> {
  await server?.stop();
  server = null;
}

export async function observeHandler(args: ObserveArgs): Promise<ToolResult> {
  const action = args.action ?? 'status';
  try {
    if (action === 'start' || action === 'restart') {
      if (action === 'restart') await stopObserveServer();
      const { url, port } = await startObserveServer();
      return okResult({ url, port, running: true, hint: `Open ${url} to watch the agent live.` });
    }
    if (action === 'stop') {
      await stopObserveServer();
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
