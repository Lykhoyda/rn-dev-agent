import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

// Source check by exception: walk.ts runs main() on import, so its capture wiring cannot be driven in a unit test.
const src = new URL('../../../src/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, src), 'utf8');

test('the only production capture requires private inputs and forwards native truncation', () => {
  const callers = readdirSync(src, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && path !== 'qa/capture.ts')
    .filter((path) => /\bcaptureScreen\(\s*\{/.test(read(path)));
  assert.deepEqual(callers, ['qa/walk.ts']);
  const walk = read('qa/walk.ts');
  const calls = walk.match(/\bcaptureScreen\(\s*\{[^}]*\}/g) ?? [];
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\brequirePrivateInputs:\s*true\b/);
  assert.match(walk, /\btruncated:\s*data\.truncated\b/);
});
