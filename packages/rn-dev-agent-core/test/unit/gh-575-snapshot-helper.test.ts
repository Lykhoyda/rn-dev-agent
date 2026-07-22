import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const repositoryPath = (path: string): string => resolve(repositoryRoot, path);
const snapshotHelper = repositoryPath('scripts/snapshot_state.sh');

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test('GH-575 snapshot guidance uses package-local exact-device invocations', async () => {
  const shared = await readFile(
    repositoryPath('packages/shared-agent-knowledge/skills/rn-device-control/SKILL.md'),
    'utf8',
  );
  const claude = await readFile(
    repositoryPath('packages/claude-plugin/skills/rn-device-control/SKILL.md'),
    'utf8',
  );
  const codex = await readFile(
    repositoryPath('packages/codex-plugin/skills/rn-device-control/SKILL.md'),
    'utf8',
  );
  assert.equal(claude, shared);
  assert.match(shared, /\$CLAUDE_PLUGIN_ROOT\/scripts\/snapshot_state\.sh/);
  assert.match(codex, /<package-root>\/scripts\/snapshot_state\.sh/);
  for (const guidance of [shared, codex]) {
    assert.match(guidance, /snapshot_state\.sh" ios --device-id/);
    assert.match(guidance, /snapshot_state\.sh" android --device-id/);
    assert.match(guidance, /immutable result directory/);
    assert.match(guidance, /SNAPSHOT_RESULT=\$\(bash/);
    assert.doesNotMatch(guidance, /captures screenshot \+ UI hierarchy simultaneously/);
  }
});

test('GH-575 snapshot requires and targets one exact iOS simulator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-snapshot-ios-'));
  const bin = join(root, 'bin');
  const output = join(root, 'output');
  const log = join(root, 'xcrun.log');
  const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  await mkdir(bin);
  await mkdir(output);
  await chmod(output, 0o700);
  await executable(
    join(bin, 'xcrun'),
    `#!/bin/sh
if [ "$1 $2 $3" = "simctl list devices" ]; then
  printf '    iPhone One (%s) (Booted)\n    iPhone Two (11111111-2222-3333-4444-555555555555) (Booted)\n' '${udid}'
  exit 0
fi
printf '%s\n' "$*" >> "$MOCK_LOG"
printf 'jpeg\n' > "$6"
`,
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, TMPDIR: root };
  try {
    const capture = await pexecFile(
      'bash',
      [snapshotHelper, 'ios', '--device-id', udid, '--output-dir', output],
      { env },
    );
    const result = capture.stdout.trim();
    assert.match(result, /\/snapshot-ios-[A-Za-z0-9]+$/);
    assert.equal(await readFile(join(result, 'screenshot.jpg'), 'utf8'), 'jpeg\n');
    const calls = await readFile(log, 'utf8');
    assert.match(calls, new RegExp(`simctl io ${udid} screenshot`));
    assert.doesNotMatch(calls, /simctl io booted/);

    await assert.rejects(
      pexecFile('bash', [snapshotHelper, 'ios'], { env }),
      /device-id is required/,
    );
    await chmod(output, 0o755);
    await assert.rejects(
      pexecFile('bash', [snapshotHelper, 'ios', '--device-id', udid, '--output-dir', output], {
        env,
      }),
      /mode 0700/,
    );
    await chmod(output, 0o700);
    const linkedOutput = join(root, 'linked-output');
    await symlink(output, linkedOutput);
    await assert.rejects(
      pexecFile(
        'bash',
        [snapshotHelper, 'ios', '--device-id', udid, '--output-dir', linkedOutput],
        { env },
      ),
      /not a symlink/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 snapshot creates private output and targets every Android operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-snapshot-android-'));
  const bin = join(root, 'bin');
  const log = join(root, 'adb.log');
  const serial = 'emulator-5556';
  await mkdir(bin);
  await executable(
    join(bin, 'adb'),
    `#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_LOG"
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n'
elif [ "$3 $4 $5" = "exec-out screencap -p" ]; then
  printf 'png\n'
elif [ "$3 $4" = "exec-out cat" ]; then
  printf '<hierarchy><node text="Login" resource-id="login" content-desc="" bounds="[0,0][1,1]" clickable="true"/></hierarchy>\n'
fi
`,
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, TMPDIR: root };
  try {
    const { stdout } = await pexecFile('bash', [snapshotHelper, 'android', '--device-id', serial], {
      env,
    });
    const output = stdout.trim();
    assert.match(output, /\/snapshot-android-[A-Za-z0-9]+$/);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(output, 'screenshot.png'), 'utf8'), 'png\n');
    const hierarchy = JSON.parse(
      await readFile(join(output, 'ui_elements.json'), 'utf8'),
    ) as Array<{
      text: string;
    }>;
    assert.equal(hierarchy[0]?.text, 'Login');
    const operations = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .filter((line) => line !== 'devices');
    assert.ok(operations.length >= 4);
    assert.equal(
      operations.every((line) => line.startsWith(`-s ${serial} `)),
      true,
    );

    await assert.rejects(
      pexecFile('bash', [snapshotHelper, 'android', '--device-id', 'emulator-9999'], { env }),
      /not connected/,
    );
    const source = await readFile(snapshotHelper, 'utf8');
    assert.equal(
      await readFile(repositoryPath('packages/claude-plugin/scripts/snapshot_state.sh'), 'utf8'),
      source,
    );
    assert.equal(
      await readFile(repositoryPath('packages/codex-plugin/scripts/snapshot_state.sh'), 'utf8'),
      source,
    );
    assert.doesNotMatch(source, /\bkill\b/);
    assert.doesNotMatch(source, /\s&\s*(?:\n|$)/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 snapshot removes internally owned output when capture fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-snapshot-failure-'));
  const bin = join(root, 'bin');
  const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  await mkdir(bin);
  await executable(
    join(bin, 'xcrun'),
    `#!/bin/sh
if [ "$1 $2 $3" = "simctl list devices" ]; then
  printf '    iPhone One (%s) (Booted)\n' '${udid}'
  exit 0
fi
exit 1
`,
  );
  try {
    await assert.rejects(
      pexecFile('bash', [snapshotHelper, 'ios', '--device-id', udid], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
      }),
      /iOS screenshot capture failed/,
    );
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('rn-snapshot.')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 snapshot cleans caller-owned staging when either Android artifact fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-snapshot-android-failure-'));
  const bin = join(root, 'bin');
  const output = join(root, 'output');
  const serial = 'emulator-5556';
  await mkdir(bin);
  await mkdir(output);
  await chmod(output, 0o700);
  await executable(
    join(bin, 'adb'),
    `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\nemulator-5556\tdevice\n'
  exit 0
fi
if [ "$3 $4 $5" = "exec-out screencap -p" ]; then
  printf 'png\n'
  exit 0
fi
if [ "$3 $4 $5" = "shell rm -f" ]; then
  exit 0
fi
exit 1
`,
  );
  try {
    await assert.rejects(
      pexecFile(
        'bash',
        [snapshotHelper, 'android', '--device-id', serial, '--output-dir', output],
        {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
        },
      ),
      /requires both screenshot and UI hierarchy artifacts/,
    );
    assert.deepEqual(await readdir(output), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'GH-575 concurrent snapshots publish separate immutable complete evidence sets',
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-snapshot-lock-'));
    const bin = join(root, 'bin');
    const output = join(root, 'output');
    const serial = 'emulator-5556';
    await mkdir(bin);
    await mkdir(output);
    await chmod(output, 0o700);
    await executable(
      join(bin, 'adb'),
      `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\nemulator-5556\tdevice\n'
  exit 0
fi
if [ "$3 $4 $5" = "exec-out screencap -p" ]; then
  printf 'png-%s\n' "$PPID"
  exit 0
fi
if [ "$3 $4 $5" = "shell uiautomator dump" ]; then
  exit 0
fi
if [ "$3 $4" = "exec-out cat" ]; then
  printf '<hierarchy><node text="%s" resource-id="new" content-desc="" bounds="[0,0][1,1]" clickable="true"/></hierarchy>\n' "$PPID"
  exit 0
fi
exit 0
`,
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
    };
    try {
      const [first, second] = await Promise.all([
        pexecFile(
          'bash',
          [snapshotHelper, 'android', '--device-id', serial, '--output-dir', output],
          { env, timeout: 5_000 },
        ),
        pexecFile(
          'bash',
          [snapshotHelper, 'android', '--device-id', serial, '--output-dir', output],
          { env, timeout: 5_000 },
        ),
      ]);
      const resultDirs = [first.stdout.trim(), second.stdout.trim()];
      assert.notEqual(resultDirs[0], resultDirs[1]);
      for (const resultDir of resultDirs) {
        const screenshot = await readFile(join(resultDir, 'screenshot.png'), 'utf8');
        const hierarchy = JSON.parse(
          await readFile(join(resultDir, 'ui_elements.json'), 'utf8'),
        ) as Array<{ text: string }>;
        assert.equal(screenshot.trim().replace('png-', ''), hierarchy[0]?.text);
      }
      assert.equal(
        (await readdir(output)).some((name) => name.startsWith('.snapshot-stage.')),
        false,
      );
      assert.equal(
        (await readdir(output)).filter((name) => name.startsWith('snapshot-android-')).length,
        2,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('GH-575 snapshot ignores and preserves an obsolete lock symlink', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-snapshot-lock-link-'));
  const bin = join(root, 'bin');
  const output = join(root, 'output');
  const foreign = join(root, 'foreign');
  const lock = join(output, '.snapshot.lock');
  const serial = 'emulator-5556';
  await mkdir(bin);
  await mkdir(output);
  await chmod(output, 0o700);
  await mkdir(foreign);
  await symlink(foreign, lock);
  await executable(
    join(bin, 'adb'),
    `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\nemulator-5556\tdevice\n'
  exit 0
fi
if [ "$3 $4 $5" = "exec-out screencap -p" ]; then
  printf 'png\n'
elif [ "$3 $4 $5" = "shell uiautomator dump" ]; then
  exit 0
elif [ "$3 $4" = "exec-out cat" ]; then
  printf '<hierarchy><node text="Ready" resource-id="ready" content-desc="" bounds="[0,0][1,1]" clickable="true"/></hierarchy>\n'
fi
`,
  );
  try {
    const { stdout } = await pexecFile(
      'bash',
      [snapshotHelper, 'android', '--device-id', serial, '--output-dir', output],
      { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.match(stdout.trim(), /\/snapshot-android-[A-Za-z0-9]+$/);
    assert.equal((await lstat(lock)).isSymbolicLink(), true);
    assert.equal((await stat(foreign)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 published snapshot docs describe exact sequential private capture', async () => {
  const docs = await readFile(
    repositoryPath('apps/docs-site/src/content/docs/skills/rn-device-control.mdx'),
    'utf8',
  );
  assert.match(docs, /snapshot_state\.sh" ios --device-id/);
  assert.match(docs, /captures state sequentially/);
  assert.match(docs, /owner-only private directory/);
  assert.match(docs, /fails closed.*identity/s);
  assert.match(docs, /atomically published as its own immutable.*result directory/s);
  assert.doesNotMatch(
    docs,
    /Concurrent State Snapshot|simultaneously, cutting state-check time by ~40%/,
  );
});
