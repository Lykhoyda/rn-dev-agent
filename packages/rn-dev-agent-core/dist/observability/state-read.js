// GH #579: kind → parsed-envelope reader for the observe UI panels; resolves the client per call so reads recover after target replacement like the tool path.
export const STATE_KINDS = ['route', 'store', 'tree'];
function isStateKind(kind) {
    return STATE_KINDS.includes(kind);
}
export function buildStateRead(input) {
    return async (kind) => {
        if (!isStateKind(kind))
            return null;
        try {
            if (input.isFlowActive()) {
                return {
                    ok: false,
                    code: 'BUSY_FLOW_ACTIVE',
                    error: 'a flow is running — live state read skipped',
                };
            }
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
    };
}
