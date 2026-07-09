import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveMirrorConfig, DEFAULT_MIRROR_FPS } from '../../dist/project-config.js';

test('default: enabled, fps 20', () => {
  assert.deepEqual(resolveMirrorConfig({ env: undefined, readConfig: () => null }), {
    enabled: true,
    fps: DEFAULT_MIRROR_FPS,
    source: 'default',
  });
});

test('env "0"/"false" disables even when config enables', () => {
  const readConfig = () => ({ observe: { mirror: { enabled: true } } });
  for (const env of ['0', 'false']) {
    assert.equal(resolveMirrorConfig({ env, readConfig }).enabled, false);
    assert.equal(resolveMirrorConfig({ env, readConfig }).source, 'env');
  }
});

test('env "1"/"true" enables over config false', () => {
  const readConfig = () => ({ observe: { mirror: { enabled: false } } });
  for (const env of ['1', 'true']) {
    assert.equal(resolveMirrorConfig({ env, readConfig }).enabled, true);
  }
});

test('config enabled:false respected when env unset', () => {
  const r = resolveMirrorConfig({
    env: undefined,
    readConfig: () => ({ observe: { mirror: { enabled: false } } }),
  });
  assert.deepEqual({ enabled: r.enabled, source: r.source }, { enabled: false, source: 'config' });
});

test('fps: config value used, clamped to 5..30, junk → default', () => {
  const mk = (fps) =>
    resolveMirrorConfig({ env: undefined, readConfig: () => ({ observe: { mirror: { fps } } }) })
      .fps;
  assert.equal(mk(12), 12);
  assert.equal(mk(1), 5);
  assert.equal(mk(120), 30);
  assert.equal(mk('fast'), DEFAULT_MIRROR_FPS);
  assert.equal(mk(undefined), DEFAULT_MIRROR_FPS);
});

test('config read errors fail open (enabled, defaults)', () => {
  const r = resolveMirrorConfig({
    env: undefined,
    readConfig: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(r, { enabled: true, fps: DEFAULT_MIRROR_FPS, source: 'default' });
});
