// GH #993 / #990 (Option A): managed dev-client replay through cdp_run_action —
// and therefore cdp_login_prologue — refuses a flow containing clearState BEFORE
// anything destructive runs. The flow's own launchApp{clearState} uninstalls the
// app and strands the dev client at its picker, so the gate's relaunch can never
// re-attach; the product previously ran that stage and then blamed axis A.
// cdp_auto_login already refuses the same flow content up front.

import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test, type TestContext } from 'node:test';
import { createLoginPrologueHandler } from '../../dist/tools/login-prologue.js';
import { isDevClientLaunchShape } from '../../dist/tools/run-action.js';
import {
  createPinnedRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

const SIM = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.test.app';

// The project's `user-login` shape from #993: clearState relaunch, then openLink.
function clearStateLoginYaml(id = 'user-login'): string {
  return [
    `appId: ${APP_ID}`,
    '---',
    `# id: ${id}`,
    '# intent: restore an authenticated fixture state',
    '# tags: [auth]',
    '# mutates: true',
    '# status: active',
    '# enginePin: maestro-runner@1.1.24',
    '',
    '- launchApp:',
    '    clearState: true',
    '    stopApp: true',
    '- openLink: ${DEV_CLIENT_URL}',
    '- tapOn:',
    '    id: "login-email"',
    '- assertVisible:',
    '    id: "home-screen"',
    '',
  ].join('\n');
}

interface Trace {
  maestroRuns: number;
  claims: number;
  relaunches: number;
  appFileResolutions: number;
}

function harness(
  t: TestContext,
  install: Record<string, unknown> | null,
  options: { yaml?: string } = {},
) {
  const project = createTmpProject();
  t.after(() => project.cleanup());
  project.seedAction('user-login', options.yaml ?? clearStateLoginYaml(), null);
  const trace: Trace = { maestroRuns: 0, claims: 0, relaunches: 0, appFileResolutions: 0 };
  const runAction = createPinnedRunActionHandler({
    targetContext: () => ({ platform: 'ios', deviceId: SIM, appId: APP_ID }),
    installReceipt: () => install,
    resolveAppFile: () => {
      trace.appFileResolutions += 1;
      return '/tmp/Fixture.app';
    },
    claimNativeOrigin: async () => {
      trace.claims += 1;
    },
    completeNativeOrigin: async () => {},
    relaunchManagedApp: async () => {
      trace.relaunches += 1;
    },
    reproveManagedOrigin: async () => {},
    reissueInstallReceipt: async () => {},
    maestroRun: async () => {
      trace.maestroRuns += 1;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' },
            }),
          },
        ],
      };
    },
  });
  return { project, trace, runAction };
}

function parse(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

const EXPO_INSTALL = { platform: 'ios', deviceId: SIM, appId: APP_ID, buildKind: 'expo' };

test('GH#993: isDevClientLaunchShape reads only the existing install binding', () => {
  assert.equal(isDevClientLaunchShape(null), false);
  assert.equal(isDevClientLaunchShape({ buildKind: 'bare-react-native' }), false);
  assert.equal(isDevClientLaunchShape({ buildKind: 'expo' }), true);
});

test('GH#993: a clearState action on a dev-client session is refused with zero runner invocations', async (t) => {
  const { trace, runAction, project } = harness(t, EXPO_INSTALL);
  const sidecarBefore = JSON.stringify(project.readSidecar('user-login'));

  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.match(envelope.error, /Refusing to replay a flow containing clearState/);
  assert.match(envelope.error, /No runner was invoked and the app was not touched/);
  assert.match(envelope.error, /device_reset_state/);
  assert.match(envelope.error, /EG_DEV_CLIENT_CLEARSTATE/);
  assert.equal(envelope.meta.launchShape, 'dev-client');
  assert.equal(envelope.meta.fallback, 'none');
  assert.deepEqual(trace, { maestroRuns: 0, claims: 0, relaunches: 0, appFileResolutions: 0 });
  assert.equal(
    JSON.stringify(project.readSidecar('user-login')),
    sidecarBefore,
    'no RunRecord is persisted for a refusal that never ran',
  );
});

test('GH#993: an explicit appFile does not bypass the dev-client refusal', async (t) => {
  // A reinstall bundle does not rescue a dev client stranded at its picker.
  const { trace, runAction, project } = harness(t, EXPO_INSTALL);
  const envelope = parse(
    await runAction({
      actionId: 'user-login',
      projectRoot: project.root,
      autoRepair: false,
      appFile: '/explicit/Other.app',
    }),
  );
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 0);
});

