import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { okResult, failResult, warnResult } from '../utils.js';
import { getEngineStatus, enginePinCaveat, strictPinRefusal } from '../domain/engine-pin.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { resolveBundleId, readExpoSlug } from '../project-config.js';
import { chooseMaestroDispatch, shouldWarnFallback, flowContainsHideKeyboard, } from './maestro-dispatch.js';
import { flowUsesClearState, resolveAppFileForClearState } from './resolve-ios-app-file.js';
import { buildMaestroFlow, parseAndValidateFlow, isValidBundleId, MaestroValidationError, } from '../domain/maestro-validator.js';
import { outputIndicatesFlowFailure } from '../domain/maestro-error-parser.js';
import { augmentFailureWithDegradation, resolveFloorMs } from '../domain/tap-latency.js';
import { buildStepSummary, buildTerminalEvidence, classifyExecError, combineRunnerOutput, formatFailureHeadline, } from '../domain/maestro-step-parser.js';
import { fastHealthCheck as defaultFastHealthCheck, stopFastRunner as defaultStopFastRunner, } from '../runners/rn-fast-runner-client.js';
import { ExactAndroidDeviceRequiredError, releaseAndroidInteractionSlot as defaultReleaseAndroidSlot, } from '../runners/release-android-slot.js';
import { markCdpStale as defaultMarkCdpStale } from '../cdp/recovery.js';
import { maestroAuthorityRefusal, sameDevice, verifyMaestroDeviceAuthority, } from '../domain/maestro-device-authority.js';
import { collectDirectRunnerEvidence, createRunnerReportDir, disposeRunnerReportDir, runnerReportArgs, } from '../domain/maestro-runner-report.js';
import { completeManagedRunnerParkAuthority, claimManagedNativeOriginAuthority, completeManagedNativeOriginAuthority, hasManagedInstallReissueAuthority, reissueManagedInstallAuthority, relaunchManagedNativeOriginApp, reproveManagedNativeOrigin, } from '../session/authority-gate.js';
import { SessionAuthorityError } from '../session/registry.js';
const defaultExecFile = promisify(execFileCb);
/**
 * GH#202 Phase 2a + GH#237: run a Maestro flow with L2 parked. iOS stops the
 * fast-runner (XCTest); Android releases the single UiAutomation slot (our
 * runner's instrumentation would otherwise block maestro-runner's UIAutomator2
 * server — #237). Mark CDP stale afterward (always — even on failure) so the
 * next read reconnects to post-flow state. The L2 runner lazily restarts on the
 * next device_* call. MUST run inside the held arbiter `flow` lease.
 */
export async function runFlowParked(run, opts = {}) {
    const stale = opts.markCdpStale ?? defaultMarkCdpStale;
    try {
        if (opts.platform === 'android') {
            const release = opts.releaseAndroidSlot ?? defaultReleaseAndroidSlot;
            const outcome = await release({ deviceId: opts.deviceId });
            opts.onAndroidRelease?.(outcome);
        }
        else {
            await (opts.stopFastRunner ?? defaultStopFastRunner)(opts.deviceId);
        }
        await opts.completeRunnerPark?.();
        return await run();
    }
    finally {
        stale();
    }
}
/**
 * Splice `-e KEY=VALUE` param pairs in just before the flow file. Both runners
 * treat args trailing the flow file as additional flow files (maestro-runner
 * then `stat`s `-e`/`KEY=VALUE` as paths and aborts), so params MUST precede
 * it. `buildArgs` always emits the flow file last.
 */
