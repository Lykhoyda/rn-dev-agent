export const STATE_KINDS = ['route', 'store', 'tree'];
function isStateKind(kind) {
    return STATE_KINDS.includes(kind);
}
export function buildStateRead(input) {
    return async (kind) => {
        if (!isStateKind(kind))
            return null;
        let gate;
        try {
            gate = input.acquire();
        }
        catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        if (!gate.ok) {
            return {
                ok: false,
                code: gate.code ?? 'BUSY_FLOW_ACTIVE',
                error: 'device is busy — live state read skipped',
            };
        }
        try {
            const result = await input.handlers[kind]();
            const text = result?.content?.[0]?.text;
            if (typeof text !== 'string')
                return { ok: false, error: 'empty tool result' };
            try {
                return JSON.parse(text);
            }
            catch {
                return { ok: false, error: 'non-JSON tool result' };
            }
        }
        catch (e) {
            return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
        finally {
            try {
                gate.release();
            }
            catch {
                /* release is best-effort */
            }
        }
    };
}
