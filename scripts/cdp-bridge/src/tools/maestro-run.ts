import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import type { ToolResult } from '../utils.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { resolveBundleId, readExpoSlug } from '../project-config.js';
import { chooseMaestroDispatch, shouldWarnFallback } from './maestro-dispatch.js';
import { flowUsesClearState, resolveIosAppFile } from './resolve-ios-app-file.js';
import {
  buildMaestroFlow,
  parseAndValidateFlow,
  isValidBundleId,
  MaestroValidationError,
} from '../domain/maestro-validator.js';

const execFile = promisify(execFileCb);

interface MaestroRunArgs {
  flowPath?: string;
  inlineYaml?: string;
  platform?: 'ios' | 'android';
  appId?: string;
  appFile?: string;
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

export function createMaestroRunHandler(): (args: MaestroRunArgs) => Promise<ToolResult> {
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
      return failResult(
        'Cannot determine platform. Pass platform or open a device session first.',
      );
    }

    // B59: tiered dispatch — maestro-runner when viable, Maestro CLI fallback
    // when iOS-only and adb is missing, fail-fast with install hints when neither.
    const dispatch = chooseMaestroDispatch({ platform });
    if ('error' in dispatch) {
      return failResult(dispatch.error);
    }

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
      const rawAppId = resolveAppId(args.appId, platform);
      headerAppId = parsed.appId ?? (rawAppId && isValidBundleId(rawAppId) ? rawAppId : undefined);
      if (rawAppId && !parsed.appId && !isValidBundleId(rawAppId)) {
        return failResult(`Refusing to run Maestro: invalid bundle ID '${String(rawAppId).slice(0, 80)}' from project config (Phase 134.1)`);
      }
      validatedContent = buildMaestroFlow(headerAppId ? { appId: headerAppId } : {}, parsed.commands);
      // Unique per-call path — multi-LLM review caught the fixed
      // `/tmp/rn-maestro-inline.yaml` racing on concurrent maestro_run
      // calls (parallel test invocations could overwrite each other's
      // validated content between writeFileSync and execFile).
      flowFile = join(tmpdir(), `rn-maestro-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
      writeFileSync(flowFile, validatedContent, 'utf-8');
    } catch (err) {
      if (err instanceof MaestroValidationError) {
        return failResult(`Refusing to run Maestro: ${err.message} (Phase 134.1)`);
      }
      throw err;
    }

    const timeout = args.timeoutMs ?? 120_000;

    // GH #116: build the final argv. Start with the dispatch tier's
    // base args, then append `-e KEY=VALUE` pairs for any supplied
    // params. Validation already ran at the top of the handler so by
    // this point every key matches PARAM_KEY_RE and every value is a
    // string — no need to re-check.
    let appFile = args.appFile;
    if (!appFile && platform === 'ios' && flowUsesClearState(validatedContent)) {
      if (!headerAppId) {
        return failResult(
          'Flow uses clearState on iOS but no appId is known to locate the .app. ' +
          'Add `appId:` to the flow header or pass appFile=<path-to-.app>.',
        );
      }
      appFile = resolveIosAppFile(headerAppId) ?? undefined;
      if (!appFile) {
        return failResult(
          `Flow uses clearState on iOS but no built .app could be located for ${headerAppId}. ` +
          'Pass appFile=<path-to-.app> (e.g. <DerivedData>/Build/Products/Debug-iphonesimulator/<App>.app).',
        );
      }
    }
    const baseArgs = dispatch.buildArgs(platform, flowFile, appFile);
    const paramArgs: string[] = [];
    if (args.params) {
      for (const [key, value] of Object.entries(args.params)) {
        paramArgs.push('-e', `${key}=${value}`);
      }
    }
    const finalArgs = [...baseArgs, ...paramArgs];

    try {
      const { stdout, stderr } = await execFile(
        dispatch.binPath,
        finalArgs,
        { timeout, encoding: 'utf8' },
      );

      const output = (stdout + '\n' + stderr).trim();
      // Reaching here means the runner exited 0 — that exit code is the
      // authoritative pass signal (a real flow failure exits non-zero and is
      // handled in the catch below). The output scan is only a secondary guard;
      // it keys on maestro's own `FAILED` status token rather than the previous
      // broad `Error:` match, which false-flagged passing runs whose app/console
      // logs merely contained "Error:".
      const passed = !output.includes('FAILED');
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
      return warnResult(
        meta,
        dispatch.fallbackReason
          ? `${dispatch.fallbackReason}; flow completed with warnings or failures`
          : 'Flow completed with warnings or failures',
      );
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
      const combined = (stdout + '\n' + stderr).trim();
      return failResult(`Maestro flow failed: ${msg.slice(0, 500)}`, {
        flowFile,
        platform,
        runner: dispatch.runner,
        passed: false,
        // `output` mirrors the success/warn shape so callers can read
        // it the same way regardless of which path they hit.
        output: combined.slice(0, 4000),
      });
    }
  };
}
