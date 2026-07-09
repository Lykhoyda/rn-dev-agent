// M6 / Phase 112: sanitizeFilename + getRecordingsDir tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sanitizeFilename, getRecordingsDir } from '../../dist/tools/test-recorder.js';

test('M6: sanitizeFilename strips .json extension', () => {
  assert.equal(sanitizeFilename('login-flow.json'), 'login-flow');
  assert.equal(sanitizeFilename('login-flow.JSON'), 'login-flow');
});

test('M6: sanitizeFilename preserves dashes, underscores, alphanumerics', () => {
  assert.equal(sanitizeFilename('my-Test_Flow_123'), 'my-Test_Flow_123');
});

test('M6: sanitizeFilename replaces special chars with underscore', () => {
  assert.equal(sanitizeFilename('foo/bar baz.tmp'), 'foo_bar_baz_tmp');
  assert.equal(sanitizeFilename('../etc/passwd'), '___etc_passwd');
});

test('M6: getRecordingsDir returns project-root-relative path when root resolves', () => {
  const dir = getRecordingsDir(() => '/fake/project');
  assert.equal(dir, join('/fake/project', '.rn-agent', 'recordings'));
});

test('M6: getRecordingsDir returns null when project root is missing', () => {
  const dir = getRecordingsDir(() => null);
  assert.equal(dir, null);
});
