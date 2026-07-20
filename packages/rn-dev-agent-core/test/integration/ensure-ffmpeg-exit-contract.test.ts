import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const contractTest = join(repositoryRoot, 'scripts', 'test', 'ensure-ffmpeg.test.sh');

for (const [label, helper] of [
  ['source', join(repositoryRoot, 'scripts', 'ensure-ffmpeg.sh')],
  ['packaged', join(repositoryRoot, 'packages', 'claude-plugin', 'scripts', 'ensure-ffmpeg.sh')],
] as const) {
  test(`ensure-ffmpeg has consistent four-branch exits in the ${label} helper`, async () => {
    const { stdout, stderr } = await execFileAsync('bash', [contractTest, helper, label], {
      encoding: 'utf8',
    });

    assert.equal(stderr, '');
    const receipt = JSON.parse(stdout.trim()) as {
      status: string;
      helper: string;
      cases: Array<{ case: string; expectedExit: number; actualExit: number }>;
    };
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.helper, label);
    assert.deepEqual(
      receipt.cases.map(({ case: caseName, expectedExit, actualExit }) => ({
        case: caseName,
        expectedExit,
        actualExit,
      })),
      [
        { case: 'pre-installed', expectedExit: 0, actualExit: 0 },
        { case: 'homebrew-install-success', expectedExit: 0, actualExit: 0 },
        { case: 'homebrew-install-failure', expectedExit: 1, actualExit: 1 },
        { case: 'homebrew-absent', expectedExit: 1, actualExit: 1 },
      ],
    );
  });
}
