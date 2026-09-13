import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { darwinProcessBirthRequirement } from '../../dist/session/process-birth.js';
import { parseStartOutput } from '../../dist/tools/device-record.js';

const sourceScript = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'record_proof.sh',
);
const scope = 'c'.repeat(64);
const bootId = '12345678-1234-1234-1234-123456789abc';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'record-proof-authority-'));
  const legacyPrefix = join(root, 'legacy-record');
  const runtimeDirectory = join(root, 'runtime');
  const prefix = join(runtimeDirectory, 'record');
  const script = join(root, 'record_proof.sh');
  const adb = join(root, 'adb');
  const ffmpeg = join(root, 'ffmpeg');
  const ffprobe = join(root, 'ffprobe');
  const killMarker = join(root, 'kill-marker');
  const pullMarker = join(root, 'pull-marker');
  const remoteDeleteMarker = join(root, 'remote-delete-marker');
  const conversionMarker = join(root, 'conversion-marker');
  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${legacyPrefix}"`)
    .replace('RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"', `RUNTIME_DIR="${runtimeDirectory}"`)
    .replace('RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"', `RUNTIME_ROOT="${root}"`)
    .replace(
      'RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"',
      `RUNTIME_DIR="${runtimeDirectory}"`,
    )
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(root, 'raw')}"`);
  writeFileSync(script, source);
  writeFileSync(
    adb,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == "get-state" ]]; then
  [[ "\${FAKE_DEVICE_STATE:-device}" == "device" ]] || exit 1
  echo device
elif [[ "$args" == *"pidof screenrecord"* ]]; then
  printf '%s\\n' "\${FAKE_SCREENRECORD_PIDS:-}"
elif [[ "$args" == *"/proc/sys/kernel/random/boot_id"* ]]; then
  echo "${bootId}"
elif [[ "$args" == *"readlink /proc/777/exe"* ]]; then
  [[ "\${FAKE_READLINK_FAIL:-0}" == "0" ]] || exit 1
  echo /system/bin/screenrecord
elif [[ "$args" == *"cat /proc/777/cmdline"* ]]; then
  printf '%s\\0%s\\0' /system/bin/screenrecord "\${FAKE_REMOTE_PATH:-/sdcard/proof.mp4}"
elif [[ "$args" == *"cat /proc/777/stat"* ]]; then
  printf '%s\\n' "\${FAKE_STAT}"
elif [[ "$args" == *"kill -2 777"* ]]; then
  touch "\${FAKE_KILL_MARKER}"
elif [[ "$args" == *"test ! -e /proc/777"* ]]; then
  [[ "\${FAKE_PROC_PRESENT:-1}" == "0" ]]
elif [[ "$args" == *"shell rm -f"* ]]; then
  [[ "\${FAKE_REMOTE_DELETE_FAIL:-0}" == "0" ]] || exit 44
  [[ -z "\${FAKE_REMOTE_DELETE_MARKER:-}" ]] || touch "\${FAKE_REMOTE_DELETE_MARKER}"
elif [[ "$args" == *"shell test ! -e"* ]]; then
  [[ "\${FAKE_REMOTE_DELETE_FAIL:-0}" == "0" ]]
elif [[ "$args" == pull\\ * || "$args" == *" pull "* ]]; then
  [[ "\${FAKE_PULL_FAIL:-0}" == "0" ]] || exit 43
  destination="\${@: -1}"
  [[ -f "$destination" && ! -L "$destination" ]] || exit 42
  printf '%s\\n' "$destination" > "\${FAKE_PULL_MARKER}"
  printf recording > "$destination"
  if [[ -n "\${FAKE_PRIOR_RAW_PATH:-}" ]]; then
    mkdir "\${FAKE_PRIOR_RAW_PATH}"
  fi
  if [[ "\${FAKE_TERMINATE_PULL_PARENT:-0}" == "1" ]]; then
    kill -TERM "$PPID"
    sleep 0.2
  fi
