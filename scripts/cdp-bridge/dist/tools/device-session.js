import { runAgentDevice, setActiveSession, clearActiveSession, getActiveSession, } from '../agent-device-wrapper.js';
import { okResult, failResult } from '../utils.js';
export function createDeviceSnapshotHandler() {
    return async (args) => {
        const action = args.action ?? 'snapshot';
        if (action === 'open') {
            if (!args.appId) {
                return failResult('appId is required for action=open (e.g. "com.example.app")');
            }
            const sessionName = args.sessionName ?? `rn-agent-${Date.now()}`;
            const cliArgs = ['open', args.appId, '--session', sessionName];
            if (args.platform)
                cliArgs.push('--platform', args.platform);
            const result = await runAgentDevice(cliArgs, { skipSession: true });
            if (!result.isError) {
                setActiveSession({
                    name: sessionName,
                    platform: args.platform,
                    openedAt: new Date().toISOString(),
                });
            }
            return result;
        }
        if (action === 'close') {
            const session = getActiveSession();
            if (!session) {
                return okResult({ closed: true, message: 'No active session to close' });
            }
            const result = await runAgentDevice(['close']);
            if (!result.isError) {
                clearActiveSession();
            }
            return result;
        }
        // action === 'snapshot'
        if (!getActiveSession()) {
            return failResult('No device session open. Call device_snapshot with action="open" first.', { hint: 'Provide appId and platform to start a session.' });
        }
        return runAgentDevice(['snapshot', '-i']);
    };
}
