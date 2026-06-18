// Phase 2 Task 10: ensure-agent-device.sh is deleted and detect-rn-project.sh
// no longer references it. Uses node:fs so the assertion is deterministic —
// no shell execution required.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve repo root: scripts/cdp-bridge/test/unit/ → ../../../../
const REPO_ROOT = resolve(__dirname, '../../../../');
const INSTALLER_PATH = resolve(REPO_ROOT, 'scripts/ensure-agent-device.sh');
const HOOK_PATH = resolve(REPO_ROOT, 'hooks/detect-rn-project.sh');

test('scripts/ensure-agent-device.sh does not exist', () => {
  assert.ok(
    !existsSync(INSTALLER_PATH),
    `scripts/ensure-agent-device.sh still exists at ${INSTALLER_PATH} — it must be git rm'd`,
  );
});

test('hooks/detect-rn-project.sh exists (sanity check)', () => {
  assert.ok(
    existsSync(HOOK_PATH),
    `hooks/detect-rn-project.sh not found at ${HOOK_PATH} — path resolution is wrong`,
  );
});

test('hooks/detect-rn-project.sh does not reference ensure-agent-device', () => {
  const src = readFileSync(HOOK_PATH, 'utf8');
  const lines = src.split('\n');
  const offending = lines.filter(
    (l) => !l.trimStart().startsWith('#') && l.includes('ensure-agent-device'),
  );
  assert.deepEqual(
    offending,
    [],
    `detect-rn-project.sh still references ensure-agent-device:\n${offending.join('\n')}`,
  );
});

test('hooks/detect-rn-project.sh still invokes ensure-android-ready.sh', () => {
  const src = readFileSync(HOOK_PATH, 'utf8');
  assert.match(
    src,
    /ensure-android-ready\.sh/,
    'detect-rn-project.sh must still invoke ensure-android-ready.sh (do not remove it)',
  );
});