export function assembleMaestroArgs(baseArgs, paramArgs) {
    if (paramArgs.length === 0)
        return baseArgs;
    return [...baseArgs.slice(0, -1), ...paramArgs, baseArgs[baseArgs.length - 1]];
}
export function nestedMaestroAuthorityCallbacks(args) {
    return {
        claimNativeOrigin: () => claimManagedNativeOriginAuthority(args),
        completeNativeOrigin: (targetExpected) => completeManagedNativeOriginAuthority(args, targetExpected),
        relaunchManagedApp: () => relaunchManagedNativeOriginApp(args),
        reproveManagedOrigin: () => reproveManagedNativeOrigin(args),
        completeRunnerPark: () => completeManagedRunnerParkAuthority(args),
        reissueInstallReceipt: hasManagedInstallReissueAuthority(args)
            ? () => reissueManagedInstallAuthority(args)
            : null,
    };
}
export class MaestroStageExecutionError extends Error {
    completedResults;
    stageError;
    constructor(completedResults, stageError) {
        super(stageError instanceof Error ? stageError.message : String(stageError), {
            cause: stageError,
        });
        this.name = 'MaestroStageExecutionError';
        this.completedResults = [...completedResults];
        this.stageError = stageError;
    }
}
const lifecycleCommands = new Set(['launchApp', 'clearState', 'killApp', 'stopApp']);
function commandName(command) {
    if (typeof command === 'string')
        return command;
    if (!command || typeof command !== 'object' || Array.isArray(command))
        return null;
    const keys = Object.keys(command);
    return keys.length === 1 ? keys[0] : null;
}
function nestedLifecycleCommand(command) {
    if (!command || typeof command !== 'object' || Array.isArray(command))
        return false;
    const runFlow = command.runFlow;
    if (!runFlow || typeof runFlow !== 'object' || Array.isArray(runFlow))
        return false;
    const commands = runFlow.commands;
    return Array.isArray(commands) && commands.some(nestedLifecycleCommandOrSelf);
}
function nestedLifecycleCommandOrSelf(command) {
    const name = commandName(command);
    return (name !== null && lifecycleCommands.has(name)) || nestedLifecycleCommand(command);
}
export function planMaestroAuthorityStages(commands) {
    const stages = [];
    let pending = [];
    let targetExpected = true;
    const flushPending = () => {
        if (pending.length === 0)
            return;
        stages.push({ commands: pending, requiresOrigin: true });
        pending = [];
    };
    for (const command of commands) {
        const name = commandName(command);
        if (nestedLifecycleCommand(command)) {
            throw new MaestroValidationError('conditional runFlow commands cannot contain app lifecycle transitions');
        }
        if (name !== null && lifecycleCommands.has(name)) {
            flushPending();
            stages.push({ commands: [command], requiresOrigin: false });
            targetExpected = name === 'launchApp';
            continue;
        }
        pending.push(command);
    }
    flushPending();
    return { stages, targetExpected };
}
export async function executeMaestroAuthorityStages(commands, executeStage, claimOrigin, completeOrigin, relaunchManagedApp, reproveManagedOrigin) {
    const plan = planMaestroAuthorityStages(commands);
    const results = [];
    // GH #708: a relaunched dev-client can need the flow's own post-launch steps
    // (dev-server picker) before it re-registers. Carry the failure to flow end
    // instead of aborting between stages; the origin is still proven before this
    // run can report success.
    let pendingOriginError;
    for (const stage of plan.stages) {
        if (stage.requiresOrigin && pendingOriginError === undefined)
            await claimOrigin();
        try {
            results.push(await executeStage(stage.commands));
            if (stage.commands.length === 1 && commandName(stage.commands[0]) === 'launchApp') {
                try {
                    await relaunchManagedApp();
                    pendingOriginError = undefined;
                }
                catch (error) {
                    if (!reproveManagedOrigin || error instanceof SessionAuthorityError)
                        throw error;
                    pendingOriginError = error;
                }
            }
        }
        catch (error) {
            await completeOrigin(false);
            throw new MaestroStageExecutionError(results, error);
        }
    }
    if (pendingOriginError !== undefined) {
        try {
            await reproveManagedOrigin();
        }
        catch {
            await completeOrigin(false);
            throw new MaestroStageExecutionError(results, pendingOriginError);
        }
    }
    await completeOrigin(plan.targetExpected);
    return results;
}
export function resolveMaestroFlowAppId(boundAppId, parsedAppId) {
    if (boundAppId !== undefined && !isValidBundleId(boundAppId)) {
        throw new MaestroValidationError(`Invalid bundle ID for authority-bound app: ${JSON.stringify(boundAppId).slice(0, 80)}`);
    }
    if (boundAppId && parsedAppId && parsedAppId !== boundAppId) {
        throw new MaestroValidationError(`Flow appId ${parsedAppId} does not match authority-bound appId ${boundAppId}`);
    }
    return boundAppId ?? parsedAppId;
}
/** GH #116: Maestro env-style key pattern. Refuses anything that could
 *  syntactically be confused with a flag (`--`, `-e`) or break the
 *  KEY=VALUE join (`=`, space, control chars). Strict; documented. */
