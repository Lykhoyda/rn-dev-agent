export function wireEventHandlers(eventHandlers, buffers, sendFn, getIsPaused, setIsPaused) {
    eventHandlers.set('Runtime.consoleAPICalled', (params) => {
        const p = params;
        const text = p.args?.map(a => a.value !== undefined ? String(a.value) : (a.description ?? '')).join(' ') ?? '';
        if (text.startsWith('__RN_NET__:'))
            return;
        buffers.console.push({
            level: p.type,
            text,
            timestamp: new Date().toISOString(),
        });
    });
    eventHandlers.set('Network.requestWillBeSent', (params) => {
        const p = params;
        buffers.network.push({
            id: p.requestId,
            method: p.request?.method ?? 'GET',
            url: p.request?.url ?? '',
            timestamp: new Date().toISOString(),
        });
    });
    eventHandlers.set('Network.responseReceived', (params) => {
        const p = params;
        const entry = buffers.network.findLast(e => e.id === p.requestId);
        if (entry) {
            entry.status = p.response?.status;
            entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
        }
    });
    eventHandlers.set('Network.loadingFailed', (params) => {
        const p = params;
        const entry = buffers.network.findLast(e => e.id === p.requestId);
        if (entry) {
            entry.status = 0;
            entry.duration_ms = Date.now() - new Date(entry.timestamp).getTime();
        }
    });
    eventHandlers.set('Debugger.scriptParsed', (params) => {
        const p = params;
        if (p.scriptId && p.url) {
            buffers.scripts.set(p.scriptId, {
                scriptId: p.scriptId,
                url: p.url,
                startLine: p.startLine ?? 0,
                endLine: p.endLine ?? 0,
            });
        }
    });
    eventHandlers.set('Log.entryAdded', (params) => {
        const p = params;
        const e = p.entry;
        if (!e)
            return;
        buffers.log.push({
            source: e.source ?? 'other',
            level: e.level ?? 'info',
            text: e.text ?? '',
            timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString(),
            url: e.url,
            lineNumber: e.lineNumber,
        });
    });
    eventHandlers.set('Network.loadingFinished', (params) => {
        const p = params;
        const entry = buffers.network.findLast(e => e.id === p.requestId);
        if (entry) {
            entry.bodyAvailable = true;
            entry.bodySize = p.encodedDataLength;
        }
    });
    eventHandlers.set('Debugger.paused', async () => {
        setIsPaused(true);
        try {
            await sendFn('Debugger.resume');
        }
        catch {
            // Best effort auto-resume
        }
        setIsPaused(false);
    });
}
export function parseNetworkHookMessage(params, networkMode, networkBuffer) {
    if (networkMode !== 'hook')
        return;
    const p = params;
    const firstArg = p.args?.[0]?.value;
    if (typeof firstArg !== 'string' || !firstArg.startsWith('__RN_NET__:'))
        return;
    try {
        const parts = firstArg.split(':');
        const type = parts[1];
        const data = JSON.parse(parts.slice(2).join(':'));
        if (type === 'request') {
            networkBuffer.push({
                id: data.id,
                method: data.method ?? 'GET',
                url: data.url ?? '',
                timestamp: new Date().toISOString(),
            });
        }
        else if (type === 'response') {
            const entry = networkBuffer.findLast(e => e.id === data.id);
            if (entry) {
                entry.status = data.status;
                entry.duration_ms = data.duration_ms;
            }
        }
    }
    catch (err) {
        console.error('CDP: malformed network hook message dropped:', typeof firstArg === 'string' ? firstArg.slice(0, 100) : typeof firstArg, err instanceof Error ? err.message : '');
    }
}
