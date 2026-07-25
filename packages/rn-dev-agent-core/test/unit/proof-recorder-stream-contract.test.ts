import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sourceScript = resolve(import.meta.dirname, '../../../../scripts/record_proof.sh');

test('the recorder supervisor releases start streams and owns child output', async () => {
  const script = await readFile(sourceScript, 'utf8');
  const supervisorLaunch = script
    .split('\n')
    .find((line) => line.includes('python3 - "$@"') && line.trimEnd().endsWith('&'));

  assert.ok(supervisorLaunch);
  assert.match(supervisorLaunch, /3< <\(printf/);
  assert.match(supervisorLaunch, /> "\$recorder_log" 2>&1 <<'PY' &$/);
  assert.match(script, /stdout=log,\n\s+stderr=subprocess\.STDOUT,/);
  const supervisorPidIndex = script.indexOf('SUPERVISOR_PID=$!');
  const tokenWriteIndex = script.indexOf('> "$token_tmp"');
  const startActionIndex = script.indexOf('action == "START"');
  const recorderSpawnIndex = script.indexOf('subprocess.Popen(');
  const incarnationPublishIndex = script.indexOf(
    'mv "$incarnation_tmp" "$(incarnation_file "$scope")"',
  );
  const supervisorLaunchIndex = script.indexOf('python3 - "$@"');
  assert.notEqual(supervisorPidIndex, -1);
  assert.notEqual(tokenWriteIndex, -1);
  assert.notEqual(startActionIndex, -1);
  assert.notEqual(recorderSpawnIndex, -1);
  assert.notEqual(incarnationPublishIndex, -1);
  assert.notEqual(supervisorLaunchIndex, -1);
  assert.ok(supervisorPidIndex < tokenWriteIndex);
  assert.ok(startActionIndex < recorderSpawnIndex);
  assert.ok(incarnationPublishIndex < supervisorLaunchIndex);
  assert.match(script, /\$\{PID_PREFIX\}-\$\{scope\}-\$\{incarnation\}\.\$\{suffix\}/);
  assert.match(script, /else f"failed \{return_code\}\\n"/);
  assert.match(
    script,
    /if \[\[ "\$supervisor_terminal" == "true" \]\]; then\n\s+:/,
  );
  assert.match(
    script,
    /sleep 1\n\n\s+if \[\[ -s "\$\(supervisor_state_file "\$scope" "\$incarnation"\)" \]\]; then/,
  );
  const directLaunches = script
    .split('\n')
    .filter(
      (line) =>
        /\b(?:xcrun\b.*recordVideo|adb\b.*screenrecord)\b/.test(line) &&
        line.trimEnd().endsWith(' &'),
    );
  assert.deepEqual(directLaunches, []);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'proof-recorder-supervisor-'));
  const prefix = join(root, 'record');
  const script = join(root, 'record_proof.sh');
  const xcrun = join(root, 'xcrun');
  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${prefix}"`)
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(root, 'raw')}"`);
  writeFileSync(script, source);
  writeFileSync(
    xcrun,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == "simctl list devices booted" ]]; then
  echo "iPhone (Booted)"
elif [[ "$*" == *"recordVideo"* ]]; then
  raw_path="\${@: -1}"
  printf partial > "$raw_path"
  sleep 1.2
  exit 7
fi
`,
  );
  chmodSync(script, 0o755);
  chmodSync(xcrun, 0o755);
  return {
    root,
    prefix,
    script,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('a spontaneous nonzero recorder exit is reported as failure', async () => {
  const state = fixture();
  const scope = 'e'.repeat(64);
  try {
    const output = join(state.root, 'capture.mp4');
    const started = spawnSync('bash', [state.script, 'start', 'ios', output, '--scope', scope], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        RN_DEV_AGENT_PROCESS_BIRTH_HELPER: resolve(
          import.meta.dirname,
          '../../dist/native/darwin-process-birth',
        ),
      },
    });
    assert.equal(started.status, 0, started.stderr);
    const identity = /pid=(\d+) birth=([a-f0-9]{64})/.exec(started.stdout);
    assert.ok(identity);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));

    const stopped = spawnSync(
      'bash',
      [state.script, 'stop', scope, identity[1], identity[2]],
      { encoding: 'utf8' },
    );
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /Recorder failed:/);
    assert.doesNotMatch(stopped.stdout, /Saved:/);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), false);
  } finally {
    state.cleanup();
  }
});

test('terminal supervisor state takes precedence over a reused live PID', async () => {
  const state = fixture();
  const scope = 'f'.repeat(64);
  const replacement = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    assert.ok(replacement.pid);
    const birth = 'a'.repeat(64);
    const incarnation = 'b'.repeat(32);
    const output = join(state.root, 'capture.mp4');
    const raw = join(state.root, 'capture.mov');
    writeFileSync(`${state.prefix}-${scope}.pid`, `${replacement.pid}\n`);
    writeFileSync(`${state.prefix}-${scope}.birth`, `${birth}\n`);
    writeFileSync(`${state.prefix}-${scope}.platform`, 'ios\n');
    writeFileSync(`${state.prefix}-${scope}.path`, `${output}\n`);
    writeFileSync(`${state.prefix}-${scope}.raw-path`, `${raw}\n`);
    writeFileSync(`${state.prefix}-${scope}.incarnation`, `${incarnation}\n`);
    writeFileSync(
      `${state.prefix}-${scope}-${incarnation}.supervisor-state`,
      'exited 0\n',
    );
    writeFileSync(raw, 'recording');

    const stopped = spawnSync(
      'bash',
      [state.script, 'stop', scope, `${replacement.pid}`, birth],
      { encoding: 'utf8' },
    );
    assert.equal(stopped.status, 0, stopped.stderr);
    const replacementState = spawnSync('ps', ['-p', `${replacement.pid}`, '-o', 'stat='], {
      encoding: 'utf8',
    });
    assert.equal(replacementState.status, 0);
    assert.doesNotMatch(replacementState.stdout.trim(), /^Z/);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.incarnation`), false);
    assert.equal(
      existsSync(`${state.prefix}-${scope}-${incarnation}.supervisor-state`),
      false,
    );
  } finally {
    replacement.kill('SIGKILL');
    state.cleanup();
  }
});
