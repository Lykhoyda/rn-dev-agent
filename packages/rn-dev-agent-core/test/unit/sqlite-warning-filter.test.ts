import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const filterPath = new URL('../../dist/sqlite-warning-filter.js', import.meta.url).pathname;

test('SQLite warning filter suppresses only the known warning', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      filterPath,
      '--input-type=module',
      '-e',
      [
        "await import('node:sqlite')",
        "process.emitWarning('unrelated experimental', 'ExperimentalWarning')",
        "process.emitWarning('ordinary warning')",
      ].join(';'),
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  assert.match(result.stderr, /ExperimentalWarning: unrelated experimental/);
  assert.match(result.stderr, /Warning: ordinary warning/);
});