fi
`,
  );
  writeFileSync(
    ffmpeg,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${FAKE_FFMPEG_SUCCESS:-0}" == "1" ]]; then
  [[ "$*" == *" -f mp4 "* ]] || exit 2
  printf converted > "\${@: -1}"
  [[ -z "\${FAKE_CONVERSION_MARKER:-}" ]] || touch "\${FAKE_CONVERSION_MARKER}"
  exit 0
fi
if [[ "\${FAKE_TERMINATE_CONVERSION:-0}" == "1" ]]; then
  touch "\${FAKE_CONVERSION_MARKER}"
  kill -TERM "$PPID"
  sleep 0.2
fi
exit 1
`,
  );
  chmodSync(adb, 0o755);
  chmodSync(ffmpeg, 0o755);
  writeFileSync(ffprobe, '#!/usr/bin/env bash\nprintf "5.0\\n"\n');
  chmodSync(ffprobe, 0o755);
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  return {
    root,
    legacyPrefix,
    runtimeDirectory,
    prefix,
    script,
    killMarker,
    pullMarker,
    remoteDeleteMarker,
    conversionMarker,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedLocalBinding(prefix: string) {
  writeFileSync(`${prefix}-${scope}.pid`, '999999');
  writeFileSync(`${prefix}-${scope}.birth`, 'local-birth');
  writeFileSync(`${prefix}-${scope}.platform`, 'android');
  writeFileSync(`${prefix}-${scope}.path`, '/tmp/proof.mp4');
}

function seedCaptureTiming(prefix: string) {
  const now = Number(
    spawnSync('python3', ['-c', 'import time; print(time.monotonic())'], { encoding: 'utf8' })
      .stdout,
  );
  const incarnation = 'f'.repeat(32);
  writeFileSync(`${prefix}-${scope}.incarnation`, incarnation);
  writeFileSync(`${prefix}-${scope}-${incarnation}.child-pid`, '777');
  writeFileSync(
    `${prefix}-${scope}-${incarnation}.supervisor-state`,
    `exited 0\n${JSON.stringify({
      scope,
      incarnation,
      pid: 777,
      launch: now - 125,
      ready: now - 124.9,
      stop: now - 5,
      signal: now - 4.99,
      exit: now - 4,
      disposition: 'normal',
      remote_state: 'present',
    })}\n`,
  );
}

function captureIdentity(path: string): string {
  const metadata = lstatSync(path, { bigint: true });
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}:${digest}`;
}

function androidCaptureFixture(t: TestContext, options: NodeJS.ProcessEnv = {}) {
  const state = fixture();
  const marker = join(state.root, 'host-stopped');
  const remoteGone = join(state.root, 'remote-gone');
  const events = join(state.root, 'events');
  const output = join(state.root, 'proof.mp4');
  const adb = join(state.root, 'adb');
  const ffmpeg = join(state.root, 'ffmpeg');
  writeFileSync(
    adb,
    `#!/usr/bin/env python3
import json, os, pathlib, signal, sys, time
args = sys.argv[1:]
joined = " ".join(args)
events = pathlib.Path(os.environ["EVENTS"])
gone = pathlib.Path(os.environ["REMOTE_GONE"])
transport_done = gone.with_name("transport-done")
mode = os.environ.get("REMOTE_STATE", "present")
def event(value):
  with events.open("a") as f: f.write(json.dumps([value, time.monotonic()]) + "\\n")
if args == ["devices"]:
  print("emulator-5554\\tdevice")
elif args == ["get-state"]:
  print("device")
elif "pidof screenrecord" in joined:
  print("777" if pathlib.Path(os.environ["REMOTE_PATH"]).exists() and not gone.exists() else "")
elif args[:2] == ["shell", "screenrecord"]:
  pathlib.Path(os.environ["REMOTE_PATH"]).write_text(args[-1])
  def stop(signum, frame):
      event("host-stop")
      pathlib.Path(os.environ["HOST_STOPPED"]).touch()
  signal.signal(signal.SIGINT, stop)
  while (not gone.exists() and not transport_done.exists()) or os.environ.get("TRANSPORT_STUCK") == "1": time.sleep(0.02)
  event("transport-exit")
elif "cat /proc/777/stat" in joined:
  event("probe:" + mode)
  if mode in ("absent", "unknown") or gone.exists(): sys.exit(1)
  print("777 (screenrecord) S " + "0 " * 18 + ("999" if mode == "reused" else "123"))
elif "cat /proc/sys/kernel/random/boot_id" in joined:
  print("${bootId}")
elif "readlink /proc/777/exe" in joined:
  print("/system/bin/screenrecord")
elif "cat /proc/777/cmdline" in joined:
  print("/system/bin/screenrecord " + pathlib.Path(os.environ["REMOTE_PATH"]).read_text())
elif "test ! -e /proc/777" in joined:
  sys.exit(0 if mode == "absent" or gone.exists() else 1)
elif "kill -2 777" in joined:
  time.sleep(float(os.environ.get("REMOTE_LATENCY", "0")))
  event("remote-int")
  if mode == "signal-failed": sys.exit(1)
  if mode == "remote-still-live":
      transport_done.touch()
      sys.exit(0)
  gone.touch()
  event("remote-exit")
  if mode == "failed-then-absent": sys.exit(1)
elif args[0] == "pull":
  pathlib.Path(args[-1]).write_text("native capture")
elif "shell rm -f" in joined or "shell test ! -e" in joined:
  sys.exit(44 if os.environ.get("DELETE_FAIL") == "1" else 0)
else:
  sys.exit(2)
`,
  );
  writeFileSync(
    ffmpeg,
    `#!/usr/bin/env python3
import json, os, pathlib, sys
with open(os.environ["ENCODER_ARGS"], "a") as f: f.write(json.dumps(sys.argv[1:]) + "\\n")
pathlib.Path(sys.argv[-1]).write_text("converted")
`,
  );
  writeFileSync(
    join(state.root, 'ffprobe'),
    '#!/usr/bin/env bash\necho \'{"frames":[{"best_effort_timestamp_time":"0"}]}\'\n',
  );
  const env = {
    ...process.env,
    ...options,
    PATH: `${state.root}:${process.env.PATH}`,
    RN_DEV_AGENT_PROCESS_BIRTH_HELPER: join(
      dirname(sourceScript),
      '../packages/rn-dev-agent-core/native/darwin-process-birth',
    ),
    RN_DEV_AGENT_PROCESS_BIRTH_REQUIREMENT: darwinProcessBirthRequirement(),
    EVENTS: events,
    REMOTE_GONE: remoteGone,
    HOST_STOPPED: marker,
    REMOTE_PATH: join(state.root, 'remote-path'),
    ENCODER_ARGS: join(state.root, 'encoder-args'),
  };
  t.after(() => {
    spawnSync('bash', [state.script, 'abort', scope], { env, timeout: 10_000 });
    writeFileSync(remoteGone, '');
    state.cleanup();
  });
  const start = spawnSync('bash', [state.script, 'start', 'android', output, '--scope', scope], {
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(start.status, 0, start.stderr);
  const binding = parseStartOutput(start.stdout);
  assert.ok(binding);
  const incarnation = readFileSync(`${state.prefix}-${scope}.incarnation`, 'utf8').trim();
  const statePath = `${state.prefix}-${scope}-${incarnation}.supervisor-state`;
  writeFileSync(events, '');
  const args = [state.script, 'stop', scope, String(binding.pid), binding.processBirth];
  const control = (command: string, overrides: NodeJS.ProcessEnv = {}) =>
    spawnSync(
      'bash',
      [
        '-c',
        `source "$1"; select_scope_state "$2"; scope="$2"; incarnation="$3"; ${command}`,
        'android-control',
        state.script,
        scope,
        incarnation,
      ],
      { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 15_000 },
    );
  const timing = () => JSON.parse(readFileSync(statePath, 'utf8').split('\n')[1]);
  return { state, env, events, remoteGone, args, statePath, control, timing };
}

test('Android witnesses remote identity before transport shutdown and retains the first interval for retry', (t) => {
  for (const remoteState of ['present', 'absent', 'reused', 'unknown', 'failed-then-absent']) {
    const { env, events, args, statePath } = androidCaptureFixture(t);
    const first = spawnSync('bash', args, {
      env: { ...env, REMOTE_STATE: remoteState, DELETE_FAIL: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(first.status, 0);
    const timeline: [string, number][] = readFileSync(events, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const observed = timeline.map(([event]) => event);
    const timing = JSON.parse(readFileSync(statePath, 'utf8').split('\n')[1]);
    if (remoteState === 'unknown') {
      assert.equal(observed.includes('host-stop'), false);
      assert.equal(observed.includes('remote-int'), false);
      assert.equal(timing.disposition, 'uncertain');
      assert.equal(timing.signal, null);
      assert.equal(existsSync(env.ENCODER_ARGS), false);
      continue;
    }
    assert.ok(
      existsSync(env.ENCODER_ARGS),
      JSON.stringify({ remoteState, first, timing, timeline }),
    );
    const encodes = readFileSync(env.ENCODER_ARGS, 'utf8');
    const encodingArgs: string[] = JSON.parse(encodes.trim());
    if (remoteState === 'present') {
      assert.equal(timing.disposition, 'normal', JSON.stringify({ timing, timeline }));
      assert.equal(observed.includes('host-stop'), false);
      assert.equal(observed.filter((event) => event === 'remote-int').length, 1);
      const remoteInt = timeline.find(([event]) => event === 'remote-int')![1];
      assert.ok(timing.stop <= remoteInt && remoteInt <= timing.signal);
      assert.ok(observed.indexOf('remote-exit') < observed.indexOf('transport-exit'));
      assert.ok(timing.signal <= timing.exit);
      assert.doesNotMatch(first.stdout, /normalization skipped/);
      const duration = Number(encodingArgs[encodingArgs.indexOf('-t') + 1]);
      assert.ok(Math.abs(duration - (timing.signal - timing.ready)) <= 1 / 60);
    } else {
      assert.match(first.stdout, /normalization skipped/);
      assert.notEqual(timing.disposition, 'normal');
      assert.equal(timing.signal, null);
      if (remoteState !== 'failed-then-absent') {
        assert.equal(observed.includes('remote-int'), false);
      }
      assert.equal(encodingArgs.includes('-t'), false);
    }
    const incompleteRetry = spawnSync('bash', args, {
      env: { ...env, REMOTE_STATE: remoteState, DELETE_FAIL: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(incompleteRetry.status, 0);
    assert.deepEqual(JSON.parse(readFileSync(statePath, 'utf8').split('\n')[1]), timing);
    assert.equal(readFileSync(env.ENCODER_ARGS, 'utf8'), encodes);
    const retry = spawnSync('bash', args, {
      env: { ...env, REMOTE_STATE: remoteState },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /^Saved: /m);
    assert.equal(readFileSync(env.ENCODER_ARGS, 'utf8'), encodes);
  }
});

test('Android rejects competing begin and mismatched results without renewing the first bracket', (t) => {
  const capture = androidCaptureFixture(t, { TRANSPORT_STUCK: '1' });
  const begin = capture.control(
    'request_supervisor_signal "$scope" ANDROID_STOP_BEGIN "$incarnation"; printf "%s" "$SUPERVISOR_REQUEST_NONCE"',
  );
  assert.equal(begin.status, 0, begin.stderr);
  const first = capture.timing();
  const duplicate = spawnSync('bash', capture.args, {
    env: capture.env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /ANDROID_STOP_BEGIN request \(pending\)/);
  assert.deepEqual(capture.timing(), first);
  const mismatch = capture.control(
    'request_supervisor_signal "$scope" ANDROID_STOP_RESULT "$incarnation" wrong:signaled',
  );
  assert.notEqual(mismatch.status, 0);
  const legacy = capture.control('request_supervisor_signal "$scope" INT "$incarnation"');
  assert.notEqual(legacy.status, 0);
  assert.deepEqual(capture.timing(), first);
  assert.doesNotMatch(readFileSync(capture.events, 'utf8'), /remote-int|host-stop/);

  const result = capture.control(
    'stop_android_recorder "$scope" signal; request_supervisor_signal "$scope" ANDROID_STOP_RESULT "$incarnation" "$BEGIN_NONCE:$ANDROID_SIGNAL_OUTCOME"',
    { BEGIN_NONCE: begin.stdout },
  );
  assert.equal(result.status, 0, result.stderr);
  const accepted = capture.timing();
  assert.equal(accepted.disposition, 'normal');
  const replay = capture.control(
    'request_supervisor_signal "$scope" ANDROID_STOP_RESULT "$incarnation" "$BEGIN_NONCE:signaled"',
    { BEGIN_NONCE: begin.stdout },
  );
  assert.equal(replay.status, 0, replay.stderr);
  assert.deepEqual(capture.timing(), accepted);
  const contradictory = capture.control(
    'request_supervisor_signal "$scope" ANDROID_STOP_RESULT "$incarnation" "$BEGIN_NONCE:absent"',
    { BEGIN_NONCE: begin.stdout },
  );
  assert.notEqual(contradictory.status, 0);
  assert.deepEqual(capture.timing(), accepted);
  assert.equal(
    capture.control(
      'request_supervisor_signal "$scope" KILL "$incarnation"; wait_for_supervisor_terminal "$scope" "$incarnation"',
    ).status,
    0,
  );
  assert.equal(capture.timing().disposition, 'forced');
  assert.equal(capture.timing().stop, first.stop);
});

test('Android defers a fast transport exit for its result and never repairs an expired bracket', async (t) => {
  for (const delay of [150, 1_500, 5_200]) {
    const capture = androidCaptureFixture(t);
    const begin = capture.control(
      'request_supervisor_signal "$scope" ANDROID_STOP_BEGIN "$incarnation"; printf "%s" "$SUPERVISOR_REQUEST_NONCE"',
    );
    assert.equal(begin.status, 0, begin.stderr);
    const first = capture.timing();
    assert.equal(capture.control('stop_android_recorder "$scope" signal').status, 0);
    await new Promise((resolve) => setTimeout(resolve, delay));
    assert.match(readFileSync(capture.events, 'utf8'), /transport-exit/);
    assert.equal(capture.timing().signal, null);
    if (delay < 5_000) {
      assert.equal(capture.timing().exit, null);
      const result = capture.control(
        'request_supervisor_signal "$scope" ANDROID_STOP_RESULT "$incarnation" "$BEGIN_NONCE:signaled"; wait_for_supervisor_terminal "$scope" "$incarnation"',
        { BEGIN_NONCE: begin.stdout },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(capture.timing().disposition, 'normal');
      assert.ok(capture.timing().signal <= capture.timing().exit);
      if (delay > 1_000) {
        const clock = capture.control(
          'read_capture_timing "$scope" "$incarnation" android; printf "%s|%s" "$CAPTURE_DURATION" "$CAPTURE_TIMING_UNAVAILABLE"',
        );
        assert.equal(clock.status, 0, clock.stderr);
        const [duration, unavailable] = clock.stdout.split('|');
        assert.equal(unavailable, '');
        const settled = capture.timing();
        assert.ok(settled.signal - settled.stop >= 1);
        assert.ok(Math.abs(Number(duration) - (settled.signal - settled.ready)) <= 1 / 60);
      }
    } else {
      const expired = capture.timing();
      assert.equal(expired.android_stop.result, 'expired');
      assert.equal(expired.disposition, 'uncertain');
      const late = capture.control(
        'request_supervisor_signal "$scope" ANDROID_STOP_RESULT "$incarnation" "$BEGIN_NONCE:signaled"',
        { BEGIN_NONCE: begin.stdout },
      );
      assert.notEqual(late.status, 0);
      assert.deepEqual(capture.timing(), expired);
    }
    assert.equal(capture.timing().stop, first.stop);
  }
});

test('Android normalizes at 30 fps when the device stop handshake outlasts one second', (t) => {
  const capture = androidCaptureFixture(t, { REMOTE_LATENCY: '1.1' });
  const first = spawnSync('bash', capture.args, {
    env: { ...capture.env, DELETE_FAIL: '1' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(first.status, 0);
  assert.doesNotMatch(first.stdout, /normalization skipped/);
  const timing = capture.timing();
  assert.equal(timing.disposition, 'normal');
  assert.ok(timing.signal - timing.stop >= 1);
  const encodingArgs: string[] = JSON.parse(
    readFileSync(capture.env.ENCODER_ARGS, 'utf8').trim().split('\n')[0],
  );
  assert.ok(encodingArgs.includes('fps=30,tpad=stop_mode=clone:stop=-1'));
  const duration = Number(encodingArgs[encodingArgs.indexOf('-t') + 1]);
  assert.ok(Math.abs(duration - (timing.signal - timing.ready)) <= 1 / 60);
  const retry = spawnSync('bash', capture.args, {
    env: capture.env,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(retry.status, 0, retry.stderr);
  assert.match(retry.stdout, /^Saved: /m);
});

test('Android resumes expired attempts as cleanup and retains force after a checked remote signal', async (t) => {
  for (const incomplete of [false, true]) {
    const capture = androidCaptureFixture(t, { TRANSPORT_STUCK: '1' });
    let firstStop: number | undefined;
    if (incomplete) {
      const begin = capture.control(
        'request_supervisor_signal "$scope" ANDROID_STOP_BEGIN "$incarnation"',
      );
      assert.equal(begin.status, 0, begin.stderr);
      firstStop = capture.timing().stop;
      await new Promise((resolve) => setTimeout(resolve, 5_200));
      assert.equal(capture.timing().android_stop.result, 'expired');
    }
    const stop = spawnSync('bash', capture.args, {
      env: { ...capture.env, DELETE_FAIL: '1' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    assert.notEqual(stop.status, 0);
    assert.match(stop.stdout, /recorder required force stop/);
    const timing = capture.timing();
    assert.equal(timing.disposition, 'forced');
    if (incomplete) {
      assert.equal(timing.stop, firstStop);
      assert.equal(timing.signal, null);
    } else {
      assert.ok(timing.stop <= timing.signal && timing.signal <= timing.exit);
    }
    const events = readFileSync(capture.events, 'utf8');
    assert.equal(events.match(/remote-int/g)?.length, 1);
    assert.doesNotMatch(events, /host-stop|transport-exit/);
    const encodes: string[] = JSON.parse(readFileSync(capture.env.ENCODER_ARGS, 'utf8').trim());
    assert.equal(encodes.includes('-t'), false);
  }
});

test('Android wait-only finalization refuses a still-live remote without signaling it again', (t) => {
  const capture = androidCaptureFixture(t);
  const stop = spawnSync('bash', capture.args, {
    env: { ...capture.env, REMOTE_STATE: 'remote-still-live' },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.notEqual(stop.status, 0);
  assert.match(stop.stderr, /device-side screenrecord PID 777 did not stop/);
  assert.equal(capture.timing().disposition, 'normal');
  assert.equal(readFileSync(capture.events, 'utf8').match(/remote-int/g)?.length, 1);
  assert.equal(existsSync(capture.env.ENCODER_ARGS), false);
});

test('Android abort retains authority when the exact device is unreachable', () => {
  const state = fixture();
  try {
    seedLocalBinding(state.prefix);
    const result = spawnSync('bash', [state.script, 'abort', scope], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_DEVICE_STATE: 'offline',
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_STAT: '',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /device is unreachable/);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
  } finally {
    state.cleanup();
  }
});

test('Android abort refuses cleanup when an unbound screenrecord remains', () => {
  const state = fixture();
  try {
    seedLocalBinding(state.prefix);
    const result = spawnSync('bash', [state.script, 'abort', scope], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_SCREENRECORD_PIDS: '777',
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_STAT: '',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unbound device-side screenrecord remains active/);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
  } finally {
    state.cleanup();
  }
});

test('Android stop finalizes without signaling a reused remote PID', () => {
  const state = fixture();
  try {
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.remote-pid`, '777');
    writeFileSync(`${state.prefix}-${scope}.remote-birth`, `${bootId}:123`);
    writeFileSync(`${state.prefix}-${scope}.remote-command`, '/system/bin/screenrecord');
    writeFileSync(
      `${state.prefix}-${scope}.remote-args`,
      '/system/bin/screenrecord /sdcard/proof.mp4',
    );
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    const stat = ['777', '(screenrecord)', 'S', ...Array(18).fill('0'), '999'].join(' ');
    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: stat,
      },
    });
    assert.equal(result.status, 0);
    assert.equal(existsSync(state.killMarker), false);
  } finally {
    state.cleanup();
  }
});

