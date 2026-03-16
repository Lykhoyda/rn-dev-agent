import {
  runAgentDevice,
  setActiveSession,
  clearActiveSession,
  getActiveSession,
} from '../agent-device-wrapper.js';
import type { ToolResult } from '../utils.js';
import { okResult, failResult } from '../utils.js';

type SnapshotAction = 'open' | 'close' | 'snapshot';

interface SnapshotArgs {
  action: SnapshotAction;
  appId?: string;
  platform?: string;
  sessionName?: string;
}

export function createDeviceSnapshotHandler(): (args: SnapshotArgs) => Promise<ToolResult> {
  return async (args) => {
    const action = args.action ?? 'snapshot';

    if (action === 'open') {
      if (!args.appId) {
        return failResult('appId is required for action=open (e.g. "com.example.app")');
      }

      // Warn when targeting Expo Go — agent-device steals focus from Expo Go (B71)
      const EXPO_GO_BUNDLES = ['host.exp.Exponent', 'host.exp.exponent'];
      if (EXPO_GO_BUNDLES.includes(args.appId)) {
        return failResult(
          'agent-device is incompatible with Expo Go — it steals foreground focus (B71). ' +
          'Use CDP tools (cdp_component_tree, cdp_store_state, cdp_evaluate) and xcrun simctl for screenshots instead.',
          { hint: 'Use cdp_evaluate for JS-level interactions. device_screenshot works without a session.' },
        );
      }

      const sessionName = args.sessionName ?? `rn-agent-${Date.now()}`;
      const cliArgs = ['open', args.appId, '--session', sessionName];
      if (args.platform) cliArgs.push('--platform', args.platform);

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
      return failResult(
        'No device session open. Call device_snapshot with action="open" first.',
        { hint: 'Provide appId and platform to start a session.' },
      );
    }

    return runAgentDevice(['snapshot', '-i']);
  };
}
