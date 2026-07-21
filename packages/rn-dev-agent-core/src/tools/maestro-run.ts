import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { getEngineStatus, enginePinCaveat, strictPinRefusal } from '../domain/engine-pin.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { resolveBundleId, readExpoSlug } from '../project-config.js';
import {
  chooseMaestroDispatch,
  shouldWarnFallback,
  flowContainsHideKeyboard,
  type MaestroDispatchInputs,
} from './maestro-dispatch.js';
import { resolveAppFileForClearState } from './resolve-ios-app-file.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  isValidBundleId,
  MaestroValidationError,
} from '../domain/maestro-validator.js';
import { outputIndicatesFlowFailure } from '../domain/maestro-error-parser.js';
import { augmentFailureWithDegradation, resolveFloorMs } from '../domain/tap-latency.js';
import {
  buildStepSummary,
  buildTerminalEvidence,
  classifyExecError,
  combineRunnerOutput,
  formatFailureHeadline,
} from '../domain/maestro-step-parser.js';
import {
  fastHealthCheck as defaultFastHealthCheck,
  stopFastRunner as defaultStopFastRunner,
} from '../runners/rn-fast-runner-client.js';
import { releaseAndroidInteractionSlot as defaultReleaseAndroidSlot } from '../runners/release-android-slot.js';
import { markCdpStale as defaultMarkCdpStale } from '../cdp/recovery.js';
import {
  sameDevice,
  shouldRejectMaestroDeviceAuthority,
  verifyMaestroDeviceAuthority,
} from '../domain/maestro-device-authority.js';
import {
  collectDirectRunnerEvidence,
  createRunnerReportDir,
  disposeRunnerReportDir,
  runnerReportArgs,
} from '../domain/maestro-runner-report.js';
import type { SessionState } from '../types.js';

const defaultExecFile = promisify(execFileCb);

export interface FlowParkOpts {
  platform?: 'ios' | 'android';
  deviceId?: string;
  stopFastRunner?: (deviceId?: string) => void;
  markCdpStale?: () => void;
  releaseAndroidSlot?: (opts: { deviceId?: string }) => Promise<void>;
}

/**
 * GH#202 Phase 2a + GH#237: run a Maestro flow with L2 parked. iOS stops the
 * fast-runner (XCTest); Android releases the single UiAutomation slot (our
 * runner's instrumentation would otherwise block maestro-runner's UIAutomator2
 * server — #237). Mark CDP stale afterward (always — even on failure) so the
 * next read reconnects to post-flow state. The L2 runner lazily restarts on the
 * next device_* call. MUST run inside the held arbiter `flow` lease.
 */
export async function runFlowParked<T>(run: () => Promise<T>, opts: FlowParkOpts = {}): Promise<T> {
  const stale = opts.markCdpStale ?? defaultMarkCdpStale;
  try {
    if (opts.platform === 'android') {
      const release = opts.releaseAndroidSlot ?? defaultReleaseAndroidSlot;
      await release({ deviceId: opts.deviceId });
    } else {
      (opts.stopFastRunner ?? defaultStopFastRunner)(opts.deviceId);
    }
    return await run();
  } finally {
    stale();
  }
}

/**
 * Splice `-e KEY=VALUE` param pairs in just before the flow file. Both runners
 * treat args trailing the flow file as additional flow files (maestro-runner
 * then `stat`s `-e`/`KEY=VALUE` as paths and aborts), so params MUST precede
 * it. `buildArgs` always emits the flow file last.
 */
export function assembleMaestroArgs(baseArgs: string[], paramArgs: string[]): string[] {
  if (paramArgs.length === 0) return baseArgs;
  return [...baseArgs.slice(0, -1), ...paramArgs, baseArgs[baseArgs.length - 1]];
}

interface MaestroRunArgs {
  flowPath?: string;
  inlineYaml?: string;
  platform?: 'ios' | 'android';
  appId?: string;
  appFile?: string;
  /** Exact UDID/serial. Defaults only from a matching active device session. */
  deviceId?: string;
  timeoutMs?: number;
  /**
   * GH #116: per-flow parameter bindings forwarded as `-e KEY=VALUE`
   * pairs to the maestro-runner subprocess. Keys must match
   * /^[A-Z_][A-Z0-9_]*$/ (Maestro's documented env-style convention) —
   * any other key shape is refused so a malformed/hostile payload can't
   * become a shell-injectable flag. Values are NOT quoted; they're
   * passed as separate argv entries so shell metacharacters are inert
   * by construction (execFile, not exec).
   */
  params?: Record<string, string>;
}

