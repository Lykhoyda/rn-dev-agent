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