test('Android stop treats disappearance during identity capture as absence', () => {
  const state = fixture();
  try {
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.remote-pid`, '777');
    writeFileSync(`${state.prefix}-${scope}.remote-birth`, `${bootId}:123`);
    writeFileSync(`${state.prefix}-${scope}.remote-command`, '/system/bin/screenrecord');
    writeFileSync(
      `${state.prefix}-${scope}.remote-args`,
      '/system/bin/screenrecord /sdcard/proof.mp4',
    );
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    const stat = ['777', '(screenrecord)', 'S', ...Array(18).fill('0'), '123'].join(' ');
    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: stat,
        FAKE_READLINK_FAIL: '1',
        FAKE_PROC_PRESENT: '0',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(state.killMarker), false);
  } finally {
    state.cleanup();
  }
});

test('Android stop refuses a same-birth recorder with different output arguments', () => {
  const state = fixture();
  try {
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.remote-pid`, '777');
    writeFileSync(`${state.prefix}-${scope}.remote-birth`, `${bootId}:123`);
    writeFileSync(`${state.prefix}-${scope}.remote-command`, '/system/bin/screenrecord');
    writeFileSync(
      `${state.prefix}-${scope}.remote-args`,
      '/system/bin/screenrecord /sdcard/proof.mp4',
    );
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    const stat = ['777', '(screenrecord)', 'S', ...Array(18).fill('0'), '123'].join(' ');
    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_STAT: stat,
        FAKE_REMOTE_PATH: '/sdcard/foreign.mp4',
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /command identity changed/);
    assert.equal(existsSync(state.killMarker), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
  } finally {
    state.cleanup();
  }
});