/** GH #116: Maestro env-style key pattern. Refuses anything that could
 *  syntactically be confused with a flag (`--`, `-e`) or break the
 *  KEY=VALUE join (`=`, space, control chars). Strict; documented. */
const PARAM_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

function resolvePlatform(override?: string): 'ios' | 'android' | null {
  if (override === 'ios' || override === 'android') return override;
  const session = getActiveSession();
  return (session?.platform as 'ios' | 'android' | undefined) ?? null;
}

function resolveAppId(override?: string, platform?: string): string {
  if (override) return override;
  if (platform) return resolveBundleId(platform) ?? readExpoSlug() ?? '';
  return readExpoSlug() ?? '';
}

export interface MaestroRunDeps {
  fastHealthCheck?: () => Promise<boolean>;
  getActiveSession?: () => SessionState | null;
  chooseDispatch?: typeof chooseMaestroDispatch;
  parkFlow?: typeof runFlowParked;
  execFile?: (
    file: string,
    args: string[],
    options: { timeout: number; encoding: 'utf8'; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface RunnerResumeEvidence {
  attempted: boolean;
  healthy: boolean;
}

/**
 * Read-only verification of the already-parked runner. The probe is the iOS
 * rn-fast-runner's, so on Android it would report an unhealthy runner that was
 * never involved in the run — omit the evidence there instead of lying.
 */
export async function buildRunnerResume(
  platform: 'ios' | 'android',
  probe: () => Promise<boolean>,
): Promise<RunnerResumeEvidence | undefined> {
  if (platform !== 'ios') return undefined;
  return { attempted: true, healthy: await probe().catch(() => false) };
}

export function createMaestroRunHandler(
  deps: MaestroRunDeps = {},
): (args: MaestroRunArgs) => Promise<ToolResult> {
  const fastHealthCheck = deps.fastHealthCheck ?? defaultFastHealthCheck;
  const activeSession = deps.getActiveSession ?? getActiveSession;
  const selectDispatch = deps.chooseDispatch ?? chooseMaestroDispatch;
  const parkFlow = deps.parkFlow ?? runFlowParked;
  const execute = deps.execFile ?? defaultExecFile;
  return async (args) => {
    // GH #116: validate params shape FIRST so a malformed payload is rejected
    // regardless of platform / dispatch-tier availability. CI envs without
    // maestro-runner or Maestro CLI would otherwise short-circuit at
    // chooseMaestroDispatch before reaching the validator.
    if (args.params) {
      for (const [key, value] of Object.entries(args.params)) {
        if (!PARAM_KEY_RE.test(key)) {
          return failResult(
            `Refusing to run Maestro: invalid param key '${String(key).slice(0, 60)}' ` +
              `— must match ${PARAM_KEY_RE.source} (GH #116).`,
          );
        }
        if (typeof value !== 'string') {
          return failResult(
            `Refusing to run Maestro: param '${key}' has non-string value (GH #116).`,
          );
        }
      }
    }

    const platform = resolvePlatform(args.platform);
    if (!platform) {
      return failResult('Cannot determine platform. Pass platform or open a device session first.');
    }

    const session = activeSession();
    const matchingSessionDeviceId =
      session?.platform === platform && session.deviceId ? session.deviceId : undefined;
    if (
      args.deviceId &&
      matchingSessionDeviceId &&
      !sameDevice(args.deviceId, matchingSessionDeviceId)
    ) {
      return failResult(
        `Refusing Maestro target ${args.deviceId}: active ${platform} session is bound to ${matchingSessionDeviceId}.`,
        'TARGET_SESSION_MISMATCH',
        { requestedDeviceId: args.deviceId, activeSessionDeviceId: matchingSessionDeviceId },
      );
    }
    const requestedDeviceId = args.deviceId ?? matchingSessionDeviceId;
    if (
      requestedDeviceId !== undefined &&
      (requestedDeviceId.length === 0 ||
        requestedDeviceId.length > 256 ||
        /\s/.test(requestedDeviceId))
    ) {
      return failResult(
        'Refusing Maestro: deviceId must be 1-256 non-whitespace characters.',
        'INVALID_ARGUMENT',
      );
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
    let flowFile: string;
    let rawYaml: string;
    let validatedContent: string;
    let headerAppId: string | undefined;

    if (args.inlineYaml) {
      rawYaml = args.inlineYaml;
    } else if (args.flowPath) {
      if (!existsSync(args.flowPath)) {
        return failResult(`Flow file not found: ${args.flowPath}`);
      }
      try {
        rawYaml = readFileSync(args.flowPath, 'utf-8');
      } catch (err) {
        return failResult(`Failed to read flow file: ${(err as Error).message}`);
      }
    } else {
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
      flowHasHideKeyboard = flowContainsHideKeyboard(parsed.commands);
      const rawAppId = resolveAppId(args.appId, platform);
      headerAppId = parsed.appId ?? (rawAppId && isValidBundleId(rawAppId) ? rawAppId : undefined);
      if (rawAppId && !parsed.appId && !isValidBundleId(rawAppId)) {
        return failResult(
          `Refusing to run Maestro: invalid bundle ID '${String(rawAppId).slice(0, 80)}' from project config (Phase 134.1)`,
        );
      }
      validatedContent = buildMaestroFlow(
        headerAppId ? { appId: headerAppId } : {},
        parsed.commands,
      );
      // Unique per-call path — multi-LLM review caught the fixed
      // `/tmp/rn-maestro-inline.yaml` racing on concurrent maestro_run
      // calls (parallel test invocations could overwrite each other's
      // validated content between writeFileSync and execFile).
      flowFile = join(
        tmpdir(),
        `rn-maestro-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
      );
      writeFileSync(flowFile, validatedContent, 'utf-8');
    } catch (err) {
      if (err instanceof MaestroValidationError) {
        return failResult(`Refusing to run Maestro: ${err.message} (Phase 134.1)`);
      }
      throw err;
    }

    // B59 + GH #356/B223: tiered dispatch — maestro-runner when viable, Maestro
    // CLI fallback when iOS-only and adb is missing, and (B223) the Maestro CLI
    // for Android flows that use hideKeyboard (maestro-runner no-ops it there).
    const dispatch = selectDispatch({ platform, flowHasHideKeyboard } as MaestroDispatchInputs);
    if ('error' in dispatch) {
      return failResult(dispatch.error);
    }

    const timeout = args.timeoutMs ?? 120_000;

    // GH #116: build the final argv. Start with the dispatch tier's
    // base args, then append `-e KEY=VALUE` pairs for any supplied
    // params. Validation already ran at the top of the handler so by
    // this point every key matches PARAM_KEY_RE and every value is a
    // string — no need to re-check.
    const appFileResolution = resolveAppFileForClearState(
      platform,
      validatedContent,
      headerAppId,
      args.appFile,
    );
    if (!appFileResolution.ok) {
      return failResult(appFileResolution.error);
    }
    const baseArgs = dispatch.buildArgs(
      platform,
      flowFile,
      appFileResolution.appFile,
      requestedDeviceId,
    );
    const paramArgs: string[] = [];
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
    const directRunnerEvidence = (output: string) =>
      collectDirectRunnerEvidence(runnerReportDir, output);

    // GH #397: engine-pin visibility. Detection is process-cached and fail-open
    // (null on error). The caveat rides the existing warn-once mechanism below;
    // RN_ENGINE_PIN_STRICT=1 opts into refusing PROVEN divergence only.
    const engineStatus =
      dispatch.runner === 'maestro-runner' ? await getEngineStatus().catch(() => null) : null;
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
      const { stdout, stderr } = await parkFlow(
        () =>
          execute(dispatch.binPath, finalArgs, {
            timeout,
            encoding: 'utf8',
            maxBuffer: 10 * 1024 * 1024,
          }),
        { platform, deviceId: requestedDeviceId },
      );

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
        requireWdaProvenance: passed,
      });
      if (shouldRejectMaestroDeviceAuthority(deviceAuthority)) {
        return failResult(
          `Maestro device authority refused: requested ${requestedDeviceId}, direct runner/WDA evidence was ${deviceAuthority.reportedDeviceId ?? 'missing'} (${deviceAuthority.reason}).`,
          'DEVICE_AUTHORITY_MISMATCH',
          {
            flowFile,
            platform,
            runner: dispatch.runner,
            transport: dispatch.runner,
            passed: false,
            deviceAuthority,
            output: output.slice(0, 4000),
          },
        );
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
      };

      // GH #356/B223: a degradedReason (Android hideKeyboard with no Maestro CLI)
      // is a caveat surfaced the same way as a fallbackReason. GH #397: so is
      // an engine-pin drift (warn-once via the same mechanism).
      const caveat = dispatch.fallbackReason ?? dispatch.degradedReason ?? pinCaveat ?? undefined;

      if (passed) {
        // B59 (Gemini review, conf 82): on success-with-fallback, only emit
        // a loud warning the FIRST time per process so a 100-flow loop
        // doesn't generate 100 identical warnings. Subsequent successes
        // carry the reason silently in meta.
        if (caveat && shouldWarnFallback(caveat)) {
          return warnResult(meta, caveat);
        }
        return okResult(meta);
      }
      const baseWarnMsg = caveat
        ? `${caveat}; flow completed with warnings or failures`
        : 'Flow completed with warnings or failures';
      // GH #263: classify on the FULL output (not the sliced meta.output).
      const warnAug = augmentFailureWithDegradation(
        output,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        baseWarnMsg,
        meta,
      );
      return warnResult(warnAug.meta, warnAug.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Multi-LLM review of PR #115 (Codex conf 95): when execFile
      // throws on timeout (or kill), Node attaches the partial stdout
      // and stderr to the error object. Preserve them in `data.output`
      // so downstream parsers (notably `cdp_run_action`'s
      // `parseMaestroFailure`) can still classify the underlying
      // failure — e.g. a SELECTOR_NOT_FOUND emitted just before the
      // timeout boundary. Without this, auto-repair is silently
      // pessimised exactly when devices are slow / under load.
      const errAny = err as { stdout?: unknown; stderr?: unknown };
      const stdout = typeof errAny?.stdout === 'string' ? errAny.stdout : '';
      const stderr = typeof errAny?.stderr === 'string' ? errAny.stderr : '';
      const combined = combineRunnerOutput(stdout, stderr);
      const { timedOut, outputTruncated } = classifyExecError(err);
      const directEvidence = directRunnerEvidence(combined);
      const deviceAuthority = verifyMaestroDeviceAuthority({
        runner: dispatch.runner,
        platform,
        requestedDeviceId,
        output: directEvidence.output,
        directReportDeviceIds: directEvidence.reportDeviceIds,
      });
      const summary = buildStepSummary(combined, { failed: true });
      const spawnError =
        combined.length === 0 &&
        ['ENOENT', 'EACCES'].includes(String((err as { code?: unknown } | null)?.code ?? ''));
      const terminal = buildTerminalEvidence(combined, { timedOut, spawnError });
      const runnerResume = await buildRunnerResume(platform, fastHealthCheck);
      if (shouldRejectMaestroDeviceAuthority(deviceAuthority)) {
        return failResult(
          `Maestro device authority refused: requested ${requestedDeviceId}, direct runner/WDA evidence was ${deviceAuthority.reportedDeviceId ?? 'missing'} (${deviceAuthority.reason}).`,
          'DEVICE_AUTHORITY_MISMATCH',
          {
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
          },
        );
      }
      // Headline from structured data (raw-free); the raw err.message is the
      // fallback only for system errors with no step output (e.g. spawn ENOENT).
      const headline = formatFailureHeadline(summary, { timedOut, outputTruncated }, msg);
      // GH #263: a timeout/non-zero exit is also a failure surface — flag a
      // wedged runtime here too if the successful taps were degraded.
      const failAug = augmentFailureWithDegradation(
        combined,
        resolveFloorMs(process.env.RN_RUNTIME_DEGRADED_FLOOR_MS),
        headline,
        {
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
        },
      );
      return failResult(failAug.message, failAug.meta);
    } finally {
      disposeRunnerReportDir(runnerReportDir);
    }
  };
}
