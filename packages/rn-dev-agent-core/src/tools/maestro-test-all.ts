import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import {
  chooseMaestroDispatch,
  shouldWarnFallback,
  flowContainsHideKeyboard,
} from './maestro-dispatch.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  MaestroValidationError,
} from '../domain/maestro-validator.js';
import { assembleMaestroArgs, runFlowParked } from './maestro-run.js';
import { outputIndicatesFlowFailure } from '../domain/maestro-error-parser.js';
import { resolveAppFileForClearState } from './resolve-ios-app-file.js';
import {
  maestroAuthorityRefusal,
  sameDevice,
  verifyMaestroDeviceAuthority,
  type MaestroDeviceAuthority,
} from '../domain/maestro-device-authority.js';
import {
  collectDirectRunnerEvidence,
  createRunnerReportDir,
  disposeRunnerReportDir,
  runnerReportArgs,
} from '../domain/maestro-runner-report.js';

const execFile = promisify(execFileCb);

interface MaestroTestAllArgs {
  platform?: 'ios' | 'android';
  deviceId?: string;
  flowDir?: string;
  pattern?: string;
  timeoutPerFlow?: number;
  stopOnFailure?: boolean;
}

interface FlowResult {
  name: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  deviceAuthority?: MaestroDeviceAuthority;
}

function discoverFlows(dir: string, pattern?: string): string[] {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir, { recursive: true }) as string[];
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
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      return yamls;
    }
    return yamls.filter((f) => re.test(f));
  }
  return yamls;
}

