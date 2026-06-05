import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('CLAUDE.md documents the three-layer device-control contract', () => {
  const md = readFileSync(join(repoRoot, 'CLAUDE.md'), 'utf8');
  assert.match(md, /Three-layer device-control contract/i);
  assert.match(md, /L1 INTROSPECTION/);
  assert.match(md, /L2 INTERACTION/);
  assert.match(md, /L3 FLOW-REPLAY/);
});
