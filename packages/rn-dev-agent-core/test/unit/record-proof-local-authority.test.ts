import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { promisify } from 'node:util';
import {
  darwinProcessBirthRequirement,
  probeProcessBirth,
} from '../../dist/session/process-birth.js';
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
const recorderStartTimeoutMs = 30_000;
const execFileAsync = promisify(execFile);

function probeProcessPresence(pid: number): 'present' | 'absent' | 'unknown' {
  const processState = spawnSync('ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
  });
  if (processState.status === 0) {
    return processState.stdout.trim().startsWith('Z') ? 'absent' : 'present';
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
    .replace('RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"', `RUNTIME_ROOT="${root}"`)
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
      timeout: recorderStartTimeoutMs,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
        RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
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
  const abort = spawnSync('bash', [script, 'abort', scope], {
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PATH: `${root}:${process.env.PATH}`,
      RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
      RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
    },
  });
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
    .replace('RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"', `RUNTIME_ROOT="${root}"`)
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
    RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
  };
  const start = spawnSync(
    'bash',
    [script, 'start', 'ios', output, '--scope', scope, '--udid', 'test-device'],
    { encoding: 'utf8', timeout: recorderStartTimeoutMs, env },
  );
  assert.equal(start.status, 0, start.stderr);
  const parsed = parseStartOutput(start.stdout);
  assert.ok(parsed);
  recorderPid = parsed.pid;

  const stop = spawnSync('bash', [script, 'stop', scope, String(parsed.pid), parsed.processBirth], {
    encoding: 'utf8',
    timeout: recorderStartTimeoutMs,
    env,
  });
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
    .replace('RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"', `RUNTIME_ROOT="${root}"`)
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
    RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
  };
  const start = await execFileAsync(
    'bash',
    [script, 'start', 'ios', output, '--scope', scope, '--udid', 'test-device'],
    { encoding: 'utf8', timeout: recorderStartTimeoutMs, env },
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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
    supervisorBirth !== parsed.processBirth || probeProcessPresence(supervisorPid) === 'absent',
    true,
  );
  const expectedChildBirth = childBefore.status === 'present' ? childBefore.birth.token : null;
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

async function createUnreapedPid(registerCleanup: (cleanup: () => void) => void): Promise<number> {
  const parent = spawn(
    'python3',
    [
      '-c',
      [
        'import subprocess, sys, time',
        'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(600)"])',
        'child.kill()',
        'print(child.pid, flush=True)',
        'time.sleep(600)',
      ].join('\n'),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  registerCleanup(() => {
    try {
      parent.kill('SIGKILL');
    } catch {}
  });

  const zombiePid = await new Promise<number>((resolve, reject) => {
    let buffered = '';
    parent.stdout.setEncoding('utf8');
    parent.stdout.on('data', (chunk: string) => {
      buffered += chunk;
      const line = buffered.split('\n')[0];
      if (buffered.includes('\n')) resolve(Number(line.trim()));
    });
    parent.once('error', reject);
    parent.once('exit', () => reject(new Error('zombie parent exited early')));
  });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (probeProcessPresence(zombiePid) === 'absent') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(probeProcessPresence(zombiePid), 'absent');
  return zombiePid;
}

function probeLocalProcess(
  pid: number,
  preamble = '',
): { status: number | null; state: string; stderr: string } {
  const probe = spawnSync(
    'bash',
    [
      '-c',
      `source "$1"; ${preamble} probe_local_process "$2" "$3"; printf '%s\\n' "$LOCAL_PROCESS_STATE"`,
      'probe',
      sourceScript,
      String(pid),
      'marker-that-a-defunct-process-cannot-carry',
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
        RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
      },
    },
  );
  return { status: probe.status, state: probe.stdout.trim(), stderr: probe.stderr };
}

test('an unreaped recorder process reads as absent, not as changed command identity', async (t) => {
  const zombiePid = await createUnreapedPid((cleanup) => t.after(cleanup));

  const probe = probeLocalProcess(zombiePid);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.state, 'absent');
});

