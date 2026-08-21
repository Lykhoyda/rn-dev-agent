import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { chooseMaestroDispatch, shouldWarnFallback } from './maestro-dispatch.js';
import { buildMaestroFlow, parseAndValidateFlow, MaestroValidationError, } from '../domain/maestro-validator.js';
import { assembleMaestroArgs, executeMaestroAuthorityStages, MaestroStageExecutionError, nestedMaestroAuthorityCallbacks, planMaestroAuthorityStages, resolveMaestroFlowAppId, runFlowParked, } from './maestro-run.js';
import { outputIndicatesFlowFailure } from '../domain/maestro-error-parser.js';
import { exactPinRefusal, getEngineStatus, isOlderSdkInstallFailure, olderSdkInstallDiagnosis, } from '../domain/engine-pin.js';
import { classifyLearnedActionPath, isLearnedActionPath, replayCompatibilityPreflight, standaloneLearnedActionPathRefusal, } from '../domain/action-engine-compat.js';
import { parseM7Header } from '../domain/reusable-action.js';
import { resolveActionPath } from '../domain/action-store.js';
import { flowUsesClearState, resolveAppFileForClearState } from './resolve-ios-app-file.js';
import { maestroAuthorityRefusal, sameDevice, verifyMaestroDeviceAuthority, } from '../domain/maestro-device-authority.js';
import { collectDirectRunnerEvidence, createRunnerReportDir, disposeRunnerReportDir, runnerReportArgs, } from '../domain/maestro-runner-report.js';
import { SessionAuthorityError } from '../session/registry.js';
const defaultExecFile = promisify(execFileCb);
function discoverFlows(dir, pattern, topLevelOnly = false) {
    if (!existsSync(dir))
        return [];
    const files = topLevelOnly
        ? readdirSync(dir)
        : readdirSync(dir, { recursive: true });
    const yamls = files
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map((f) => join(dir, f))
        .sort();
    if (pattern) {
        // Phase 134.5 (deepsec BUG: regex-dos): a malicious or malformed
        // `pattern` arg could throw on invalid regex syntax or hang on
        // catastrophic backtracking (e.g. `(a+)+$` against a long input).
        // Cap the pattern length and wrap construction; on any error,
        // skip filtering rather than crash discovery.
        if (pattern.length > 256) {
            return yamls;
        }
        let re;
        try {
            re = new RegExp(pattern, 'i');
        }
        catch {
            return yamls;
        }
        return yamls.filter((f) => re.test(f));
    }
    return yamls;
}
export function createMaestroTestAllHandler(deps = {}) {
    const activeSession = deps.getActiveSession ?? getActiveSession;
    const selectDispatch = deps.chooseDispatch ?? chooseMaestroDispatch;
    const parkFlow = deps.parkFlow ?? runFlowParked;
    const resolveAppFile = deps.resolveAppFile ?? resolveAppFileForClearState;
    const execute = deps.execFile ?? defaultExecFile;
    const now = deps.now ?? Date.now;
    const resolveEngineStatus = deps.resolveEngineStatus ?? (() => getEngineStatus().catch(() => null));
    return async (args) => {
        const platform = (args.platform ?? activeSession()?.platform);
        if (!platform) {
            return failResult('Cannot determine platform. Pass platform or open a device session first.');
        }
        const session = activeSession();
        const boundAppId = args.appId ?? (session?.platform === platform ? session.appId : undefined);
        const matchingSessionDeviceId = session?.platform === platform && session.deviceId ? session.deviceId : undefined;
        if (args.deviceId &&
            matchingSessionDeviceId &&
            !sameDevice(args.deviceId, matchingSessionDeviceId)) {
            return failResult(`Refusing Maestro suite target ${args.deviceId}: active ${platform} session is bound to ${matchingSessionDeviceId}.`, 'TARGET_SESSION_MISMATCH', { requestedDeviceId: args.deviceId, activeSessionDeviceId: matchingSessionDeviceId });
        }
        const requestedDeviceId = args.deviceId ?? matchingSessionDeviceId;
        const dispatch = selectDispatch({ platform });
        if ('error' in dispatch) {
            return failResult(dispatch.error);
        }
        const engineStatus = await resolveEngineStatus();
        const pinRefusal = exactPinRefusal(engineStatus);
        if (pinRefusal)
            return failResult(pinRefusal);
        const root = findProjectRoot();
        const flowDir = args.flowDir ?? (root ? join(root, '.rn-agent', 'actions') : null);
        if (!flowDir) {
            return failResult('Cannot determine project root. Pass flowDir explicitly.');
        }
        const resolvedFlowDir = resolve(flowDir);
        const flowDirClassification = classifyLearnedActionPath(join(resolvedFlowDir, '__action__.yaml'));
        if (flowDirClassification === 'descendant') {
            return failResult(`Refusing to execute learned-action descendants from ${resolvedFlowDir} as standalone flows.`);
        }
        const learnedCorpus = flowDirClassification === 'action';
        const learnedProjectRoot = learnedCorpus ? dirname(dirname(resolvedFlowDir)) : null;
        const flows = discoverFlows(flowDir, args.pattern, learnedCorpus);
        if (flows.length === 0) {
            return failResult(`No Maestro flows found in ${flowDir}. Generate flows with maestro_generate first.`);
        }
        const preflightResults = [];
        const preparedFlows = [];
        for (const flow of flows) {
            const name = flow.replace(flowDir + '/', '');
            const start = now();
            try {
                const actionPathRefusal = standaloneLearnedActionPathRefusal(flow);
                if (actionPathRefusal)
                    throw new Error(actionPathRefusal);
                if (learnedProjectRoot) {
                    const actionId = basename(flow).replace(/\.ya?ml$/i, '');
                    const resolvedAction = resolveActionPath(learnedProjectRoot, actionId);
                    if (resolvedAction === null || resolve(resolvedAction) !== resolve(flow)) {
                        throw new Error(`Action ${actionId} does not resolve to ${flow}.`);
                    }
                }
                const yamlText = readFileSync(flow, 'utf-8');
                const parsed = parseAndValidateFlow(yamlText, {
                    flowDir: dirname(flow),
                    flowRoot: flowDir,
                });
                const flowId = name.replace(/\.ya?ml$/i, '');
                const meta = parseM7Header(yamlText, flowId);
                const requireEnginePin = meta !== null || isLearnedActionPath(flow);
                const preflight = replayCompatibilityPreflight({
                    enginePin: meta?.enginePin,
                    commands: parsed.commands,
                    engineStatus,
                    requireEnginePin,
                });
                if (preflight)
                    throw new Error(preflight);
                planMaestroAuthorityStages(parsed.commands);
                const parsedAppId = resolveMaestroFlowAppId(boundAppId, parsed.appId);
                const canonical = buildMaestroFlow(parsedAppId !== undefined ? { appId: parsedAppId } : {}, parsed.commands);
                const appFileResolution = resolveAppFile(platform, canonical, parsedAppId, undefined, {
                    deviceId: requestedDeviceId,
                });
                if (!appFileResolution.ok)
                    throw new Error(appFileResolution.error);
                preparedFlows.push({
                    name,
                    commands: parsed.commands,
                    appId: parsedAppId,
                    canonical,
                    appFile: appFileResolution.appFile,
                    reinstallsApp: Boolean(appFileResolution.appFile) && flowUsesClearState(canonical),
                });
            }
            catch (err) {
                const reason = err instanceof MaestroValidationError
                    ? `Refused by validator: ${err.message}`
                    : err instanceof Error
                        ? err.message
                        : String(err);
                preflightResults.push({
                    name,
                    passed: false,
                    durationMs: now() - start,
                    error: reason.slice(0, 300),
                });
            }
        }
        if (preflightResults.length > 0) {
            return failResult(`Suite preflight refused ${preflightResults.length} of ${flows.length} flows before execution.`, {
                total: flows.length,
                executed: 0,
                passed: 0,
                failed: preflightResults.length,
                platform,
                flowDir,
                runner: dispatch.runner,
                requestedDeviceId: requestedDeviceId ?? null,
                results: preflightResults,
            });
        }
        const timeout = args.timeoutPerFlow ?? 120_000;
        const managedAuthority = nestedMaestroAuthorityCallbacks(args);
        const claimOrigin = deps.claimNativeOrigin ?? managedAuthority.claimNativeOrigin;
        const completeOrigin = deps.completeNativeOrigin ?? managedAuthority.completeNativeOrigin;
        const relaunchManagedApp = deps.relaunchManagedApp ?? managedAuthority.relaunchManagedApp;
        const reproveManagedOrigin = deps.reproveManagedOrigin ?? managedAuthority.reproveManagedOrigin;
        const completeRunnerPark = deps.completeRunnerPark ?? managedAuthority.completeRunnerPark;
        const reissueInstallReceipt = deps.reissueInstallReceipt ?? managedAuthority.reissueInstallReceipt;
        const results = [];
        let passed = 0;
        let failed = 0;
        for (const prepared of preparedFlows) {
            const { name } = prepared;
            const start = now();
            const safeFlowFile = join(tmpdir(), `rn-maestro-validated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
            writeFileSync(safeFlowFile, prepared.canonical, 'utf-8');
            const parsedCommands = prepared.commands;
            const parsedAppId = prepared.appId;
            const appFile = prepared.appFile;
            const reinstallsApp = prepared.reinstallsApp;
            let flowDispatch = dispatch;
            const runnerReportDir = createRunnerReportDir(flowDispatch.runner, 'rn-maestro-suite-report');
            const baseArgs = flowDispatch.buildArgs(platform, safeFlowFile, appFile, requestedDeviceId);
            const finalArgs = assembleMaestroArgs(baseArgs, runnerReportArgs(runnerReportDir));
            // GH #705 follow-up: commit a fresh install receipt after a clearState
            // reinstall — mirrors maestro_run, so the first clearState flow in a
            // corpus no longer breaks axis I for every flow and tool call after it.
            let installReceiptCommitted = false;
            const commitReinstalledInstall = async () => {
                if (!reinstallsApp || installReceiptCommitted || !reissueInstallReceipt)
                    return;
                installReceiptCommitted = true;
                await reissueInstallReceipt();
            };
            try {
                const stageResults = await parkFlow(() => executeMaestroAuthorityStages(parsedCommands, async (commands) => {
                    const remainingTimeout = start + timeout - now();
                    if (remainingTimeout <= 0) {
                        const error = new Error('Maestro flow timeout exhausted before the next stage');
                        Object.assign(error, { code: 'ETIMEDOUT' });
                        throw error;
                    }
                    writeFileSync(safeFlowFile, buildMaestroFlow(parsedAppId !== undefined ? { appId: parsedAppId } : {}, [
                        ...commands,
                    ]), 'utf-8');
                    return execute(flowDispatch.binPath, finalArgs, {
                        timeout: remainingTimeout,
                        encoding: 'utf8',
                        maxBuffer: 10 * 1024 * 1024,
                    });
                }, claimOrigin, completeOrigin, relaunchManagedApp, reproveManagedOrigin), {
                    platform,
                    deviceId: requestedDeviceId,
                    completeRunnerPark,
                });
                await commitReinstalledInstall();
                const stdout = stageResults.map((result) => result.stdout).join('\n');
                const stderr = stageResults.map((result) => result.stderr).join('\n');
                const output = (stdout + '\n' + stderr).trim();
                // The runner already exited 0 here, so that exit code is the
                // authoritative pass signal. The secondary scan keys on Maestro's own
                // status LINES (GH#249: a bare `FAILED` substring false-flagged passing
                // runs whose app logs contained the token; mirrors the maestro_run fix).
                const outputPassed = !outputIndicatesFlowFailure(output);
                const directEvidence = collectDirectRunnerEvidence(runnerReportDir, output);
                const deviceAuthority = verifyMaestroDeviceAuthority({
                    runner: flowDispatch.runner,
                    platform,
                    requestedDeviceId,
                    output: directEvidence.output,
                    directReportDeviceIds: directEvidence.reportDeviceIds,
                    directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
                    requireWdaProvenance: outputPassed,
                });
                const authorityRefusal = maestroAuthorityRefusal(deviceAuthority);
                const ok = outputPassed && !authorityRefusal;
                results.push({
                    name,
                    passed: ok,
                    durationMs: now() - start,
                    error: authorityRefusal ?? (ok ? undefined : output.slice(0, 300)),
                    deviceAuthority,
                });
                if (ok)
                    passed++;
                else
                    failed++;
                if (!ok && args.stopOnFailure)
                    break;
            }
            catch (err) {
                // A flow that died mid-way may still have reinstalled: re-issue before
                // reporting, so the failure is the flow's and not a broken axis I.
                await commitReinstalledInstall();
                if (err instanceof SessionAuthorityError)
                    throw err;
                const stageError = err instanceof MaestroStageExecutionError ? err.stageError : err;
                const msg = stageError instanceof Error ? stageError.message : String(stageError);
                const errWithOutput = stageError;
                const completed = err instanceof MaestroStageExecutionError
                    ? err.completedResults
                    : [];
                const capturedOutput = [
                    ...completed.flatMap((result) => [result.stdout, result.stderr]),
                    errWithOutput.stdout,
                    errWithOutput.stderr,
                ]
                    .filter((value) => typeof value === 'string')
                    .join('\n')
                    .trim();
                // No captured output means the runner never executed (spawn ENOENT/EACCES,
                // a park failure, a timeout before first byte). There is no device to
                // adjudicate, and an authority verdict here would be the only thing the
                // suite reports — masking a broken Maestro install as a wrong-device run.
                const directEvidence = capturedOutput
                    ? collectDirectRunnerEvidence(runnerReportDir, capturedOutput)
                    : null;
                const deviceAuthority = directEvidence
                    ? verifyMaestroDeviceAuthority({
                        runner: flowDispatch.runner,
                        platform,
                        requestedDeviceId,
                        output: directEvidence.output,
                        directReportDeviceIds: directEvidence.reportDeviceIds,
                        directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
                    })
                    : null;
                const authorityRefusal = deviceAuthority
                    ? maestroAuthorityRefusal(deviceAuthority, msg.slice(0, 300))
                    : null;
                // GH #741: a pre-O install reject is a capability gap; reporting it as
                // a flow failure (or worse, an authority mismatch) dead-ends operators.
                const preOFailure = platform === 'android' && isOlderSdkInstallFailure(capturedOutput)
                    ? olderSdkInstallDiagnosis(flowDispatch.runner)
                    : null;
                results.push({
                    name,
                    passed: false,
                    durationMs: now() - start,
                    error: preOFailure ?? authorityRefusal ?? msg.slice(0, 300),
                    ...(deviceAuthority && !preOFailure ? { deviceAuthority } : {}),
                });
                failed++;
                if (args.stopOnFailure)
                    break;
            }
            finally {
                disposeRunnerReportDir(runnerReportDir);
            }
        }
        // GH #356/B223: surface the base dispatch's fallback reason, or (if any
        // Android hideKeyboard flow had to degrade to maestro-runner) the keyboard caveat.
        const batchCaveat = dispatch.fallbackReason;
        const summary = {
            total: flows.length,
            executed: results.length,
            passed,
            failed,
            platform,
            flowDir,
            runner: dispatch.runner,
            requestedDeviceId: requestedDeviceId ?? null,
            ...(batchCaveat ? { fallbackReason: batchCaveat } : {}),
            results,
        };
        if (failed > 0) {
            const baseMsg = `${failed} of ${results.length} flows failed`;
            return warnResult(summary, batchCaveat ? `${batchCaveat}; ${baseMsg}` : baseMsg);
        }
        // B59 (Gemini review, conf 82): suppress repeated success-with-fallback
        // warnings within the same process — first call surfaces, subsequent
        // calls keep the reason in meta only.
        if (batchCaveat && shouldWarnFallback(batchCaveat)) {
            return warnResult(summary, batchCaveat);
        }
        return okResult(summary);
    };
}
