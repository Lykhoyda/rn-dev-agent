import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockE2eTestCore } from '../../dist/tools/lock-e2e-test.js';

function parse(r) { return JSON.parse(r.content[0].text); }

// REALISTIC action format: appId top section, '---', M7 header comments, steps.
function seedAction(root, id, params = '') {
  const dir = join(root, '.rn-agent', 'actions');
  mkdirSync(dir, { recursive: true });
  const header = [`# id: ${id}`, '# intent: do a thing', '# status: active', '# appId: com.x'];
  if (params) header.push(`# params: ${params}`);
  writeFileSync(
    join(dir, `${id}.yaml`),
    `appId: com.x\n---\n${header.join('\n')}\n- launchApp\n`,
    'utf8',
  );
}
const okMaestro = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { passed: true, output: 'Flow PASSED' } }) }] });
const failMaestro = async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: false, error: "Element not found: id='x'", meta: { output: "Element not found: id='x'" } }) }], isError: true });
const deps = (maestroRun) => ({
  maestroRun,
  getGitInfo: () => ({ sha: 'sha1', dirty: false }),
  getSession: () => ({ name: 's', platform: 'ios', deviceId: 'udid', appId: 'com.x', openedAt: '' }),
  now: () => new Date('2026-06-18T00:00:00Z'),
});

test('strict pass → freezes an EXECUTABLE locked test (appId preserved)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro)));
    assert.equal(res.ok, true);
    assert.equal(res.data.locked, true);
    const frozen = readFileSync(join(root, '.rn-agent', 'e2e', 'login.yaml'), 'utf8');
    assert.match(frozen, /^appId: com\.x$/m); // BLOCKER-1: executable
    assert.match(frozen, /^---$/m);
    assert.match(frozen, /- launchApp/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('strict fail → refuses, no file written', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(failMaestro)));
    assert.equal(res.ok, false);
    assert.equal(res.code, 'STRICT_RUN_FAILED');
    assert.equal(existsSync(join(root, '.rn-agent', 'e2e', 'login.yaml')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('param-needing action → refused PARAMS_UNSUPPORTED (no maestro run)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login', 'EMAIL');
    let called = false;
    const res = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(async () => { called = true; return okMaestro(); })));
    assert.equal(res.code, 'PARAMS_UNSUPPORTED');
    assert.equal(called, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('already locked → refused unless relock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    seedAction(root, 'login');
    await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro));
    const dup = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root }, deps(okMaestro)));
    assert.equal(dup.code, 'ALREADY_LOCKED');
    const re = parse(await lockE2eTestCore({ actionId: 'login', projectRoot: root, relock: true }, deps(okMaestro)));
    assert.equal(re.ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing action → NOT_FOUND', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lock-'));
  try {
    const res = parse(await lockE2eTestCore({ actionId: 'nope', projectRoot: root }, deps(okMaestro)));
    assert.equal(res.code, 'NOT_FOUND');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
