import { discoverLockedTests, loadLockedTest } from '../domain/e2e-test.js';
import {
  classifyFlowResult,
  skippedResult,
  unloadableResult,
  computeVerdict,
  diffNewlyFailing,
  writeRunRecord,
  loadRunRecord,
  lastGreenRunId,
} from '../domain/e2e-run.js';
import type { E2eFlowResult, E2eRunRecord } from '../domain/e2e-run.js';
import type { LockedE2eTest } from '../domain/e2e-test.js';
import {
  loadE2eConfig,
  resolveParams,
  secretValuesFor,
  redactSecrets,
} from '../domain/e2e-config.js';
import type { E2eConfig } from '../domain/e2e-config.js';
import { getGitInfo as realGetGitInfo } from '../e2e/git-info.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { okResult, warnResult, failResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { SessionState } from '../types.js';
import {
  writeRequest,
  updateRequest,
  listRequests,
  TERMINAL_STATUSES,
} from '../domain/e2e-run-request.js';

export interface RunE2eSuiteArgs {
  pattern?: string;
  projectRoot?: string;
  deviceId?: string;
}

export interface RunE2eSuiteDeps {
  discover?: (projectRoot: string) => string[];
  load?: (projectRoot: string, id: string) => LockedE2eTest | null;
  maestroRun?: (args: Record<string, unknown>) => Promise<ToolResult>;
  getGitInfo?: (projectRoot: string) => { sha: string | null; dirty: boolean };
  getSession?: () => SessionState | null;
  now?: () => Date;
  makeRunId?: (now: () => Date, rand: () => string) => string;
  runReload?: () => Promise<boolean>;
  onProgress?: (completed: number, total: number, lastTestId: string) => void;
  loadConfig?: (projectRoot: string) => E2eConfig;
}

export function makeRunId(now: () => Date, rand: () => string): string {
  return `run-${now().toISOString().replace(/[:.]/g, '-')}-${rand()}`;
}

function readMaestro(result: ToolResult): { passed: boolean; output: string } {
  try {
    const env = JSON.parse(result.content[0].text) as {
      ok?: boolean;
      data?: { passed?: boolean; output?: string };
      error?: string;
      meta?: { output?: string };
    };
    return {
      passed: env.ok === true && env.data?.passed === true,
      output: env.data?.output ?? env.meta?.output ?? env.error ?? '',
    };
  } catch {
    return { passed: false, output: 'unparseable maestro result' };
  }
}

function filterByPattern(ids: string[], pattern?: string): string[] {
  if (!pattern || pattern.length > 256) return ids;
  try {
    const re = new RegExp(pattern, 'i');
    return ids.filter((id) => re.test(id));
  } catch {
    return ids;
  }
}

export async function runE2eSuiteCore(
  args: RunE2eSuiteArgs,
  deps: RunE2eSuiteDeps = {},
): Promise<ToolResult> {
  const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
  const discover = deps.discover ?? discoverLockedTests;
  const load = deps.load ?? loadLockedTest;
  const maestroRun = deps.maestroRun ?? createMaestroRunHandler();
  const getGit = deps.getGitInfo ?? realGetGitInfo;
  const getSession = deps.getSession ?? getActiveSession;
  const now = deps.now ?? (() => new Date());
  const mkRunId = deps.makeRunId ?? makeRunId;
  const rand = (): string => Math.random().toString(36).slice(2, 8);

  const ids = filterByPattern(discover(projectRoot), args.pattern);
  if (ids.length === 0) {
    return warnResult(
      {
        runId: null,
        verdict: 'green',
        totals: { total: 0, passed: 0, failed: 0, skipped: 0 },
        results: [],
        newlyFailing: [],
      },
      'No locked e2e tests found — lock one with cdp_lock_e2e_test',
      { code: 'NO_E2E_TESTS' },
    );
  }

  const runId = mkRunId(now, rand);
  const startedAt = now().toISOString();
  const startMs = now().getTime();
  const session = getSession();
  const platform = session?.platform ?? 'ios';
  const deviceId = args.deviceId ?? session?.deviceId ?? null;
  const git = getGit(projectRoot);

  let metroReloaded = false;
  if (deps.runReload) {
    try {
      metroReloaded = await deps.runReload();
    } catch {
      metroReloaded = false;
    }
  }

  const loadCfg = deps.loadConfig ?? loadE2eConfig;
  const config = loadCfg(projectRoot);

  const results: E2eFlowResult[] = [];
  for (const id of ids) {
    const locked = load(projectRoot, id);
    if (!locked) {
      results.push(
        unloadableResult(
          id,
          'locked test file is present but could not be parsed (corrupt or missing sentinel)',
        ),
      );
      deps.onProgress?.(results.length, ids.length, id);
      continue;
    }
    if (locked.params?.length) {
      const resolved = resolveParams(config, id, locked.params);
      if (!resolved.ok) {
        results.push(
          skippedResult(id, locked.intent, 'missing param values: ' + resolved.missing.join(', ')),
        );
        deps.onProgress?.(results.length, ids.length, id);
        continue;
      }
      const t0 = now().getTime();
      const result = await maestroRun({
        flowPath: locked.filePath,
        platform: platform as 'ios' | 'android',
        params: resolved.params,
      });
      const { passed, output } = readMaestro(result);
      const safeOutput = redactSecrets(output, secretValuesFor(config, resolved.params));
      results.push(
        classifyFlowResult({
          testId: id,
          intent: locked.intent,
          passed,
          durationMs: now().getTime() - t0,
          output: safeOutput,
        }),
      );
      deps.onProgress?.(results.length, ids.length, id);
      continue;
    }
    const t0 = now().getTime();
    const result = await maestroRun({
      flowPath: locked.filePath,
      platform: platform as 'ios' | 'android',
    });
    const { passed, output } = readMaestro(result);
    results.push(
      classifyFlowResult({
        testId: id,
        intent: locked.intent,
        passed,
        durationMs: now().getTime() - t0,
        output,
      }),
    );
    deps.onProgress?.(results.length, ids.length, id);
  }

  const verdict = computeVerdict(results);
  const prevGreenId = lastGreenRunId(projectRoot);
  const prevGreen = prevGreenId ? loadRunRecord(projectRoot, prevGreenId) : null;
  const record: E2eRunRecord = {
    runId,
    startedAt,
    finishedAt: now().toISOString(),
    durationMs: now().getTime() - startMs,
    gitSha: git.sha,
    gitDirty: git.dirty,
    platform,
    deviceId,
    metroReloaded,
    totals: {
      total: results.length,
      passed: results.filter((r) => r.classification === 'pass').length,
      failed: results.filter((r) => !r.passed && r.classification !== 'skipped').length,
      skipped: results.filter((r) => r.classification === 'skipped').length,
    },
    verdict,
    results,
    previousGreenRunId: prevGreenId,
  };
  writeRunRecord(projectRoot, record);

  return okResult({
    runId,
    verdict,
    totals: record.totals,
    results,
    newlyFailing: diffNewlyFailing(record, prevGreen),
    metroReloaded,
  });
}

