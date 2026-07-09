// Story 06 Phase C.2 (#387): thin spawn layer over the claude CLI. One
// fixture = one headless `claude -p` against the real server; the judge is a
// second tool-less call with --json-schema (constrained decoding pins the
// 0..1 scale — an unconstrained judge returns integers like 9).
// Flag set probe-verified on @anthropic-ai/claude-code 2.1.205 (2026-07-09):
// --tools ToolSearch drops built-ins (Bash burned 5 turns in the probe) but
// keeps the deferred-MCP loader; --setting-sources "" + empty cwd keep local
// CLAUDE.md/plugins out so local runs match CI.
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { parseTranscript, type TranscriptOutcome } from './eval-core.ts';

export interface ServerConfig {
  mcpServers: Record<string, { command: string; args?: string[] }>;
}

export interface RunnerOpts {
  model: string;
  mcpConfigPath: string;
  serverName: string;
  cwd: string;
  timeoutMs: number;
  bin: string;
}

export function buildFixtureArgs(prompt: string, o: RunnerOpts): string[] {
  return [
    '-p', prompt,
    '--mcp-config', o.mcpConfigPath,
    '--strict-mcp-config',
    '--allowedTools', `mcp__${o.serverName}__*`,
    '--tools', 'ToolSearch',
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', '',
    '--model', o.model,
  ];
}

// server-config.json args are repo-root-relative (the tester ran from the
// repo); headless runs use an empty scratch cwd, so paths must be absolute.
export function absolutizeServerConfig(config: ServerConfig, repoRoot: string): ServerConfig {
  const out = structuredClone(config);
  for (const server of Object.values(out.mcpServers)) {
    if (Array.isArray(server.args)) {
      server.args = server.args.map((a) => (a.startsWith('-') || isAbsolute(a) ? a : resolve(repoRoot, a)));
    }
  }
  return out;
}

export type FixtureRun =
  | { kind: 'ok'; outcome: TranscriptOutcome }
  | { kind: 'timeout' }
  | { kind: 'infra'; detail: string };

// A transcript that ENDED in a terminal error (CLI/session/MCP failure) must
// never be scored as a fixture verdict — it would read as a false regression.
export function classifyOutcome(outcome: TranscriptOutcome): FixtureRun {
  if (outcome.resultIsError || outcome.subtype !== 'success') {
    return { kind: 'infra', detail: `terminal result ${outcome.subtype} (is_error=${outcome.resultIsError})` };
  }
  return { kind: 'ok', outcome };
}

export function runFixture(prompt: string, o: RunnerOpts): FixtureRun {
  const r = spawnSync(o.bin, buildFixtureArgs(prompt, o), {
    cwd: o.cwd,
    encoding: 'utf8',
    timeout: o.timeoutMs,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') return { kind: 'timeout' };
  if (r.error) return { kind: 'infra', detail: String(r.error) };
  try {
    return classifyOutcome(parseTranscript(r.stdout ?? ''));
  } catch (e) {
    return {
      kind: 'infra',
      detail: `${(e as Error).message}; exit=${r.status}; stderr=${(r.stderr ?? '').slice(0, 500)}`,
    };
  }
}

export const VERDICT_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    score: { type: 'number', minimum: 0, maximum: 1 },
    reasoning: { type: 'string' },
  },
  required: ['score', 'reasoning'],
});

// The judge sees tool NAMES + errored flags + final text — never tool-result
// contents. The task prompt must be included too: without it the judge reads
// prompt-given facts in the response as fabrication (acceptance run 2,
// 2026-07-10: "blank white screen" — quoted from the prompt — was judged an
// invented UI finding).
export function buildJudgePrompt(
  criteria: string,
  taskPrompt: string,
  finalText: string,
  toolTrace: string[],
): string {
  return [
    'You are grading one automated eval of an AI assistant. Score how well the response satisfies the criteria on a scale from 0.0 (not at all) to 1.0 (fully satisfied). Judge only against the criteria.',
    '',
    '## Criteria',
    criteria,
    '',
    '## Task the assistant was given',
    taskPrompt || '(not recorded)',
    '',
    '## Tools the assistant called (in order)',
    toolTrace.length > 0 ? toolTrace.join('\n') : '(none)',
    '',
    '## Final response under evaluation',
    finalText || '(empty response)',
  ].join('\n');
}

export interface JudgeVerdict {
  score: number;
  reasoning: string;
}

export interface JudgeOpts {
  model: string;
  bin: string;
  cwd: string;
  timeoutMs: number;
}

export function runJudge(
  criteria: string,
  taskPrompt: string,
  outcome: TranscriptOutcome,
  o: JudgeOpts,
): JudgeVerdict {
  const trace = outcome.toolCalls.map((c) => `${c.name}${c.isError ? ' (errored)' : ''}`);
  const r = spawnSync(
    o.bin,
    [
      '-p', buildJudgePrompt(criteria, taskPrompt, outcome.finalText, trace),
      '--tools', '',
      '--setting-sources', '',
      '--output-format', 'json',
      '--json-schema', VERDICT_SCHEMA,
      '--model', o.model,
    ],
    {
      cwd: o.cwd,
      encoding: 'utf8',
      timeout: o.timeoutMs,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`judge spawn failed: ${r.error ?? `exit ${r.status}`}; stderr=${(r.stderr ?? '').slice(0, 300)}`);
  }
  const parsed = JSON.parse(r.stdout) as { structured_output?: unknown; result?: unknown };
  const v = (parsed.structured_output ??
    (typeof parsed.result === 'string' ? JSON.parse(parsed.result) : parsed.result)) as
    | { score?: unknown; reasoning?: unknown }
    | undefined;
  const score = v?.score;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error(`judge returned invalid verdict: ${JSON.stringify(v).slice(0, 200)}`);
  }
  return { score, reasoning: String(v.reasoning ?? '') };
}