test('GH#993: a dev-client URL launch (Android shape) is refused the same way', async (t) => {
  const { trace, runAction, project } = harness(t, {
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: APP_ID,
    buildKind: 'expo',
    devClientUrl: 'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.2.2%3A8081',
  });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 0);
});

test('GH#993: a bare-RN install that merely declares a devClientUrl is not a dev-client session', async (t) => {
  // The signed build provenance decides; dev-client-authority already refuses to
  // bind a bare-react-native runtime that carries a devClientUrl.
  const { trace, runAction, project } = harness(t, {
    platform: 'ios',
    deviceId: SIM,
    appId: APP_ID,
    buildKind: 'bare-react-native',
    devClientUrl: 'exp+app://expo-development-client/?url=http%3A%2F%2F10.0.0.2%3A8081',
  });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1, 'the GH#705 clearState path still runs');
  assert.equal(trace.appFileResolutions, 1);
});

test('GH#993: cdp_login_prologue inherits the refusal without executing anything', async (t) => {
  const { trace, runAction, project } = harness(t, EXPO_INSTALL);
  const prologue = createLoginPrologueHandler({ runAction });

  const envelope = parse(await prologue({ projectRoot: project.root }));

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.doesNotMatch(envelope.error, /METRO_ORIGIN_MISMATCH/);
  assert.deepEqual(trace, { maestroRuns: 0, claims: 0, relaunches: 0, appFileResolutions: 0 });
});

test('GH#993: a clearState action on a bare React Native session keeps GH#705 behaviour', async (t) => {
  const { trace, runAction, project } = harness(t, {
    platform: 'ios',
    deviceId: SIM,
    appId: APP_ID,
    buildKind: 'bare-react-native',
  });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1, 'the flow still runs');
  assert.equal(trace.appFileResolutions, 1, 'the GH#705 reinstall bundle is still resolved');
});

test('GH#993: a warm (non-clearState) action on a dev-client session is unaffected', async (t) => {
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, {
    yaml: fixtureYaml({ id: 'user-login', intent: 'warm login', selectors: ['login-submit'] }),
  });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1);
  assert.equal(trace.appFileResolutions, 0);
});

test('GH#993: a prose comment mentioning clearState: true is not a clearState flow', async (t) => {
  // The creating-actions skill tells authors this exact rule; the refusal is
  // decided on the parsed commands, not on the YAML text.
  const yaml = fixtureYaml({ id: 'user-login', intent: 'warm login', selectors: ['login-submit'] })
    .replace('- launchApp', '# never use clearState: true here\n- launchApp')
    .replace('- launchApp\n', '- launchApp:\n    stopApp: false\n');
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, { yaml });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1, 'the warm flow runs');
});

test('GH#993: the bare `clearState: <appId>` spelling is refused, not just clearState: true', async (t) => {
  // Maestro's documented standalone spelling wipes the same dev-client state as
  // launchApp{clearState: true}; the refusal must not turn on the literal `true`.
  const yaml = fixtureYaml({
    id: 'user-login',
    intent: 'warm login',
    selectors: ['login-submit'],
  }).replace('- launchApp\n', `- launchApp:\n    stopApp: false\n- clearState: ${APP_ID}\n`);
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, { yaml });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.deepEqual(trace, { maestroRuns: 0, claims: 0, relaunches: 0, appFileResolutions: 0 });
});

