import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { reacquireIosTargetApp } from '../../dist/tools/device-session.js';
import { SessionAuthorityError } from '../../dist/session/registry.js';

const source = readFileSync(new URL('../../src/tools/device-session.ts', import.meta.url), 'utf8');

test('runner leak recovery unbinds stale authority and reuses production dependencies', () => {
  assert.match(
    source,
    /await deps\.unbindRunner\?\.\(\);[\s\S]*reopenSessionForRecovery\(appId, platform, attachOnly, deviceId, deps\)/,
  );
  assert.match(
    source,
    /return createDeviceSnapshotHandler\(dependencies\)\(\{[\s\S]*sessionName: recoveryName/,
  );
});

test('preferred runner reacquire rotates durable authority around the process restart', async () => {
  const calls: string[] = [];
  const result = await reacquireIosTargetApp('dev.example', 'SIM-1', {
    stopFastRunner: async () => {
      calls.push('stop');
    },
    unbindRunner: async () => {
      calls.push('unbind');
    },
    launchApp: async () => {
      calls.push('launch');
    },
    ensureFastRunner: async () => {
      calls.push('start');
    },
    bindRunner: async () => {
      calls.push('bind');
    },
  });

  assert.equal(result.isError, undefined);
  assert.deepEqual(calls, ['stop', 'unbind', 'launch', 'start', 'bind']);
});

test('preferred runner reacquire does not discard authority after an unproven stop', async () => {
  const calls: string[] = [];
  const result = await reacquireIosTargetApp('dev.example', 'SIM-1', {
    stopFastRunner: async () => {
      calls.push('stop');
      throw new Error('runner stop unproven');
    },
    unbindRunner: async () => {
      calls.push('unbind');
    },
    launchApp: async () => {
      calls.push('launch');
    },
    ensureFastRunner: async () => {
      calls.push('start');
    },
    bindRunner: async () => {
      calls.push('bind');
    },
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /runner stop unproven/);
  assert.deepEqual(calls, ['stop']);
});

test('preferred runner reacquire preserves unavailable attestation details', async () => {
  const result = await reacquireIosTargetApp('dev.example', 'SIM-1', {
    stopFastRunner: async () => {},
    unbindRunner: async () => {},
    launchApp: async () => {},
    ensureFastRunner: async () => {
      throw new SessionAuthorityError(
        'PROCESS_BIRTH_UNAVAILABLE',
        'native runner process identity could not be read on a loaded host',
        undefined,
        {
          attestation: 'unavailable',
          pid: 4242,
          step: 'helper',
          failure: 'timeout',
          elapsedMs: 2000,
          nextAction:
            'Process identity could not be read in time on a loaded host. Reduce host process contention, then retry the original operation; do not reopen or rebind the device.',
        },
      );
    },
    bindRunner: async () => {},
  });
  const body = JSON.parse(result.content[0]!.text) as {
    code?: string;
    meta?: Record<string, unknown>;
  };

  assert.equal(result.isError, true);
  assert.equal(body.code, 'PROCESS_BIRTH_UNAVAILABLE');
  assert.equal(body.meta?.attestation, 'unavailable');
  assert.equal(body.meta?.pid, 4242);
  assert.equal(body.meta?.step, 'helper');
  assert.equal(body.meta?.failure, 'timeout');
  assert.equal(body.meta?.elapsedMs, 2000);
  assert.match(String(body.meta?.nextAction), /loaded host/);
});
