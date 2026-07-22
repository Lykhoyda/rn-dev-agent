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

test('GH-575 caller-owned EAS cache survives resolver exit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-helper-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const artifact = join(cache, 'development-ios.tar.gz');
  await mkdir(project);
  await mkdir(cache);
  await chmod(cache, 0o700);
  await writeFile(join(project, 'eas.json'), '{"build":{"development":{}}}\n');
  await writeFile(artifact, 'artifact');
  try {
    const { stdout } = await pexecFile('bash', [easHelper, 'ios', 'development', cache], {
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
    '#!/bin/sh\nprintf \'[{"artifacts":{"buildUrl":"https://example.invalid/dev"}}]\\n\'\n',
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
printf 'dev artifact\n' > "$2"
`,
  );
  try {
    const { stdout } = await pexecFile('bash', [easHelper, 'ios', 'dev', cache], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    const result = JSON.parse(stdout) as { path: string; source: string };
    assert.equal(result.path, await realpath(join(cache, 'dev-ios.tar.gz')));
    assert.equal(result.source, 'eas');
    assert.equal(await readFile(result.path, 'utf8'), 'dev artifact\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GH-575 default EAS output is private, retained, and does not log signed URLs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-private-'));
  const project = join(root, 'project');
  const bin = join(root, 'bin');
  await mkdir(project);
  await mkdir(bin);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  await executable(
    join(bin, 'eas'),
    '#!/bin/sh\nprintf \'[{"artifacts":{"buildUrl":"https://example.invalid/private?X-Amz-Signature=signed-secret"}}]\\n\'\n',
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
printf 'artifact\n' > "$2"
`,
  );
  try {
    const { stdout, stderr } = await pexecFile('bash', [easHelper, 'ios', 'development'], {
      cwd: project,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: root },
    });
    const result = JSON.parse(stdout) as { path: string };
    const output = resolve(result.path, '..');
    assert.equal(output.startsWith(join(await realpath(root), 'rn-eas-builds.')), true);
    assert.equal((await stat(output)).mode & 0o777, 0o700);
    assert.equal(await readFile(result.path, 'utf8'), 'artifact\n');
    assert.doesNotMatch(stderr, /X-Amz-Signature|signed-secret|https:\/\//);
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

test('GH-575 EAS publication rejects unsafe destinations and reports rename failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rn-agent-eas-publish-'));
  const project = join(root, 'project');
  const cache = join(root, 'artifacts');
  const bin = join(root, 'bin');
  const destination = join(cache, 'development-ios.tar.gz');
  await mkdir(project);
  await mkdir(cache);
  await chmod(cache, 0o700);
  await mkdir(bin);
  await mkdir(destination);
  await writeFile(join(project, 'eas.json'), '{"build":{}}\n');
  try {
    await assert.rejects(
      pexecFile('bash', [easHelper, 'ios', 'development', cache], { cwd: project }),
      (error: unknown) => {
        const result = JSON.parse((error as { stdout?: string }).stdout ?? '') as {
          message: string;
        };
        assert.match(result.message, /regular file path/);
        return true;
      },
    );

    await rm(destination, { recursive: true });
    await executable(
      join(bin, 'eas'),
      '#!/bin/sh\nprintf \'[{"artifacts":{"buildUrl":"https://example.invalid/build"}}]\\n\'\n',
    );
    await executable(
      join(bin, 'curl'),
      `#!/bin/sh
while [ "$1" != "-o" ]; do shift; done
printf 'artifact\n' > "$2"
`,
    );
    await executable(join(bin, 'mv'), '#!/bin/sh\nexit 1\n');
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
  printf '[{"artifacts":{"buildUrl":"https://example.invalid/beta"}}]\n'
  touch "$MOCK_SYNC/beta.wrote"
  wait_for_marker "$MOCK_SYNC/alpha.wrote"
else
  wait_for_marker "$MOCK_SYNC/beta.wrote"
  printf '[{"artifacts":{"buildUrl":"https://example.invalid/alpha"}}]\n'
  touch "$MOCK_SYNC/alpha.wrote"
fi
`,
    );
    await executable(
      join(bin, 'curl'),
      `#!/bin/sh
output=""
url=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then output="$2"; shift 2
  elif [ "\${1#http}" != "$1" ]; then url="$1"; shift
  else shift
  fi
done
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
      assert.deepEqual((await readdir(cache)).sort(), ['alpha-ios.tar.gz', 'beta-ios.tar.gz']);
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
