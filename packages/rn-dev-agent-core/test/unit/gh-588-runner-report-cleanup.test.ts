import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMaestroRunHandler } from '../../dist/tools/maestro-run.js';
import { chooseMaestroDispatch } from '../../dist/tools/maestro-dispatch.js';
import {
  collectDirectRunnerEvidence,
  disposeRunnerReportDir,
} from '../../dist/domain/maestro-runner-report.js';

const EXACT = '5C10B45B-2065-458B-B885-0F83F49747C8';
const APP_ID = 'com.rndevagent.testapp';

function runnerLog(): string {
  return [
    'Single device execution mode',
    `Building WDA for device ${EXACT} (team ID: )`,
    `Starting WDA on device ${EXACT} (port: 8447)`,
    'Flow execution completed: 1 passed, 0 failed, 0 skipped',
  ].join('\n');
}

function fakeRunnerDispatch() {
  const dispatch = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/usr/bin/maestro',
    maestroRunnerPath: () => '/fake/maestro-runner',
  });
  if ('error' in dispatch) throw new Error(dispatch.error);
  return dispatch;
}

function reportDirFrom(args: string[]): string {
  const index = args.indexOf('--output');
  assert.notEqual(index, -1, 'maestro-runner must receive a report --output dir');
  return args[index + 1];
}

function handlerWriting(exit: 'zero' | 'nonzero', seen: { dir?: string }, flowDeviceId = EXACT) {
  return createMaestroRunHandler({
    getActiveSession: () => ({
      name: 'exact',
      platform: 'ios',
      deviceId: EXACT,
      appId: APP_ID,
      openedAt: new Date(0).toISOString(),
    }),
    chooseDispatch: () => fakeRunnerDispatch(),
    parkFlow: async (run: () => Promise<unknown>) => run(),
    execFile: async (_file: string, args: string[]) => {
      const dir = reportDirFrom(args);
      seen.dir = dir;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'maestro-runner.log'), runnerLog(), 'utf8');
      writeFileSync(
        join(dir, 'report.json'),
        JSON.stringify({
          device: { id: EXACT, platform: 'ios' },
          flows: [{ device: { id: flowDeviceId, platform: 'ios' } }],
        }),
        'utf8',
      );
      writeFileSync(join(dir, 'report.html'), '<html></html>', 'utf8');
      if (exit === 'nonzero') {
        throw Object.assign(new Error('runner exited 1'), {
          stdout: '',
          stderr: 'Element not found',
          code: 1,
        });
      }
      return { stdout: '', stderr: '' };
    },
  });
}

test('a passing runner flow consumes then deletes its temporary report tree', async () => {
  const seen: { dir?: string } = {};
  const result = await handlerWriting(
    'zero',
    seen,
  )({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.ok, true, result.content[0].text);
  assert.equal(body.data.deviceAuthority.verified, true, 'structured report must be consumed');
  assert.equal(body.data.deviceAuthority.reportedDeviceId, EXACT);
  assert.equal(body.data.runnerReportDir, undefined, 'no deleted path may leak into the envelope');
  assert.equal(existsSync(seen.dir!), false, 'report tree must be removed after the run');
});

test('contradictory report device identities refuse and still delete the report tree', async () => {
  const seen: { dir?: string } = {};
  const result = await handlerWriting(
    'zero',
    seen,
    'A7D2C7C9-A7DE-474D-95F2-7D2DF0EE44D3',
  )({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(body.meta.deviceAuthority.reportedDeviceId, null);
  assert.equal(body.meta.deviceAuthority.reason, 'reported-device-ambiguous');
  assert.equal(existsSync(seen.dir!), false, 'ambiguous report tree must be removed');
});

test('a non-zero runner exit still deletes its temporary report tree', async () => {
  const seen: { dir?: string } = {};
  const result = await handlerWriting(
    'nonzero',
    seen,
  )({
    inlineYaml: '- launchApp',
    platform: 'ios',
    appId: APP_ID,
  });
  const body = JSON.parse(result.content[0].text);
  assert.equal(body.meta.deviceAuthority.reportedDeviceId, EXACT);
  assert.equal(body.meta.runnerReportDir, undefined);
  assert.equal(existsSync(seen.dir!), false, 'report tree must be removed on the failure path');
});

test('structured report identity survives scalar and alternate device key spellings', () => {
  const shapes = [
    { device: EXACT },
    { device: { udid: EXACT } },
    { device: { deviceId: EXACT } },
    { flows: [{ device: { serial: EXACT } }] },
    { udid: EXACT },
    { id: 'run-42', flows: [{ id: 'flow-1', deviceId: EXACT }] },
    { device: { id: 'iPhone-16-Pro', udid: EXACT } },
    { device: { id: 'iPhone16,1', deviceId: EXACT, name: 'iPhone 17 Pro' } },
    { flows: [{ device: { id: 'Pixel_9_API_35', serial: EXACT } }] },
  ];
  for (const shape of shapes) {
    const dir = mkdtempSync(join(tmpdir(), 'gh-588-report-shape-'));
    try {
      writeFileSync(join(dir, 'report.json'), JSON.stringify(shape), 'utf8');
      assert.deepEqual(
        collectDirectRunnerEvidence(dir, '').reportDeviceIds,
        [EXACT],
        `report shape ${JSON.stringify(shape)} must yield exactly the executing device`,
      );
    } finally {
      disposeRunnerReportDir(dir);
      assert.equal(existsSync(dir), false);
    }
  }
});
