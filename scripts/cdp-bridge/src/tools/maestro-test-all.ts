import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { chooseMaestroDispatch, shouldWarnFallback } from './maestro-dispatch.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  MaestroValidationError,
} from '../domain/maestro-validator.js';
import { runFlowParked } from './maestro-run.js';
import { outputIndicatesFlowFailure } from '../domain/maestro-error-parser.js';
import { resolveAppFileForClearState } from './resolve-ios-app-file.js';

const execFile = promisify(execFileCb);

interface MaestroTestAllArgs {
  platform?: 'ios' | 'android';
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
    const platform = (args.platform ?? getActiveSession()?.platform) as 'ios' | 'android' | undefined;
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
    const flowDir = args.flowDir ?? (root ? join(root, '.rn-agent', 'actions') : null);
    if (!flowDir) {
      return failResult('Cannot determine project root. Pass flowDir explicitly.');
    }

    const flows = discoverFlows(flowDir, args.pattern);
    if (flows.length === 0) {
      return failResult(`No Maestro flows found in ${flowDir}. Generate flows with maestro_generate first.`);
    }

    const timeout = args.timeoutPerFlow ?? 120_000;
    const results: FlowResult[] = [];
    let passed = 0;
    let failed = 0;

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
      try {
        const yamlText = readFileSync(flow, 'utf-8');
        const parsed = parseAndValidateFlow(yamlText);
        const canonical = buildMaestroFlow(
          parsed.appId !== undefined ? { appId: parsed.appId } : {},
          parsed.commands,
        );
        safeFlowFile = join(tmpdir(), `rn-maestro-validated-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
        writeFileSync(safeFlowFile, canonical, 'utf-8');
        // GH#201 parity with maestro_run: an iOS clearState flow must reinstall
        // the app, which maestro-runner can only do given --app-file.
        const appFileResolution = resolveAppFileForClearState(platform, canonical, parsed.appId, undefined);
        if (!appFileResolution.ok) {
          results.push({ name, passed: false, durationMs: Date.now() - start, error: appFileResolution.error.slice(0, 300) });
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

      try {
        const { stdout, stderr } = await runFlowParked(
          () =>
            execFile(
              dispatch.binPath,
              dispatch.buildArgs(platform, safeFlowFile, appFile),
              { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
            ),
          { platform, deviceId: getActiveSession()?.deviceId },
        );
        const output = (stdout + '\n' + stderr).trim();
        // The runner already exited 0 here, so that exit code is the
        // authoritative pass signal. The secondary scan keys on Maestro's own
        // status LINES (GH#249: a bare `FAILED` substring false-flagged passing
        // runs whose app logs contained the token; mirrors the maestro_run fix).
        const ok = !outputIndicatesFlowFailure(output);

        results.push({
          name,
          passed: ok,
          durationMs: Date.now() - start,
          error: ok ? undefined : output.slice(0, 300),
        });

        if (ok) passed++;
        else failed++;

        if (!ok && args.stopOnFailure) break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        results.push({
          name,
          passed: false,
          durationMs: Date.now() - start,
          error: msg.slice(0, 300),
        });
        failed++;
        if (args.stopOnFailure) break;
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
      return warnResult(
        summary,
        dispatch.fallbackReason ? `${dispatch.fallbackReason}; ${baseMsg}` : baseMsg,
      );
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
