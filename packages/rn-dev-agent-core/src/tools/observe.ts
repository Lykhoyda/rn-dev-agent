import { z } from 'zod';
import { okResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import { ObservabilityServer } from '../observability/server.js';
import type { E2eServerDeps, StateServerDeps } from '../observability/server.js';
import type { MirrorManager } from '../observability/mirror/manager.js';
import type { ObserveAuthority } from '../observability/server.js';
import { recorder } from '../observability/recorder.js';
import { resolveObservePort } from '../project-config.js';
import { writeObserveState, removeObserveState } from '../observability/observe-state.js';

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
let mirrorManager: MirrorManager | undefined;
let stateDeps: StateServerDeps | undefined;
let authorityDeps:
  | {
      resolve(): { port: number; authority: ObserveAuthority };
      bind(input: { port: number; authority: ObserveAuthority; autostarted: boolean }): void;
      unbind(authority: ObserveAuthority): void;
    }
  | undefined;

export function setObserveE2eDeps(d: E2eServerDeps): void {
  e2eDeps = d;
}

export function setObserveStateDeps(d: StateServerDeps): void {
  stateDeps = d;
}

export function setObserveMirror(m: MirrorManager): void {
  mirrorManager = m;
}

export function setObserveAuthorityDeps(deps: typeof authorityDeps): void {
  authorityDeps = deps;
}

let starting: Promise<{ url: string; port: number }> | null = null;
let boundAuthority: ObserveAuthority | null = null;

/**
 * Start (or return) the module-global observability server on the resolved
 * port (env RN_AGENT_OBSERVE_PORT > .rn-agent/config.json observe.port > 7333).
 * Exported as the autostart entry point so `observe status/stop` sees the
 * autostarted instance. Concurrent callers share one in-flight start, and
 * stopObserveServer awaits it, so a stop racing a pending start can never
 * orphan a listening server (PR #403 review).
 */
export async function startObserveServer(options: {
  autostarted?: boolean;
} = {}): Promise<{ url: string; port: number }> {
  if (starting) return starting;
  const autostarted = options.autostarted === true;
  starting = (async () => {
    const resolved = authorityDeps?.resolve();
    if (!server) {
      server = new ObservabilityServer(
        recorder,
        e2eDeps,
        mirrorManager,
        stateDeps,
        resolved?.authority,
        stopObserveServer,
      );
    }
    const port = resolved?.port ?? resolveObservePort().port;
    let bindAttempted = false;
    let stateWriteAttempted = false;
    try {
      const res = await server.start(port);
      if (resolved) {
        bindAttempted = true;
        authorityDeps?.bind({ port: res.port, authority: resolved.authority, autostarted });
        boundAuthority = resolved.authority;
      }
      stateWriteAttempted = true;
      writeObserveState(res.url, res.port);
      return res;
    } catch (error) {
      const failedServer = server;
      server = null;
      const cleanupErrors: unknown[] = [];
      try {
        await failedServer?.stop();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (bindAttempted && resolved) {
        try {
          authorityDeps?.unbind(resolved.authority);
          if (
            boundAuthority?.sessionId === resolved.authority.sessionId &&
            boundAuthority.claimEpoch === resolved.authority.claimEpoch &&
            boundAuthority.instanceId === resolved.authority.instanceId
          ) {
            boundAuthority = null;
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (stateWriteAttempted) {
        try {
          removeObserveState();
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `OBSERVE_START_ROLLBACK_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  })();
  try {
    return await starting;
  } catch (e) {
    starting = null;
    throw e;
  }
}

export async function stopObserveServer(): Promise<void> {
  if (starting) {
    try {
      await starting;
    } catch {
      /* start failed — nothing bound */
    }
  }
  starting = null;
  await server?.stop();
  server = null;
  // GH #776: a fenced caller (bind_device's Observe yield) reaches this stop
  // owner through the HTTP route, outside its operation's async context, so the
  // registry rejects the unbind and clears the binding itself. Local teardown
  // must still complete, and that rejection is not a shutdown failure.
  let unbindError: unknown;
  try {
    if (boundAuthority) authorityDeps?.unbind(boundAuthority);
  } catch (error) {
    unbindError = error;
  }
  boundAuthority = null;
  removeObserveState();
  if (
    unbindError !== undefined &&
    (unbindError as { code?: unknown } | null)?.code !== 'AUTHORITY_LOST_DURING_OPERATION'
  ) {
    throw unbindError;
  }
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
