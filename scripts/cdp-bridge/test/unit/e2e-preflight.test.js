import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getGitInfo } from '../../dist/e2e/git-info.js';
import { preflight } from '../../dist/e2e/preflight.js';

test('getGitInfo parses sha + dirty from injected exec', () => {
  const exec = (_cmd, args) => (args.includes('rev-parse') ? 'abc1234\n' : ' M file.ts\n');
  assert.deepEqual(getGitInfo('/x', exec), { sha: 'abc1234', dirty: true });
});

test('getGitInfo: clean → dirty false; failure → sha null', () => {
  const clean = (_c, args) => (args.includes('rev-parse') ? 'def5678\n' : '');
  assert.deepEqual(getGitInfo('/x', clean), { sha: 'def5678', dirty: false });
  const boom = () => { throw new Error('not a git repo'); };
  assert.deepEqual(getGitInfo('/x', boom), { sha: null, dirty: false });
});

test('preflight ok when metro up + app installed', () => {
  assert.deepEqual(
    preflight({ platform: 'ios', udid: 'u', appId: 'com.x', metroReachable: true, appInstalled: true }),
    { ok: true },
  );
});

test('preflight SETUP_ERROR for metro down / no device / app missing; null app tolerated', () => {
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: false, appInstalled: true }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: null, metroReachable: true, appInstalled: true }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: true, appInstalled: false }).code, 'SETUP_ERROR');
  assert.equal(preflight({ platform: 'ios', udid: 'u', metroReachable: true, appInstalled: null }).ok, true);
});
