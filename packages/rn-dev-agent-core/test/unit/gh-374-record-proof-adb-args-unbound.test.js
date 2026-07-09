// GH #374: `device_record action=stop` aborted on macOS with
//   record_proof.sh: line 180: adb_args[@]: unbound variable
// Root cause: cmd_stop's Android branch declares `local -a adb_args=()` and
// only fills it when a `.serial` sidecar exists. In the single-device case
// cmd_start rm's that sidecar, so adb_args stays empty — and under
// `set -euo pipefail` on bash 3.2 (the macOS default /bin/bash) expanding an
// empty array as "${adb_args[@]}" is an UNBOUND-VARIABLE error, aborting the
// stop before the pull/convert. Bash >= 4.4 removed that behavior, which is
// why ubuntu-latest CI (bash 5.x) never caught it. The same file already used
// the correct guard `"${saved_paths[@]+"${saved_paths[@]}"}"` at another site.
//
// Two-layer regression guard:
//  1. STATIC invariant (runs everywhere, incl. CI): no unguarded
//     `adb "${adb_args[@]}"` remains — every expansion uses the `+`-default
//     guard. This is the CI-effective guard because the runtime crash does not
//     reproduce on bash >= 4.4.
//  2. BEHAVIORAL reproduction (only meaningful where empty-array expansion is
//     an error, i.e. bash < 4.4 / macOS): runs `stop` against an intentionally
//     UNPATCHED copy (asserts it DOES crash — proving the test detects the bug)
//     and against the real PATCHED script (asserts it does NOT). Skipped on
//     bash >= 4.4, where layer 1 carries the guarantee.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'record_proof.sh',
);
const GUARDED = '${adb_args[@]+"${adb_args[@]}"}';

// Does THIS bash treat an empty-array expansion under `set -u` as unbound?
function bashErrorsOnEmptyArray() {
  const r = spawnSync('bash', ['-uc', 'a=(); printf "%s" "${a[@]}"'], { encoding: 'utf8' });
  return r.status !== 0 && /unbound variable/i.test(r.stderr || '');
}

test('static: no unguarded ${adb_args[@]} expansion survives (the #374 invariant)', () => {
  const src = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(
    src,
    /adb "\$\{adb_args\[@\]\}"/,
    'record_proof.sh must not expand adb_args unguarded — empty-array + set -u aborts on bash 3.2',
  );
  const guardedCount = src.split(GUARDED).length - 1;
  assert.ok(
    guardedCount >= 3,
    `expected the 3 known adb_args expansions to use the +-default guard, found ${guardedCount}`,
  );
});

test('behavioral: stop survives a serial-less single-device Android state (repros on bash < 4.4)', (t) => {
  if (!bashErrorsOnEmptyArray()) {
    t.skip(
      'bash >= 4.4: empty-array expansion is not an error here; the static test covers the invariant',
    );
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'gh374-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));

  // Hermetic copy: rewrite the hardcoded /tmp prefixes so we never touch real
  // recorder state, and seed a single-device Android stop state with NO .serial
  // sidecar (the exact shape that leaves adb_args empty).
  const realSrc = readFileSync(SCRIPT, 'utf8');
  const pidPrefix = join(base, 'rec');
  const hermetic = realSrc
    .replace('PID_PREFIX="/tmp/rn-dev-agent-record"', `PID_PREFIX="${pidPrefix}"`)
    .replace('RAW_PREFIX="/tmp/rn-dev-agent-raw"', `RAW_PREFIX="${join(base, 'raw')}"`);

  const seedState = () => {
    writeFileSync(`${pidPrefix}-android.pid`, '999999'); // dead pid → no wait loop
    writeFileSync(`${pidPrefix}-android.path`, join(base, 'out.mp4'));
    writeFileSync(`${pidPrefix}-android.device-path`, '/sdcard/gh374-nonexistent.mp4');
    // deliberately NO `${pidPrefix}-android.serial`
  };
  const runStop = (scriptText) => {
    const p = join(base, 'record_proof.sh');
    writeFileSync(p, scriptText);
    seedState();
    const r = spawnSync('bash', [p, 'stop'], { encoding: 'utf8' });
    return `${r.stdout || ''}\n${r.stderr || ''}`;
  };

  // RED: reverting the guard reintroduces the crash — proves the test detects it.
  const unpatched = hermetic.replaceAll(GUARDED, '${adb_args[@]}');
  assert.match(
    runStop(unpatched),
    /adb_args\[@\]: unbound variable/,
    'sanity: the unguarded form must still crash, or this test proves nothing',
  );

  // GREEN: the real (patched) script must not crash on the same state.
  assert.doesNotMatch(
    runStop(hermetic),
    /unbound variable/,
    'patched record_proof.sh must survive a serial-less single-device Android stop',
  );
});
