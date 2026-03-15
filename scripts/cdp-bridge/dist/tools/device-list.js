import { runAgentDevice } from '../agent-device-wrapper.js';
export function createDeviceListHandler() {
    return async () => runAgentDevice(['devices'], { skipSession: true });
}
export function createDeviceScreenshotHandler() {
    return async (args) => {
        const cliArgs = ['screenshot'];
        if (args.path)
            cliArgs.push(args.path);
        return runAgentDevice(cliArgs);
    };
}
