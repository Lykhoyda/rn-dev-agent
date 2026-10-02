import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { packDirectory, runtimeRunnerManifest, tarballName } from '../build-qaren-tarball.ts';

function tree(files: Record<string, { body: string; mode: number }>, mtime: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'qaren-pack-'));
  for (const [path, { body, mode }] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
    chmodSync(join(dir, path), mode);
    utimesSync(join(dir, path), mtime, mtime);
  }
  return dir;
}

const LONG = `qaren-1.2.3-darwin-arm64/runtime/runners/rn-android-runner/app/src/androidTest/java/dev/${'x'.repeat(60)}/Test.kt`;

test('two packs of one tree are byte-identical regardless of disk mtimes, modes and creation order', () => {
  const first = tree(
    {
      'qaren-1.2.3-darwin-arm64/bin/qaren': { body: 'bin', mode: 0o700 },
      'qaren-1.2.3-darwin-arm64/VERSION': { body: '1.2.3\n', mode: 0o600 },
      [LONG]: { body: 'kt', mode: 0o664 },
    },
    1_000,
  );
  const second = tree(
    {
      [LONG]: { body: 'kt', mode: 0o644 },
      'qaren-1.2.3-darwin-arm64/VERSION': { body: '1.2.3\n', mode: 0o644 },
      'qaren-1.2.3-darwin-arm64/bin/qaren': { body: 'bin', mode: 0o755 },
    },
    2_000_000,
  );
  try {
    assert.deepEqual(packDirectory(first, 1_700_000_000), packDirectory(second, 1_700_000_000));
    assert.notDeepEqual(packDirectory(first, 1_700_000_000), packDirectory(first, 1_700_000_001));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test('the archive carries sorted entries, root ownership, normalised modes and the fixed mtime', () => {
  const dir = tree(
    {
      'top/b.txt': { body: 'b', mode: 0o600 },
      'top/a/run': { body: 'a', mode: 0o700 },
      [LONG]: { body: 'kt', mode: 0o644 },
    },
    5,
  );
  try {
    const archive = join(dir, 'out.tar.gz');
    writeFileSync(archive, packDirectory(dir, 1_700_000_000));
    const names = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(names, [...names].sort());
    assert.ok(names.includes(LONG), 'a path beyond 100 bytes survives through the ustar prefix');
    const listing = execFileSync('tar', ['--numeric-owner', '-tvzf', archive], {
      encoding: 'utf8',
    });
    for (const line of listing.trim().split('\n')) {
      // bsdtar lists `<links> 0 0`, GNU tar `0/0`.
      assert.match(line, /^(drwxr-xr-x|-rwxr-xr-x|-rw-r--r--)\s+(\d+\s+0\s+0|0\/0)\s/, line);
    }
    assert.match(listing, /-rwxr-xr-x.*top\/a\/run/);
    assert.match(listing, /-rw-r--r--.*top\/b\.txt/);
    const gz = packDirectory(dir, 1_700_000_000);
    assert.equal(gz.readUInt32LE(4), 0, 'gzip header carries no mtime');
    assert.equal(gz[9], 0xff, 'gzip header carries no build-host OS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('anything but regular files and directories is refused', () => {
  const dir = tree({ 'top/file': { body: 'x', mode: 0o644 } }, 5);
  try {
    symlinkSync('/etc/passwd', join(dir, 'top', 'link'));
    assert.throws(() => packDirectory(dir, 0), /only regular files and directories ship/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the runtime manifest names only the runner zips, never a qaren tarball', () => {
  const root = {
    version: '1.2.3',
    xcodeBuildVersion: '16.4',
    assets: {
      ios: [{ name: 'rn-fast-runner-1.2.3-sim.zip', sha256: 'a'.repeat(64), bytes: 1 }],
      android: [{ name: 'rn-android-runner-1.2.3.zip', sha256: 'b'.repeat(64), bytes: 2 }],
      qaren: {
        'darwin-arm64': {
          name: tarballName('1.2.3', 'darwin-arm64'),
          sha256: 'c'.repeat(64),
          bytes: 3,
        },
      },
    },
  };
  assert.deepEqual(JSON.parse(runtimeRunnerManifest(JSON.stringify(root), '1.2.3')), {
    version: '1.2.3',
    assets: { ios: root.assets.ios, android: root.assets.android },
    xcodeBuildVersion: '16.4',
  });
  assert.throws(() => runtimeRunnerManifest(JSON.stringify(root), '1.2.4'), /vouches for v1\.2\.3/);
  assert.throws(
    () => runtimeRunnerManifest(JSON.stringify({ version: '1.2.3', assets: {} }), '1.2.3'),
    /no ios and android assets/,
  );
});
