import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { parsePlan } from '../../../dist/qa/plan.js';
import { runPlan } from '../../../dist/qa/walker.js';
import { createDeviceSnapshotHandler } from '../../../dist/handlers/device-session.js';
import {
  _setFastRunnerStateForTest,
  _setCapabilitiesForTest,
  _setFetchForTest,
} from '../../../dist/runners/rn-fast-runner-client.js';
import { REQUIRED_IOS_COMMANDS, REQUIRED_IOS_FEATURES } from '../../../dist/runners/protocol.js';
import {
  _setActiveSessionForTest,
  getCachedSnapshot,
  setSnapshotAuthorityProvider,
} from '../../../dist/agent-device-wrapper.js';
import { clearRefMap, getCachedMetadata } from '../../../dist/fast-runner-ref-map.js';
import { parseEnvelope } from '../../helpers/result-helpers.js';
import { nativeCapture } from './platform-presence-fixtures.ts';
import { scriptedJudge, walker } from './judgment-fixtures.ts';

beforeEach(() => {
  clearRefMap();
  setSnapshotAuthorityProvider(null);
  _setActiveSessionForTest({
    name: 'ios-privacy',
    platform: 'ios',
    deviceId: 'sim',
    appId: 'com.test',
    openedAt: 'now',
  });
  _setFastRunnerStateForTest({
    port: 22088,
    pid: process.pid,
    deviceId: 'sim',
    bundleId: 'com.test',
    startedAt: 'now',
  });
});

afterEach(() => {
  _setFetchForTest(globalThis.fetch);
  _setFastRunnerStateForTest(null);
  _setCapabilitiesForTest([]);
  _setActiveSessionForTest(null);
  setSnapshotAuthorityProvider(null);
  clearRefMap();
});

test('iOS QA acquisition masks native values and derived labels without public values or caching', async () => {
  const secret = 'alice@example.test';
  for (const type of ['TextField', 'Other', 'UnknownView', 'SecureTextField']) {
    for (const label of ['Email', secret]) {
      for (const hasValue of [true, false]) {
        if (!hasValue && label !== secret) continue;
        const native = nativeCapture();
        const observed = native.nodes[1];
        const nodes = [
          ...native.nodes,
          {
            ...observed,
            index: 2,
            type,
            identifier: 'email',
            label,
            ...(hasValue ? { value: secret } : {}),
            presence: {
              ...observed.presence,
              nodeIndex: 2,
              labelSource: label === secret ? 'value' : 'direct',
            },
          },
          {
            ...observed,
            index: 3,
            type: 'StaticText',
            identifier: undefined,
            label: `Welcome ${secret}`,
            presence: { ...observed.presence, nodeIndex: 3 },
          },
        ];
        _setFetchForTest(async (url, init) => {
          if (String(url).endsWith('/health'))
            return Response.json({
              ok: true,
              protocolVersion: 2,
              commands: REQUIRED_IOS_COMMANDS,
              capabilities: [...REQUIRED_IOS_FEATURES, 'PLATFORM_PRESENCE_V2', 'QA_READ_ONLY_V1'],
            });
          assert.equal(JSON.parse(String(init?.body)).command, 'snapshot');
          return Response.json({ ok: true, data: { ...native, nodes } });
        });
        const snapshot = createDeviceSnapshotHandler();
        const publicResult = parseEnvelope(
          await snapshot({
            action: 'snapshot',
            platformPresence: true,
            presenceBudgetMs: 20_000,
          }),
        );
        assert.equal(publicResult.ok, true);
        assert.equal(
          publicResult.data.nodes.some((node) => Object.hasOwn(node, 'value')),
          false,
        );
        const cached = getCachedSnapshot('ios');
        assert.ok(cached);
        assert.equal(
          cached.nodes.some((node) => Object.hasOwn(node, 'value')),
          false,
        );

        const judge = scriptedJudge((questions, _, state) => {
          assert.equal(JSON.stringify({ questions, state }).includes(secret), false);
          return Object.fromEntries(
            Object.keys(questions).map((id) => [id, { type: 'noul', noul: 0.01 }]),
          );
        });
        const f = walker([], judge);
        let shots = 0;
        f.deps.screenshot = async (name) => {
          shots++;
          return name;
        };
        f.deps.captureScreen = () =>
          captureScreen({
            appId: 'com.test',
            requirePrivateInputs: true,
            native: async () => {
              const result = parseEnvelope(
                await snapshot({
                  action: 'snapshot',
                  qaReadOnly: true,
                  platformPresence: true,
                  presenceBudgetMs: 20_000,
                }),
              );
              assert.equal(result.ok, true);
              assert.equal(result.data.nodes[2].value, hasValue ? secret : undefined);
              return { ...result.data, snapshotVerdict: result.meta.snapshotVerdict };
            },
            react: async () => ({
              interactive: [],
              verdict: { state: 'ok', path: 'interactive', complete: true },
              hostEvidence: { hosts: [], complete: true },
            }),
          });
        const result = await runPlan(
          parsePlan('✓ A greeting is shown\n✓ "Nothing like this"').blocks!,
          f.deps,
        );
        assert.equal(result.verdict, 'FAIL');
        assert.ok(judge.requests.length > 0);
        assert.equal(
          JSON.stringify({ result, rows: f.rows, prompts: judge.requests }).includes(secret),
          false,
        );
        assert.match(result.failure!.seen, /Welcome •••/);
        assert.equal(shots, 0);
        assert.strictEqual(getCachedSnapshot('ios'), cached);
        assert.equal(Object.hasOwn(getCachedMetadata('@e2')!, 'value'), false);
      }
    }
  }
});
