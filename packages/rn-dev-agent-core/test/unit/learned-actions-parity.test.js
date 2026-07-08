// learned-actions-parity.test.js — behavioral parity test for the TS→JS
// migration of scripts/learned-actions.mjs → packages/rn-dev-agent-core/src/learned-actions.ts
// compiled to dist/learned-actions.js.
//
// Creates a fixture corpus in a temp dir (two YAML actions with M7 headers),
// spawns the compiled CLI, and asserts the JSON output matches expectations.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'packages', 'rn-dev-agent-core', 'dist', 'learned-actions.js');

function run(args, cwd) {
  return execFileSync(process.execPath, [SCRIPT, ...args], {
    cwd,
    encoding: 'utf8',
    // exit 3 = nothing found — still valid output, just non-zero
    // execFileSync throws on non-zero unless we catch the error
  });
}

function runAllowCode3(args, cwd) {
  try {
    return run(args, cwd);
  } catch (err) {
    if (err.status === 3) return err.stdout;
    throw err;
  }
}

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'la-parity-'));
  const actionsDir = join(dir, '.rn-agent', 'actions');
  mkdirSync(actionsDir, { recursive: true });

  writeFileSync(
    join(actionsDir, 'login-flow.yaml'),
    `# id: login-flow
# intent: Login with email and password
# tags: [auth, login]
# mutates: false
# status: active
appId: com.example.testapp
---
- launchApp
- tapOn:
    id: "email-input"
- inputText: "\${EMAIL}"
- tapOn:
    id: "password-input"
- inputText: "\${PASSWORD}"
- tapOn:
    id: "login-button"
`,
  );

  writeFileSync(
    join(actionsDir, 'cart-add-item.yaml'),
    `# id: cart-add-item
# intent: Add an item to the cart
# tags: [cart, shopping]
# mutates: true
# status: experimental
appId: com.example.testapp
---
- launchApp
- tapOn:
    id: "product-\${ITEM_ID}"
- tapOn:
    id: "add-to-cart-button"
`,
  );

  return dir;
}

test('section b: finds both actions, correct count and ids', () => {
  const dir = makeFixture();
  try {
    const raw = run(
      ['--json', '--section', 'b', '--workspace-root', dir, '--memory-cwd', dir],
      dir,
    );
    const out = JSON.parse(raw);

    assert.equal(out.sections.flows.count, 2, 'should find 2 flows');
    assert.equal(out.total, 2, 'total should be 2');

    const ids = out.sections.flows.items.map((f) => f.id).sort();
    assert.deepEqual(ids, ['cart-add-item', 'login-flow'], 'ids should match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('section b: flow fields match golden values', () => {
  const dir = makeFixture();
  try {
    const raw = run(
      ['--json', '--section', 'b', '--workspace-root', dir, '--memory-cwd', dir],
      dir,
    );
    const out = JSON.parse(raw);

    // Items are sorted by flow name: cart-add-item < login-flow
    const cart = out.sections.flows.items.find((f) => f.id === 'cart-add-item');
    const login = out.sections.flows.items.find((f) => f.id === 'login-flow');

    assert.ok(cart, 'cart-add-item should be present');
    assert.equal(cart.appId, 'com.example.testapp');
    assert.equal(cart.intent, 'Add an item to the cart');
    assert.equal(cart.mutates, true);
    assert.equal(cart.status, 'experimental');
    assert.deepEqual(cart.tags, ['cart', 'shopping']);
    assert.deepEqual(cart.params, ['ITEM_ID']);
    assert.equal(cart.produces, null);
    assert.ok(cart.replay.includes('-e ITEM_ID=...'), 'replay should include ITEM_ID param');

    assert.ok(login, 'login-flow should be present');
    assert.equal(login.appId, 'com.example.testapp');
    assert.equal(login.intent, 'Login with email and password');
    assert.equal(login.mutates, false);
    assert.equal(login.status, 'active');
    assert.deepEqual(login.tags, ['auth', 'login']);
    assert.deepEqual(login.params.sort(), ['EMAIL', 'PASSWORD']);
    assert.equal(login.produces, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--filter: keyword filtering narrows results', () => {
  const dir = makeFixture();
  try {
    const raw = run(
      [
        '--json',
        '--section',
        'b',
        '--filter',
        'cart',
        '--workspace-root',
        dir,
        '--memory-cwd',
        dir,
      ],
      dir,
    );
    const out = JSON.parse(raw);

    assert.equal(out.sections.flows.count, 1, 'filter should return 1 result');
    assert.equal(out.sections.flows.items[0].id, 'cart-add-item');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--appId: appId filtering', () => {
  const dir = makeFixture();
  try {
    const raw = run(
      [
        '--json',
        '--section',
        'b',
        '--appId',
        'com.example.testapp',
        '--workspace-root',
        dir,
        '--memory-cwd',
        dir,
      ],
      dir,
    );
    const out = JSON.parse(raw);
    assert.equal(out.sections.flows.count, 2, 'appId match should return both items');

    const raw2 = runAllowCode3(
      [
        '--json',
        '--section',
        'b',
        '--appId',
        'com.other.app',
        '--workspace-root',
        dir,
        '--memory-cwd',
        dir,
      ],
      dir,
    );
    const out2 = JSON.parse(raw2);
    assert.equal(out2.sections.flows.count, 0, 'wrong appId should return 0 items');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit code 3 when nothing found', () => {
  const dir = makeFixture();
  try {
    let exitCode = 0;
    try {
      execFileSync(
        process.execPath,
        [
          SCRIPT,
          '--json',
          '--section',
          'b',
          '--filter',
          'zzznomatch',
          '--workspace-root',
          dir,
          '--memory-cwd',
          dir,
        ],
        {
          encoding: 'utf8',
        },
      );
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 3, 'should exit with code 3 when nothing matches');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit code 2 on unknown flag', () => {
  const dir = makeFixture();
  try {
    let exitCode = 0;
    try {
      execFileSync(process.execPath, [SCRIPT, '--not-a-real-flag'], { encoding: 'utf8' });
    } catch (err) {
      exitCode = err.status;
    }
    assert.equal(exitCode, 2, 'should exit with code 2 for unknown flag');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('human table output contains section headers (no --json)', () => {
  const dir = makeFixture();
  try {
    const raw = run(['--workspace-root', dir, '--memory-cwd', dir], dir);
    assert.ok(raw.includes('## B. Reusable Maestro flows'), 'should include section B header');
    assert.ok(raw.includes('## A. Feedback memories'), 'should include section A header');
    assert.ok(raw.includes('login-flow'), 'should include login-flow in table');
    assert.ok(raw.includes('cart-add-item'), 'should include cart-add-item in table');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--section a: only memories section, no flows', () => {
  const dir = makeFixture();
  try {
    const raw = runAllowCode3(
      ['--json', '--section', 'a', '--workspace-root', dir, '--memory-cwd', dir],
      dir,
    );
    const out = JSON.parse(raw);
    assert.equal(out.sections.flows.count, 0, 'section a should not include flows');
    assert.equal(out.sections.memories.count, 0, 'no memories in empty fixture');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
