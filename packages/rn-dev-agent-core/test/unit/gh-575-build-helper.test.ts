import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const pexecFile = promisify(execFile);
const expoHelper = resolve('scripts/expo_ensure_running.sh');
const easHelper = resolve('scripts/eas_resolve_artifact.sh');
const firstProjectId = '11111111-1111-4111-8111-111111111111';
const secondProjectId = '22222222-2222-4222-8222-222222222222';

function expoAppJson(projectId: string): string {
  return `${JSON.stringify({ expo: { extra: { eas: { projectId } } } })}\n`;
}

function easBuildJson(
  url: string,
  options: { projectId?: string; buildId?: string; completedAt?: string } = {},
): string {
  return JSON.stringify([
    {
      id: options.buildId ?? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      project: { id: options.projectId ?? firstProjectId },
      completedAt: options.completedAt ?? '2026-07-22T10:00:00.000Z',
      artifacts: { buildUrl: url },
    },
  ]);
}

async function executable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}

test('GH-575 packaged EAS helpers match the canonical source', async () => {
  const source = await readFile(easHelper, 'utf8');
  assert.equal(
    await readFile(resolve('packages/claude-plugin/scripts/eas_resolve_artifact.sh'), 'utf8'),
    source,
  );
  assert.equal(
    await readFile(resolve('packages/codex-plugin/scripts/eas_resolve_artifact.sh'), 'utf8'),
    source,
  );
});

test('GH-575 packaged EAS references document immutable app-scoped cache paths', async () => {
  const source = await readFile(
    resolve(
      'packages/shared-agent-knowledge/skills/rn-device-control/references/expo-eas-builds.md',
    ),
    'utf8',
  );
  assert.equal(
    await readFile(
      resolve('packages/claude-plugin/skills/rn-device-control/references/expo-eas-builds.md'),
      'utf8',
    ),
    source,
  );
  const codex = await readFile(
    resolve('packages/codex-plugin/skills/rn-device-control/references/expo-eas-builds.md'),
    'utf8',
  );
  for (const reference of [source, codex]) {
    assert.match(reference, /\.eas-cache-<project-id>-development-ios-A1b2C3\.json/);
    assert.match(reference, /development-ios-A1b2C3\.tar\.gz/);
    assert.match(reference, /exact Expo\/EAS project ID/);
    assert.match(reference, /newest remote build timestamp and ID deterministically/);
    assert.doesNotMatch(reference, /"path":"\/private\/path\/development-ios\.tar\.gz"/);
  }
});

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

