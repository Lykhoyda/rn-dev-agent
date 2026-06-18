import { z } from 'zod';
import { okResult, failResult } from '../utils.js';
import { ObservabilityServer } from '../observability/server.js';
import { recorder } from '../observability/recorder.js';
export const observeSchema = {
    action: z
        .enum(['start', 'stop', 'status'])
        .default('status')
        .describe('start = launch the web UI and return its URL; stop = tear it down; status = report whether it is running'),
};
export function parsePinnedPort(raw) {
    if (!raw)
        return undefined;
    const n = Number.parseInt(raw, 10);
    return Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
}
let server = null;
let e2eDeps;
export function setObserveE2eDeps(d) {
    e2eDeps = d;
}
export async function observeHandler(args) {
    const action = args.action ?? 'status';
    try {
        if (action === 'start') {
            if (!server)
                server = new ObservabilityServer(recorder, e2eDeps);
            const pinned = parsePinnedPort(process.env.RN_AGENT_OBSERVE_PORT);
            const { url, port } = await server.start(pinned);
            return okResult({ url, port, running: true, hint: `Open ${url} to watch the agent live.` });
        }
        if (action === 'stop') {
            await server?.stop();
            server = null;
            return okResult({ running: false });
        }
        if (server) {
            const { url, port } = await server.start();
            return okResult({ running: true, url, port });
        }
        return okResult({ running: false });
    }
    catch (e) {
        return failResult(e instanceof Error ? e.message : String(e));
    }
}
