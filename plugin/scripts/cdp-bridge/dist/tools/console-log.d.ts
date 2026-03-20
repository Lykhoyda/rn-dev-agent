import type { CDPClient } from '../cdp-client.js';
export declare function createConsoleLogHandler(getClient: () => CDPClient): (args: {
    level: string;
    limit: number;
    clear: boolean;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