test('GH-575 Android device discovery failure still returns valid JSON', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-android-failure-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(project);
  await mkdir(bin);
  await executable(join(bin, 'adb'), '#!/bin/sh\nexit 127\n');
  try {
    await assert.rejects(
      pexecFile(
        'bash',
        [expoHelper, 'android', '--bundle-id', 'com.example.preview', '--start-metro', 'false'],
        { cwd: project, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } },
      ),
      (error: unknown) => {
        const output = error as { stdout?: string };
        const result = JSON.parse(output.stdout ?? '') as { status: string; message: string };
        assert.equal(result.status, 'error');
        assert.match(result.message, /adb is unavailable or failed/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 caller-owned EAS cache reuses its validated immutable sidecar pair', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-helper-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  const easCalls = join(root, 'eas.calls');
  const foreign = join(root, 'foreign');
  await mkdir(project);
  await mkdir(cache);
  await chmod(cache, 0o700);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{"development":{}}}\n');
  await writeFile(join(project, 'app.json'), expoAppJson(firstProjectId));
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
printf 'call\n' >> "$MOCK_EAS_CALLS"
printf '%s\n' '${easBuildJson('https://example.invalid/development')}'
`,
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
cat >/dev/null
while [ "$1" != "-o" ]; do shift; done
printf 'artifact\n' > "$2"
`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_EAS_CALLS: easCalls,
    TMPDIR: root,
  };
  try {
    const first = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    const second = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    const firstResult = JSON.parse(first.stdout) as { path: string; source: string };
    const secondResult = JSON.parse(second.stdout) as { path: string; source: string };
    assert.equal(firstResult.source, 'eas');
    assert.equal(secondResult.source, 'cache');
    assert.equal(secondResult.path, firstResult.path);
    assert.equal(await readFile(firstResult.path, 'utf8'), 'artifact\n');
    assert.equal(await readFile(easCalls, 'utf8'), 'call\n');

    const sidecarName = (await readdir(cache)).find((name) => name.startsWith('.eas-cache-'));
    assert.ok(sidecarName);
    const sidecar = join(cache, sidecarName);
    assert.equal((await stat(sidecar)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(sidecar, 'utf8')), {
      projectId: firstProjectId,
      platform: 'ios',
      profile: 'development',
      buildId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      buildTimestamp: '2026-07-22T10:00:00.000Z',
      artifact: basename(firstResult.path),
    });

    await writeFile(firstResult.path, '');
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development', cache], { cwd: project, env }),
      /Cached artifact must be nonempty/,
    );
    await writeFile(firstResult.path, 'artifact\n');

    await writeFile(foreign, 'foreign\n');
    await rm(sidecar);
    await symlink(foreign, sidecar);
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development', cache], { cwd: project, env }),
      /Artifact cache sidecar must be a regular file/,
    );
    assert.equal(await readFile(foreign, 'utf8'), 'foreign\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 EAS cache keys profiles by exact artifact name', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-cache-key-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  await mkdir(project);
  await mkdir(cache);
  await chmod(cache, 0o700);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await writeFile(join(cache, 'development-ios.tar.gz'), 'wrong profile');
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
printf '%s\n' '${easBuildJson('https://example.invalid/dev')}'
`,
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
cat >/dev/null
printf 'dev artifact\n' > "$2"
`,
  );
  try {
    const { stdout } = await pexecFile('bash', [easHelper, 'ios', 'dev', cache], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const result = JSON.parse(stdout) as { path: string; source: string };
    assert.match(result.path, /\/dev-ios-[A-Za-z0-9]+\.tar\.gz$/);
    assert.equal(resolve(result.path, '..'), await realpath(cache));
    assert.equal(result.source, 'eas');
    assert.equal(await readFile(result.path, 'utf8'), 'dev artifact\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 EAS cache identity follows the exact project ID, not the checkout path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-app-key-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  const calls = join(root, 'eas.calls');
  for (const directory of [project, cache, bin]) {
    await mkdir(directory);
  }
  await chmod(cache, 0o700);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await writeFile(join(project, 'app.json'), expoAppJson(firstProjectId));
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
if grep -q '${firstProjectId}' app.json; then
  printf 'first\n' >> "$MOCK_EAS_CALLS"
  printf '%s\n' '${easBuildJson('https://example.invalid/first', { projectId: firstProjectId, buildId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })}'
else
  printf 'second\n' >> "$MOCK_EAS_CALLS"
  printf '%s\n' '${easBuildJson('https://example.invalid/second', { projectId: secondProjectId, buildId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })}'
fi
`,
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
config=$(cat)
while [ "$1" != "-o" ]; do shift; done
printf '%s\n' "$config" > "$2"
`,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MOCK_EAS_CALLS: calls,
  };
  try {
    const first = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    await writeFile(join(project, 'app.json'), expoAppJson(secondProjectId));
    const second = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    await writeFile(join(project, 'app.json'), expoAppJson(firstProjectId));
    const firstAgain = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    const firstResult = JSON.parse(first.stdout) as { path: string; source: string };
    const secondResult = JSON.parse(second.stdout) as { path: string; source: string };
    const cachedResult = JSON.parse(firstAgain.stdout) as { path: string; source: string };
    assert.equal(firstResult.source, 'eas');
    assert.equal(secondResult.source, 'eas');
    assert.equal(cachedResult.source, 'cache');
    assert.equal(cachedResult.path, firstResult.path);
    assert.notEqual(firstResult.path, secondResult.path);
    assert.match(await readFile(firstResult.path, 'utf8'), /\/first/);
    assert.match(await readFile(secondResult.path, 'utf8'), /\/second/);
    assert.equal((await readdir(cache)).filter((name) => name.startsWith('.eas-cache-')).length, 2);
    assert.equal(await readFile(calls, 'utf8'), 'first\nsecond\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 EAS cache reuse is skipped when static project identity is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-no-project-id-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  const calls = join(root, 'eas.calls');
  for (const directory of [project, cache, bin]) await mkdir(directory);
  await chmod(cache, 0o700);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await writeFile(join(project, 'app.config.js'), 'module.exports = { expo: {} };\n');
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
printf 'call\n' >> "$MOCK_EAS_CALLS"
printf '%s\n' '${easBuildJson('https://example.invalid/fresh')}'
`,
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
cat >/dev/null
while [ "$1" != "-o" ]; do shift; done
printf 'artifact\n' > "$2"
`,
  );
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_EAS_CALLS: calls };
  try {
    const first = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    const second = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
      cwd: project,
      env,
    });
    assert.equal(JSON.parse(first.stdout).source, 'eas');
    assert.equal(JSON.parse(second.stdout).source, 'eas');
    assert.equal(await readFile(calls, 'utf8'), 'call\ncall\n');
    assert.match(first.stderr, /exact Expo project ID is not statically provable/);
    assert.match(second.stderr, /exact Expo project ID is not statically provable/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 default EAS output is private, retained, and does not log signed URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-private-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const curlArgs = join(root, 'curl.args');
  await mkdir(project);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
printf '%s\n' '${easBuildJson('https://example.invalid/private?X-Amz-Signature=signed-secret')}'
`,
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
printf '%s\n' "$*" > "$MOCK_CURL_ARGS"
config=$(cat)
case "$config" in
  *signed-secret*) ;;
  *) exit 9 ;;
esac
while [ "$1" != "-o" ]; do shift; done
printf 'artifact\n' > "$2"
`,
  );
  try {
    const { stdout, stderr } = await pexecFile('bash', [easHelper, 'ios', 'development'], {
      cwd: project,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: root,
        MOCK_CURL_ARGS: curlArgs,
      },
    });
    const result = JSON.parse(stdout) as { path: string };
    const output = resolve(result.path, '..');
    assert.equal(output.startsWith(join(await realpath(root), 'rn-eas-builds.')), true);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal(await readFile(result.path, 'utf8'), 'artifact\n');
    assert.doesNotMatch(stderr, /X-Amz-Signature|signed-secret|https:\/\//);
    const args = await readFile(curlArgs, 'utf8');
    assert.match(args, /--config -/);
    assert.doesNotMatch(args, /X-Amz-Signature|signed-secret|https:\/\//);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 failed EAS resolution removes private output and classifies diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-failure-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  const secret = 'secret-value-123456789';
  const signedUrl = 'https://example.invalid/build?credential=quoted-secret';
  await mkdir(project);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
printf 'Authentication failed {"unknownCredential":"%s","url":"%s"}\n' '${secret}' '${signedUrl}' >&2
exit 1
`,
  );
  try {
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development'], {
        cwd: project,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
      }),
      (error: unknown) => {
        const output = error as { stdout?: string; stderr?: string };
        const stdout = output.stdout ?? '';
        const result = JSON.parse(stdout) as { message: string };
        assert.match(result.message, /authentication failed; run eas whoami and authenticate\./);
        assert.doesNotMatch(stdout, new RegExp(secret));
        assert.doesNotMatch(output.stderr ?? '', new RegExp(secret));
        assert.doesNotMatch(stdout, /quoted-secret|https:\/\//);
        assert.doesNotMatch(output.stderr ?? '', /quoted-secret|https:\/\//);
        return true;
      },
    );
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('rn-eas-builds.')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 auto-selected EAS profiles cannot escape the output directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-profile-'));
  const project = join(root, 'project');
  const escaped = join(root, 'target-ios.tar.gz');
  await mkdir(project);
  await writeFile(
    join(project, 'eas.json'),
    '{"build":{"../../target":{"ios":{"simulator":true}}}}\n',
  );
  try {
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios'], {
        cwd: project,
        env: { ...process.env, TMPDIR: root },
      }),
      (error: unknown) => {
        const output = error as { stdout?: string };
        const result = JSON.parse(output.stdout ?? '') as { message: string };
        assert.match(result.message, /Invalid profile name/);
        return true;
      },
    );
    await assert.rejects(readFile(escaped));
    assert.equal(
      (await readdir(root)).some((name) => name.startsWith('rn-eas-builds.')),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 EAS publication reports immutable artifact publication failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-publish-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  await mkdir(project);
  await mkdir(cache);
  await chmod(cache, 0o700);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  try {
    await executable(
      join(bin, 'eas'),
      `#!/bin/sh
printf '%s\n' '${easBuildJson('https://example.invalid/build')}'
`,
    );
    await executable(
      join(bin, 'curl'),
      `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
cat >/dev/null
printf 'artifact\n' > "$2"
`,
    );
    await executable(join(bin, 'ln'), '#!/bin/sh\nexit 1\n');
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development', cache], {
        cwd: project,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
      (error: unknown) => {
        const result = JSON.parse((error as { stdout?: string }).stdout ?? '') as {
          message: string;
        };
        assert.match(result.message, /Failed to publish downloaded artifact/);
        return true;
      },
    );
    assert.deepEqual(await readdir(cache), []);

    await executable(
      join(bin, 'ln'),
      '#!/bin/sh\nexec /bin/ln "$@"\n',
    );
    await executable(join(bin, 'mv'), '#!/bin/sh\nexit 1\n');
    const unrelated = join(cache, 'preview-ios-Unrelated.tar.gz');
    await writeFile(unrelated, 'other run\n');
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development', cache], {
        cwd: project,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
      (error: unknown) => {
        const result = JSON.parse((error as { stdout?: string }).stdout ?? '') as {
          message: string;
        };
        assert.match(result.message, /Failed to publish artifact cache sidecar/);
        return true;
      },
    );
    assert.deepEqual(await readdir(cache), ['preview-ios-Unrelated.tar.gz']);
    assert.equal(await readFile(unrelated, 'utf8'), 'other run\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 EAS resolver rejects empty downloads before publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-empty-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  await mkdir(project);
  await mkdir(cache);
  await chmod(cache, 0o700);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await executable(
    join(bin, 'eas'),
    `#!/bin/sh
printf '%s\n' '${easBuildJson('https://example.invalid/empty')}'
`,
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
cat >/dev/null
while [ "$1" != "-o" ]; do shift; done
: > "$2"
`,
  );
  try {
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development', cache], {
        cwd: project,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
      }),
      /Downloaded artifact must be a nonempty regular file/,
    );
    assert.deepEqual(await readdir(cache), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'GH-575 concurrent EAS resolutions isolate metadata and publish complete artifacts',
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-concurrency-'));
    const project = join(root, 'project');
    const cache = join(root, 'artifacts');
    const bin = join(root, 'bin');
    const sync = join(root, 'sync');
    await mkdir(project);
    await mkdir(cache);
    await chmod(cache, 0o700);
    await mkdir(bin);
    await mkdir(sync);
    await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
    await executable(
      join(bin, 'eas'),
      `#!/bin/sh
profile=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--buildProfile" ]; then profile="$2"; shift 2; else shift; fi
done
wait_for_marker() {
  marker="$1"
  attempts=0
  while [ ! -f "$marker" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 200 ] || exit 70
    sleep 0.01
  done
}
touch "$MOCK_SYNC/$profile.ready"
other=alpha
[ "$profile" = "alpha" ] && other=beta
wait_for_marker "$MOCK_SYNC/$other.ready"
if [ "$profile" = "beta" ]; then
  printf '%s\n' '${easBuildJson('https://example.invalid/beta', { buildId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' })}'
  touch "$MOCK_SYNC/beta.wrote"
  wait_for_marker "$MOCK_SYNC/alpha.wrote"
else
  wait_for_marker "$MOCK_SYNC/beta.wrote"
  printf '%s\n' '${easBuildJson('https://example.invalid/alpha', { buildId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })}'
  touch "$MOCK_SYNC/alpha.wrote"
fi
`,
    );
    await executable(
      join(bin, 'curl'),
      `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then output="$2"; shift 2
  else shift
  fi
done
config=$(cat)
url=$(printf '%s\n' "$config" | cut -d '"' -f 2)
printf '%s\n' "$url" > "$output"
`,
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_SYNC: sync,
    };
    try {
      const [alpha, beta] = await Promise.all(
        ['alpha', 'beta'].map((profile) =>
          pexecFile('bash', [easHelper, 'ios', profile, cache], {
            cwd: project,
            env,
            timeout: 5_000,
          }),
        ),
      );
      const alphaResult = JSON.parse(alpha.stdout) as { path: string };
      const betaResult = JSON.parse(beta.stdout) as { path: string };
      assert.equal(await readFile(alphaResult.path, 'utf8'), 'https://example.invalid/alpha\n');
      assert.equal(await readFile(betaResult.path, 'utf8'), 'https://example.invalid/beta\n');
      assert.match(alphaResult.path, /\/alpha-ios-[A-Za-z0-9]+\.tar\.gz$/);
      assert.match(betaResult.path, /\/beta-ios-[A-Za-z0-9]+\.tar\.gz$/);
      assert.equal((await readdir(cache)).length, 4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'GH-575 cache selection uses remote build order instead of completion order',
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-same-profile-'));
    const project = join(root, 'project');
    const cache = join(root, 'artifacts');
    const bin = join(root, 'bin');
    const sync = join(root, 'sync');
    const calls = join(root, 'eas.calls');
    await mkdir(project);
    await mkdir(cache);
    await chmod(cache, 0o700);
    await mkdir(bin);
    await mkdir(sync);
    await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
    await writeFile(join(project, 'app.json'), expoAppJson(firstProjectId));
    await executable(
      join(bin, 'eas'),
      `#!/bin/sh
if mkdir "$MOCK_SYNC/older-claimed" 2>/dev/null; then
  printf 'older\n' >> "$MOCK_EAS_CALLS"
  printf '%s\n' '${easBuildJson('https://example.invalid/older?signed=credential', { buildId: '11111111-aaaa-4aaa-8aaa-111111111111', completedAt: '2026-07-21T10:00:00.000Z' })}'
else
  printf 'newer\n' >> "$MOCK_EAS_CALLS"
  printf '%s\n' '${easBuildJson('https://example.invalid/newer?signed=credential', { buildId: '22222222-bbbb-4bbb-8bbb-222222222222', completedAt: '2026-07-22T10:00:00.000Z' })}'
fi
`,
    );
    await executable(
      join(bin, 'curl'),
      `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
output="$2"
config=$(cat)
case "$config" in
  *'https://example.invalid/newer?signed=credential'*)
    printf 'newer\n' > "$output"
    touch "$MOCK_SYNC/newer-downloaded"
    ;;
  *'https://example.invalid/older?signed=credential'*)
    attempts=0
    while [ ! -f "$MOCK_SYNC/newer-downloaded" ]; do
      attempts=$((attempts + 1))
      [ "$attempts" -lt 200 ] || exit 70
      sleep 0.01
    done
    sleep 0.2
    printf 'older\n' > "$output"
    ;;
  *) exit 9 ;;
esac
`,
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_SYNC: sync,
      MOCK_EAS_CALLS: calls,
    };
    try {
      const [first, second] = await Promise.all([
        pexecFile('bash', [easHelper, 'ios', 'development', cache], {
          cwd: project,
          env,
          timeout: 5_000,
        }),
        pexecFile('bash', [easHelper, 'ios', 'development', cache], {
          cwd: project,
          env,
          timeout: 5_000,
        }),
      ]);
      const firstResult = JSON.parse(first.stdout) as { path: string };
      const secondResult = JSON.parse(second.stdout) as { path: string };
      assert.notEqual(firstResult.path, secondResult.path);
      assert.match(firstResult.path, /\/development-ios-[A-Za-z0-9]+\.tar\.gz$/);
      assert.match(secondResult.path, /\/development-ios-[A-Za-z0-9]+\.tar\.gz$/);
      const firstContents = await readFile(firstResult.path, 'utf8');
      const secondContents = await readFile(secondResult.path, 'utf8');
      assert.notEqual(firstContents, secondContents);
      const newerPath = firstContents === 'newer\n' ? firstResult.path : secondResult.path;
      assert.equal((await readdir(cache)).length, 4);

      const cached = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
        cwd: project,
        env,
      });
      const cachedResult = JSON.parse(cached.stdout) as { path: string; source: string };
      assert.equal(cachedResult.source, 'cache');
      assert.equal(cachedResult.path, newerPath);
      assert.equal((await readdir(cache)).length, 4);
      assert.equal(await readFile(calls, 'utf8'), 'older\nnewer\n');
      const sidecars = (await readdir(cache)).filter((name) => name.startsWith('.eas-cache-'));
      assert.equal(sidecars.length, 2);
      for (const sidecar of sidecars) {
        assert.equal((await stat(join(cache, sidecar))).mode & 0o777, 0o600);
        const metadata = JSON.parse(await readFile(join(cache, sidecar), 'utf8')) as {
          projectId: string;
          buildId: string;
          buildTimestamp: string;
          artifact: string;
        };
        assert.equal(metadata.projectId, firstProjectId);
        assert.match(metadata.buildId, /^[12]{8}-/);
        assert.match(metadata.buildTimestamp, /^2026-07-2[12]T/);
        assert.equal(await readFile(join(cache, metadata.artifact), 'utf8').then(Boolean), true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  'GH-575 reconciles a sidecar exposed by a failing atomic rename',
  { timeout: 10_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-commit-point-'));
    const project = join(root, 'project');
    const cache = join(root, 'artifacts');
    const bin = join(root, 'bin');
    const sync = join(root, 'sync');
    const easCalls = join(root, 'eas.calls');
    const sidecarVisible = join(sync, 'sidecar-visible');
    const consumerDone = join(sync, 'consumer-done');
    for (const directory of [project, cache, bin, sync]) await mkdir(directory);
    await chmod(cache, 0o700);
    await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
    await writeFile(join(project, 'app.json'), expoAppJson(firstProjectId));
    await executable(
      join(bin, 'eas'),
      `#!/bin/sh
printf 'call\n' >> "$MOCK_EAS_CALLS"
printf '%s\n' '${easBuildJson('https://example.invalid/committed')}'
`,
    );
    await executable(
      join(bin, 'curl'),
      `#!/bin/sh
cat >/dev/null
while [ "$1" != "-o" ]; do shift; done
printf 'committed artifact\n' > "$2"
`,
    );
    await executable(
      join(bin, 'mv'),
      `#!/bin/sh
/bin/mv "$@" || exit 1
touch "$MOCK_SYNC/sidecar-visible"
attempts=0
while [ ! -f "$MOCK_SYNC/consumer-done" ]; do
  attempts=$((attempts + 1))
  [ "$attempts" -lt 300 ] || exit 70
  sleep 0.01
done
exit 73
`,
    );
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      MOCK_SYNC: sync,
      MOCK_EAS_CALLS: easCalls,
    };
    try {
      const publisher = pexecFile(
        'bash',
        [
          '-o',
          'pipefail',
          '-c',
          'bash "$1" "$2" "$3" "$4" | head -c 0',
          'publisher',
          easHelper,
          'ios',
          'development',
          cache,
        ],
        { cwd: project, env, timeout: 5_000 },
      ).then(
        () => ({ failed: false }),
        (error: unknown) => ({ failed: true, error }),
      );

      let visible = false;
      for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
          await stat(sidecarVisible);
          visible = true;
          break;
        } catch {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }
      }
      assert.equal(visible, true);

      let consumer: { stdout: string } | undefined;
      try {
        consumer = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
          cwd: project,
          env,
          timeout: 5_000,
        });
      } finally {
        await writeFile(consumerDone, 'done\n');
      }
      assert.ok(consumer);
      const consumerResult = JSON.parse(consumer.stdout) as { path: string; source: string };
      assert.equal(consumerResult.source, 'cache');

      const publisherResult = await publisher;
      assert.equal(publisherResult.failed, true);
      if ('error' in publisherResult) {
        assert.doesNotMatch(
          (publisherResult.error as { stderr?: string }).stderr ?? '',
          /Failed to publish artifact cache sidecar/,
        );
      }
      assert.equal(await readFile(consumerResult.path, 'utf8'), 'committed artifact\n');
      assert.equal(
        (await readdir(cache)).filter((name) => name.startsWith('.eas-cache-')).length,
        1,
      );
      assert.equal(await readFile(easCalls, 'utf8'), 'call\n');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('GH-575 EAS resolver rejects permissive and symlinked output directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-safety-'));
  const project = join(root, 'project');
  const permissive = join(root, 'permissive');
  const linked = join(root, 'linked');
  await mkdir(project);
  await mkdir(permissive);
  await chmod(permissive, 0o755);
  await symlink(permissive, linked);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  try {
    for (const output of [permissive, linked]) {
      await assert.rejects(
        pexecFile('bash', [easHelper, 'ios', 'development', output], { cwd: project }),
        (error: unknown) => {
          const result = JSON.parse((error as { stdout?: string }).stdout ?? '') as {
            status: string;
          };
          assert.equal(result.status, 'error');
          return true;
        },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
