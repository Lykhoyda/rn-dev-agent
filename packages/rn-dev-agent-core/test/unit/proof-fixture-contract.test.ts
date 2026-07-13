import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('proof fixture exposes the canonical three-state feature flow', () => {
  const app = read('apps/proof-fixture/App.tsx');
  for (const marker of [
    'proof-start',
    'proof-open-form',
    'proof-name-input',
    'proof-submit',
    'proof-result',
    'Feature accepted',
  ]) {
    assert.match(app, new RegExp(marker));
  }
});

test('canonical proof action carries reusable-action metadata and assertions', () => {
  const flow = read('apps/proof-fixture/actions/canonical-proof.yaml');
  assert.match(flow, /^# id: canonical-proof/m);
  assert.match(flow, /^# intent: /m);
  assert.match(flow, /^# tags: /m);
  assert.match(flow, /^# mutates: true/m);
  assert.match(flow, /^# status: experimental/m);
  assert.match(flow, /proof-result/);
  assert.match(flow, /Feature accepted/);
  assert.doesNotMatch(flow, /clearState:\s*true/);
});

test('proof fixture uses a development client for deterministic Metro routing', () => {
  const packageJson = JSON.parse(read('apps/proof-fixture/package.json')) as {
    dependencies?: Record<string, string>;
  };
  const appJson = JSON.parse(read('apps/proof-fixture/app.json')) as {
    expo?: { plugins?: Array<[string, Record<string, unknown>]> };
  };

  assert.equal(packageJson.dependencies?.['expo-dev-client'], '~57.0.5');
  assert.deepEqual(appJson.expo?.plugins, [
    [
      'expo-dev-client',
      { launchMode: 'most-recent', skipOnboarding: true, showMenuAtLaunch: false },
    ],
  ]);
});
