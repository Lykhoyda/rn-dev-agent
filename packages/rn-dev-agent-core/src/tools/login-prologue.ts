import { listActions } from '../domain/action-inventory.js';
import { loadAction } from '../domain/action-store.js';
import {
  ACTION_LOGIN_HELPER,
  LOGIN_PROLOGUE_ALIAS,
  LOGIN_PROLOGUE_BLOCKED,
  type LoginPrologueOutcome,
  type LoginPrologueStepTiming,
} from '../domain/login-prologue.js';
import type { RunRecord } from '../domain/reusable-action.js';
import { failResult, okResult, type ToolResult } from '../utils.js';
import { sealStrictRunAction, type RunActionArgs } from './run-action.js';

export type LoginPrologueArgs = Omit<RunActionArgs, 'actionId' | 'autoRepair' | 'forceReload'>;

export interface LoginPrologueDependencies {
  runAction: (args: RunActionArgs) => Promise<ToolResult>;
  now?: () => Date;
}

interface ToolEnvelope {
  ok?: boolean;
  code?: string;
  error?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function parseEnvelope(result: ToolResult): ToolEnvelope {
  try {
    return JSON.parse(result.content[0]?.text ?? '{}') as ToolEnvelope;
  } catch {
    return { ok: false, code: 'BAD_RESPONSE', error: 'Action replay returned invalid JSON.' };
  }
}

export function createLoginPrologueHandler(deps: LoginPrologueDependencies) {
  const now = deps.now ?? (() => new Date());
  return async (args: LoginPrologueArgs): Promise<ToolResult> => {
    const projectRoot = args.projectRoot ?? process.cwd();
    const prologueStarted = now();
    const steps: LoginPrologueStepTiming[] = [];
    let inventory: Awaited<ReturnType<typeof listActions>> = [];

    const measure = async <T>(
      name: LoginPrologueStepTiming['name'],
      run: () => Promise<T>,
    ): Promise<T> => {
      const started = now();
      try {
        return await run();
      } finally {
        const ended = now();
        steps.push({
          name,
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
        });
      }
    };

    const finish = (
      state: LoginPrologueOutcome['state'],
      extra: Partial<LoginPrologueOutcome>,
    ): LoginPrologueOutcome => {
      const ended = now();
      return {
        schemaVersion: 1,
        state,
        role: ACTION_LOGIN_HELPER,
        alias: LOGIN_PROLOGUE_ALIAS,
        startedAt: prologueStarted.toISOString(),
        endedAt: ended.toISOString(),
        elapsedMs: Math.max(0, ended.getTime() - prologueStarted.getTime()),
        steps,
        inventory: { count: inventory.length, actionIds: inventory.map((action) => action.id) },
        ...extra,
      };
    };

    const blocked = (code: string, detail: string, extra: Partial<LoginPrologueOutcome> = {}) => {
      const outcome = finish(LOGIN_PROLOGUE_BLOCKED, {
        failure: { code, detail },
        ...extra,
      });
      return failResult(`Login prologue blocked: ${detail}`, 'LOGIN_PROLOGUE_BLOCKED', {
        loginPrologue: outcome,
      });
    };

    try {
      inventory = await measure('inventory', () => listActions(projectRoot));
      const action = await measure('resolve', async () =>
        loadAction(projectRoot, LOGIN_PROLOGUE_ALIAS),
      );
      if (!action) {
        return blocked(
          'LOGIN_ACTION_MISSING',
          `No exact ${LOGIN_PROLOGUE_ALIAS} learned action was found. Auth-tag or intent inference is not permitted.`,
        );
      }
      if (action.metadata.id !== LOGIN_PROLOGUE_ALIAS) {
        return blocked(
          'LOGIN_ACTION_ID_MISMATCH',
          `The ${LOGIN_PROLOGUE_ALIAS} action file declares a different action id.`,
        );
      }

      const replayArgs = Object.create(
        Object.getPrototypeOf(args),
        Object.getOwnPropertyDescriptors(args),
      ) as RunActionArgs;
      Object.assign(replayArgs, {
        actionId: LOGIN_PROLOGUE_ALIAS,
        autoRepair: false,
        forceReload: false,
        proofReplay: false,
        blindProbeMode: 'forbid',
        trigger: args.trigger ?? 'agent',
      });
      sealStrictRunAction(replayArgs);

      let replayResult: ToolResult;
      try {
        replayResult = await measure('replay', () => deps.runAction(replayArgs));
      } catch (error) {
        const code =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code)
            : 'ACTION_REPLAY_THROW';
        return blocked(code, 'The saved login action threw before producing a result.', {
          actionId: LOGIN_PROLOGUE_ALIAS,
        });
      }

      const replay = parseEnvelope(replayResult);
      const strictRunRecordId =
        typeof replay.data?.strictRunRecordId === 'string'
          ? replay.data.strictRunRecordId
          : typeof replay.meta?.strictRunRecordId === 'string'
            ? replay.meta.strictRunRecordId
            : undefined;
      let freshRecord: RunRecord | undefined;
      await measure('verify-run-record', async () => {
        const reloaded = loadAction(projectRoot, LOGIN_PROLOGUE_ALIAS);
        freshRecord = strictRunRecordId
          ? reloaded?.state.runHistory.find((record) => record.runId === strictRunRecordId)
          : undefined;
      });

      if (replay.ok !== true || replay.data?.passed !== true) {
        const metaFailureKind = replay.meta?.failureKind;
        return blocked(
          replay.code ??
            (typeof metaFailureKind === 'string'
              ? metaFailureKind
              : (freshRecord?.failureCode ?? 'ACTION_REPLAY_FAILED')),
          'The saved login action did not pass; exploratory login is now terminally blocked.',
          { actionId: LOGIN_PROLOGUE_ALIAS, ...(freshRecord ? { runRecord: freshRecord } : {}) },
        );
      }
      if (!strictRunRecordId || !freshRecord || freshRecord.status !== 'pass') {
        return blocked(
          'AUTHORITATIVE_RUN_RECORD_MISSING',
          'The saved login action reported success without a fresh passing RunRecord.',
          { actionId: LOGIN_PROLOGUE_ALIAS },
        );
      }

      const outcome = finish('passed', {
        actionId: LOGIN_PROLOGUE_ALIAS,
        runRecord: freshRecord,
        actionResult: {
          transport: replay.data.transport,
          transportVersion: replay.data.transportVersion,
          fallback: replay.data.fallback,
          perStepReadback: replay.data.perStepReadback,
        },
      });
      return okResult(outcome);
    } catch {
      return blocked(
        'LOGIN_PROLOGUE_INTERNAL_ERROR',
        'The login prologue failed before it could prove a passing replay.',
      );
    }
  };
}
