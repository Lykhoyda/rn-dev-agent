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
  'working-directory'?: string;
};

// Everything the harness reproduces. A `run:` step carrying anything else is
// refused rather than executed with that field silently dropped.
const MODELLED_STEP_KEYS = new Set(['name', 'id', 'run', 'if', 'env', 'working-directory']);
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
export type JobRun = {
  steps: StepResult[];
  ok: boolean;
  failed?: StepResult;
  outputs: Record<string, Record<string, string>>;
};

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
  // Step outputs written to $GITHUB_OUTPUT become `steps.<id>.outputs.<key>`
  // expressions for every later step, the way the runner resolves them.
  const live = { ...ctx };
  const jobEnv = resolveEnv(job.env, live);
  const scriptDir = mkdtempSync(join(tmpdir(), 'workflow-step-'));

  const results: StepResult[] = [];
  const outputs: Record<string, Record<string, string>> = {};
  let index = 0;
  for (const step of job.steps ?? []) {
    if (step.run === undefined) continue;
    const name = step.name ?? step.id ?? `step-${index}`;
    if (only && !only.includes(name)) continue;
    if (step.if && !only) {
      throw new Error(`step "${name}" is conditional; select steps explicitly to simulate it`);
    }
    const unmodelled = Object.keys(step).filter((key) => !MODELLED_STEP_KEYS.has(key));
    if (unmodelled.length > 0) {
      throw new Error(
        `step "${name}" uses fields the harness does not model: ${unmodelled.join(', ')}`,
      );
    }
    const scriptPath = join(scriptDir, `${index}.sh`);
    const outputPath = join(scriptDir, `${index++}.outputs`);
    writeFileSync(scriptPath, resolveExpressions(step.run, live));
    writeFileSync(outputPath, '');
    const result = spawnSync(
      'bash',
      ['--noprofile', '--norc', '-e', '-o', 'pipefail', scriptPath],
      {
        cwd: step['working-directory'] ? join(cwd, step['working-directory']) : cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...env,
          ...jobEnv,
          ...resolveEnv(step.env, live),
          GITHUB_WORKSPACE: cwd,
          GITHUB_OUTPUT: outputPath,
        },
      },
    );
    const emitted = Object.fromEntries(
      readFileSync(outputPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('=');
          return [line.slice(0, at), line.slice(at + 1)];
        }),
    );
    if (step.id) {
      outputs[step.id] = emitted;
      for (const [key, value] of Object.entries(emitted)) {
        live[`steps.${step.id}.outputs.${key}`] = value;
      }
    }
    const stepResult: StepResult = {
      name,
      status: result.status ?? 1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
    results.push(stepResult);
    if (stepResult.status !== 0) return { steps: results, ok: false, failed: stepResult, outputs };
  }
  return { steps: results, ok: true, outputs };
}

// Normalised view of a shell script: one token array per simple command, with
// quoting and `${X}` / `$X` spelling collapsed so assertions describe the command
// that runs rather than how it happens to be written.
export function shellCommands(script: string): string[][] {
  return script
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .flatMap((line) => line.split(/\s*(?:\|\||&&|;)\s*/))
    .map((command) => {
      const tokens = command
        .trim()
        .split(/\s+/)
        .map((token) => token.replace(/["']/g, '').replace(/\$\{(\w+)\}/g, '$$$1'))
        .filter(Boolean);
      // A leading shell keyword must not hide the command it introduces: `then
      // git push …` has to normalise to the same tokens as a bare `git push …`,
      // or a caller inspecting commands is blind to the construct it sits in.
      while (tokens.length > 0 && SHELL_KEYWORDS.has(tokens[0])) tokens.shift();
      return tokens;
    })
    .filter((tokens) => tokens.length > 0);
}

const SHELL_KEYWORDS = new Set(['then', 'else', 'elif', 'do', 'in', '!', '{', '(']);

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
  headRepo?: string;
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
  gitDir?: string;
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
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      GH_STUB_STATE: stateDir,
      ...(seed.gitDir ? { GH_STUB_GIT_DIR: seed.gitDir } : {}),
    },
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