test('a recorder that becomes unreaped mid-probe still reads as absent', async (t) => {
  const zombiePid = await createUnreapedPid((cleanup) => t.after(cleanup));

  const probe = probeLocalProcess(
    zombiePid,
    [
      '__entry_checked=0;',
      'is_present() {',
      '  if (( __entry_checked == 0 )); then __entry_checked=1; return 0; fi;',
      '  is_alive "$1" && ! is_zombie "$1";',
      '};',
    ].join(' '),
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.state, 'absent');
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

async function timingFixture(t: test.TestContext, mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'record-proof-timing-'));
  const prefix = join(root, 'record');
  const script = join(root, 'record_proof.sh');
  const source = readFileSync(sourceScript, 'utf8')
    .replace('RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"', `RUNTIME_ROOT="${root}"`)
    .replaceAll('RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"', `RUNTIME_DIR="${root}"`)
    .replaceAll('import time\n', 'import time\ntime.time = lambda: float("nan")\n');
  writeFileSync(script, source);
  writeFileSync(
    join(root, 'xcrun'),
    `#!/usr/bin/env python3
import os, pathlib, signal, sys, time
if sys.argv[1:] == ["simctl", "list", "devices", "booted"]:
    print("Test Device (Booted)")
    sys.exit(0)
deadline = None
def stop(signum, frame):
    global deadline
    if deadline is None:
        deadline = time.monotonic() + 0.8
signal.signal(signal.SIGINT, signal.SIG_IGN if os.environ["CAPTURE_MODE"] == "forced" else stop)
if os.environ["CAPTURE_MODE"] != "missing-ready":
    time.sleep(0.25)
    print("Recording started", flush=True)
while deadline is None or time.monotonic() < deadline:
    if pathlib.Path(os.environ["CAPTURE_EXIT"]).exists():
        sys.exit(int(os.environ.get("CAPTURE_EXIT_CODE", "0")))
    time.sleep(0.02)
`,
  );
  chmodSync(join(root, 'xcrun'), 0o755);
  const env = {
    ...process.env,
    PATH: `${root}:${process.env.PATH}`,
    RN_DEV_AGENT_PROCESS_BIRTH_HELPER: processBirthHelper,
    RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
    CAPTURE_MODE: mode,
    CAPTURE_EXIT: join(root, 'exit'),
  };
  let pid = 0;
  t.after(async () => {
    if (pid) {
      await execFileAsync('bash', [script, 'abort', scope], { env, timeout: 10_000 }).catch(
        () => {},
      );
    }
    rmSync(root, { recursive: true, force: true });
  });
  const { stdout } = await execFileAsync(
    'bash',
    [script, 'start', 'ios', join(root, 'proof.mp4'), '--scope', scope, '--udid', 'test-device'],
    { env, timeout: recorderStartTimeoutMs },
  );
  const start = parseStartOutput(stdout);
  assert.ok(start);
  pid = start.pid;
  const incarnation = readFileSync(`${prefix}-${scope}.incarnation`, 'utf8').trim();
  const statePath = `${prefix}-${scope}-${incarnation}.supervisor-state`;
  const state = () => JSON.parse(readFileSync(statePath, 'utf8').split('\n')[1]);
  const control = (action: string) =>
    execFileAsync(
      'bash',
      [
        '-c',
        'source "$1"; select_scope_state "$2"; request_supervisor_signal "$2" "$3" "$4"',
        '_',
        script,
        scope,
        action,
        incarnation,
      ],
      { env, timeout: 10_000 },
    );
  const terminal = () =>
    execFileAsync(
      'bash',
      [
        '-c',
        'source "$1"; select_scope_state "$2"; wait_for_supervisor_terminal "$2" "$3"',
        '_',
        script,
        scope,
        incarnation,
      ],
      { env, timeout: 10_000 },
    );
  const duration = async (platform = 'ios') => {
    const { stdout } = await execFileAsync(
      'bash',
      [
        '-c',
        'source "$1"; select_scope_state "$2"; read_capture_timing "$2" "$3" "$4"; printf "%s\\n%s\\n" "$CAPTURE_DURATION" "$CAPTURE_TIMING_UNAVAILABLE"',
        '_',
        script,
        scope,
        incarnation,
        platform,
      ],
      { env, timeout: 10_000 },
    );
    const [value, warning] = stdout.split('\n');
    return { value: value ? Number(value) : null, warning };
  };
  return { root, state, statePath, control, terminal, duration };
}

