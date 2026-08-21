import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAESTRO_RUNNER_PIN } from '../../dist/domain/engine-pin.js';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(BRIDGE_ROOT, '..', '..', 'scripts', 'ensure-maestro-runner.sh');

test('gh-397: installer and runtime expose the same pin manifest', () => {
  const result = spawnSync('bash', [SCRIPT, '--print-pin-json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), MAESTRO_RUNNER_PIN);
});
