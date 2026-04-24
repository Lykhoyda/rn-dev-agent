import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { resolveBundleId, readExpoSlug } from '../project-config.js';
import { chooseMaestroDispatch, shouldWarnFallback } from './maestro-dispatch.js';
const execFile = promisify(execFileCb);
function resolvePlatform(override) {
    if (override === 'ios' || override === 'android')
        return override;
    const session = getActiveSession();
    return session?.platform ?? null;
}
function resolveAppId(override, platform) {
    if (override)
        return override;
    if (platform)
        return resolveBundleId(platform) ?? readExpoSlug() ?? '';
    return readExpoSlug() ?? '';
}
export function createMaestroRunHandler() {
    return async (args) => {
        const platform = resolvePlatform(args.platform);
        if (!platform) {
            return failResult('Cannot determine platform. Pass platform or open a device session first.');
        }
        // B59: tiered dispatch — maestro-runner when viable, Maestro CLI fallback
        // when iOS-only and adb is missing, fail-fast with install hints when neither.
        const dispatch = chooseMaestroDispatch({ platform });
        if ('error' in dispatch) {
            return failResult(dispatch.error);
        }
        let flowFile;
        if (args.inlineYaml) {
            const appId = resolveAppId(args.appId, platform);
            const header = appId ? `appId: ${appId}\n---\n` : '---\n';
            const content = header + args.inlineYaml;
            flowFile = '/tmp/rn-maestro-inline.yaml';
            writeFileSync(flowFile, content, 'utf-8');
        }
        else if (args.flowPath) {
            if (!existsSync(args.flowPath)) {
                return failResult(`Flow file not found: ${args.flowPath}`);
            }
            flowFile = args.flowPath;
        }
        else {
            return failResult('Provide either flowPath or inlineYaml.');
        }
        const timeout = args.timeoutMs ?? 120_000;
        try {
            const { stdout, stderr } = await execFile(dispatch.binPath, dispatch.buildArgs(platform, flowFile), { timeout, encoding: 'utf8' });
            const output = (stdout + '\n' + stderr).trim();
            const passed = !output.includes('FAILED') && !output.includes('Error:');
            const meta = {
                passed,
                flowFile,
                platform,
                runner: dispatch.runner,
                output: output.slice(0, 2000),
                ...(dispatch.fallbackReason ? { fallbackReason: dispatch.fallbackReason } : {}),
            };
            if (passed) {
                // B59 (Gemini review, conf 82): on success-with-fallback, only emit
                // a loud warning the FIRST time per process so a 100-flow loop
                // doesn't generate 100 identical warnings. Subsequent successes
                // carry the reason silently in meta.fallbackReason.
                if (dispatch.fallbackReason && shouldWarnFallback(dispatch.fallbackReason)) {
                    return warnResult(meta, dispatch.fallbackReason);
                }
                return okResult(meta);
            }
            return warnResult(meta, dispatch.fallbackReason
                ? `${dispatch.fallbackReason}; flow completed with warnings or failures`
                : 'Flow completed with warnings or failures');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return failResult(`Maestro flow failed: ${msg.slice(0, 500)}`, {
                flowFile,
                platform,
                runner: dispatch.runner,
            });
        }
    };
}
