import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('background recorders release the start command output streams', async () => {
  const script = await readFile(
    resolve(import.meta.dirname, '../../../../scripts/record_proof.sh'),
    'utf8',
  );
  const launches = script
    .split('\n')
    .filter((line) => /\b(recordVideo|screenrecord)\b/.test(line) && line.trimEnd().endsWith('&'));

  assert.equal(launches.length, 3);
  for (const launch of launches) {
    assert.match(launch, />\s*"\$recorder_log"\s*2>&1\s*&$/);
  }
});
