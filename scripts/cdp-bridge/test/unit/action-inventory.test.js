import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listActions } from '../../dist/domain/action-inventory.js';

function makeProject() {
  const root = join(
    tmpdir(),
    `action-inv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(root, '.rn-agent', 'actions'), { recursive: true });
  return root;
}

function writeAction(root, id, extra = '') {
  const yaml = `# id: ${id}\n# intent: Do ${id}\n# status: active\n${extra}- launchApp\n`;
  writeFileSync(join(root, '.rn-agent', 'actions', `${id}.yaml`), yaml);
}

test('listActions returns empty array when dir is missing', async () => {
  const root = join(tmpdir(), `action-inv-missing-${Date.now()}`);
  const result = await listActions(root);
  assert.deepEqual(result, []);
});

test('listActions returns correct summaries sorted by id', async () => {
  const root = makeProject();
  try {
    writeAction(root, 'beta-flow');
    writeAction(
      root,
      'alpha-flow',
      '# mutates: true\n# appId: com.example.app\n# params: [USER, PASS]\n',
    );
    const result = await listActions(root);
    assert.equal(result.length, 2);
    assert.equal(result[0].id, 'alpha-flow');
    assert.equal(result[0].intent, 'Do alpha-flow');
    assert.equal(result[0].status, 'active');
    assert.equal(result[0].mutates, true);
    assert.equal(result[0].appId, 'com.example.app');
    assert.deepEqual(result[0].params, ['USER', 'PASS']);
    assert.equal(result[1].id, 'beta-flow');
    assert.equal(result[1].intent, 'Do beta-flow');
    assert.equal(result[1].mutates, undefined);
    assert.equal(result[1].appId, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('listActions skips unparseable files and continues', async () => {
  const root = makeProject();
  try {
    writeAction(root, 'good-action');
    writeFileSync(
      join(root, '.rn-agent', 'actions', 'bad-action.yaml'),
      'not: yaml: with: no: m7: header\n',
    );
    const result = await listActions(root);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'good-action');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
