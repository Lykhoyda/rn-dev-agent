import type { CDPClient } from '../cdp-client.js';
export declare function createNavigationStateHandler(getClient: () => CDPClient): () => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
