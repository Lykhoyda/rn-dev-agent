import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);
const expoHelper = resolve('scripts/expo_ensure_running.sh');
const easHelper = resolve('scripts/eas_resolve_artifact.sh');

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test('GH-575 iOS artifact install uses the selected simulator for every operation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-ios-helper-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const artifact = join(root, 'Preview App.app');
  const log = join(root, 'xcrun.log');
  const udid = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
  await mkdir(project);
  await mkdir(bin);
  await mkdir(artifact);
  await executable(
    join(bin, 'xcrun'),
    `#!/bin/sh
if [ "$1 $2 $3" = "simctl list devices" ]; then
  printf '    iPhone One (%s) (Booted)\n    iPhone Two (11111111-2222-3333-4444-555555555555) (Booted)\n' '${udid}'
  exit 0
fi
printf '%s\n' "$*" >> "$MOCK_LOG"
`,
  );
  try {
    const { stdout } = await pexecFile(
      'bash',
      [
        expoHelper,
        'ios',
        '--device-id',
        udid,
        '--artifact',
        artifact,
        '--bundle-id',
        'com.example.preview',
        '--start-metro',
        'false',
      ],
      {
        cwd: project,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, TMPDIR: root },
      },
    );
    assert.equal(JSON.parse(stdout).device_id, udid);
    const calls = await readFile(log, 'utf8');
    assert.match(calls, new RegExp(`simctl install ${udid} `));
    assert.match(calls, new RegExp(`simctl launch ${udid} com\\.example\\.preview`));
    assert.doesNotMatch(calls, / booted /);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 Android install targets one exact serial and fails closed on ambiguity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-android-helper-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const artifact = join(root, 'preview app.apk');
  const log = join(root, 'adb.log');
  await mkdir(project);
  await mkdir(bin);
  await writeFile(artifact, 'apk');
  await executable(
    join(bin, 'adb'),
    `#!/bin/sh
if [ "$1" = "devices" ]; then
  printf 'List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n'
  exit 0
fi
printf '%s\n' "$*" >> "$MOCK_LOG"
`,
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_LOG: log, TMPDIR: root };
  try {
    const { stdout } = await pexecFile(
      'bash',
      [
        expoHelper,
        'android',
        '--device-id',
        'emulator-5556',
        '--artifact',
        artifact,
        '--bundle-id',
        'com.example.preview',
        '--start-metro',
        'false',
      ],
      { cwd: project, env },
    );
    assert.equal(JSON.parse(stdout).device_id, 'emulator-5556');
    const calls = await readFile(log, 'utf8');
    assert.match(calls, /-s emulator-5556 install -r .*preview app\.apk/);
    assert.match(calls, /-s emulator-5556 shell am start -n com\.example\.preview\/\.MainActivity/);

    await writeFile(log, '');
    await assert.rejects(
      pexecFile(
        'bash',
        [expoHelper, 'android', '--bundle-id', 'com.example.preview', '--start-metro', 'false'],
        { cwd: project, env },
      ),
      (error: unknown) => {
        const output = error as { stdout?: string };
        assert.match(output.stdout ?? '', /Multiple connected Android devices/);
        return true;
      },
    );
    assert.equal(await readFile(log, 'utf8'), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 default EAS cache path survives resolver exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-helper-'));
  const project = join(root, 'project');
  const cache = join(root, 'rn-eas-builds');
  const artifact = join(cache, 'development-ios.tar.gz');
  await mkdir(project);
  await mkdir(cache);
  await writeFile(join(project, 'eas.json'), '{"build":{"development":{}}}\n');
  await writeFile(artifact, 'artifact');
  try {
    const { stdout } = await pexecFile('bash', [easHelper, 'ios', 'development'], {
      cwd: project,
      env: { ...process.env, TMPDIR: root },
    });
    const result = JSON.parse(stdout) as { status: string; path: string };
    assert.equal(result.status, 'ok');
    assert.equal(result.path, await realpath(artifact));
    assert.equal(await readFile(artifact, 'utf8'), 'artifact');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