export function createMaestroTestAllHandler(): (args: MaestroTestAllArgs) => Promise<ToolResult> {
  return async (args) => {
    const platform = (args.platform ?? getActiveSession()?.platform) as
      | 'ios'
      | 'android'
      | undefined;
    if (!platform) {
      return failResult('Cannot determine platform. Pass platform or open a device session first.');
    }
    const session = getActiveSession();
    const matchingSessionDeviceId =
      session?.platform === platform && session.deviceId ? session.deviceId : undefined;
    if (
      args.deviceId &&
      matchingSessionDeviceId &&
      !sameDevice(args.deviceId, matchingSessionDeviceId)
    ) {
      return failResult(
        `Refusing Maestro suite target ${args.deviceId}: active ${platform} session is bound to ${matchingSessionDeviceId}.`,
        'TARGET_SESSION_MISMATCH',
        { requestedDeviceId: args.deviceId, activeSessionDeviceId: matchingSessionDeviceId },
      );
    }
    const requestedDeviceId = args.deviceId ?? matchingSessionDeviceId;

    // B59: tiered dispatch (see maestro-dispatch.ts) — picks maestro-runner
    // when viable, falls back to the Maestro CLI on iOS+no-adb machines.
    const dispatch = chooseMaestroDispatch({ platform });
    if ('error' in dispatch) {
      return failResult(dispatch.error);
    }

    const root = findProjectRoot();
    const flowDir = args.flowDir ?? (root ? join(root, '.rn-agent', 'actions') : null);
    if (!flowDir) {
      return failResult('Cannot determine project root. Pass flowDir explicitly.');
    }

    const flows = discoverFlows(flowDir, args.pattern);
    if (flows.length === 0) {
      return failResult(
        `No Maestro flows found in ${flowDir}. Generate flows with maestro_generate first.`,
      );
    }

    const timeout = args.timeoutPerFlow ?? 120_000;
    const results: FlowResult[] = [];
    let passed = 0;
    let failed = 0;
    // GH #356/B223: surfaced once if any Android flow needed hideKeyboard but
    // the Maestro CLI was unavailable, so it ran on maestro-runner (no-op).
    let keyboardCaveat: string | null = null;

    for (const flow of flows) {
      const name = flow.replace(flowDir + '/', '');
      const start = Date.now();

      // Phase 134.1 (deepsec CRITICAL #5): read + validate every
      // discovered flow before execution. Auto-discovery is the highest-
      // trust gap in the codebase: a malicious project file (or a
      // prompt-injected save earlier in the session) lands here for
      // replay otherwise. Write the canonical re-serialization to a temp
      // file and execute that — never the on-disk YAML directly, so
      // any inert metadata or duplicated headers can't sneak through.
      let safeFlowFile: string;
      let appFile: string | undefined;
      let flowHasHideKeyboard = false;
      try {
        const yamlText = readFileSync(flow, 'utf-8');
        const parsed = parseAndValidateFlow(yamlText);
        flowHasHideKeyboard = flowContainsHideKeyboard(parsed.commands);
        const canonical = buildMaestroFlow(
          parsed.appId !== undefined ? { appId: parsed.appId } : {},
          parsed.commands,
        );
        safeFlowFile = join(
          tmpdir(),
          `rn-maestro-validated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`,
        );
        writeFileSync(safeFlowFile, canonical, 'utf-8');
        // GH#201 parity with maestro_run: an iOS clearState flow must reinstall
        // the app, which maestro-runner can only do given --app-file.
        const appFileResolution = resolveAppFileForClearState(
          platform,
          canonical,
          parsed.appId,
          undefined,
        );
        if (!appFileResolution.ok) {
          results.push({
            name,
            passed: false,
            durationMs: Date.now() - start,
            error: appFileResolution.error.slice(0, 300),
          });
          failed++;
          if (args.stopOnFailure) break;
          continue;
        }
        appFile = appFileResolution.appFile;
      } catch (err) {
        const reason =
          err instanceof MaestroValidationError
            ? `Refused by validator: ${err.message}`
            : `Read/parse error: ${(err as Error).message}`;
        results.push({
          name,
          passed: false,
          durationMs: Date.now() - start,
          error: reason.slice(0, 300),
        });
        failed++;
        if (args.stopOnFailure) break;
        continue;
      }

      // GH #356/B223: Android flows that use hideKeyboard must run via the
      // official Maestro CLI (maestro-runner no-ops hideKeyboard on Android).
      // Re-route per flow; fall back to the base dispatch if re-selection errors.
      let flowDispatch = dispatch;
      if (platform === 'android' && flowHasHideKeyboard) {
        const rerouted = chooseMaestroDispatch({ platform, flowHasHideKeyboard: true });
        if (!('error' in rerouted)) {
          flowDispatch = rerouted;
          if (rerouted.degradedReason) keyboardCaveat ??= rerouted.degradedReason;
        }
      }

      const runnerReportDir = createRunnerReportDir(flowDispatch.runner, 'rn-maestro-suite-report');
      const baseArgs = flowDispatch.buildArgs(platform, safeFlowFile, appFile, requestedDeviceId);
      const finalArgs = assembleMaestroArgs(baseArgs, runnerReportArgs(runnerReportDir));

      try {
        const { stdout, stderr } = await runFlowParked(
          () =>
            execFile(flowDispatch.binPath, finalArgs, {
              timeout,
              encoding: 'utf8',
              maxBuffer: 10 * 1024 * 1024,
            }),
          { platform, deviceId: requestedDeviceId },
        );
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
          requireWdaProvenance: outputPassed,
        });
        const authorityRefusal = maestroAuthorityRefusal(deviceAuthority);
        const ok = outputPassed && !authorityRefusal;

        results.push({
          name,
          passed: ok,
          durationMs: Date.now() - start,
          error: authorityRefusal ?? (ok ? undefined : output.slice(0, 300)),
          deviceAuthority,
        });

        if (ok) passed++;
        else failed++;

        if (!ok && args.stopOnFailure) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const errWithOutput = err as { stdout?: unknown; stderr?: unknown };
        const capturedOutput = [errWithOutput.stdout, errWithOutput.stderr]
          .filter((value): value is string => typeof value === 'string')
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
            })
          : null;
        const authorityRefusal = deviceAuthority
          ? maestroAuthorityRefusal(deviceAuthority, msg.slice(0, 300))
          : null;
        results.push({
          name,
          passed: false,
          durationMs: Date.now() - start,
          error: authorityRefusal ?? msg.slice(0, 300),
          ...(deviceAuthority ? { deviceAuthority } : {}),
        });
        failed++;
        if (args.stopOnFailure) break;
      } finally {
        disposeRunnerReportDir(runnerReportDir);
      }
    }

    // GH #356/B223: surface the base dispatch's fallback reason, or (if any
    // Android hideKeyboard flow had to degrade to maestro-runner) the keyboard caveat.
    const batchCaveat = dispatch.fallbackReason ?? keyboardCaveat;
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