test('Android legacy stop pulls into an exclusive private-runtime file', () => {
  const state = fixture();
  try {
    const legacyRaw = join(state.root, `raw-android-123.mp4`);
    const output = join(state.root, 'proof.mp4');
    seedLocalBinding(state.legacyPrefix);
    writeFileSync(`${state.legacyPrefix}-${scope}.path`, output);
    writeFileSync(`${state.legacyPrefix}-${scope}.raw-path`, legacyRaw);
    writeFileSync(`${state.legacyPrefix}-${scope}.device-path`, '/sdcard/proof.mp4');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const pullDestination = readFileSync(state.pullMarker, 'utf8').trim();
    assert.equal(pullDestination.startsWith(`${state.runtimeDirectory}/tmp/`), true);
    assert.equal(existsSync(legacyRaw), false);
  } finally {
    state.cleanup();
  }
});

test('Android pull removes its private partial file when stop is terminated', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: '',
        FAKE_TERMINATE_PULL_PARENT: '1',
      },
    });

    assert.notEqual(result.status, 0);
    const pullDestination = readFileSync(state.pullMarker, 'utf8').trim();
    assert.equal(existsSync(pullDestination), false);
  } finally {
    state.cleanup();
  }
});

test('Android remote capture remains available when conversion is interrupted', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_CONVERSION_MARKER: state.conversionMarker,
        FAKE_STAT: '',
        FAKE_TERMINATE_CONVERSION: '1',
      },
    });

    assert.notEqual(result.status, 0);
    assert.equal(existsSync(state.remoteDeleteMarker), false);
    assert.equal(existsSync(state.conversionMarker), true);
    const retainedPull = readFileSync(state.pullMarker, 'utf8').trim();
    assert.equal(existsSync(retainedPull), true);
    assert.equal(existsSync(`${state.prefix}-${scope}.device-path`), true);
  } finally {
    state.cleanup();
  }
});

