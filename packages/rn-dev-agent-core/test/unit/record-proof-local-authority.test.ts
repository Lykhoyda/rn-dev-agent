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

function probeProcessPresence(pid: number): 'present' | 'absent' | 'unknown' {
  const processState = spawnSync('ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
  });
  if (processState.status === 0) {
    return /^Z/.test(processState.stdout.trim()) ? 'absent' : 'present';
  }
  return processState.status === 1 && processState.stdout.trim() === '' ? 'absent' : 'unknown';
}

async function waitForDifferentBirth(
  pid: number,
  expectedBirth: string,
  observe = probeProcessBirth,
  delay = () => new Promise((resolve) => setTimeout(resolve, 50)),
  observePresence = probeProcessPresence,
): Promise<string | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const presence = observePresence(pid);
    if (presence === 'absent') return null;
    const observed = observe(pid);
    if (observed.status === 'absent') return null;
    if (observed.status === 'present' && observed.birth.token !== expectedBirth) {
      return observed.birth.token;
    }
    await delay();
  }
  const presence = observePresence(pid);
  if (presence === 'absent') return null;
  const observed = observe(pid);
  if (observed.status === 'absent') return null;
  return observed.status === 'present' ? observed.birth.token : expectedBirth;
}

test('unknown process birth does not prove recorder termination', async () => {
  const expectedBirth = 'a'.repeat(64);
  let attempts = 0;
  const observed = await waitForDifferentBirth(
    123,
    expectedBirth,
    () => {
      attempts += 1;
      return { status: 'unknown' };
    },
    async () => {},
    () => 'present',
  );

  assert.equal(observed, expectedBirth);
  assert.equal(attempts, 41);
});

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
    .replace('RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"', `RUNTIME_DIR="${root}"`)
    .replace(
      'RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"',
      `RUNTIME_ROOT="${root}"`,
    )
    .replace('RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"', `RUNTIME_DIR="${root}"`)
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
  const incarnation = readFileSync(`${prefix}-${scope}.incarnation`, 'utf8').trim();
  const tokenPath = `${prefix}-${scope}-${incarnation}.control-token`;
  const requestPath = `${prefix}-${scope}-${incarnation}.control-request`;
  const token = readFileSync(tokenPath, 'utf8').trim();
  const processRow = spawnSync('ps', ['-ww', '-p', String(parsed.pid), '-o', 'command='], {
    encoding: 'utf8',
  });
  assert.equal(processRow.status, 0, processRow.stderr);
  assert.equal(processRow.stdout.includes(token), false);
  assert.equal(processRow.stdout.includes(requestPath), false);
  assert.equal(readFileSync(`${prefix}-${scope}.birth`, 'utf8').trim(), parsed.processBirth);
  const observed = probeProcessBirth(parsed.pid);
  assert.equal(observed.status, 'present');
  if (observed.status === 'present') {
    assert.equal(observed.birth.token, parsed.processBirth);
  }
  rmSync(`${prefix}-${scope}.pid`);
  rmSync(`${prefix}-${scope}.birth`);
  const abort = spawnSync(
    'bash',
    [script, 'abort', scope],
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
  assert.equal(abort.status, 0, abort.stderr);
  assert.equal(existsSync(tokenPath), false);
  const afterAbortBirth = await waitForDifferentBirth(parsed.pid, parsed.processBirth);
  assert.equal(
    afterAbortBirth !== parsed.processBirth || probeProcessPresence(parsed.pid) === 'absent',
    true,
  );
  recorderPid = 0;
});

test('recording supervisor force-stops its unreaped child after SIGINT is ignored', async (t) => {
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
    .replace('RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"', `RUNTIME_DIR="${root}"`)
    .replace(
      'RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"',
      `RUNTIME_ROOT="${root}"`,
    )
    .replace('RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"', `RUNTIME_DIR="${root}"`)
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
  const observedBirth = await waitForDifferentBirth(parsed.pid, parsed.processBirth);
  assert.notEqual(observedBirth, parsed.processBirth);
  assert.equal(
    observedBirth !== parsed.processBirth || probeProcessPresence(parsed.pid) === 'absent',
    true,
  );
  recorderPid = 0;
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
    .replace('RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"', `RUNTIME_DIR="${root}"`)
    .replace(
      'RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"',
      `RUNTIME_ROOT="${root}"`,
    )
    .replace('RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"', `RUNTIME_DIR="${root}"`)
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
  const incarnation = readFileSync(`${prefix}-${scope}.incarnation`, 'utf8').trim();
  const childPath = `${prefix}-${scope}-${incarnation}.child-pid`;
  const requestPath = `${prefix}-${scope}-${incarnation}.control-request`;
  const statePath = `${prefix}-${scope}-${incarnation}.supervisor-state`;
  childPid = Number(readFileSync(childPath, 'utf8').trim());
  const childBefore = probeProcessBirth(childPid);
  assert.equal(childBefore.status, 'present');
  writeFileSync(requestPath, Buffer.from([0xff]));
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (readFileSync(statePath, 'utf8').trim().startsWith('failed')) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(readFileSync(statePath, 'utf8').trim(), /^failed(?: |$)/);
  assert.equal(existsSync(`${prefix}-${scope}.pid`), true);
  const supervisorBirth = await waitForDifferentBirth(supervisorPid, parsed.processBirth);
  const childBirth = await waitForDifferentBirth(
    childPid,
    childBefore.status === 'present' ? childBefore.birth.token : '',
  );
  assert.equal(
    supervisorBirth !== parsed.processBirth ||
      probeProcessPresence(supervisorPid) === 'absent',
    true,
  );
  const expectedChildBirth =
    childBefore.status === 'present' ? childBefore.birth.token : null;
  assert.equal(
    childBirth !== expectedChildBirth || probeProcessPresence(childPid) === 'absent',
    true,
  );
  const cleanup = spawnSync(
    'bash',
    [script, 'stop', scope, String(parsed.pid), parsed.processBirth],
    { encoding: 'utf8', timeout: 10_000, env },
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  assert.match(cleanup.stdout, /^Recorder failed: supervisor terminated unexpectedly$/m);
  assert.doesNotMatch(cleanup.stdout, /^Saved:/m);
  assert.equal(existsSync(`${prefix}-${scope}.pid`), false);
  supervisorPid = 0;
  childPid = 0;
});

test('recording stop delegates signals to the authenticated supervisor', () => {
  const source = readFileSync(sourceScript, 'utf8');
  assert.match(source, /request_supervisor_signal "\$scope" "INT"/);
  assert.match(source, /request_supervisor_signal "\$scope" "KILL"/);
  assert.match(source, /child\.poll\(\)/);
  assert.match(source, /with os\.fdopen\(3, "rb"\)/);
  assert.match(source, /request_supervisor_signal "\$scope" "ABORT"/);
  assert.doesNotMatch(source, /os\.waitid/);
  assert.doesNotMatch(source, /kill -(?:INT|9) "\$pid"/);
});
