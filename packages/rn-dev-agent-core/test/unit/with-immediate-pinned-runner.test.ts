import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAESTRO_RUNNER_PIN,
  buildReplayEngineStatus,
  withImmediatePinnedRunner,
  _resetEngineStatusForTest,
  _setEngineStatusForTest,
  _setPinnedRunnerAttestationForTest,
} from '../../dist/domain/engine-pin.js';

const publicationHelperSupported =
  process.platform === 'darwin' ||
  (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'));

const nativeDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'native');
const fixtureBinary =
  process.platform === 'darwin'
    ? join(nativeDir, 'darwin-process-birth')
    : join(nativeDir, `linux-conditional-publication-${process.arch}`);

test(
  'withImmediatePinnedRunner starts the copied publication helper after hardening',
  { skip: publicationHelperSupported ? false : 'POSIX publication helper is unavailable' },
  async () => {
    const cache = mkdtempSync(join(tmpdir(), 'mr-runner-exec-'));
    const previousCache = process.env.RN_DEV_AGENT_RUNNER_CACHE;
    process.env.RN_DEV_AGENT_RUNNER_CACHE = cache;
    try {
      const packed = join(cache, 'packed', 'maestro-runner');
      mkdirSync(join(packed, 'bin'), { recursive: true });
      const renameFrom = join(cache, 'rename-from');
      const renameTo = join(cache, 'rename-to');
      mkdirSync(renameFrom);
      // Copy the committed native helper, not a shebang or /bin/sh: Linux
      // execveat(CLOEXEC) cannot reopen a script, and Darwin kills copied arm64e
      // system binaries. Production maestro-runner is a native binary.
      copyFileSync(fixtureBinary, join(packed, 'bin', 'maestro-runner'));
      chmodSync(join(packed, 'bin', 'maestro-runner'), 0o755);
      const archive = join(cache, 'maestro-runner.tar.gz');
      const packedTar = spawnSync('tar', [
        '-czf',
        archive,
        '-C',
        join(cache, 'packed'),
        'maestro-runner',
      ]);
      assert.equal(packedTar.status, 0, String(packedTar.stderr));

      const pinRoot = join(cache, 'maestro-runner', MAESTRO_RUNNER_PIN.version);
      mkdirSync(join(pinRoot, 'bin'), { recursive: true });
      const runnerPath = join(pinRoot, 'bin', 'maestro-runner');
      copyFileSync(join(packed, 'bin', 'maestro-runner'), runnerPath);
      chmodSync(runnerPath, 0o755);
      copyFileSync(archive, join(pinRoot, '.payload.tar.gz'));

      _setPinnedRunnerAttestationForTest({
        sha256: createHash('sha256').update(readFileSync(runnerPath)).digest('hex'),
        archiveSha256: createHash('sha256').update(readFileSync(archive)).digest('hex'),
      });
      const status = buildReplayEngineStatus('pinned-ok', MAESTRO_RUNNER_PIN.version, false, {
        selectedPath: runnerPath,
        provenance: 'pin-cache',
      });
      _setEngineStatusForTest(status);

      const launched = await withImmediatePinnedRunner(
        runnerPath,
        async () => status,
        async (boundPath, prefixArgs = []) => {
          assert.equal(boundPath.endsWith('.runner-exec'), true);
          return spawnSync(
            boundPath,
            [...prefixArgs, '--rename-no-replace', renameFrom, renameTo],
            { encoding: 'utf8' },
          );
        },
      );

      assert.equal(launched.error, undefined, launched.error?.stack ?? launched.error?.message);
      assert.notEqual(launched.error?.code, 'EACCES');
      assert.equal(launched.status, 0, `${launched.stdout}${launched.stderr}`);
      assert.equal(existsSync(renameTo), true);
      assert.equal(existsSync(renameFrom), false);
    } finally {
      _resetEngineStatusForTest();
      if (previousCache === undefined) delete process.env.RN_DEV_AGENT_RUNNER_CACHE;
      else process.env.RN_DEV_AGENT_RUNNER_CACHE = previousCache;
      rmSync(cache, { recursive: true, force: true });
    }
  },
);
