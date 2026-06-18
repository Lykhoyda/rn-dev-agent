import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

test('architecture.mdx documents the three-layer device-control contract', () => {
  // CLAUDE.md is no longer tracked (kept local-only); the published architecture
  // doc is now the canonical home of the three-layer contract — assert against it.
  const md = readFileSync(
    join(repoRoot, 'docs-site', 'src', 'content', 'docs', 'architecture.mdx'),
    'utf8',
  );
  assert.match(md, /Three-layer device-control contract/i);
  assert.match(md, /L1 INTROSPECTION/);
  assert.match(md, /L2 INTERACTION/);
  assert.match(md, /L3 FLOW-REPLAY/);
});