const STALE_MS = 15 * 60_000;

export interface RunE2eSuiteHandlerDeps extends RunE2eSuiteDeps {
  isPidAlive?: (pid: number) => boolean;
  preflightCheck?: () => Promise<{ ok: true } | { ok: false; code: 'SETUP_ERROR'; detail: string }>;
}

export function isRunActive(
  projectRoot: string,
  isPidAlive: (pid: number) => boolean,
  now: () => Date,
  staleMs: number = STALE_MS,
): boolean {
  const nowMs = now().getTime();
  return listRequests(projectRoot).some((r) => {
    if (TERMINAL_STATUSES.has(r.status)) return false;
    if (!isPidAlive(r.pid)) return false;
    const age = nowMs - new Date(r.updatedAt).getTime();
    return Number.isFinite(age) && age < staleMs;
  });
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createRunE2eSuiteHandler(deps: RunE2eSuiteHandlerDeps = {}) {
  return async (args: RunE2eSuiteArgs): Promise<ToolResult> => {
    const projectRoot = args.projectRoot ?? findProjectRoot() ?? process.cwd();
    const isPidAlive = deps.isPidAlive ?? defaultPidAlive;
    const now = deps.now ?? (() => new Date());
    const preflightCheck = deps.preflightCheck ?? (async () => ({ ok: true as const }));

    if (isRunActive(projectRoot, isPidAlive, now)) {
      return failResult('An e2e run is already in progress', 'E2E_RUN_ACTIVE');
    }

    const rand = (): string => Math.random().toString(36).slice(2, 8);
    const runId = (deps.makeRunId ?? makeRunId)(now, rand);
    writeRequest(projectRoot, {
      runId,
      status: 'requested',
      pid: process.pid,
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      pattern: args.pattern,
    });

    const pre = await preflightCheck();
    if (!pre.ok) {
      updateRequest(projectRoot, runId, { status: 'failed', updatedAt: now().toISOString() });
      return failResult(pre.detail, 'SETUP_ERROR');
    }

    updateRequest(projectRoot, runId, { status: 'running', updatedAt: now().toISOString() });
    const externalOnProgress = deps.onProgress;
    try {
      const result = await runE2eSuiteCore(args, {
        ...deps,
        makeRunId: () => runId,
        onProgress: (completed, total, lastTestId) => {
          updateRequest(projectRoot, runId, {
            updatedAt: now().toISOString(),
            progress: { total, completed, lastTestId },
          });
          externalOnProgress?.(completed, total, lastTestId);
        },
      });
      updateRequest(projectRoot, runId, { status: 'done', updatedAt: now().toISOString() });
      return result;
    } catch (err) {
      updateRequest(projectRoot, runId, { status: 'failed', updatedAt: now().toISOString() });
      return failResult(
        `e2e run crashed: ${err instanceof Error ? err.message : String(err)}`,
        'E2E_RUN_CRASHED',
      );
    }
  };
}
