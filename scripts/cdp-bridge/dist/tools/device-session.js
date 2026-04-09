import { runAgentDevice, setActiveSession, clearActiveSession, getActiveSession, ensureFastRunner, } from '../agent-device-wrapper.js';
import { stopFastRunner } from '../fast-runner-session.js';
import { okResult, failResult, warnResult } from '../utils.js';
import { resolveBundleId } from '../project-config.js';
export function createDeviceSnapshotHandler() {
    return async (args) => {
        const action = args.action ?? 'snapshot';
        if (action === 'open') {
            let appId = args.appId;
            let autoDetected = false;
            if (!appId) {
                const platform = args.platform ?? 'ios';
                appId = resolveBundleId(platform) ?? undefined;
                if (!appId) {
                    return failResult('appId is required for action=open (e.g. "com.example.app"). ' +
                        'Could not auto-detect from app.json — provide appId explicitly.');
                }
                autoDetected = true;
            }
            // Warn when targeting Expo Go — agent-device steals focus from Expo Go (B71)
            const EXPO_GO_BUNDLES = ['host.exp.Exponent', 'host.exp.exponent'];
            if (EXPO_GO_BUNDLES.includes(appId)) {
                return failResult('agent-device is incompatible with Expo Go — it steals foreground focus (B71). ' +
                    'Use CDP tools (cdp_component_tree, cdp_store_state, cdp_evaluate) and xcrun simctl for screenshots instead.', { hint: 'Use cdp_evaluate for JS-level interactions. device_screenshot works without a session.' });
            }
            const sessionName = args.sessionName ?? `rn-agent-${Date.now()}`;
            const cliArgs = ['open', appId, '--session', sessionName];
            if (args.platform)
                cliArgs.push('--platform', args.platform);
            const result = await runAgentDevice(cliArgs, { skipSession: true });
            if (!result.isError) {
                let deviceId;
                try {
                    const envelope = JSON.parse(result.content[0].text);
                    deviceId = envelope?.data?.deviceId ?? envelope?.data?.device?.id;
                }
                catch { /* best-effort */ }
                setActiveSession({
                    name: sessionName,
                    platform: args.platform,
                    deviceId,
                    openedAt: new Date().toISOString(),
                });
                if (args.platform === 'ios' && deviceId) {
                    ensureFastRunner(deviceId, appId).catch(() => { });
                }
                if (autoDetected) {
                    return warnResult(JSON.parse(result.content[0].text).data, `appId auto-detected from app.json: ${appId}`);
                }
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
                stopFastRunner();
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
