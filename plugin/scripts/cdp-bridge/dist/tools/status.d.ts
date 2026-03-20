import type { CDPClient } from '../cdp-client.js';
export declare function createStatusHandler(getClient: () => CDPClient, setClient: (c: CDPClient) => void, createClient: (port: number) => CDPClient): (args: {
    metroPort?: number;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
