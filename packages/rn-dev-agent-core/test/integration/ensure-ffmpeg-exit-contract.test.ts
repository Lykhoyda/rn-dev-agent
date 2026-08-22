import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      cases: Array<{
        case: string;
        initiatingCondition: string;
        pathMasking: string;
        expectedExit: number;
        actualExit: number;
        skipGuidanceOnStderr: boolean;
      }>;
    };
    assert.equal(receipt.status, 'passed');
    assert.equal(receipt.helper, label);
    assert.deepEqual(receipt.cases, [
      {
        case: 'pre-installed',
        initiatingCondition: 'ffmpeg already installed',
        pathMasking: 'host ffmpeg and brew masked; ffmpeg stub exposed',
        expectedExit: 0,
        actualExit: 0,
        skipGuidanceOnStderr: false,
      },
      {
        case: 'homebrew-install-success',
        initiatingCondition: 'ffmpeg absent; Homebrew install succeeds',
        pathMasking: 'host ffmpeg and brew masked; brew stub exposed',
        expectedExit: 0,
        actualExit: 0,
        skipGuidanceOnStderr: false,
      },
      {
        case: 'homebrew-install-failure',
        initiatingCondition: 'ffmpeg absent; Homebrew install fails',
        pathMasking: 'host ffmpeg and brew masked; failing brew stub exposed',
        expectedExit: 1,
        actualExit: 1,
        skipGuidanceOnStderr: true,
      },
      {
        case: 'homebrew-absent',
        initiatingCondition: 'ffmpeg and Homebrew absent',
        pathMasking: 'host ffmpeg and brew masked; no command stubs exposed',
        expectedExit: 1,
        actualExit: 1,
        skipGuidanceOnStderr: true,
      },
    ]);
  });
}
