import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const contractScript = resolve(repositoryRoot, 'scripts/test/ensure-idb.test.sh');

for (const [name, helperPath] of [
  ['source', resolve(repositoryRoot, 'scripts/ensure-idb.sh')],
  ['packaged', resolve(repositoryRoot, 'packages/claude-plugin/scripts/ensure-idb.sh')],
] as const) {
  test(`ensure-idb SessionStart contract (${name} helper)`, async () => {
    const { stdout, stderr } = await execFileAsync('bash', [contractScript], {
      cwd: repositoryRoot,
      env: { ...process.env, SCRIPT_UNDER_TEST: helperPath },
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    assert.equal(stderr, '');
    assert.match(stdout, /incompatible-client: reports interpreter incompatibility/);
    assert.match(stdout, /incompatible-client: unchanged environment remains suppressed/);
    assert.match(stdout, /incompatible-client: environment change is re-evaluated/);
    assert.match(stdout, /present: reports available/);
    assert.match(stdout, /install: exactly one spawn recorded/);
    assert.doesNotMatch(stdout, /^FAIL:/m);
  });
}