test('Android finalized output retries failed remote deletion without repulling', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');

    const firstStop = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_REMOTE_DELETE_FAIL: '1',
        FAKE_STAT: '',
      },
    });

    assert.notEqual(firstStop.status, 0);
    const finalizedOutput = `${output.slice(0, -4)}.mov`;
    assert.equal(existsSync(finalizedOutput), true);
    const pullManifest = `${state.prefix}-${scope}.pull-manifest`;
    assert.equal(existsSync(pullManifest), true);
    const pulledCapture = readFileSync(pullManifest, 'utf8').split('\n')[1];
    assert.equal(existsSync(pulledCapture), true);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
    writeFileSync(finalizedOutput, 'replacement');

    const secondStop = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_PULL_FAIL: '1',
        FAKE_STAT: '',
      },
    });

    assert.equal(secondStop.status, 0, secondStop.stderr);
    assert.equal(existsSync(state.remoteDeleteMarker), true);
    assert.equal(readFileSync(finalizedOutput, 'utf8'), 'recording');
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), false);
    assert.equal(existsSync(pullManifest), false);
  } finally {
    state.cleanup();
  }
});

test('Android cleanup retries resume a skipped-normalization capture without re-encoding', () => {
  for (const skipped of [
    'ffmpeg unavailable',
    'native frame timestamps unreadable',
    '30 fps H.264 re-encode failed',
    'capture timing unavailable',
  ]) {
    const state = fixture();
    try {
      if (skipped === 'ffmpeg unavailable') {
        writeFileSync(
          state.script,
          readFileSync(state.script, 'utf8').replaceAll(
            'if command -v ffmpeg >/dev/null 2>&1; then',
            'if false; then',
          ),
        );
      } else if (skipped === 'native frame timestamps unreadable') {
        writeFileSync(join(state.root, 'ffprobe'), '#!/usr/bin/env bash\nexit 1\n');
      } else {
        writeFileSync(
          join(state.root, 'ffprobe'),
          '#!/usr/bin/env bash\necho \'{"frames":[{"best_effort_timestamp_time":"0"}]}\'\n',
        );
      }
      const output = join(state.root, 'proof.mp4');
      seedLocalBinding(state.prefix);
      if (skipped !== 'capture timing unavailable') seedCaptureTiming(state.prefix);
      writeFileSync(`${state.prefix}-${scope}.path`, output);
      writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
      const env = {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_CONVERSION_MARKER: state.conversionMarker,
        FAKE_STAT: '',
      };
      const first = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
        encoding: 'utf8',
        env: { ...env, FAKE_REMOTE_DELETE_FAIL: '1' },
      });
      assert.notEqual(first.status, 0);
      assert.ok(first.stdout.includes(`Cadence normalization skipped: ${skipped}`), first.stdout);
      const finalized = readFileSync(`${state.prefix}-${scope}.finalized-path`, 'utf8').trim();
      assert.equal(finalized.endsWith('.mp4'), skipped === 'ffmpeg unavailable');
      const second = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
        encoding: 'utf8',
        env: { ...env, FAKE_PULL_FAIL: '1', FAKE_FFMPEG_SUCCESS: '1' },
      });
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /^Saved: /m);
      assert.equal(existsSync(state.conversionMarker), false);
    } finally {
      state.cleanup();
    }
  }
});

