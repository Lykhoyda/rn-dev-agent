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
    return info.architecture === 'new' || info.architecture === 'old' ? info.architecture : 'unknown';
  } catch {
    return 'unknown';
  }
}

export function createHeapUsageHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (_args: Record<string, never>, client) => {
    try {
      const result = await client.send('Runtime.getHeapUsage', undefined) as {
        usedSize?: number;
        totalSize?: number;
      };
      return okResult({
        usedMB: Number(((result.usedSize ?? 0) / 1024 / 1024).toFixed(2)),
        totalMB: Number(((result.totalSize ?? 0) / 1024 / 1024).toFixed(2)),
        usedBytes: result.usedSize ?? 0,
        totalBytes: result.totalSize ?? 0,
        utilization: result.totalSize ? Number(((result.usedSize ?? 0) / result.totalSize * 100).toFixed(1)) : 0,
      });
    } catch (err) {
      return failResult(`Heap usage unavailable: ${err instanceof Error ? err.message : err}`);
    }
  });
}

export function createCpuProfileHandler(getClient: () => CDPClient) {
  return withConnection(getClient, async (args: { durationMs?: number }, client) => {
    const duration = Math.min(Math.max(args.durationMs ?? 3000, 500), 30000);

    // D597: JS-based sampling fallback when Profiler domain unavailable
    if (!client.profilerAvailable) {
      try {
        const sampleScript = `
          (function() {
            var samples = {};
            var count = 0;
            var interval = setInterval(function() {
              try {
                var stack = new Error().stack || '';
                var lines = stack.split('\\n').slice(1, 6);
                lines.forEach(function(line) {
                  var match = line.match(/at\\s+(.+?)\\s*\\(/);
                  var name = match ? match[1].trim() : line.trim();
                  if (name && name !== 'anonymous' && name !== '') {
                    samples[name] = (samples[name] || 0) + 1;
                  }
                });
              } catch(e) {}
              count++;
              if (count >= ${Math.floor(duration / 50)}) {
                clearInterval(interval);
                globalThis.__RN_AGENT_PROFILE_RESULT__ = JSON.stringify(samples);
              }
            }, 50);
            return 'sampling';
          })()
        `;
        await client.evaluate(sampleScript);
        await new Promise(r => setTimeout(r, duration + 200));
        const result = await client.evaluate('globalThis.__RN_AGENT_PROFILE_RESULT__ || "{}"');
        void client.evaluate('delete globalThis.__RN_AGENT_PROFILE_RESULT__');
        const samples = JSON.parse(String(result.value || '{}')) as Record<string, number>;
        const hotFunctions = Object.entries(samples)
          .sort(([, a], [, b]) => b - a)
          .slice(0, 20)
          .map(([name, hitCount]) => ({ name, hitCount, url: '', line: 0 }));
        return okResult({
          durationMs: duration,
          nodeCount: hotFunctions.length,
          hotFunctions,
          source: 'js-sampling',
          note: 'Approximate — using Error().stack sampling (Profiler domain unavailable)',
        });
      } catch (err) {
        return failResult(`JS-based profiling failed: ${err instanceof Error ? err.message : err}`);
      }
    }

    try {
      await client.send('Profiler.enable', undefined);
      await client.send('Profiler.start', undefined);

      await new Promise(r => setTimeout(r, duration));

      const result = await client.send('Profiler.stop', undefined) as {
        profile?: {
          nodes?: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }>;
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
        .filter(n => (n.hitCount ?? 0) > 0)
        .sort((a, b) => (b.hitCount ?? 0) - (a.hitCount ?? 0))
        .slice(0, 20)
        .map(n => ({
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
      try { await client.send('Profiler.disable', undefined); } catch { /* cleanup */ }
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
