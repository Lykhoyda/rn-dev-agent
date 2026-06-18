import type { CDPClient } from '../cdp-client.js';
import { okResult, failResult, withConnection } from '../utils.js';

// M10 / Phase 110 / D667: advisory hint appended to cpuProfile failures when
// the target is running on the classic bridge (Fabric absent). CPU profiling
// via CDP Profiler domain is known to be flaky on Old Arch — this wording
// points users at the most likely cause + actionable alternatives.
export const OLD_ARCH_PROFILER_HINT =
  'Old architecture detected — CPU profile may be unreliable or incomplete on the classic bridge. ' +
  'Prefer cdp_heap_usage for memory, or enable New Architecture (newArchitecture: true in app.json) for profiling.';

// Single-shot probe of app architecture. Used in the error path of cpuProfile
// so we can surface OLD_ARCH_PROFILER_HINT only when it's actually relevant.
// Wrapped in try/catch — any failure collapses to 'unknown' so we don't hint.
async function safeProbeArchitecture(client: CDPClient): Promise<'new' | 'old' | 'unknown'> {
  try {
    const result = await client.evaluate(client.helperExpr('getAppInfo()'));
    if (typeof result.value !== 'string') return 'unknown';
    const info = JSON.parse(result.value) as { architecture?: unknown };
    return info.architecture === 'new' || info.architecture === 'old'
      ? info.architecture
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createHeapUsageHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (_args: Record<string, never>, client) => {
    try {
      const result = (await client.send('Runtime.getHeapUsage', undefined)) as {
        usedSize?: number;
        totalSize?: number;
      };
      return okResult({
        usedMB: Number(((result.usedSize ?? 0) / 1024 / 1024).toFixed(2)),
        totalMB: Number(((result.totalSize ?? 0) / 1024 / 1024).toFixed(2)),
        usedBytes: result.usedSize ?? 0,
        totalBytes: result.totalSize ?? 0,
        utilization: result.totalSize
          ? Number((((result.usedSize ?? 0) / result.totalSize) * 100).toFixed(1))
          : 0,
      });
    } catch (err) {
      return failResult(`Heap usage unavailable: ${err instanceof Error ? err.message : err}`);
    }
  });
}

export function createCpuProfileHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { durationMs?: number }, client) => {
    const duration = Math.min(Math.max(args.durationMs ?? 3000, 500), 30000);

    // CDP-007 (was D597): when the CDP Profiler domain is unavailable, the
    // previous fallback sampled `new Error().stack` inside its own
    // `setInterval` callback. Those frames describe the SAMPLER's call
    // stack (`Timeout.eval`, `listOnTimeout`, `process.processTimers`),
    // not the app — labelling them as `hotFunctions` actively misled
    // optimization work.
    //
    // We now refuse to fabricate hotFunctions when Profiler is missing.
    // Caller gets a clear unavailability error with actionable hints.
    if (!client.profilerAvailable) {
      const arch = await safeProbeArchitecture(client);
      const archHint = arch === 'old' ? OLD_ARCH_PROFILER_HINT : null;
      return failResult(
        'CPU profiling unavailable: CDP Profiler domain is not exposed by this Hermes target. ' +
          "No JS-based fallback is provided because sampling the sampler's own stack produced " +
          'misleading hotFunctions (CDP-007).',
        'PROFILER_UNAVAILABLE',
        {
          architecture: arch,
          hint:
            archHint ??
            'For memory analysis use cdp_heap_usage. For diagnostics use cdp_console_log/cdp_error_log. ' +
              'Profiler domain availability varies across React Native + Hermes versions.',
        },
      );
    }

    try {
      await client.send('Profiler.enable', undefined);
      await client.send('Profiler.start', undefined);

      await new Promise((r) => setTimeout(r, duration));

      const result = (await client.send('Profiler.stop', undefined)) as {
        profile?: {
          nodes?: Array<{
            id: number;
            callFrame: { functionName: string; url: string; lineNumber: number };
            hitCount?: number;
          }>;
          startTime?: number;
          endTime?: number;
        };
      };

      await client.send('Profiler.disable', undefined);

      const profile = result.profile;
      if (!profile?.nodes) {
        return failResult('Profiler returned empty profile');
      }

      const hotFunctions = profile.nodes
        .filter((n) => (n.hitCount ?? 0) > 0)
        .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))
        .slice(0, 20)
        .map((n) => ({
          name: n.callFrame.functionName || '(anonymous)',
          url: n.callFrame.url,
          line: n.callFrame.lineNumber,
          hitCount: n.hitCount ?? 0,
        }));

      return okResult({
        durationMs: duration,
        nodeCount: profile.nodes.length,
        hotFunctions,
        startTime: profile.startTime,
        endTime: profile.endTime,
      });
    } catch (err) {
      try {
        await client.send('Profiler.disable', undefined);
      } catch {
        /* cleanup */
      }
      const base = `CPU profiling failed: ${err instanceof Error ? err.message : err}`;
      // M10: advisory hint when the cause is likely Old Architecture.
      const arch = await safeProbeArchitecture(client);
      if (arch === 'old') {
        return failResult(base, { hint: OLD_ARCH_PROFILER_HINT, architecture: arch });
      }
      return failResult(base);
    }
  });
}
