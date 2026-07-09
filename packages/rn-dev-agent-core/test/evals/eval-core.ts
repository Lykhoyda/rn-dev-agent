// Story 06 Phase C.2 (#387): pure core for the headless-Claude eval runner —
// YAML fixture parsing (schema-compatible with the retired mcp-server-tester,
// so committed eval YAMLs stay byte-identical), stream-json transcript
// parsing, required-tool verdicts, and junit output that round-trips through
// compare-baseline's parseJunitXml. Runs under Node >= 22.18 type stripping.
import { parse } from 'yaml';

export type ScorerSpec =
  | { type: 'llm-judge'; criteria: string; threshold: number }
  | { type: 'regex'; pattern: string };

export interface EvalFixture {
  name: string;
  prompt: string;
  required: string[];
  scorers: ScorerSpec[];
}

export interface EvalFile {
  models: string[];
  maxSteps: number | undefined;
  fixtures: EvalFixture[];
}

// Raw-text pre-parse substitution (tester-compatible): fixtures are injected
// as minified single-line JSON so block scalars survive. Unknown vars are
// left intact so a typo'd name fails loudly at YAML/JSON level, not silently.
export function substituteVars(rawText: string, vars: Record<string, string>): string {
  return rawText.replace(/\$\{([A-Z0-9_]+)\}/g, (m, name: string) => vars[name] ?? m);
}

export function parseEvalYaml(rawText: string, vars: Record<string, string>): EvalFile {
  const doc = parse(substituteVars(rawText, vars)) as {
    evals?: {
      models?: string[];
      max_steps?: number;
      tests?: Array<{
        name?: string;
        prompt?: string;
        expected_tool_calls?: { required?: string[] };
        response_scorers?: Array<{ type?: string; criteria?: string; threshold?: number; pattern?: string }>;
      }>;
    };
  };
  const evals = doc?.evals;
  if (!evals || !Array.isArray(evals.tests)) throw new Error('eval YAML: missing evals.tests');
  const seen = new Set<string>();
  const fixtures = evals.tests.map((t): EvalFixture => {
    if (!t?.name || !t?.prompt) throw new Error('eval YAML: fixture missing name/prompt');
    if (seen.has(t.name)) throw new Error(`eval YAML: duplicate fixture name "${t.name}"`);
    seen.add(t.name);
    const scorers = (t.response_scorers ?? []).map((s): ScorerSpec => {
      if (s.type === 'llm-judge') {
        return { type: 'llm-judge', criteria: String(s.criteria ?? ''), threshold: Number(s.threshold ?? 0.7) };
      }
      if (s.type === 'regex') return { type: 'regex', pattern: String(s.pattern ?? '') };
      throw new Error(`eval YAML: unsupported scorer type "${s.type}" in "${t.name}"`);
    });
    return {
      name: t.name,
      prompt: String(t.prompt),
      required: t.expected_tool_calls?.required ?? [],
      scorers,
    };
  });
  return { models: evals.models ?? [], maxSteps: evals.max_steps, fixtures };
}

export interface ToolCall {
  name: string;
  isError: boolean;
}

export interface TranscriptOutcome {
  toolCalls: ToolCall[];
  finalText: string;
  subtype: string;
  resultIsError: boolean;
  numTurns: number;
  totalCostUsd: number;
}

interface ContentBlock {
  type?: string;
  id?: string;
  name?: string;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

export function parseTranscript(streamJson: string): TranscriptOutcome {
  const calls = new Map<string, ToolCall>();
  let result:
    | { subtype?: string; is_error?: boolean; num_turns?: number; total_cost_usd?: number; result?: unknown }
    | undefined;
  for (const raw of streamJson.split('\n')) {
    const s = raw.trim();
    if (!s.startsWith('{')) continue;
    let e: { type?: string; message?: { content?: ContentBlock[] | string } };
    try {
      e = JSON.parse(s);
    } catch {
      continue;
    }
    if (e.type === 'assistant' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_use' && b.id && b.name) calls.set(b.id, { name: b.name, isError: false });
      }
    } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
      for (const b of e.message.content) {
        if (b?.type === 'tool_result' && b.tool_use_id && b.is_error === true) {
          const call = calls.get(b.tool_use_id);
          if (call) call.isError = true;
        }
      }
    } else if (e.type === 'result') {
      result = e as typeof result;
    }
  }
  if (!result) throw new Error('claude transcript: no result event (run died mid-flight)');
  return {
    toolCalls: [...calls.values()],
    finalText: typeof result.result === 'string' ? result.result : '',
    subtype: result.subtype ?? 'unknown',
    resultIsError: result.is_error === true,
    numTurns: result.num_turns ?? 0,
    totalCostUsd: result.total_cost_usd ?? 0,
  };
}

// Tool names arrive prefixed (mcp__<server>__<tool>); fixture `required`
// lists bare tool names. ToolSearch is the deferred-tool loader, never a
// fixture-satisfying call.
export function stripMcpPrefix(name: string): string {
  return name.replace(/^mcp__.+?__/, '');
}

export interface FixtureCheck {
  pass: boolean;
  reasons: string[];
}

export function checkRequired(outcome: TranscriptOutcome, required: string[]): FixtureCheck {
  const reasons: string[] = [];
  for (const req of required) {
    const hits = outcome.toolCalls.filter(
      (c) => c.name !== 'ToolSearch' && stripMcpPrefix(c.name) === req,
    );
    if (hits.length === 0) {
      const actual = outcome.toolCalls.map((c) => stripMcpPrefix(c.name)).join(', ') || 'none';
      reasons.push(`required tool "${req}" was not called (actual: ${actual})`);
    } else if (!hits.some((c) => !c.isError)) {
      reasons.push(`required tool "${req}" was called but every call errored`);
    }
  }
  return { pass: reasons.length === 0, reasons };
}