test('Android migrates pending path-only finalization through a fresh pull', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const legacyFinalized = `${output.slice(0, -4)}.mov`;
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    writeFileSync(`${state.prefix}-${scope}.finalized-path`, legacyFinalized);
    writeFileSync(legacyFinalized, 'legacy-finalized');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_STAT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(state.pullMarker), true);
    assert.equal(existsSync(state.remoteDeleteMarker), true);
    assert.equal(readFileSync(legacyFinalized, 'utf8'), 'recording');
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), false);
  } finally {
    state.cleanup();
  }
});

test('Android adopts authenticated finalized output when the device copy is gone', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const finalizedOutput = `${output.slice(0, -4)}.mov`;
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    writeFileSync(`${state.prefix}-${scope}.finalized-path`, finalizedOutput);
    writeFileSync(finalizedOutput, 'authenticated-finalized');
    writeFileSync(`${state.prefix}-${scope}.finalized-identity`, captureIdentity(finalizedOutput));

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_FAIL: '1',
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_STAT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(state.pullMarker), false);
    assert.equal(existsSync(state.remoteDeleteMarker), true);
    assert.equal(readFileSync(finalizedOutput, 'utf8'), 'authenticated-finalized');
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), false);
  } finally {
    state.cleanup();
  }
});

test('Android atomically replaces an output symlink without writing its target', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const publishedOutput = `${output.slice(0, -4)}.mov`;
    const victim = join(state.root, 'victim.txt');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    writeFileSync(victim, 'unchanged');
    symlinkSync(victim, publishedOutput);

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(victim, 'utf8'), 'unchanged');
    assert.equal(lstatSync(publishedOutput).isSymbolicLink(), false);
    assert.equal(readFileSync(publishedOutput, 'utf8'), 'recording');
  } finally {
    state.cleanup();
  }
});

