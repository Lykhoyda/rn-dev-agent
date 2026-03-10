import { textResult, withConnection } from '../utils.js';
const LEVEL_ALIASES = {
    warn: 'warning',
};
const INTERNAL_PREFIX = '__RN_NET__:';
export function createConsoleLogHandler(getClient) {
    return withConnection(getClient, async (args, client) => {
        if (args.clear) {
            client.consoleBuffer.clear();
            return textResult(JSON.stringify({ cleared: true }));
        }
        const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
        const cdpLevel = LEVEL_ALIASES[args.level] ?? args.level;
        let entries = cdpLevel === 'all'
            ? client.consoleBuffer.getLast(client.consoleBuffer.size)
            : client.consoleBuffer.filter(e => e.level === cdpLevel);
        entries = entries
            .filter(e => !e.text.startsWith(INTERNAL_PREFIX))
            .slice(-limit);
        return textResult(JSON.stringify({
            count: entries.length,
            entries,
        }));
    });
}
