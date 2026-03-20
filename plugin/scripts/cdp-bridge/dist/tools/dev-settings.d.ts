import type { CDPClient } from '../cdp-client.js';
type DevAction = 'reload' | 'toggleInspector' | 'togglePerfMonitor' | 'dismissRedBox';
export declare function createDevSettingsHandler(getClient: () => CDPClient): (args: {
    action: DevAction;
}) => Promise<{
    content: {
        type: "text";
        text: string;
    }[];
}>;
export {};
