import { readFileSync } from 'node:fs';
import { loadAction } from '../domain/action-store.js';
import { freezeLockedTest, loadLockedTest } from '../domain/e2e-test.js';
import { loadE2eConfig, resolveParams, secretValuesFor, redactSecrets, } from '../domain/e2e-config.js';
import { getGitInfo as realGetGitInfo } from '../e2e/git-info.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { okResult, failResult } from '../utils.js';
function readPassed(result) {
    try {
        const env = JSON.parse(result.content[0].text);
        return {
            passed: env.ok === true && env.data?.passed === true,
            output: env.data?.output ?? env.meta?.output ?? env.error ?? '',
        };
    }
    catch {
        return { passed: false, output: 'unparseable maestro result' };
    }
}
export async function lockE2eTestCore(args, deps = {}) {
    const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
    const load = deps.loadAction ?? loadAction;
    const readFile = deps.readActionFile ?? ((p) => readFileSync(p, 'utf8'));
    const getGit = deps.getGitInfo ?? realGetGitInfo;
    const getSession = deps.getSession ?? getActiveSession;
    const now = deps.now ?? (() => new Date());
    const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
    const action = load(projectRoot, args.actionId);
    if (!action)
        return failResult(`Action '${args.actionId}' not found`, 'NOT_FOUND');
    const loadCfg = deps.loadConfig ?? loadE2eConfig;
    let resolvedParams;
    if (action.metadata.params?.length) {
        const config = loadCfg(projectRoot);
        const resolved = resolveParams(config, args.actionId, action.metadata.params);
        if (!resolved.ok) {
            return failResult(`missing param values for ${resolved.missing.join(', ')} — add them to .rn-agent/e2e.config.json (tests.${args.actionId}.params or defaults.params)`, 'MISSING_PARAMS');
        }
        resolvedParams = resolved.params;
    }
    if (!args.relock && loadLockedTest(projectRoot, args.actionId)) {
        return failResult(`'${args.actionId}' is already locked — pass relock:true to re-lock`, 'ALREADY_LOCKED');
    }
    const session = getSession();
    const platform = session?.platform ?? undefined;
    const runArgs = {
        flowPath: action.filePath,
        platform,
        ...(session?.deviceId ? { deviceId: session.deviceId } : {}),
    };
    if (resolvedParams)
        runArgs['params'] = resolvedParams;
    const result = await maestroRun(runArgs);
    const { passed, output } = readPassed(result);
    if (!passed) {
        let failOutput = output.slice(0, 500);
        if (resolvedParams) {
            const config = loadCfg(projectRoot);
            failOutput = redactSecrets(failOutput, secretValuesFor(config, resolvedParams));
        }
        return failResult(`'${args.actionId}' did not pass a strict run — repair it until it passes, then lock`, 'STRICT_RUN_FAILED', { output: failOutput });
    }
    const git = getGit(projectRoot);
    const locked = freezeLockedTest(projectRoot, {
        id: action.metadata.id,
        intent: action.metadata.intent,
        sourceActionId: action.metadata.id,
        flow: readFile(action.filePath),
        appId: action.metadata.appId,
    }, { gitSha: git.sha, now });
    return okResult({
        locked: true,
        id: locked.id,
        filePath: locked.filePath,
        lockedAt: locked.lockedAt,
        relocked: Boolean(args.relock),
    });
}
export function createLockE2eTestHandler(deps = {}) {
    return (args) => lockE2eTestCore(args, deps);
}
