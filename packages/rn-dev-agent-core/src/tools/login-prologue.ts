import { listActions } from '../domain/action-inventory.js';
import { loadAction } from '../domain/action-store.js';
import {
  ACTION_LOGIN_HELPER,
  LOGIN_PROLOGUE_ALIAS,
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
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function parseEnvelope(result: ToolResult): ToolEnvelope {
  try {
    return JSON.parse(result.content[0]?.text ?? '{}') as ToolEnvelope;
  } catch {
    return { ok: false };
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

    const unresolved = (detail: string): ToolResult =>
      failResult(`cdp_login_prologue: ${detail}`, 'LOAD_FAILED', {
        role: ACTION_LOGIN_HELPER,
        alias: LOGIN_PROLOGUE_ALIAS,
      });

    const missingAuthoritativeRunRecord = (): ToolResult =>
      failResult(
        `cdp_login_prologue: ${LOGIN_PROLOGUE_ALIAS} reported success without a fresh passing RunRecord.`,
        'LOAD_FAILED',
        {
          role: ACTION_LOGIN_HELPER,
          alias: LOGIN_PROLOGUE_ALIAS,
          actionId: LOGIN_PROLOGUE_ALIAS,
          failureKind: 'AUTHORITATIVE_RUN_RECORD_MISSING',
        },
      );

    let action;
    try {
      inventory = await measure('inventory', () => listActions(projectRoot));
      action = await measure('resolve', async () => loadAction(projectRoot, LOGIN_PROLOGUE_ALIAS));
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('does not match filename identity') &&
        error.message.includes(LOGIN_PROLOGUE_ALIAS)
      ) {
        return unresolved(
          `the ${LOGIN_PROLOGUE_ALIAS} action file declares a different action id.`,
        );
      }
      return unresolved(
        `could not load the exact ${LOGIN_PROLOGUE_ALIAS} learned action: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!action) {
      return unresolved(
        `no exact ${LOGIN_PROLOGUE_ALIAS} learned action was found. Auth-tag or intent inference is not permitted.`,
      );
    }
    if (action.metadata.id !== LOGIN_PROLOGUE_ALIAS) {
      return unresolved(`the ${LOGIN_PROLOGUE_ALIAS} action file declares a different action id.`);
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

    const replayResult = await measure('replay', () => deps.runAction(replayArgs));
    const replay = parseEnvelope(replayResult);
    if (replay.ok !== true) return replayResult;
    if (replay.data?.passed !== true) return missingAuthoritativeRunRecord();

    const strictRunRecordId =
      typeof replay.data.strictRunRecordId === 'string'
        ? replay.data.strictRunRecordId
        : typeof replay.meta?.strictRunRecordId === 'string'
          ? replay.meta.strictRunRecordId
          : undefined;
    let freshRecord: RunRecord | undefined;
    try {
      await measure('verify-run-record', async () => {
        const reloaded = loadAction(projectRoot, LOGIN_PROLOGUE_ALIAS);
        freshRecord = strictRunRecordId
          ? reloaded?.state.runHistory.find((record) => record.runId === strictRunRecordId)
          : undefined;
      });
    } catch (error) {
      return unresolved(
        `could not verify the exact ${LOGIN_PROLOGUE_ALIAS} learned action: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!freshRecord || freshRecord.status !== 'pass') {
      return missingAuthoritativeRunRecord();
    }

    const ended = now();
    const outcome: LoginPrologueOutcome = {
      schemaVersion: 1,
      role: ACTION_LOGIN_HELPER,
      alias: LOGIN_PROLOGUE_ALIAS,
      actionId: LOGIN_PROLOGUE_ALIAS,
      startedAt: prologueStarted.toISOString(),
      endedAt: ended.toISOString(),
      elapsedMs: Math.max(0, ended.getTime() - prologueStarted.getTime()),
      steps,
      inventory: { count: inventory.length, actionIds: inventory.map((entry) => entry.id) },
      runRecord: freshRecord,
      actionResult: {
        transport: replay.data.transport,
        transportVersion: replay.data.transportVersion,
        fallback: replay.data.fallback,
        perStepReadback: replay.data.perStepReadback,
      },
    };
    return okResult(outcome);
  };
}
