import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('the recorder supervisor releases start streams and owns child output', async () => {
  const script = await readFile(
    resolve(import.meta.dirname, '../../../../scripts/record_proof.sh'),
    'utf8',
  );
  const supervisorLaunch = script
    .split('\n')
    .find((line) => line.includes('python3 - "$@"') && line.trimEnd().endsWith('&'));

  assert.ok(supervisorLaunch);
  assert.match(supervisorLaunch, /3< <\(printf/);
  assert.match(supervisorLaunch, /> "\$recorder_log" 2>&1 <<'PY' &$/);
  assert.match(script, /stdout=log,\n\s+stderr=subprocess\.STDOUT,/);
  const directLaunches = script
    .split('\n')
    .filter(
      (line) =>
        /\b(?:xcrun\b.*recordVideo|adb\b.*screenrecord)\b/.test(line) &&
        line.trimEnd().endsWith(' &'),
    );
  assert.deepEqual(directLaunches, []);
});
