import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { resolveBundleId, readExpoSlug } from '../project-config.js';
const execFile = promisify(execFileCb);
function getRunnerPath() {
    const path = join(homedir(), '.maestro-runner', 'bin', 'maestro-runner');
    return existsSync(path) ? path : null;
}
function resolvePlatform(override) {
    if (override)
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
        const runnerPath = getRunnerPath();
        if (!runnerPath) {
            return failResult('maestro-runner not found. Install: curl -fsSL https://open.devicelab.dev/install/maestro-runner | bash');
        }
        const platform = resolvePlatform(args.platform);
        if (!platform) {
            return failResult('Cannot determine platform. Pass platform or open a device session first.');
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
            const { stdout, stderr } = await execFile(runnerPath, ['--platform', platform, 'test', flowFile], { timeout, encoding: 'utf8' });
            const output = (stdout + '\n' + stderr).trim();
            const passed = !output.includes('FAILED') && !output.includes('Error:');
            if (passed) {
                return okResult({
                    passed: true,
                    flowFile,
                    platform,
                    output: output.slice(0, 2000),
                });
            }
            return warnResult({ passed: false, flowFile, platform, output: output.slice(0, 2000) }, 'Flow completed with warnings or failures');
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return failResult(`Maestro flow failed: ${msg.slice(0, 500)}`, {
                flowFile,
                platform,
            });
        }
    };
}