test('Android finalizes an existing raw capture when replacement pull fails', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'raw-android-123.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.raw-path`, raw);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    writeFileSync(raw, 'existing-recording');
    writeFileSync(`${state.prefix}-${scope}.raw-identity`, captureIdentity(raw));

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_PULL_FAIL: '1',
        FAKE_STAT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const finalizedOutput = `${output.slice(0, -4)}.mov`;
    assert.equal(readFileSync(finalizedOutput, 'utf8'), 'existing-recording');
    assert.equal(existsSync(state.remoteDeleteMarker), true);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), false);
  } finally {
    state.cleanup();
  }
});

test('Android retains an unbound prior capture in the replacement manifest', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'raw-android-123.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.raw-path`, raw);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    writeFileSync(raw, 'prior-recording');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_FAIL: '1',
        FAKE_STAT: '',
      },
    });

    assert.notEqual(result.status, 0);
    const manifest = readFileSync(`${state.prefix}-${scope}.pull-manifest`, 'utf8').split('\n');
    assert.equal(manifest[3], raw);
    assert.equal(manifest[4], captureIdentity(raw));
    assert.equal(existsSync(raw), true);
  } finally {
    state.cleanup();
  }
});

test('Android supplies an explicit MP4 format to conversion staging', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_CONVERSION_MARKER: state.conversionMarker,
        FAKE_FFMPEG_SUCCESS: '1',
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: '',
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(state.conversionMarker), true);
    assert.equal(readFileSync(output, 'utf8'), 'converted');
  } finally {
    state.cleanup();
  }
});

