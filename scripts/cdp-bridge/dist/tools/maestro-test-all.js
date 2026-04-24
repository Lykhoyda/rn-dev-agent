import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { chooseMaestroDispatch, shouldWarnFallback } from './maestro-dispatch.js';
const execFile = promisify(execFileCb);
function discoverFlows(dir, pattern) {
    if (!existsSync(dir))
        return [];
    const files = readdirSync(dir, { recursive: true });
    const yamls = files
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map((f) => join(dir, f))
        .sort();
    if (pattern) {
        const re = new RegExp(pattern, 'i');
        return yamls.filter((f) => re.test(f));
    }
    return yamls;
}
export function createMaestroTestAllHandler() {
    return async (args) => {
        const platform = (args.platform ?? getActiveSession()?.platform);
        if (!platform) {
            return failResult('Cannot determine platform. Pass platform or open a device session first.');
        }
        // B59: tiered dispatch (see maestro-dispatch.ts) — picks maestro-runner
        // when viable, falls back to the Maestro CLI on iOS+no-adb machines.
        const dispatch = chooseMaestroDispatch({ platform });
        if ('error' in dispatch) {
            return failResult(dispatch.error);
        }
        const root = findProjectRoot();
        const flowDir = args.flowDir ?? (root ? join(root, '.maestro', 'flows') : null);
        if (!flowDir) {
            return failResult('Cannot determine project root. Pass flowDir explicitly.');
        }
        const flows = discoverFlows(flowDir, args.pattern);
        if (flows.length === 0) {
            return failResult(`No Maestro flows found in ${flowDir}. Generate flows with maestro_generate first.`);
        }
        const timeout = args.timeoutPerFlow ?? 120_000;
        const results = [];
        let passed = 0;
        let failed = 0;
        for (const flow of flows) {
            const name = flow.replace(flowDir + '/', '');
            const start = Date.now();
            try {
                const { stdout, stderr } = await execFile(dispatch.binPath, dispatch.buildArgs(platform, flow), { timeout, encoding: 'utf8' });
                const output = (stdout + '\n' + stderr).trim();
                const ok = !output.includes('FAILED') && !output.includes('Error:');
                results.push({
                    name,
                    passed: ok,
                    durationMs: Date.now() - start,
                    error: ok ? undefined : output.slice(0, 300),
                });
                if (ok)
                    passed++;
                else
                    failed++;
                if (!ok && args.stopOnFailure)
                    break;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                results.push({
                    name,
                    passed: false,
                    durationMs: Date.now() - start,
                    error: msg.slice(0, 300),
                });
                failed++;
                if (args.stopOnFailure)
                    break;
            }
        }
        const summary = {
            total: flows.length,
            executed: results.length,
            passed,
            failed,
            platform,
            flowDir,
            runner: dispatch.runner,
            ...(dispatch.fallbackReason ? { fallbackReason: dispatch.fallbackReason } : {}),
            results,
        };
        if (failed > 0) {
            const baseMsg = `${failed} of ${results.length} flows failed`;
            return warnResult(summary, dispatch.fallbackReason ? `${dispatch.fallbackReason}; ${baseMsg}` : baseMsg);
        }
        // B59 (Gemini review, conf 82): suppress repeated success-with-fallback
        // warnings within the same process — first call surfaces, subsequent
        // calls keep the reason in meta only.
        if (dispatch.fallbackReason && shouldWarnFallback(dispatch.fallbackReason)) {
            return warnResult(summary, dispatch.fallbackReason);
        }
        return okResult(summary);
    };
}
