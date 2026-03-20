import type { CDPClient } from '../cdp-client.js';
export declare function createComponentTreeHandler(getClient: () => CDPClient): (args: {
    filter?: string;
    depth: number;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
