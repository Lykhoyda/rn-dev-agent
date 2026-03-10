export function textResult(text) {
    return { content: [{ type: 'text', text }] };
}
export function errorResult(text) {
    return { content: [{ type: 'text', text }], isError: true };
}
export function withConnection(getClient, handler, options = {}) {
    const { requireHelpers = true } = options;
    return async (args) => {
        try {
            const client = getClient();
            if (!client.isConnected) {
                return errorResult('Not connected. Call cdp_status first to connect.');
            }
            if (requireHelpers && !client.helpersInjected) {
                return errorResult('Helpers not injected. Call cdp_status to initialize.');
            }
            return await handler(args, client);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return errorResult(message);
        }
    };
}
