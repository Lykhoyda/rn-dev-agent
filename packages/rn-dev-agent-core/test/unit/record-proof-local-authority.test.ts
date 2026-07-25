import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { probeProcessBirth } from '../../dist/session/process-birth.js';
import { parseStartOutput } from '../../dist/tools/device-record.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sourceScript = join(repoRoot, 'scripts', 'record_proof.sh');
const processBirthHelper = join(
  repoRoot,
  'packages',
  'rn-dev-agent-core',
  'native',
  'darwin-process-birth',
);
const scope = 'd'.repeat(64);
const execFileAsync = promisify(execFile);

test('recording start returns while its authenticated supervisor remains active', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'record-proof-local-authority-'));
  const prefix = join(root, 'record');
  const script = join(root, 'record_proof.sh');
  const xcrun = join(root, 'xcrun');
  const output = join(root, 'proof.mp4');
  let recorderPid = 0;
  t.after(() => {
    if (recorderPid > 0) {
      try {
        process.kill(recorderPid, 'SIGKILL');
      } catch {
        recorderPid = 0;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${prefix}"`)
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(root, 'raw')}"`);
  writeFileSync(script, source);
  writeFileSync(
    xcrun,
    `#!/usr/bin/env bash
if [[ "$*" == "simctl list devices booted" ]]; then
  echo "Test Device (Booted)"
  exit 0
fi
while true; do
  sleep 1
done
`,
  );
  chmodSync(script, 0o755);
  chmodSync(xcrun, 0o755);

  const result = await execFileAsync(
    'bash',
    [script, 'start', 'ios', output, '--scope', scope, '--udid', 'test-device'],
    {
      encoding: 'utf8',
      timeout: 5_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
      },
    },
  );
  const parsed = parseStartOutput(result.stdout);
  assert.ok(parsed);
  recorderPid = parsed.pid;
  assert.equal(readFileSync(`${prefix}-${scope}.birth`, 'utf8').trim(), parsed.processBirth);
  const observed = probeProcessBirth(parsed.pid);
  assert.equal(observed.status, 'present');
  if (observed.status === 'present') {
    assert.equal(observed.birth.token, parsed.processBirth);
  }
  const stop = spawnSync(
    'bash',
    [script, 'stop', scope, String(parsed.pid), parsed.processBirth],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
      },
    },
  );
  assert.equal(stop.status, 0, stop.stderr);
  recorderPid = 0;
});

test('recording supervisor force-stops its unreaped child after SIGINT is ignored', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'record-proof-local-stop-'));
  const prefix = join(root, 'record');
  const script = join(root, 'record_proof.sh');
  const xcrun = join(root, 'xcrun');
  const output = join(root, 'proof.mp4');
  let recorderPid = 0;
  t.after(() => {
    if (recorderPid > 0) {
      try {
        process.kill(recorderPid, 'SIGKILL');
      } catch {
        recorderPid = 0;
      }
    }
    rmSync(root, { recursive: true, force: true });
  });

  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${prefix}"`)
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(root, 'raw')}"`);
  writeFileSync(script, source);
  writeFileSync(
    xcrun,
    `#!/usr/bin/env bash
if [[ "$*" == "simctl list devices booted" ]]; then
  echo "Test Device (Booted)"
  exit 0
fi
trap '' INT
while true; do
  sleep 1
done
`,
  );
  chmodSync(script, 0o755);
  chmodSync(xcrun, 0o755);

  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
  };
  const start = spawnSync(
    'bash',
    [script, 'start', 'ios', output, '--scope', scope, '--udid', 'test-device'],
    { encoding: 'utf8', timeout: 5_000, env },
  );
  assert.equal(start.status, 0, start.stderr);
  const parsed = parseStartOutput(start.stdout);
  assert.ok(parsed);
  recorderPid = parsed.pid;

  const stop = spawnSync(
    'bash',
    [script, 'stop', scope, String(parsed.pid), parsed.processBirth],
    { encoding: 'utf8', timeout: 10_000, env },
  );
  assert.equal(stop.status, 0, stop.stderr);
  assert.equal(existsSync(`${prefix}-${scope}.pid`), false);
  const observed = probeProcessBirth(parsed.pid);
  const observedBirth = observed.status === 'present' ? observed.birth.token : null;
  assert.notEqual(observedBirth, parsed.processBirth);
  if (observedBirth !== parsed.processBirth) recorderPid = 0;
});

test('recording supervisor terminates its child when request handling fails', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'record-proof-supervisor-failure-'));
  const prefix = join(root, 'record');
  const script = join(root, 'record_proof.sh');
  const xcrun = join(root, 'xcrun');
  const output = join(root, 'proof.mp4');
  let supervisorPid = 0;
  let childPid = 0;
  t.after(() => {
    for (const pid of [supervisorPid, childPid]) {
      if (pid <= 0) continue;
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  });

  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${prefix}"`)
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(root, 'raw')}"`);
  writeFileSync(script, source);
  writeFileSync(
    xcrun,
    `#!/usr/bin/env bash
if [[ "$*" == "simctl list devices booted" ]]; then
  echo "Test Device (Booted)"
  exit 0
fi
while true; do
  sleep 1
done
`,
  );
  chmodSync(script, 0o755);
  chmodSync(xcrun, 0o755);

  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
  };
  const start = await execFileAsync(
    'bash',
    [script, 'start', 'ios', output, '--scope', scope, '--udid', 'test-device'],
    { encoding: 'utf8', timeout: 5_000, env },
  );
  const parsed = parseStartOutput(start.stdout);
  assert.ok(parsed);
  supervisorPid = parsed.pid;
  childPid = Number(readFileSync(`${prefix}-${scope}.child-pid`, 'utf8').trim());
  const childBefore = probeProcessBirth(childPid);
  assert.equal(childBefore.status, 'present');
  writeFileSync(`${prefix}-${scope}.control-request`, Buffer.from([0xff]));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (readFileSync(`${prefix}-${scope}.supervisor-state`, 'utf8').trim() === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(readFileSync(`${prefix}-${scope}.supervisor-state`, 'utf8').trim(), 'failed');
  assert.equal(existsSync(`${prefix}-${scope}.pid`), true);
  const supervisorAfter = probeProcessBirth(supervisorPid);
  const childAfter = probeProcessBirth(childPid);
  const supervisorBirth =
    supervisorAfter.status === 'present' ? supervisorAfter.birth.token : null;
  const childBirth = childAfter.status === 'present' ? childAfter.birth.token : null;
  assert.notEqual(supervisorBirth, parsed.processBirth);
  assert.notEqual(
    childBirth,
    childBefore.status === 'present' ? childBefore.birth.token : null,
  );
  supervisorPid = 0;
  childPid = 0;
});

test('recording stop delegates signals to the authenticated supervisor', () => {
  const source = readFileSync(sourceScript, 'utf8');
  assert.match(source, /request_supervisor_signal "\$scope" "INT"/);
  assert.match(source, /request_supervisor_signal "\$scope" "KILL"/);
  assert.match(source, /child\.poll\(\)/);
  assert.doesNotMatch(source, /os\.waitid/);
  assert.doesNotMatch(source, /kill -(?:INT|9) "\$pid"/);
});
