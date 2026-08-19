// Executes the `run:` steps of a GitHub Actions job the way the runner does —
// one `bash -e -o pipefail` process per step, job env merged under step env,
// and no further steps once one fails — so workflow tests can assert observed
// behaviour (git refs, files, recorded CLI calls) instead of shell source text.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
export type WorkflowJob = {
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  env?: Record<string, string>;
  steps?: WorkflowStep[];
};
export type Workflow = { concurrency?: string; jobs: Record<string, WorkflowJob> };

export function loadWorkflow(path: string): Workflow {
  return parse(readFileSync(path, 'utf8')) as Workflow;
}

export function resolveExpressions(value: string, ctx: Record<string, string>): string {
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_match, expression: string) => {
    if (!(expression in ctx)) {
      throw new Error(`workflow expression is not modelled by the harness: ${expression}`);
    }
    return ctx[expression];
  });
}

function resolveEnv(
  env: Record<string, string> | undefined,
  ctx: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([key, value]) => [key, resolveExpressions(String(value), ctx)]),
  );
}

export type StepResult = { name: string; status: number; stdout: string; stderr: string };
export type JobRun = { steps: StepResult[]; ok: boolean; failed?: StepResult };

export type RunJobOptions = {
  workflow: Workflow;
  jobId: string;
  cwd: string;
  ctx: Record<string, string>;
  env?: Record<string, string>;
  only?: string[];
};

export function runJobSteps({ workflow, jobId, cwd, ctx, env, only }: RunJobOptions): JobRun {
  const job = workflow.jobs[jobId];
  if (!job) throw new Error(`no such job: ${jobId}`);
  const jobEnv = resolveEnv(job.env, ctx);
  const scriptDir = mkdtempSync(join(tmpdir(), 'workflow-step-'));

  const results: StepResult[] = [];
  let index = 0;
  for (const step of job.steps ?? []) {
    if (step.run === undefined) continue;
    const name = step.name ?? step.id ?? `step-${index}`;
    if (only && !only.includes(name)) continue;
    if (step.if && !only) {
      throw new Error(`step "${name}" is conditional; select steps explicitly to simulate it`);
    }
    const scriptPath = join(scriptDir, `${index++}.sh`);
    writeFileSync(scriptPath, resolveExpressions(step.run, ctx));
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptPath],
      {
        cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          ...jobEnv,
          ...resolveEnv(step.env, ctx),
          GITHUB_WORKSPACE: cwd,
        },
      },
    );
    const stepResult: StepResult = {
      name,
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
    results.push(stepResult);
    if (stepResult.status !== 0) return { steps: results, ok: false, failed: stepResult };
  }
  return { steps: results, ok: true };
}

export type GhStub = {
  bin: string;
  env: Record<string, string>;
  calls: () => string[][];
  state: () => GhState;
  assetPath: (tag: string, name: string) => string;
};

export type GhPullRequest = {
  number: number;
  headRefName: string;
  baseRefName?: string;
  title?: string;
  body?: string;
  state: string;
  autoMerge: string | null;
  closeComment: string | null;
};
export type GhState = {
  releases: Record<string, { assets: Record<string, { uploads: number }> }>;
  prs: GhPullRequest[];
  nextPr: number;
};

const stubSource = fileURLToPath(new URL('./gh-stub.mts', import.meta.url));

export type GhSeed = {
  releases?: Record<string, Record<string, string>>;
  prs?: GhPullRequest[];
  nextPr?: number;
};

export function installGhStub(root: string, seed: GhSeed = {}): GhStub {
  const bin = join(root, 'bin');
  const stateDir = join(root, 'gh-state');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(stateDir, 'assets'), { recursive: true });
  const assetPath = (tag: string, name: string) =>
    join(stateDir, 'assets', tag.replace(/[^\w.-]/g, '_'), name);
  const state: GhState = {
    releases: {},
    prs: seed.prs ?? [],
    nextPr: seed.nextPr ?? 1,
  };
  for (const [tag, assets] of Object.entries(seed.releases ?? {})) {
    state.releases[tag] = { assets: {} };
    for (const [name, content] of Object.entries(assets)) {
      mkdirSync(join(assetPath(tag, name), '..'), { recursive: true });
      writeFileSync(assetPath(tag, name), content);
      state.releases[tag].assets[name] = { uploads: 0 };
    }
  }
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify(state, null, 2));
  writeFileSync(join(stateDir, 'calls.jsonl'), '');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\nexec node ${JSON.stringify(stubSource)} "$@"\n`);
  chmodSync(join(bin, 'gh'), 0o755);
  return {
    bin,
    env: { PATH: `${bin}:${process.env.PATH}`, GH_STUB_STATE: stateDir },
    calls: () =>
      readFileSync(join(stateDir, 'calls.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    state: () => JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) as GhState,
    assetPath,
  };
}

export function ghCommands(calls: string[][]): string[] {
  return calls.map((call) => call.join(' '));
}