test('GH#993: an explicit launchApp clearState: false clears nothing and is not refused', async (t) => {
  const yaml = clearStateLoginYaml().replace('    clearState: true', '    clearState: false');
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, { yaml });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1, 'the flow runs past the refusal');
  assert.equal(trace.appFileResolutions, 0, 'no reinstall bundle is resolved either');
});

test('GH#993: a selector whose testID is literally clearState is not a clearState flow', async (t) => {
  // The refusal is positional: `clearState` counts as a command, not as any
  // string reachable in the tree.
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, {
    yaml: fixtureYaml({ id: 'user-login', intent: 'warm login', selectors: ['clearState'] }),
  });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1, 'the warm flow runs');
  assert.equal(trace.appFileResolutions, 0);
});

test('dev-client replay accepts a launch argument named clearState without resolving a reinstall', async (t) => {
  const yaml = clearStateLoginYaml().replace(
    '    clearState: true\n    stopApp: true',
    '    stopApp: false\n    arguments:\n      clearState: fixture-value',
  );
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, { yaml });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  assert.equal(trace.maestroRuns, 1);
  assert.equal(trace.appFileResolutions, 0);
});

test('GH#993: the bare clearState command is still refused', async (t) => {
  const yaml = clearStateLoginYaml().replace(
    '- launchApp:\n    clearState: true\n    stopApp: true',
    '- launchApp\n- clearState',
  );
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, { yaml });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 0);
});

test('GH#993: a clearState relaunch inlined in a runFlow subflow is refused', async (t) => {
  const yaml = [
    `appId: ${APP_ID}`,
    '---',
    '# id: user-login',
    '# intent: conditional reset',
    '# tags: [auth]',
    '# mutates: true',
    '# status: active',
    '# enginePin: maestro-runner@1.1.24',
    '',
    '- runFlow:',
    '    when:',
    '      visible:',
    '        id: "stale-session"',
    '    commands:',
    '      - launchApp:',
    '          clearState: true',
    '- tapOn:',
    '    id: "login-email"',
    '',
  ].join('\n');
  const { trace, runAction, project } = harness(t, EXPO_INSTALL, { yaml });
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.equal(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 0);
});

test('GH#993: an unpinned clearState action on a dev-client session gets the terminal refusal first', async (t) => {
  // Both refusals are pre-execution; the dev-client one names the rewrite the
  // action needs regardless of its pin, so it must not hide behind
  // migrate-actions the way the regex fence used to.
  const unpinned = clearStateLoginYaml().replace('# enginePin: maestro-runner@1.1.24\n', '');
  assert.doesNotMatch(unpinned, /enginePin/);
  const devClient = harness(t, EXPO_INSTALL);
  writeFileSync(devClient.project.yamlPath('user-login'), unpinned, 'utf8');
  const refused = parse(
    await devClient.runAction({
      actionId: 'user-login',
      projectRoot: devClient.project.root,
      autoRepair: false,
    }),
  );
  assert.equal(refused.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(devClient.trace.maestroRuns, 0);

  const bare = harness(t, {
    platform: 'ios',
    deviceId: SIM,
    appId: APP_ID,
    buildKind: 'bare-react-native',
  });
  writeFileSync(bare.project.yamlPath('user-login'), unpinned, 'utf8');
  const pinRefusal = parse(
    await bare.runAction({
      actionId: 'user-login',
      projectRoot: bare.project.root,
      autoRepair: false,
    }),
  );
  assert.equal(pinRefusal.code, 'ENGINE_PIN_MISMATCH', 'the same action is otherwise unpinned');
  assert.equal(bare.trace.maestroRuns, 0);
});

test('GH#993: outside a session (no install binding) the refusal does not apply', async (t) => {
  const { trace, runAction, project } = harness(t, null);
  const envelope = parse(
    await runAction({ actionId: 'user-login', projectRoot: project.root, autoRepair: false }),
  );
  assert.notEqual(envelope.code, 'DEV_CLIENT_CLEARSTATE_REFUSED');
  assert.equal(trace.maestroRuns, 1);
});
