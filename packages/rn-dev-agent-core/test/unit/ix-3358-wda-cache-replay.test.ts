import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import {
  createPinnedRunActionHandler,
  createTmpProject,
  fixtureYaml,
} from '../helpers/tmp-project.js';

let project: ReturnType<typeof createTmpProject>;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

test('IX-3358: exact-ID replay reaches the first action step after runner bootstrap', async () => {
  project.seedAction(
    'login-en',
    fixtureYaml({
      id: 'login-en',
      bundleId: 'com.rndevagent.testapp',
      status: 'active',
      selectors: ['home-welcome'],
    }),
    null,
  );
  let executions = 0;
  const handler = createPinnedRunActionHandler({
    maestroRun: async () => {
      executions += 1;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              data: {
                passed: true,
                platform: 'ios',
                transport: 'maestro-runner',
                transportVersion: '1.1.24',
                output: '✓ launchApp (0.1s)\n✓ assertVisible: home-welcome (0.2s)',
                steps: [
                  { index: 0, name: 'launchApp', verb: 'launchApp', status: 'pass' },
                  {
                    index: 1,
                    name: 'assertVisible: home-welcome',
                    verb: 'assertVisible',
                    status: 'pass',
                  },
                ],
                deviceAuthority: {
                  requestedDeviceId: 'OWNED-DEVICE',
                  reportedDeviceId: 'OWNED-DEVICE',
                  observedDeviceIds: ['OWNED-DEVICE'],
                  wdaDeviceIds: ['OWNED-DEVICE'],
                  verified: true,
                  source: 'maestro-runner-report',
                  reason: 'exact-runner-and-wda-match',
                },
              },
            }),
          },
        ],
      };
    },
  });

  const result = await handler({
    actionId: 'login-en',
    projectRoot: project.root,
    platform: 'ios',
    autoRepair: false,
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(executions, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.passed, true);
  assert.match(envelope.data.firstAttemptOutput, /✓ launchApp/);
  assert.equal(project.readSidecar('login-en').runHistory.at(-1).status, 'pass');
});
