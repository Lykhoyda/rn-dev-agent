import type { CDPClient } from '../cdp-client.js';
export declare function createErrorLogHandler(getClient: () => CDPClient): (args: {
    clear: boolean;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
