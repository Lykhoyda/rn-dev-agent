import { runAgentDevice } from '../agent-device-wrapper.js';
export function createDeviceListHandler() {
    return async () => runAgentDevice(['devices'], { skipSession: true });
}
export function createDeviceScreenshotHandler() {
    return async (args) => {
        const cliArgs = ['screenshot'];
        if (args.path)
            cliArgs.push(args.path);
        if (args.format) {
            cliArgs.push('--format', args.format);
        }
        else if (args.path) {
            if (args.path.endsWith('.jpg') || args.path.endsWith('.jpeg')) {
                cliArgs.push('--format', 'jpeg');
            }
            else if (args.path.endsWith('.png')) {
                cliArgs.push('--format', 'png');
            }
        }
        return runAgentDevice(cliArgs);
    };
}
