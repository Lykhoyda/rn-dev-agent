import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  freezeLockedTest,
  loadLockedTest,
  discoverLockedTests,
  hashBody,
  resolveLockedTestIdentityIds,
  serializeLockedTest,
} from '../../dist/domain/e2e-test.js';

const FLOW = 'appId: com.x\n---\n# id: login\n- launchApp\n';
const SRC = { id: 'login', intent: 'Log in', sourceActionId: 'login', flow: FLOW, appId: 'com.x' };
const CTX = { gitSha: 'sha123', now: () => new Date('2026-06-18T00:00:00Z') };

test('freeze writes an executable, parseable file and returns metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-io-'));
  try {
    const locked = freezeLockedTest(root, SRC, CTX);
    assert.equal(locked.id, 'login');
    assert.equal(locked.sourceContentHash, hashBody(FLOW));
    const onDisk = readFileSync(join(root, '.rn-agent', 'e2e', 'login.yaml'), 'utf8');
    assert.match(onDisk, /# e2e-locked-test: true/);
    assert.match(onDisk, /^appId: com\.x$/m); // executable header preserved
    const reloaded = loadLockedTest(root, 'login');
    assert.equal(reloaded.lockedGitSha, 'sha123');
    assert.match(reloaded.flow, /- launchApp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('discoverLockedTests lists .yaml ids sorted, ignores .yml; load null for missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-io-'));
  try {
    freezeLockedTest(root, { ...SRC, id: 'bbb' }, CTX);
    freezeLockedTest(root, { ...SRC, id: 'aaa' }, CTX);
    // a stray .yml must NOT be discovered (freeze only writes .yaml)
    mkdirSync(join(root, '.rn-agent', 'e2e'), { recursive: true });
    writeFileSync(join(root, '.rn-agent', 'e2e', 'ccc.yml'), '# e2e-locked-test: true\n', 'utf8');
    assert.deepEqual(discoverLockedTests(root), ['aaa', 'bbb']);
    assert.equal(loadLockedTest(root, 'missing'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('locked identity resolution rejects mismatched declared and source action ids', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-io-'));
  try {
    freezeLockedTest(root, { ...SRC, id: 'user-login', sourceActionId: 'other-login' }, CTX);
    assert.deepEqual(resolveLockedTestIdentityIds(root, '^user-login$'), []);

    const filePath = join(root, '.rn-agent', 'e2e', 'user-login.yaml');
    writeFileSync(
      filePath,
      serializeLockedTest({
        id: 'other-login',
        intent: SRC.intent,
        sourceActionId: 'user-login',
        lockedAt: CTX.now().toISOString(),
        lockedGitSha: CTX.gitSha,
        sourceContentHash: hashBody(FLOW),
        status: 'locked',
        appId: SRC.appId,
        flow: FLOW,
      }),
      'utf8',
    );
    assert.equal(loadLockedTest(root, 'user-login'), null);
    assert.deepEqual(resolveLockedTestIdentityIds(root, '^user-login$'), []);

    freezeLockedTest(root, { ...SRC, id: 'user-login', sourceActionId: 'user-login' }, CTX);
    assert.deepEqual(resolveLockedTestIdentityIds(root, '^user-login$'), ['user-login']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