const PARAM_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
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
const UIAUTOMATION_SESSION_CREATION_FAILURE = /^Error: failed to create driver: create session: session not created: java\.lang\.IllegalStateException: UiAutomation not connected(?:, UiAutomation@[^\r\n]+)?$/;
function attachCause(error, cause) {
    if (error instanceof Error && error.cause === undefined) {
        try {
            Object.defineProperty(error, 'cause', { value: cause, configurable: true, writable: true });
        }
        catch {
            // a frozen/sealed error keeps its own message; the warning already carries the cause
        }
    }
    return error;
}
function isPreSpawnMaestroError(error) {
    const candidate = error;
    return typeof candidate?.code === 'string' && !candidate.stdout && !candidate.stderr;
}
export function isUiAutomationNotConnectedSessionCreationFailure(error) {
    const candidate = error;
    if (typeof candidate?.code !== 'number' ||
        candidate.code === 0 ||
        typeof candidate.stderr !== 'string') {
        return false;
    }
    const records = candidate.stderr
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    return records.length === 1 && UIAUTOMATION_SESSION_CREATION_FAILURE.test(records[0]);
}
/**
 * Read-only verification of the already-parked runner. The probe is the iOS
 * rn-fast-runner's, so on Android it would report an unhealthy runner that was
 * never involved in the run — omit the evidence there instead of lying.
 */
