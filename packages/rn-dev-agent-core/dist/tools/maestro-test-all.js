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
import { exactPinRefusal, getEngineStatus, withImmediatePinnedRunner, isOlderSdkInstallFailure, olderSdkInstallDiagnosis, RunnerCacheUnavailableError, runnerCacheBootstrapFailure, } from '../domain/engine-pin.js';
import { classifyLearnedActionPath, isLearnedActionPath, replayCompatibilityPreflight, } from '../domain/action-engine-compat.js';
import { parseM7Header } from '../domain/reusable-action.js';
import { captureActionFromContext, openReadableActionLoadContext, } from '../domain/action-store.js';
import { flowUsesClearState, resolveAppFileForClearState } from './resolve-ios-app-file.js';
import { maestroAuthorityRefusal, sameDevice, verifyMaestroDeviceAuthority, } from '../domain/maestro-device-authority.js';
import { collectDirectRunnerEvidence, createRunnerReportDir, disposeRunnerReportDir, runnerReportArgs, } from '../domain/maestro-runner-report.js';
import { SessionAuthorityError } from '../session/registry.js';
const defaultExecFile = promisify(execFileCb);
function filterFlows(yamls, pattern) {
    if (pattern) {
        if (pattern.length > 256)
            return yamls;
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
function discoverFlows(dir, pattern) {
    if (!existsSync(dir))
        return [];
    const yamls = readdirSync(dir, { recursive: true })
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .map((f) => join(dir, f))
        .sort();
    return filterFlows(yamls, pattern);
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
        let learnedContext = null;
        if (learnedProjectRoot) {
            try {
                learnedContext = openReadableActionLoadContext(learnedProjectRoot);
            }
            catch (err) {
                return failResult(err instanceof Error ? err.message : String(err));
            }
        }
        if (learnedCorpus && !learnedContext) {
            return failResult(`Refusing learned-action corpus without an approved load context: ${resolvedFlowDir}.`);
        }
        const flows = learnedContext
            ? filterFlows(learnedContext.files
                .filter((file) => /\.ya?ml$/i.test(file))
                .map((file) => join(flowDir, file))
                .sort(), args.pattern)
            : discoverFlows(flowDir, args.pattern);
        if (flows.length === 0) {
            return failResult(`No Maestro flows found in ${flowDir}. Generate flows with maestro_generate first.`);
        }
        const preflightResults = [];
        const preparedFlows = [];
        for (const flow of flows) {
            const name = flow.replace(flowDir + '/', '');
            const start = now();
            try {
                let parsedCommands;
                let parsedFlowAppId;
                let meta;
                let requireEnginePin;
                if (learnedContext) {
                    const actionId = basename(flow).replace(/\.ya?ml$/i, '');
                    const action = captureActionFromContext(learnedContext, actionId);
                    if (!action || basename(action.filePath) !== basename(flow)) {
                        throw new Error(`Action ${actionId} does not resolve to ${flow}.`);
                    }
                    if (!action.replay.ok)
                        throw new MaestroValidationError(action.replay.error);
                    parsedCommands = action.replay.commands;
                    parsedFlowAppId = action.replay.appId;
                    meta = action.metadata;
                    requireEnginePin = true;
                }
                else {
                    const yamlText = readFileSync(flow, 'utf-8');
                    const parsed = parseAndValidateFlow(yamlText, {
                        flowDir: dirname(flow),
                        flowRoot: flowDir,
                    });
                    const flowId = name.replace(/\.ya?ml$/i, '');
                    parsedCommands = parsed.commands;
                    parsedFlowAppId = parsed.appId;
                    meta = parseM7Header(yamlText, flowId);
                    requireEnginePin = meta !== null || isLearnedActionPath(flow);
                }
                const preflight = replayCompatibilityPreflight({
                    enginePin: meta?.enginePin,
                    commands: parsedCommands,
                    engineStatus,
                    requireEnginePin,
                });
                if (preflight)
                    throw new Error(preflight);
                planMaestroAuthorityStages(parsedCommands);
                const parsedAppId = resolveMaestroFlowAppId(boundAppId, parsedFlowAppId);
                const canonical = buildMaestroFlow(parsedAppId !== undefined ? { appId: parsedAppId } : {}, parsedCommands);
                const appFileResolution = resolveAppFile(platform, canonical, parsedAppId, undefined, {
                    deviceId: requestedDeviceId,
                });
                if (!appFileResolution.ok)
                    throw new Error(appFileResolution.error);
                preparedFlows.push({
                    name,
                    commands: parsedCommands,
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
                    if (start + timeout - now() <= 0) {
                        const error = new Error('Maestro flow timeout exhausted before the next stage');
                        Object.assign(error, { code: 'ETIMEDOUT' });
                        throw error;
                    }
                    writeFileSync(safeFlowFile, buildMaestroFlow(parsedAppId !== undefined ? { appId: parsedAppId } : {}, [
                        ...commands,
                    ]), 'utf-8');
                    const executeRunner = (runnerPath, prefixArgs = []) => {
                        const remainingTimeout = start + timeout - now();
                        if (remainingTimeout <= 0) {
                            const error = new Error('Maestro flow timeout exhausted before runner execution');
                            Object.assign(error, { code: 'ETIMEDOUT' });
                            throw error;
                        }
                        return execute(runnerPath, [...prefixArgs, ...finalArgs], {
                            timeout: remainingTimeout,
                            encoding: 'utf8',
                            maxBuffer: 10 * 1024 * 1024,
                        });
                    };
                    if (deps.execFile) {
                        const immediateStatus = await resolveEngineStatus();
                        const refusal = exactPinRefusal(immediateStatus);
                        const immediateRefusal = refusal ? `RUNNER_PIN_CHANGED: ${refusal}` : null;
                        if (immediateRefusal)
                            throw new Error(immediateRefusal);
                        return executeRunner(flowDispatch.binPath);
                    }
                    return withImmediatePinnedRunner(flowDispatch.binPath, resolveEngineStatus, executeRunner);
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
                if (stageError instanceof RunnerCacheUnavailableError) {
                    return failResult(runnerCacheBootstrapFailure(stageError), 'WDA_BOOTSTRAP_FAILED', {
                        total: flows.length,
                        executed: results.length,
                        passed,
                        failed: failed + 1,
                        platform,
                        flowDir,
                        runner: dispatch.runner,
                        requestedDeviceId: requestedDeviceId ?? null,
                        results: [
                            ...results,
                            {
                                name,
                                passed: false,
                                durationMs: now() - start,
                                error: stageError.message,
                            },
                        ],
                    });
                }
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
