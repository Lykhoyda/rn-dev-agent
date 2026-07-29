import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = readFileSync(
  new URL('../../src/tools/device-session.ts', import.meta.url),
  'utf8',
);

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
