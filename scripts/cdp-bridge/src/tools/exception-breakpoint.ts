import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';

export function createExceptionBreakpointHandler(getClient: () => CDPClient) {
  return withConnection(
    getClient,
    async (args: { state: 'none' | 'uncaught' | 'all'; durationMs?: number }, client) => {
      const state = args.state ?? 'uncaught';
      const duration = args.durationMs
        ? Math.min(Math.max(args.durationMs, 1000), 30000)
        : undefined;

      const savedHandler = client['eventHandlers'].get('Debugger.paused');

      try {
        await client.send('Debugger.setPauseOnExceptions', { state });

        if (!duration) {
          return okResult({
            state,
            message: `Exception breakpoint set to "${state}". Call again with state="none" to disable.`,
          });
        }

        const caught: Array<{
          message: string;
          url?: string;
          line?: number;
          column?: number;
          stackPreview?: string;
        }> = [];

        const captureHandler = async (params: unknown) => {
          const p = params as {
            reason?: string;
            data?: { description?: string; value?: string };
            callFrames?: Array<{
              functionName?: string;
              url?: string;
              location?: { lineNumber?: number; columnNumber?: number };
            }>;
          };

          if (p.reason === 'exception' || p.reason === 'promiseRejection') {
            const desc = p.data?.description ?? p.data?.value ?? 'Unknown exception';
            const topFrame = p.callFrames?.[0];
            caught.push({
              message: String(desc).slice(0, 500),
              url: topFrame?.url,
              line: topFrame?.location?.lineNumber,
              column: topFrame?.location?.columnNumber,
              stackPreview: p.callFrames
                ?.slice(0, 5)
                .map(
                  (f) =>
                    `  at ${f.functionName || '(anonymous)'} (${f.url ?? '?'}:${f.location?.lineNumber ?? '?'})`,
                )
                .join('\n'),
            });
          }

          try {
            await client.send('Debugger.resume', undefined);
          } catch {
            /* best effort */
          }
        };

        client['eventHandlers'].set('Debugger.paused', captureHandler);

        await new Promise((r) => setTimeout(r, duration));

        await client.send('Debugger.setPauseOnExceptions', { state: 'none' });

        // CDP-006: when no prior handler existed, the temporary capture
        // handler must be DELETED (not left in place) — otherwise later
        // debugging/profiling flows inherit a stale pause handler that
        // resumes unrelated pauses.
        if (savedHandler) {
          client['eventHandlers'].set('Debugger.paused', savedHandler);
        } else {
          client['eventHandlers'].delete('Debugger.paused');
        }

        return okResult({
          state: 'none',
          durationMs: duration,
          exceptionsCount: caught.length,
          exceptions: caught,
        });
      } catch (err) {
        // CDP-006: same restore/delete guard on the error path so a thrown
        // capture doesn't leak the temporary handler either.
        if (savedHandler) {
          client['eventHandlers'].set('Debugger.paused', savedHandler);
        } else {
          client['eventHandlers'].delete('Debugger.paused');
        }
        try {
          await client.send('Debugger.setPauseOnExceptions', { state: 'none' });
        } catch {
          /* cleanup */
        }
        return failResult(
          `Exception breakpoint failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
  );
}