test('Android retains the device capture when fallback raw completion is unproven', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'raw-android-123.mp4');
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.raw-path`, raw);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    writeFileSync(raw, '');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_PULL_FAIL: '1',
        FAKE_STAT: '',
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recording remains on device for retry/);
    assert.equal(existsSync(state.remoteDeleteMarker), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
  } finally {
    state.cleanup();
  }
});

test('Android cleanup remains resumable after the process marker is removed', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const blockingSidecar = `${state.prefix}-${scope}.control-response`;
    seedLocalBinding(state.prefix);
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.device-path`, '/sdcard/proof.mp4');
    mkdirSync(blockingSidecar);

    const firstStop = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_REMOTE_DELETE_MARKER: state.remoteDeleteMarker,
        FAKE_STAT: '',
      },
    });

    assert.notEqual(firstStop.status, 0);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
    assert.equal(existsSync(`${state.prefix}-${scope}.cleanup-pending`), true);
    const cleanupReceipt = readFileSync(`${state.prefix}-${scope}.cleanup-pending`, 'utf8').split(
      '\n',
    );
    assert.equal(cleanupReceipt[0], 'v2');
    assert.equal(cleanupReceipt[6], '1');
    const retainedCapture = cleanupReceipt[7];
    assert.equal(existsSync(retainedCapture), true);

    const status = spawnSync('bash', [state.script, 'status', scope], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.match(status.stdout, /status=cleanup/);

    const restart = spawnSync(
      'bash',
      [state.script, 'start', 'android', output, '--scope', scope],
      {
        encoding: 'utf8',
        env: process.env,
      },
    );
    assert.notEqual(restart.status, 0);
    assert.match(restart.stderr, /requires authenticated cleanup/);

    rmSync(blockingSidecar, { recursive: true });
    const retry = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(retry.status, 0, retry.stderr);
    assert.match(retry.stdout, /^Saved: /m);
    assert.equal(existsSync(retainedCapture), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.cleanup-pending`), false);
  } finally {
    state.cleanup();
  }
});

test('Android cleanup receipt restores output and removes its private artifact', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'raw-android-pull.abc123');
    seedLocalBinding(state.prefix);
    writeFileSync(output, 'original-output');
    const outputIdentity = captureIdentity(output);
    writeFileSync(raw, 'recovery-output');
    const rawIdentity = captureIdentity(raw);
    writeFileSync(
      `${state.prefix}-${scope}.cleanup-pending`,
      [
        'v2',
        '999999',
        'local-birth',
        output,
        outputIdentity,
        String(Buffer.byteLength('original-output')),
        '1',
        raw,
        rawIdentity,
        '',
      ].join('\n'),
    );
    writeFileSync(output, 'replacement');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: process.env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'recovery-output');
    assert.equal(existsSync(raw), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.cleanup-pending`), false);
  } finally {
    state.cleanup();
  }
});

test('Android cleanup preserves recovery for an unsafe output directory', () => {
  const state = fixture();
  try {
    const sharedDirectory = join(state.root, 'shared');
    const output = join(sharedDirectory, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'raw-android-pull.abc123');
    mkdirSync(sharedDirectory);
    chmodSync(sharedDirectory, 0o777);
    seedLocalBinding(state.prefix);
    writeFileSync(output, 'original-output');
    const outputIdentity = captureIdentity(output);
    writeFileSync(raw, 'recovery-output');
    const rawIdentity = captureIdentity(raw);
    writeFileSync(
      `${state.prefix}-${scope}.cleanup-pending`,
      [
        'v2',
        '999999',
        'local-birth',
        output,
        outputIdentity,
        String(Buffer.byteLength('original-output')),
        '1',
        raw,
        rawIdentity,
        '',
      ].join('\n'),
    );
    writeFileSync(output, 'replacement');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: process.env,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /recording output directory is unsafe/);
    assert.equal(readFileSync(output, 'utf8'), 'replacement');
    assert.equal(existsSync(raw), true);
    assert.equal(existsSync(`${state.prefix}-${scope}.pid`), true);
    assert.equal(existsSync(`${state.prefix}-${scope}.cleanup-pending`), true);
  } finally {
    state.cleanup();
  }
});

test('Android v1 cleanup receipt adopts authenticated raw recovery state', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'raw-android-pull.abc123');
    seedLocalBinding(state.prefix);
    writeFileSync(output, 'original-output');
    const outputIdentity = captureIdentity(output);
    writeFileSync(raw, 'recovery-output');
    const rawIdentity = captureIdentity(raw);
    writeFileSync(
      `${state.prefix}-${scope}.pull-manifest`,
      ['v1', raw, rawIdentity, ''].join('\n'),
    );
    writeFileSync(
      `${state.prefix}-${scope}.cleanup-pending`,
      [
        'v1',
        '999999',
        'local-birth',
        output,
        outputIdentity,
        String(Buffer.byteLength('original-output')),
        '',
      ].join('\n'),
    );
    writeFileSync(output, 'replacement');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: process.env,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(output, 'utf8'), 'recovery-output');
    assert.equal(existsSync(raw), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.pull-manifest`), false);
    assert.equal(existsSync(`${state.prefix}-${scope}.cleanup-pending`), false);
  } finally {
    state.cleanup();
  }
});

test('Android legacy finalization ignores a foreign replacement raw entry', () => {
  const state = fixture();
  try {
    const legacyRaw = join(state.root, 'raw-android-456.mp4');
    const output = join(state.root, 'proof.mp4');
    seedLocalBinding(state.legacyPrefix);
    writeFileSync(`${state.legacyPrefix}-${scope}.path`, output);
    writeFileSync(`${state.legacyPrefix}-${scope}.raw-path`, legacyRaw);
    writeFileSync(`${state.legacyPrefix}-${scope}.device-path`, '/sdcard/proof.mp4');

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_KILL_MARKER: state.killMarker,
        FAKE_PULL_MARKER: state.pullMarker,
        FAKE_STAT: '',
        FAKE_PRIOR_RAW_PATH: legacyRaw,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(`${output.slice(0, -4)}.mov`), true);
  } finally {
    state.cleanup();
  }
});
