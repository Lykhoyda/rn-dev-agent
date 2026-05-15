import { okResult, failResult } from '../utils.js';
import { getFastRunnerState } from '../fast-runner-session.js';
let fetchImpl = globalThis.fetch;
export function _setFetchForTest(fn) {
    fetchImpl = fn;
}
async function postCommand(body) {
    const state = getFastRunnerState();
    if (!state) {
        throw new Error('rn-fast-runner not started — open a device session first');
    }
    const resp = await fetchImpl(`http://127.0.0.1:${state.port}/command`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    return resp.json();
}
export async function runIOS(args) {
    const body = { command: args.command };
    if (args.bundleId)
        body.appBundleId = args.bundleId;
    if (args.x !== undefined)
        body.x = args.x;
    if (args.y !== undefined)
        body.y = args.y;
    if (args.x1 !== undefined)
        body.x1 = args.x1;
    if (args.y1 !== undefined)
        body.y1 = args.y1;
    if (args.x2 !== undefined)
        body.x2 = args.x2;
    if (args.y2 !== undefined)
        body.y2 = args.y2;
    if (args.text !== undefined)
        body.text = args.text;
    if (args.durationMs !== undefined)
        body.durationMs = args.durationMs;
    if (args.direction !== undefined)
        body.direction = args.direction;
    if (args.interactiveOnly !== undefined)
        body.interactiveOnly = args.interactiveOnly;
    if (args.compact !== undefined)
        body.compact = args.compact;
    if (args.depth !== undefined)
        body.depth = args.depth;
    if (args.scope !== undefined)
        body.scope = args.scope;
    const resp = await postCommand(body);
    if (!resp.ok) {
        const message = resp.error?.message ?? 'runner returned !ok with no error';
        const code = resp.error?.code;
        if (code) {
            return failResult(message, code);
        }
        return failResult(message);
    }
    return okResult(resp.data ?? {});
}
