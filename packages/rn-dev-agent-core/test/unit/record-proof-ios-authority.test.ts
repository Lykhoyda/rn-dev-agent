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
const scope = 'e'.repeat(64);

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'record-proof-ios-'));
  const runtimeDirectory = join(root, 'runtime');
  const prefix = join(runtimeDirectory, 'record');
  const script = join(root, 'record_proof.sh');
  const ffmpeg = join(root, 'ffmpeg');
  const ffprobe = join(root, 'ffprobe');
  const stageMarker = join(root, 'stage-marker');
  const source = readFileSync(sourceScript, 'utf8')
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${join(root, 'legacy-record')}"`)
    .replace('RUNTIME_DIR="${PID_PREFIX}.private-$(id -u)"', `RUNTIME_DIR="${runtimeDirectory}"`)
    .replace('RUNTIME_ROOT="${XDG_RUNTIME_DIR:-${TMPDIR:-${HOME:-}}}"', `RUNTIME_ROOT="${root}"`)
    .replace(
      'RUNTIME_DIR="${RUNTIME_ROOT%/}/rn-dev-agent-record"',
      `RUNTIME_DIR="${runtimeDirectory}"`,
    )
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(root, 'raw')}"`);
  writeFileSync(script, source);
  writeFileSync(
    ffmpeg,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == *" -f mp4 "* ]] || exit 2
staged="\${@: -1}"
printf '%s %s\\n' "$staged" "$(stat -f %Lp "$staged" 2>/dev/null || stat -c %a "$staged")" \\
  > "\${FAKE_STAGE_MARKER}"
printf converted > "$staged"
`,
  );
  writeFileSync(ffprobe, '#!/usr/bin/env bash\nprintf "5.0\\n"\n');
  chmodSync(ffmpeg, 0o755);
  chmodSync(ffprobe, 0o755);
  mkdirSync(runtimeDirectory, { mode: 0o700 });
  mkdirSync(join(runtimeDirectory, 'tmp'), { mode: 0o700 });
  return {
    root,
    runtimeDirectory,
    prefix,
    script,
    stageMarker,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('iOS stop normalizes through an exclusive private-runtime staging file', () => {
  const state = fixture();
  try {
    const output = join(state.root, 'proof.mp4');
    const raw = join(state.runtimeDirectory, 'tmp', 'raw-ios-123.mov');
    writeFileSync(raw, 'native capture');
    chmodSync(raw, 0o600);
    writeFileSync(`${state.prefix}-${scope}.pid`, '999999');
    writeFileSync(`${state.prefix}-${scope}.birth`, 'local-birth');
    writeFileSync(`${state.prefix}-${scope}.platform`, 'ios');
    writeFileSync(`${state.prefix}-${scope}.path`, output);
    writeFileSync(`${state.prefix}-${scope}.raw-path`, raw);

    const result = spawnSync('bash', [state.script, 'stop', scope, '999999', 'local-birth'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${state.root}:${process.env.PATH}`,
        FAKE_STAGE_MARKER: state.stageMarker,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const [staged, mode] = readFileSync(state.stageMarker, 'utf8').trim().split(' ');
    assert.equal(staged.startsWith(`${state.runtimeDirectory}/tmp/`), true, staged);
    assert.equal(mode, '600');
    assert.equal(existsSync(staged), false);
    assert.equal(readFileSync(output, 'utf8'), 'converted');
    assert.equal(existsSync(raw), false);
  } finally {
    state.cleanup();
  }
});
