import { textResult, errorResult, withConnection } from '../utils.js';
const RELOAD_WAIT_MS = 15000;
const POLL_INTERVAL_MS = 500;
export function createReloadHandler(getClient) {
    return withConnection(getClient, async (_args, client) => {
        const genBefore = client.connectionGeneration;
        try {
            const result = await client.evaluate('require("react-native").DevSettings.reload()');
            if (result.error) {
                return errorResult(`Reload failed: ${result.error}`);
            }
        }
        catch {
            // Expected: WS closes when reload kills the JS bundle (D6)
        }
        const start = Date.now();
        while (Date.now() - start < RELOAD_WAIT_MS) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
            if (client.isConnected && client.helpersInjected && client.connectionGeneration > genBefore) {
                return textResult(JSON.stringify({
                    reloaded: true,
                    type: 'full',
                    reconnected: true,
                }));
            }
        }
        return textResult(JSON.stringify({
            reloaded: true,
            type: 'full',
            reconnected: client.isConnected,
            warning: client.isConnected
                ? undefined
                : 'Reload triggered but reconnection timed out. Call cdp_status to check state.',
        }));
    });
}
