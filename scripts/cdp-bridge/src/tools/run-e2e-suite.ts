import { discoverLockedTests, loadLockedTest } from '../domain/e2e-test.js';
import {
  classifyFlowResult,
  skippedResult,
  computeVerdict,
  diffNewlyFailing,
  writeRunRecord,
  loadRunRecord,
  lastGreenRunId,
} from '../domain/e2e-run.js';
import type { E2eFlowResult, E2eRunRecord } from '../domain/e2e-run.js';
import type { LockedE2eTest } from '../domain/e2e-test.js';
import { getGitInfo as realGetGitInfo } from '../e2e/git-info.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { createMaestroRunHandler } from './maestro-run.js';
import { findProjectRoot } from '../nav-graph/storage.js';
import { okResult, warnResult } from '../utils.js';
import type { ToolResult } from '../utils.js';
import type { SessionState } from '../types.js';

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

export async function runE2eSuiteCore(args: RunE2eSuiteArgs, deps: RunE2eSuiteDeps = {}): Promise<ToolResult> {
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
      { runId: null, verdict: 'green', totals: { total: 0, passed: 0, failed: 0, skipped: 0 }, results: [], newlyFailing: [] },
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

  const results: E2eFlowResult[] = [];
  for (const id of ids) {
    const locked = load(projectRoot, id);
    if (!locked) continue;
    if (locked.params?.length) {
      results.push(skippedResult(id, locked.intent, 'needs params (unsupported in v1)'));
      deps.onProgress?.(results.length, ids.length, id);
      continue;
    }
    const t0 = now().getTime();
    const result = await maestroRun({ flowPath: locked.filePath, platform: platform as 'ios' | 'android' });
    const { passed, output } = readMaestro(result);
    results.push(classifyFlowResult({ testId: id, intent: locked.intent, passed, durationMs: now().getTime() - t0, output }));
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
