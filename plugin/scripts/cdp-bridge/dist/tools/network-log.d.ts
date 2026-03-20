import type { CDPClient } from '../cdp-client.js';
export declare function createNetworkLogHandler(getClient: () => CDPClient): (args: {
    limit: number;
    filter?: string;
    clear: boolean;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
