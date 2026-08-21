import { listActions } from '../domain/action-inventory.js';
import { loadAction } from '../domain/action-store.js';
import { LOGIN_PROLOGUE_ALIAS, LOGIN_PROLOGUE_BLOCKED, } from '../domain/login-prologue.js';
import { failResult, okResult } from '../utils.js';
function parseEnvelope(result) {
    try {
        return JSON.parse(result.content[0]?.text ?? '{}');
    }
    catch {
        return { ok: false, code: 'BAD_RESPONSE', error: 'Action replay returned invalid JSON.' };
    }
}
export function createLoginPrologueHandler(deps) {
    const now = deps.now ?? (() => new Date());
    return async (args) => {
        const projectRoot = args.projectRoot ?? process.cwd();
        const prologueStarted = now();
        const steps = [];
        let inventory = [];
        const measure = async (name, run) => {
            const started = now();
            try {
                return await run();
            }
            finally {
                const ended = now();
                steps.push({
                    name,
                    startedAt: started.toISOString(),
                    endedAt: ended.toISOString(),
                    elapsedMs: Math.max(0, ended.getTime() - started.getTime()),
                });
            }
        };
        const finish = (state, extra) => {
            const ended = now();
            return {
                schemaVersion: 1,
                state,
                alias: LOGIN_PROLOGUE_ALIAS,
                startedAt: prologueStarted.toISOString(),
                endedAt: ended.toISOString(),
                elapsedMs: Math.max(0, ended.getTime() - prologueStarted.getTime()),
                steps,
                inventory: { count: inventory.length, actionIds: inventory.map((action) => action.id) },
                ...extra,
            };
        };
        const blocked = (code, detail, extra = {}) => {
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
            const action = await measure('resolve', async () => loadAction(projectRoot, LOGIN_PROLOGUE_ALIAS));
            if (!action || !inventory.some((candidate) => candidate.id === LOGIN_PROLOGUE_ALIAS)) {
                return blocked('LOGIN_ACTION_MISSING', `No exact ${LOGIN_PROLOGUE_ALIAS} learned action was found. Auth-tag or intent inference is not permitted.`);
            }
            const priorRunIds = new Set(action.state.runHistory
                .map((record) => record.runId)
                .filter((runId) => typeof runId === 'string'));
            const replayArgs = {
                ...args,
                actionId: LOGIN_PROLOGUE_ALIAS,
                autoRepair: false,
                forceReload: false,
                proofReplay: false,
                blindProbeMode: 'forbid',
                trigger: args.trigger ?? 'agent',
            };
            let replayResult;
            try {
                replayResult = await measure('replay', () => deps.runAction(replayArgs));
            }
            catch (error) {
                const code = error && typeof error === 'object' && 'code' in error
                    ? String(error.code)
                    : 'ACTION_REPLAY_THROW';
                return blocked(code, 'The saved login action threw before producing a result.', {
                    actionId: LOGIN_PROLOGUE_ALIAS,
                });
            }
            const replay = parseEnvelope(replayResult);
            let freshRecord;
            await measure('verify-run-record', async () => {
                const reloaded = loadAction(projectRoot, LOGIN_PROLOGUE_ALIAS);
                freshRecord = reloaded?.state.runHistory
                    .slice()
                    .reverse()
                    .find((record) => typeof record.runId === 'string' && !priorRunIds.has(record.runId));
            });
            if (replay.ok !== true || replay.data?.passed !== true) {
                return blocked(replay.code ?? String(replay.data?.failureKind ?? 'ACTION_REPLAY_FAILED'), 'The saved login action did not pass; exploratory login is now terminally blocked.', { actionId: LOGIN_PROLOGUE_ALIAS, ...(freshRecord ? { runRecord: freshRecord } : {}) });
            }
            if (!freshRecord || freshRecord.status !== 'pass') {
                return blocked('AUTHORITATIVE_RUN_RECORD_MISSING', 'The saved login action reported success without a fresh passing RunRecord.', { actionId: LOGIN_PROLOGUE_ALIAS });
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
        }
        catch {
            return blocked('LOGIN_PROLOGUE_INTERNAL_ERROR', 'The login prologue failed before it could prove a passing replay.');
        }
    };
}
