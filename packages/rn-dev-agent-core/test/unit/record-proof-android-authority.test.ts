import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

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
  const killMarker = join(root, 'kill-marker');
  const pullMarker = join(root, 'pull-marker');
  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${legacyPrefix}"`)
    .replace(
      'RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"',
      `RUNTIME_DIR="${runtimeDirectory}"`,
    )
    .replace(
      'RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"',
      `RUNTIME_ROOT="${root}"`,
    )
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
elif [[ "$args" == pull\\ * || "$args" == *" pull "* ]]; then
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
  chmodSync(adb, 0o755);
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  return {
    root,
    legacyPrefix,
    runtimeDirectory,
    prefix,
    script,
    killMarker,
    pullMarker,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function seedLocalBinding(prefix: string) {
  writeFileSync(`${prefix}-${scope}.pid`, '999999');
  writeFileSync(`${prefix}-${scope}.birth`, 'local-birth');
  writeFileSync(`${prefix}-${scope}.platform`, 'android');
  writeFileSync(`${prefix}-${scope}.path`, '/tmp/proof.mp4');
}

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
    const result = spawnSync(
      'bash',
      [state.script, 'stop', scope, '999999', 'local-birth'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${state.root}:${process.env.PATH}`,
          FAKE_KILL_MARKER: state.killMarker,
          FAKE_STAT: stat,
        },
      },
    );
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
    const result = spawnSync(
      'bash',
      [state.script, 'stop', scope, '999999', 'local-birth'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${state.root}:${process.env.PATH}`,
          FAKE_KILL_MARKER: state.killMarker,
          FAKE_STAT: stat,
          FAKE_READLINK_FAIL: '1',
          FAKE_PROC_PRESENT: '0',
        },
      },
    );
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
    const result = spawnSync(
      'bash',
      [state.script, 'stop', scope, '999999', 'local-birth'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${state.root}:${process.env.PATH}`,
          FAKE_KILL_MARKER: state.killMarker,
          FAKE_STAT: stat,
          FAKE_REMOTE_PATH: '/sdcard/foreign.mp4',
        },
      },
    );
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

    const result = spawnSync(
      'bash',
      [state.script, 'stop', scope, '999999', 'local-birth'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${state.root}:${process.env.PATH}`,
          FAKE_KILL_MARKER: state.killMarker,
          FAKE_PULL_MARKER: state.pullMarker,
          FAKE_STAT: '',
        },
      },
    );

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

    const result = spawnSync(
      'bash',
      [state.script, 'stop', scope, '999999', 'local-birth'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${state.root}:${process.env.PATH}`,
          FAKE_KILL_MARKER: state.killMarker,
          FAKE_PULL_MARKER: state.pullMarker,
          FAKE_STAT: '',
          FAKE_TERMINATE_PULL_PARENT: '1',
        },
      },
    );

    assert.notEqual(result.status, 0);
    const pullDestination = readFileSync(state.pullMarker, 'utf8').trim();
    assert.equal(existsSync(pullDestination), false);
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

    const result = spawnSync(
      'bash',
      [state.script, 'stop', scope, '999999', 'local-birth'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${state.root}:${process.env.PATH}`,
          FAKE_KILL_MARKER: state.killMarker,
          FAKE_PULL_MARKER: state.pullMarker,
          FAKE_STAT: '',
          FAKE_PRIOR_RAW_PATH: legacyRaw,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(`${output.slice(0, -4)}.mov`), true);
  } finally {
    state.cleanup();
  }
});
