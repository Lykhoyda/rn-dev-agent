// GH #397: the maestro-runner pin exists in TWO files — the TS manifest and
// the shell installer. Grep-sync keeps them honest (same style as
// gh-383-protocol-sync).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(BRIDGE_ROOT, '..', '..');

function extract(path: string, regex: RegExp): string {
  const src = readFileSync(path, 'utf8');
  const m = src.match(regex);
  assert.ok(m, `${path} must declare the pin (${regex})`);
  return m[1];
}

test('gh-397: pin version agrees between engine-pin.ts and ensure-maestro-runner.sh', () => {
  const ts = extract(
    join(BRIDGE_ROOT, 'src', 'domain', 'engine-pin.ts'),
    /version:\s*'(\d+\.\d+\.\d+)'/,
  );
  const sh = extract(
    join(REPO_ROOT, 'scripts', 'ensure-maestro-runner.sh'),
    /MAESTRO_RUNNER_PIN_VERSION="(\d+\.\d+\.\d+)"/,
  );
  assert.equal(sh, ts);
});

test('gh-397: darwin-arm64 sha256 agrees between engine-pin.ts and installer', () => {
  const ts = extract(
    join(BRIDGE_ROOT, 'src', 'domain', 'engine-pin.ts'),
    /'darwin-arm64':\s*'([0-9a-f]{64})'/,
  );
  const sh = extract(
    join(REPO_ROOT, 'scripts', 'ensure-maestro-runner.sh'),
    /MAESTRO_RUNNER_PIN_SHA256_DARWIN_ARM64="([0-9a-f]{64})"/,
  );
  assert.equal(sh, ts);
});
