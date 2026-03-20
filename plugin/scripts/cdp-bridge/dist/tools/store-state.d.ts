import type { CDPClient } from '../cdp-client.js';
export declare function createStoreStateHandler(getClient: () => CDPClient): (args: {
    path?: string;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