test('capture readiness waits for the first processed frame instead of child spawn', async (t) => {
  const capture = await timingFixture(t);
  const running = capture.state();
  assert.ok(running.ready - running.launch >= 0.25);
  await capture.control('INT');
  await capture.terminal();
  const ended = capture.state();
  const duration = await capture.duration();
  assert.ok(duration.value !== null);
  assert.ok(Math.abs(duration.value - (ended.stop - ended.ready)) <= 1 / 60);
});

test('a missing first-frame witness cannot authorize a padded tail', async (t) => {
  const capture = await timingFixture(t, 'missing-ready');
  await capture.control('INT');
  await capture.terminal();
  const result = await capture.duration();
  assert.equal(result.value, null);
  assert.match(result.warning, /first frame unobserved/);
});

test('normal stop freezes monotonic timing before drain, repeated stop and delayed finalization', async (t) => {
  const capture = await timingFixture(t);
  await capture.control('INT');
  const first = capture.state();
  await capture.control('INT');
  await capture.terminal();
  const ended = capture.state();
  assert.equal(ended.stop, first.stop);
  assert.equal(ended.signal, first.signal);
  assert.ok(ended.exit - ended.stop >= 0.7);
  const duration = await capture.duration();
  assert.equal(duration.warning, '');
  assert.ok(duration.value !== null);
  assert.ok(Math.abs(duration.value - (ended.stop - ended.ready)) <= 1 / 60);
  assert.deepEqual(await capture.duration(), duration);
  assert.equal((await capture.duration('android')).value, null);
});

test('early zero exit and force stop never authorize a padded tail', async (t) => {
  for (const mode of ['early', 'forced']) {
    await t.test(mode, async (t) => {
      const capture = await timingFixture(t, mode);
      if (mode === 'early') {
        writeFileSync(join(capture.root, 'exit'), '');
      } else {
        await capture.control('INT');
        await capture.control('KILL');
      }
      await capture.terminal();
      const result = await capture.duration();
      assert.equal(result.value, null);
      assert.match(result.warning, mode === 'early' ? /exited before normal stop/ : /force stop/);
    });
  }
});

test('malformed, stale and uncertain timing cannot become a capture duration', async (t) => {
  const capture = await timingFixture(t);
  await capture.control('INT');
  await capture.terminal();
  const original = capture.state();
  const invalid = [
    { ...original, launch: null },
    { ...original, launch: 'NaN' },
    { ...original, launch: original.ready + 1 },
    { ...original, stop: original.exit + 100 },
    { ...original, ready: original.launch + 2 },
    { ...original, signal: original.stop + 2 },
    { ...original, incarnation: '0'.repeat(32) },
    { ...original, scope: '0'.repeat(64) },
    { ...original, pid: original.pid + 1 },
  ];
  for (const timing of invalid) {
    writeFileSync(capture.statePath, `exited 0\n${JSON.stringify(timing)}\n`);
    const result = await capture.duration();
    assert.equal(result.value, null, JSON.stringify(timing));
    assert.match(result.warning, /capture timing unavailable/);
  }
  writeFileSync(capture.statePath, 'exited 0\n');
  assert.equal((await capture.duration()).value, null);
});
