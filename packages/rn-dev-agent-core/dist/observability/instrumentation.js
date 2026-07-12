const toolObservers = new Set();
export function setToolObserver(fn) {
    toolObservers.clear();
    if (fn)
        toolObservers.add(fn);
}
export function addToolObserver(fn) {
    toolObservers.add(fn);
    return () => {
        toolObservers.delete(fn);
    };
}
function notifyObserver(o) {
    for (const observer of toolObservers) {
        try {
            observer(o);
        }
        catch {
            /* observability is non-load-bearing */
        }
    }
}
function classifyResult(result) {
    if (!result || typeof result !== 'object')
        return 'PASS';
    const envelope = result;
    // GH#202: a BUSY_FLOW_ACTIVE refusal is expected device contention (the arbiter
    // declined to interleave a read/tap with a running flow), not a tool failure —
    // keep it out of FAIL telemetry. It rides in on a failResult envelope
    // (isError:true), so this guard must run before the isError/ok checks.
    if (resultCode(envelope) === 'BUSY_FLOW_ACTIVE')
        return 'PASS';
    if (envelope.isError === true)
        return 'FAIL';
    if (envelope.ok === false)
        return 'FAIL';
    const content = envelope.content;
    if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (first?.text && typeof first.text === 'string') {
            try {
                const parsed = JSON.parse(first.text);
                if (parsed.ok === false)
                    return 'FAIL';
            }
            catch {
                /* not JSON */
            }
        }
    }
    return 'PASS';
}
function resultCode(envelope) {
    const content = envelope.content;
    if (!Array.isArray(content) || content.length === 0)
        return null;
    const first = content[0];
    if (!first?.text || typeof first.text !== 'string')
        return null;
    try {
        const parsed = JSON.parse(first.text);
        return typeof parsed.code === 'string' ? parsed.code : null;
    }
    catch {
        /* not JSON */
    }
    return null;
}
function extractErrorFromResult(result) {
    if (!result || typeof result !== 'object')
        return null;
    const envelope = result;
    const content = envelope.content;
    if (!Array.isArray(content) || content.length === 0)
        return null;
    const first = content[0];
    if (!first?.text || typeof first.text !== 'string')
        return null;
    try {
        const parsed = JSON.parse(first.text);
        if (parsed.ok === false && typeof parsed.error === 'string')
            return parsed.error;
    }
    catch {
        /* not JSON */
    }
    if (envelope.isError === true)
        return first.text;
    return null;
}
export function instrumentTool(toolName, handler) {
    return async (...fnArgs) => {
        const start = Date.now();
        const params = fnArgs[0] && typeof fnArgs[0] === 'object' ? fnArgs[0] : {};
        try {
            const result = await handler(...fnArgs);
            const latency = Date.now() - start;
            const status = classifyResult(result);
            notifyObserver({
                tool: toolName,
                params,
                status,
                latencyMs: latency,
                result,
                error: status === 'FAIL' ? (extractErrorFromResult(result) ?? undefined) : undefined,
            });
            return result;
        }
        catch (err) {
            const latency = Date.now() - start;
            const msg = err instanceof Error ? err.message : String(err);
            notifyObserver({ tool: toolName, params, status: 'ERROR', latencyMs: latency, error: msg });
            throw err;
        }
    };
}