export async function buildRunnerResume(platform, probe) {
    if (platform !== 'ios')
        return undefined;
    return { attempted: true, healthy: await probe().catch(() => false) };
}
export function createMaestroRunHandler(deps = {}) {
    const fastHealthCheck = deps.fastHealthCheck ?? defaultFastHealthCheck;
    const activeSession = deps.getActiveSession ?? getActiveSession;
    const selectDispatch = deps.chooseDispatch ?? chooseMaestroDispatch;
    const parkFlow = deps.parkFlow ?? runFlowParked;
    const execute = deps.execFile ?? defaultExecFile;
    const now = deps.now ?? Date.now;
    return async (args) => {
        // GH #116: validate params shape FIRST so a malformed payload is rejected
        // regardless of platform / dispatch-tier availability. CI envs without
        // maestro-runner or Maestro CLI would otherwise short-circuit at
        // chooseMaestroDispatch before reaching the validator.
        if (args.params) {
            for (const [key, value] of Object.entries(args.params)) {
                if (!PARAM_KEY_RE.test(key)) {
                    return failResult(`Refusing to run Maestro: invalid param key '${String(key).slice(0, 60)}' ` +
                        `— must match ${PARAM_KEY_RE.source} (GH #116).`);
                }
                if (typeof value !== 'string') {
                    return failResult(`Refusing to run Maestro: param '${key}' has non-string value (GH #116).`);
                }
            }
        }
        const platform = resolvePlatform(args.platform);
        if (!platform) {
            return failResult('Cannot determine platform. Pass platform or open a device session first.');
        }
        const session = activeSession();
        const matchingSessionDeviceId = session?.platform === platform && session.deviceId ? session.deviceId : undefined;
        if (args.deviceId &&
            matchingSessionDeviceId &&
            !sameDevice(args.deviceId, matchingSessionDeviceId)) {
            return failResult(`Refusing Maestro target ${args.deviceId}: active ${platform} session is bound to ${matchingSessionDeviceId}.`, 'TARGET_SESSION_MISMATCH', { requestedDeviceId: args.deviceId, activeSessionDeviceId: matchingSessionDeviceId });
        }
        const requestedDeviceId = args.deviceId ??
            matchingSessionDeviceId ??
            (platform === 'android' ? process.env.ANDROID_SERIAL : undefined);
        if (requestedDeviceId !== undefined &&
            (requestedDeviceId.length === 0 ||
                requestedDeviceId.length > 256 ||
                /\s/.test(requestedDeviceId))) {
            return failResult('Refusing Maestro: deviceId must be 1-256 non-whitespace characters.', 'INVALID_ARGUMENT');
        }
        // GH #356/B223: the dispatch tier depends on whether the validated flow
        // uses hideKeyboard on Android, so the runner is chosen AFTER parsing below.
        let flowHasHideKeyboard = false;
        // Phase 134.1 (deepsec CRITICAL #4): both inlineYaml and flowPath
        // are caller-controlled. Parse, validate against the command allowlist
        // (rejecting runScript and other host-executing directives by default),
        // and re-serialize through buildMaestroFlow before writing the temp
        // file we actually execute. flowPath additionally must exist and is
        // read + validated identically — no longer trusted as "vetted because
        // it's on disk" (deepsec CRITICAL #5 covers the same disk-trust gap
        // in maestro_test_all).
        let flowFile;
        let rawYaml;
        let validatedContent;
        let validatedCommands;
        let headerAppId;
        if (args.inlineYaml) {
            rawYaml = args.inlineYaml;
        }
        else if (args.flowPath) {
            if (!existsSync(args.flowPath)) {
                return failResult(`Flow file not found: ${args.flowPath}`);
            }
            try {
                rawYaml = readFileSync(args.flowPath, 'utf-8');
            }
            catch (err) {
                return failResult(`Failed to read flow file: ${err.message}`);
            }
        }
        else {
            return failResult('Provide either flowPath or inlineYaml.');
        }
        try {
            // GH #186: when running a saved flow FILE, resolve+inline any runFlow file
            // refs relative to that file's directory, contained within it. Inline YAML
            // has no on-disk root, so runFlow file refs stay rejected there.
            const runFlowOpts = args.flowPath
                ? { flowDir: dirname(args.flowPath), flowRoot: dirname(args.flowPath) }
                : {};
            const parsed = parseAndValidateFlow(rawYaml, runFlowOpts);
            planMaestroAuthorityStages(parsed.commands);
            validatedCommands = parsed.commands;
            flowHasHideKeyboard = flowContainsHideKeyboard(parsed.commands);
            const rawAppId = resolveAppId(args.appId, platform);
            headerAppId = resolveMaestroFlowAppId(rawAppId || undefined, parsed.appId);
            validatedContent = buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, parsed.commands);
            // Unique per-call path — multi-LLM review caught the fixed
            // `/tmp/rn-maestro-inline.yaml` racing on concurrent maestro_run
            // calls (parallel test invocations could overwrite each other's
            // validated content between writeFileSync and execFile).
            flowFile = join(tmpdir(), `rn-maestro-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
            writeFileSync(flowFile, validatedContent, 'utf-8');
        }
        catch (err) {
            if (err instanceof MaestroValidationError) {
                return failResult(`Refusing to run Maestro: ${err.message} (Phase 134.1)`);
            }
            throw err;
        }
        // B59 + GH #356/B223: tiered dispatch — maestro-runner when viable, Maestro
        // CLI fallback when iOS-only and adb is missing, and (B223) the Maestro CLI
        // for Android flows that use hideKeyboard (maestro-runner no-ops it there).
        const dispatch = selectDispatch({ platform, flowHasHideKeyboard });
        if ('error' in dispatch) {
            return failResult(dispatch.error);
        }
        const timeout = args.timeoutMs ?? 120_000;
        const flowDeadline = now() + timeout;
        // GH #116: build the final argv. Start with the dispatch tier's
        // base args, then append `-e KEY=VALUE` pairs for any supplied
        // params. Validation already ran at the top of the handler so by
        // this point every key matches PARAM_KEY_RE and every value is a
        // string — no need to re-check.
        const appFileResolution = resolveAppFileForClearState(platform, validatedContent, headerAppId, args.appFile, { deviceId: requestedDeviceId });
        if (!appFileResolution.ok) {
            return failResult(appFileResolution.error);
        }
        // GH #705: only a clearState flow uninstalls and reinstalls; an --app-file
        // carried by any other flow is inert and must not re-issue the receipt.
        const reinstallsApp = Boolean(appFileResolution.appFile) && flowUsesClearState(validatedContent);
        const reissueInstallReceipt = args.reissueInstallReceipt ??
            deps.reissueInstallReceipt ??
            nestedMaestroAuthorityCallbacks(args).reissueInstallReceipt;
        let installReceiptCommitted = false;
        const commitReinstalledInstall = async () => {
            if (!reinstallsApp || installReceiptCommitted || !reissueInstallReceipt)
                return;
            installReceiptCommitted = true;
            await reissueInstallReceipt();
        };
        const baseArgs = dispatch.buildArgs(platform, flowFile, appFileResolution.appFile, requestedDeviceId);
        const paramArgs = [];
        if (args.params) {
            for (const [key, value] of Object.entries(args.params)) {
                paramArgs.push('-e', `${key}=${value}`);
            }
        }
        // A unique flattened report gives us maestro-runner's direct selected-device
        // and WDA target log. Never infer execution identity from requested argv.
        const runnerReportDir = createRunnerReportDir(dispatch.runner, 'rn-maestro-report');
        const finalArgs = assembleMaestroArgs(baseArgs, [
            ...runnerReportArgs(runnerReportDir),
            ...paramArgs,
        ]);
        const directRunnerEvidence = (output) => collectDirectRunnerEvidence(runnerReportDir, output);
        const releaseAndroidSlot = deps.releaseAndroidSlot ?? defaultReleaseAndroidSlot;
        const androidSlotReleaseWarnings = [];
        let releasedAndroidDeviceId;
        let uiAutomationRecoveryAttempted = false;
        let uiAutomationRecoveryRetried = false;
        const recordAndroidRelease = (outcome) => {
            if (outcome?.deviceId)
                releasedAndroidDeviceId = outcome.deviceId;
            if (outcome?.warnings?.length)
                androidSlotReleaseWarnings.push(...outcome.warnings);
        };
        const androidReleaseMeta = () => ({
            ...(androidSlotReleaseWarnings.length > 0
                ? { androidSlotReleaseWarnings: [...androidSlotReleaseWarnings] }
                : {}),
            ...(uiAutomationRecoveryAttempted
                ? {
                    androidUiAutomationRecovery: {
                        retried: uiAutomationRecoveryRetried,
                        retryCount: uiAutomationRecoveryRetried ? 1 : 0,
                    },
                }
                : {}),
        });
        const androidReleaseCaveat = () => androidSlotReleaseWarnings.length > 0
            ? `Android interaction-slot release warnings: ${androidSlotReleaseWarnings.join('; ')}`
            : undefined;
        // GH #397: engine-pin visibility. Detection is process-cached and fail-open
        // (null on error). The caveat rides the existing warn-once mechanism below;
        // RN_ENGINE_PIN_STRICT=1 opts into refusing PROVEN divergence only.
        const engineStatus = dispatch.runner === 'maestro-runner' ? await getEngineStatus().catch(() => null) : null;
        const pinCaveat = engineStatus ? enginePinCaveat(engineStatus) : null;
        const strictRefusal = strictPinRefusal(engineStatus, process.env.RN_ENGINE_PIN_STRICT);
        if (strictRefusal) {
            return failResult(strictRefusal, 'ENGINE_PIN_MISMATCH');
        }
        try {
            // 10MB buffer: a multi-step flow with screenshots + app console/network
            // logs routinely exceeds Node's 1MB execFile default, which would kill
            // the child with ERR_CHILD_PROCESS_STDIO_MAXBUFFER and mask a passing
            // run as a failure.
            const managedAuthority = nestedMaestroAuthorityCallbacks(args);
            const claimOrigin = args.claimNativeOrigin ?? deps.claimNativeOrigin ?? managedAuthority.claimNativeOrigin;
            const completeOrigin = args.completeNativeOrigin ??
                deps.completeNativeOrigin ??
                managedAuthority.completeNativeOrigin;
            const relaunchManagedApp = args.relaunchManagedApp ?? deps.relaunchManagedApp ?? managedAuthority.relaunchManagedApp;
            const reproveManagedOrigin = args.reproveManagedOrigin ??
                deps.reproveManagedOrigin ??
                managedAuthority.reproveManagedOrigin;
            const stageResults = await parkFlow(() => executeMaestroAuthorityStages(validatedCommands, async (commands) => {
                writeFileSync(flowFile, buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, [...commands]), 'utf-8');
                const executeOnce = async (beforeDispatch) => {
                    const remainingTimeout = flowDeadline - now();
                    if (remainingTimeout <= 0) {
                        const error = new Error('Maestro flow timeout exhausted before the next stage');
                        Object.assign(error, { code: 'ETIMEDOUT' });
                        throw error;
                    }
                    beforeDispatch?.();
                    return execute(dispatch.binPath, finalArgs, {
                        timeout: remainingTimeout,
                        encoding: 'utf8',
                        maxBuffer: 10 * 1024 * 1024,
                    });
                };
                try {
                    return await executeOnce();
                }
                catch (error) {
                    const recoveryDeviceId = requestedDeviceId ?? releasedAndroidDeviceId;
                    if (platform !== 'android' ||
                        uiAutomationRecoveryAttempted ||
                        !recoveryDeviceId ||
                        !isUiAutomationNotConnectedSessionCreationFailure(error)) {
                        throw error;
                    }
                    uiAutomationRecoveryAttempted = true;
                    const recoveryTimeout = flowDeadline - now();
                    if (recoveryTimeout <= 0) {
                        androidSlotReleaseWarnings.push('UiAutomation recovery skipped: Maestro flow timeout was exhausted');
                        throw error;
                    }
                    // NOTE: AbortSignal.timeout()'s timer is unref'd, so a cleanup
                    // awaiting only that signal never aborts once the loop drains.
                    const recoveryAbort = new AbortController();
                    const recoveryDeadlineTimer = setTimeout(() => {
                        recoveryAbort.abort(new Error('UiAutomation recovery cleanup exceeded the remaining Maestro flow timeout'));
                    }, recoveryTimeout);
                    try {
                        recordAndroidRelease(await releaseAndroidSlot({
                            deviceId: recoveryDeviceId,
                            includeLegacy: false,
                            signal: recoveryAbort.signal,
                        }));
                    }
                    catch (releaseError) {
                        androidSlotReleaseWarnings.push(`UiAutomation recovery release failed: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`);
                        throw attachCause(error, releaseError);
                    }
                    finally {
                        clearTimeout(recoveryDeadlineTimer);
                    }
                    try {
                        return await executeOnce(() => {
                            uiAutomationRecoveryRetried = true;
                        });
                    }
                    catch (retryError) {
                        if (uiAutomationRecoveryRetried && !isPreSpawnMaestroError(retryError)) {
                            throw retryError;
                        }
                        uiAutomationRecoveryRetried = false;
                        androidSlotReleaseWarnings.push(`UiAutomation recovery retry did not start: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
                        throw attachCause(error, retryError);
                    }
                }
            }, claimOrigin, completeOrigin, relaunchManagedApp, reproveManagedOrigin), {
                platform,
                deviceId: requestedDeviceId,
                releaseAndroidSlot,
                onAndroidRelease: recordAndroidRelease,
                completeRunnerPark: args.completeRunnerPark ?? managedAuthority.completeRunnerPark,
            });
            await commitReinstalledInstall();
            const stdout = stageResults.map((result) => result.stdout).join('\n');
            const stderr = stageResults.map((result) => result.stderr).join('\n');
            // combineRunnerOutput (not .trim()) so the step parser's leading-indent
            // anchor (B212) still sees the FIRST step line's indent — see GH #312.
            const output = combineRunnerOutput(stdout, stderr);
            // Reaching here means the runner exited 0 — that exit code is the
            // authoritative pass signal (a real flow failure exits non-zero and is
            // handled in the catch below). The output scan is only a secondary guard,
            // keyed on Maestro's own status LINES (GH#249: the prior bare `FAILED`
            // substring false-flagged passing runs whose app logs contained the token).
            const passed = !outputIndicatesFlowFailure(output);
            const directEvidence = directRunnerEvidence(output);
            const deviceAuthority = verifyMaestroDeviceAuthority({
                runner: dispatch.runner,
                platform,
                requestedDeviceId,
                output: directEvidence.output,
                directReportDeviceIds: directEvidence.reportDeviceIds,
                directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
                requireWdaProvenance: passed,
            });
            const authorityRefusal = maestroAuthorityRefusal(deviceAuthority);
            if (authorityRefusal) {
                return failResult(authorityRefusal, 'DEVICE_AUTHORITY_MISMATCH', {
                    flowFile,
                    platform,
                    runner: dispatch.runner,
                    transport: dispatch.runner,
                    passed: false,
                    deviceAuthority,
                    output: output.slice(0, 4000),
                    ...androidReleaseMeta(),
                });
            }
            const summary = buildStepSummary(output, { failed: !passed });
            const runnerResume = !passed ? await buildRunnerResume(platform, fastHealthCheck) : undefined;
            const meta = {
                passed,
                flowFile,
                platform,
                runner: dispatch.runner,
                transport: dispatch.runner,
                transportVersion: engineStatus?.version ?? null,
                fallback: dispatch.fallbackReason ? dispatch.runner : 'none',
                deviceAuthority,
                output: output.slice(0, 2000),
                ...summary,
                ...(!passed
                    ? { terminal: buildTerminalEvidence(output), ...(runnerResume ? { runnerResume } : {}) }
                    : {}),
                timedOut: false,
                outputTruncated: false,
                ...(dispatch.fallbackReason ? { fallbackReason: dispatch.fallbackReason } : {}),
                ...(dispatch.degradedReason ? { degradedReason: dispatch.degradedReason } : {}),
                ...(engineStatus && engineStatus.pin.status !== 'pinned-ok'
                    ? { enginePin: engineStatus.pin }
                    : {}),
                ...androidReleaseMeta(),
            };
            // GH #356/B223: a degradedReason (Android hideKeyboard with no Maestro CLI)
            // is a caveat surfaced the same way as a fallbackReason. GH #397: so is
            // an engine-pin drift (warn-once via the same mechanism).
            const caveat = dispatch.fallbackReason ?? dispatch.degradedReason ?? pinCaveat ?? undefined;
            const releaseCaveat = androidReleaseCaveat();
            if (passed) {
                // B59 (Gemini review, conf 82): on success-with-fallback, only emit
                // a loud warning the FIRST time per process so a 100-flow loop
                // doesn't generate 100 identical warnings. Subsequent successes
                // carry the reason silently in meta.
                const warnCaveat = caveat && shouldWarnFallback(caveat) ? caveat : undefined;
                if (releaseCaveat) {
                    return warnResult(meta, warnCaveat ? `${warnCaveat}; ${releaseCaveat}` : releaseCaveat);
                }
                if (warnCaveat) {
                    return warnResult(meta, warnCaveat);
                }
                return okResult(meta);
            }
            const baseWarnMsg = [caveat, releaseCaveat, 'Flow completed with warnings or failures']
                .filter((part) => Boolean(part))
                .join('; ');
            // GH #263: classify on the FULL output (not the sliced meta.output).
            const warnAug = augmentFailureWithDegradation(output, resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS), baseWarnMsg, meta);
            return warnResult(warnAug.meta, warnAug.message);
        }
        catch (err) {
            // A flow that died mid-way may still have reinstalled: re-issue before
            // reporting, so the failure is the flow's and not a broken axis I.
            await commitReinstalledInstall();
            if (err instanceof SessionAuthorityError) {
                err.attachMeta(androidReleaseMeta());
                throw err;
            }
            const stageError = err instanceof MaestroStageExecutionError ? err.stageError : err;
            const msg = stageError instanceof Error ? stageError.message : String(stageError);
            if (stageError instanceof ExactAndroidDeviceRequiredError) {
                return failResult(stageError.message, stageError.code, {
                    platform,
                    runner: dispatch.runner,
                    transport: dispatch.runner,
                    passed: false,
                    ...androidReleaseMeta(),
                });
            }
            // Multi-LLM review of PR #115 (Codex conf 95): when execFile
            // throws on timeout (or kill), Node attaches the partial stdout
            // and stderr to the error object. Preserve them in `data.output`
            // so downstream parsers (notably `cdp_run_action`'s
            // `parseMaestroFailure`) can still classify the underlying
            // failure — e.g. a SELECTOR_NOT_FOUND emitted just before the
            // timeout boundary. Without this, auto-repair is silently
            // pessimised exactly when devices are slow / under load.
            const errAny = stageError;
            const completed = err instanceof MaestroStageExecutionError
                ? err.completedResults
                : [];
            const stdout = [
                ...completed.map((result) => (typeof result.stdout === 'string' ? result.stdout : '')),
                typeof errAny?.stdout === 'string' ? errAny.stdout : '',
            ].join('\n');
            const stderr = [
                ...completed.map((result) => (typeof result.stderr === 'string' ? result.stderr : '')),
                typeof errAny?.stderr === 'string' ? errAny.stderr : '',
            ].join('\n');
            const combined = combineRunnerOutput(stdout, stderr);
            const { timedOut, outputTruncated } = classifyExecError(stageError);
            const directEvidence = directRunnerEvidence(combined);
            const deviceAuthority = verifyMaestroDeviceAuthority({
                runner: dispatch.runner,
                platform,
                requestedDeviceId,
                output: directEvidence.output,
                directReportDeviceIds: directEvidence.reportDeviceIds,
                directReportIdentityStrength: directEvidence.reportDeviceIdStrength,
            });
            const summary = buildStepSummary(combined, { failed: true });
            const spawnError = combined.length === 0 &&
                ['ENOENT', 'EACCES'].includes(String(stageError?.code ?? ''));
            const terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
            const runnerResume = await buildRunnerResume(platform, fastHealthCheck);
            // A run that produced no output never reached the device, so there is no
            // authority verdict to render — reporting one would mask the spawn/park
            // failure behind DEVICE_AUTHORITY_MISMATCH and refuse auto-repair.
            const catchRefusal = combined.length > 0 ? maestroAuthorityRefusal(deviceAuthority, msg) : null;
            if (catchRefusal) {
                return failResult(catchRefusal, 'DEVICE_AUTHORITY_MISMATCH', {
                    flowFile,
                    platform,
                    runner: dispatch.runner,
                    transport: dispatch.runner,
                    passed: false,
                    deviceAuthority,
                    output: combined.slice(0, 4000),
                    ...summary,
                    terminal,
                    ...(runnerResume ? { runnerResume } : {}),
                    timedOut,
                    outputTruncated,
                    ...androidReleaseMeta(),
                });
            }
            // Headline from structured data (raw-free); the raw err.message is the
            // fallback only for system errors with no step output (e.g. spawn ENOENT).
            const rawHeadline = formatFailureHeadline(summary, { timedOut, outputTruncated }, msg);
            const releaseCaveat = androidReleaseCaveat();
            const headline = releaseCaveat ? `${rawHeadline}; ${releaseCaveat}` : rawHeadline;
            // GH #263: a timeout/non-zero exit is also a failure surface — flag a
            // wedged runtime here too if the successful taps were degraded.
            const failAug = augmentFailureWithDegradation(combined, resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS), headline, {
                flowFile,
                platform,
                runner: dispatch.runner,
                transport: dispatch.runner,
                transportVersion: engineStatus?.version ?? null,
                fallback: dispatch.fallbackReason ? dispatch.runner : 'none',
                deviceAuthority,
                passed: false,
                // `output` mirrors the success/warn shape so callers can read
                // it the same way regardless of which path they hit.
                output: combined.slice(0, 4000),
                ...summary,
                terminal,
                ...(runnerResume ? { runnerResume } : {}),
                timedOut,
                outputTruncated,
                // GH #397: a drifted/mismatched engine causing a real failure is
                // exactly when the pin state matters — carry it on this path too.
                ...(engineStatus && engineStatus.pin.status !== 'pinned-ok'
                    ? { enginePin: engineStatus.pin }
                    : {}),
                ...androidReleaseMeta(),
            });
            return failResult(failAug.message, failAug.meta);
        }
        finally {
            try {
                writeFileSync(flowFile, validatedContent, 'utf-8');
            }
            finally {
                disposeRunnerReportDir(runnerReportDir);
            }
        }
    };
}
