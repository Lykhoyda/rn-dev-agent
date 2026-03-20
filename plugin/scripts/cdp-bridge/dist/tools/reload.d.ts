import type { CDPClient } from '../cdp-client.js';
export declare function createReloadHandler(getClient: () => CDPClient): (args: {
    full: boolean;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
