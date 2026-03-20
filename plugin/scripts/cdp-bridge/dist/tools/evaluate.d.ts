import type { CDPClient } from '../cdp-client.js';
export declare function createEvaluateHandler(getClient: () => CDPClient): (args: {
    expression: string;
    awaitPromise: boolean;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
