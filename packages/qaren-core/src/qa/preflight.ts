import { type Judge, JevError, validateAnswer } from './questions.js';
import { type JevRollup, summarizeJev } from './ledger.js';
import {
  type PreparedPlan,
  type RefusedLine,
  maskQuotedValues,
  parsePlanWithJev,
  preparePlan,
} from './plan.js';

export type PreflightResult =
  | { ok: true; prepared: PreparedPlan; jev: JevRollup }
  | {
      ok: false;
      code: 'JEV_UNREACHABLE' | 'PLAN_UNPARSEABLE';
      message: string;
      refused?: RefusedLine[];
      jev: JevRollup;
    };

export async function preflightPlan(markdown: string, judge: Judge): Promise<PreflightResult> {
  try {
    const question = { type: 'noul' as const, instructions: 'The readiness marker is ready.' };
    const answers = await judge.ask({ readiness: 'ready' }, { preflight: question }, 'preflight');
    const answer = validateAnswer(question, answers.preflight);
    if (answer.type !== 'noul' || answer.noul < 0.7) throw new JevError('JEV_RESPONSE_INVALID');
    const parsed = await parsePlanWithJev(markdown, judge);
    if (parsed.refused)
      return {
        ok: false,
        code: 'PLAN_UNPARSEABLE',
        message: 'the plan does not parse',
        refused: parsed.refused.map((r) => ({ ...r, text: maskQuotedValues(r.text) })),
        jev: summarizeJev(judge.calls),
      };
    return {
      ok: true,
      prepared: preparePlan(markdown, parsed.blocks),
      jev: summarizeJev(judge.calls),
    };
  } catch (error) {
    if (!(error instanceof JevError)) throw error;
    return {
      ok: false,
      code: 'JEV_UNREACHABLE',
      message: error.message,
      jev: summarizeJev(judge.calls),
    };
  }
}
