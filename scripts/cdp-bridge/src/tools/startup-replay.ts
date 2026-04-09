import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { CDPClient } from '../cdp-client.js';
import { getActiveSession } from '../agent-device-wrapper.js';
import { handleDevClientPicker } from './dev-client-picker.js';
import { resolveBundleId } from '../project-config.js';

const execFile = promisify(execFileCb);

export interface StartupReplayResult {
  arrived: boolean;
  screen: string;
  current_screen: string | null;
  method: string;
  latency_ms: number;
  picker_dismissed?: boolean;
  reconnect_attempts?: number;
  error?: string;
}

async function launchApp(bundleId: string, platform: string): Promise<void> {
  if (platform === 'ios') {
    await execFile('xcrun', ['simctl', 'terminate', 'booted', bundleId], {
      timeout: 10_000, encoding: 'utf8',
    }).catch(() => {});
    await execFile('xcrun', ['simctl', 'launch', 'booted', bundleId], {
      timeout: 15_000, encoding: 'utf8',
    });
  } else {
    await execFile('adb', ['shell', 'am', 'force-stop', bundleId], {
      timeout: 10_000, encoding: 'utf8',
    }).catch(() => {});
    await execFile('adb', ['shell', 'am', 'start', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', bundleId], {
      timeout: 15_000, encoding: 'utf8',
    });
  }
}

async function waitForNavigationReady(client: CDPClient, timeoutMs = 12_000): Promise<boolean> {
  const checkExpr = `(function() {
    var ref = globalThis.__NAV_REF__;
    if (ref && typeof ref.getRootState === 'function') {
      var state = ref.getRootState();
      if (state && state.routes && state.routes.length > 0) return true;
    }
    return false;
  })()`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await client.evaluate(checkExpr);
      if (result.value === true) return true;
    } catch { /* CDP may briefly disconnect during cold start */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

export async function launchAndNavigate(
  client: CDPClient,
  screen: string,
  params?: Record<string, unknown>,
  opts: { bundleId?: string; platform?: string } = {},
): Promise<StartupReplayResult> {
  const startTime = Date.now();
  const session = getActiveSession();
  const platform = opts.platform ?? session?.platform;
  if (!platform) {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime,
      error: 'Cannot determine platform. Open a device session first or pass platform explicitly.',
    };
  }

  const bundleId = opts.bundleId ?? resolveBundleId(platform);
  if (!bundleId) {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime,
      error: 'Cannot determine app bundle ID. Provide bundleId or ensure app.json exists in the project.',
    };
  }

  let pickerDismissed = false;
  let reconnectAttempts = 0;

  try {
    await launchApp(bundleId, platform);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime,
      error: `App launch failed: ${msg.slice(0, 200)}`,
    };
  }

  await new Promise(r => setTimeout(r, 1000));

  const pickerResult = await handleDevClientPicker();
  if (pickerResult?.dismissed) {
    pickerDismissed = true;
  }

  let reconnected = false;
  for (let attempt = 0; attempt < 4; attempt++) {
    reconnectAttempts = attempt + 1;
    try {
      await client.softReconnect();
      reconnected = true;
      break;
    } catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
    }
  }

  if (!reconnected) {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime, picker_dismissed: pickerDismissed,
      reconnect_attempts: reconnectAttempts,
      error: 'CDP reconnection failed after app launch. Metro may not be running.',
    };
  }

  const helperDeadline = Date.now() + 15_000;
  while (!client.helpersInjected && Date.now() < helperDeadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  if (!client.helpersInjected) {
    await client.reinjectHelpers();
  }
  if (!client.helpersInjected) {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime, picker_dismissed: pickerDismissed,
      reconnect_attempts: reconnectAttempts,
      error: 'Helpers not injected after app launch. App may still be loading.',
    };
  }

  const navReady = await waitForNavigationReady(client, 12_000);
  if (!navReady) {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime, picker_dismissed: pickerDismissed,
      reconnect_attempts: reconnectAttempts,
      error: '__NAV_REF__ not ready after 12s. NavigationContainer may not have rendered.',
    };
  }

  const paramsArg = params ? JSON.stringify(params) : 'undefined';
  const navExpr = `
    (function() {
      var navResult = __RN_AGENT.navigateTo(${JSON.stringify(screen)}, ${paramsArg});
      var parsed = JSON.parse(navResult);
      if (parsed.__agent_error) return JSON.stringify({ error: parsed.__agent_error });

      var stateResult = __RN_AGENT.getNavState();
      var state = JSON.parse(stateResult);

      function getDeepestRoute(s) {
        if (!s) return null;
        if (s.nested) return getDeepestRoute(s.nested);
        return s.routeName || null;
      }
      var currentScreen = getDeepestRoute(state);
      return JSON.stringify({
        arrived: currentScreen === ${JSON.stringify(screen)},
        current_screen: currentScreen
      });
    })()
  `;

  const navResult = await client.evaluate(navExpr);
  if (navResult.error || typeof navResult.value !== 'string') {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime, picker_dismissed: pickerDismissed,
      reconnect_attempts: reconnectAttempts,
      error: `Navigation evaluate failed: ${navResult.error ?? 'unexpected response'}`,
    };
  }

  try {
    const parsed = JSON.parse(navResult.value) as {
      arrived?: boolean;
      current_screen?: string;
      error?: string;
    };

    if (parsed.error) {
      return {
        arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
        latency_ms: Date.now() - startTime, picker_dismissed: pickerDismissed,
        reconnect_attempts: reconnectAttempts,
        error: `navigateTo error: ${parsed.error}`,
      };
    }

    return {
      arrived: parsed.arrived ?? false,
      screen,
      current_screen: parsed.current_screen ?? null,
      method: 'startup_replay',
      latency_ms: Date.now() - startTime,
      picker_dismissed: pickerDismissed,
      reconnect_attempts: reconnectAttempts,
    };
  } catch {
    return {
      arrived: false, screen, current_screen: null, method: 'startup_replay_failed',
      latency_ms: Date.now() - startTime, picker_dismissed: pickerDismissed,
      reconnect_attempts: reconnectAttempts,
      error: 'Failed to parse navigation result',
    };
  }
}
