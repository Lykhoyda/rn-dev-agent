import { logger } from '../logger.js';
import { okResult, failResult } from '../utils.js';
/**
 * cdp_restart — in-process soft state reset (B76/D644).
 *
 * Disconnects the current CDPClient (clears WebSocket, ring buffers, background poll,
 * reconnect state), creates a fresh instance, and attempts to reconnect. The MCP server
 * process is NOT restarted — for new dist/ code after npm run build, the caller must
 * fully quit and relaunch Claude Code.
 *
 * Useful for recovering from stuck connection state (e.g., target drift, helpers stale
 * after many reloads) without losing the CC session.
 */
export function createRestartHandler(getClient, setClient, createClient) {
    return async (args) => {
        try {
            logger.info('MCP', 'cdp_restart: in-process state reset requested');
            const oldClient = getClient();
            const preservedPort = oldClient.metroPort;
            try {
                await oldClient.disconnect();
            }
            catch (err) {
                logger.warn('MCP', `cdp_restart: old client disconnect failed (non-fatal): ${err instanceof Error ? err.message : err}`);
            }
            const newClient = createClient(args.metroPort ?? preservedPort);
            setClient(newClient);
            let connected = false;
            let connectError;
            try {
                await newClient.autoConnect(args.metroPort, args.platform);
                connected = newClient.isConnected;
            }
            catch (err) {
                connectError = err instanceof Error ? err.message : String(err);
                logger.warn('MCP', `cdp_restart: autoConnect failed (best-effort): ${connectError}`);
            }
            return okResult({
                restarted: true,
                connected,
                port: newClient.metroPort,
                ...(connectError ? { connectError } : {}),
            });
        }
        catch (err) {
            return failResult(err instanceof Error ? err.message : String(err));
        }
    };
}
