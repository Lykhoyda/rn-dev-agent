import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadE2eConfig,
  resolveParams,
  secretValuesFor,
  redactSecrets,
} from '../../dist/domain/e2e-config.js';

// ── loadE2eConfig ──────────────────────────────────────────────────────────

test('loadE2eConfig: missing file → {}', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2ecfg-'));
  try {
    assert.deepEqual(loadE2eConfig(root), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadE2eConfig: corrupt JSON → {}', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2ecfg-'));
  try {
    const dir = join(root, '.rn-agent');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'e2e.config.json'), '{not valid json', 'utf8');
    assert.deepEqual(loadE2eConfig(root), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('loadE2eConfig: valid file → parsed config', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2ecfg-'));
  try {
    const dir = join(root, '.rn-agent');
    mkdirSync(dir, { recursive: true });
    const cfg = {
      defaults: { params: { EMAIL: 'test@example.com' } },
      tests: { login: { params: { TITLE: 'Ship demo' } } },
      secretParams: ['PASSWORD'],
    };
    writeFileSync(join(dir, 'e2e.config.json'), JSON.stringify(cfg), 'utf8');
    assert.deepEqual(loadE2eConfig(root), cfg);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── resolveParams ──────────────────────────────────────────────────────────

test('resolveParams: no required params → ok with empty', () => {
  const result = resolveParams({}, 'login', []);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.params, {});
});

test('resolveParams: defaults only cover required → ok', () => {
  const config = { defaults: { params: { EMAIL: 'a@b.com' } } };
  const result = resolveParams(config, 'login', ['EMAIL']);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.params['EMAIL'], 'a@b.com');
});

test('resolveParams: test-level params override defaults', () => {
  const config = {
    defaults: { params: { EMAIL: 'default@b.com', TITLE: 'Default' } },
    tests: { login: { params: { EMAIL: 'override@b.com' } } },
  };
  const result = resolveParams(config, 'login', ['EMAIL', 'TITLE']);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.params['EMAIL'], 'override@b.com');
    assert.equal(result.params['TITLE'], 'Default');
  }
});

test('resolveParams: absent param → missing', () => {
  const result = resolveParams({}, 'login', ['EMAIL']);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, ['EMAIL']);
});

test('resolveParams: empty-string param → missing', () => {
  const config = { defaults: { params: { EMAIL: '' } } };
  const result = resolveParams(config, 'login', ['EMAIL']);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.missing, ['EMAIL']);
});

test('resolveParams: partial coverage → lists all missing', () => {
  const config = { defaults: { params: { EMAIL: 'a@b.com' } } };
  const result = resolveParams(config, 'login', ['EMAIL', 'PASSWORD', 'TOKEN']);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.ok(result.missing.includes('PASSWORD'));
    assert.ok(result.missing.includes('TOKEN'));
    assert.ok(!result.missing.includes('EMAIL'));
  }
});

// ── secretValuesFor ────────────────────────────────────────────────────────

test('secretValuesFor: no secretParams → empty list', () => {
  const config = {};
  const params = { EMAIL: 'a@b.com', PASSWORD: 'secret' };
  assert.deepEqual(secretValuesFor(config, params), []);
});

test('secretValuesFor: picks only values of secret-named non-empty params', () => {
  const config = { secretParams: ['PASSWORD', 'TOKEN'] };
  const params = { EMAIL: 'a@b.com', PASSWORD: 'my-secret', TOKEN: '' };
  const vals = secretValuesFor(config, params);
  assert.ok(vals.includes('my-secret'), 'should include PASSWORD value');
  assert.ok(!vals.includes('a@b.com'), 'should not include EMAIL value');
  assert.ok(!vals.includes(''), 'should not include empty TOKEN value');
});

test('secretValuesFor: empty params → empty list', () => {
  const config = { secretParams: ['PASSWORD'] };
  assert.deepEqual(secretValuesFor(config, {}), []);
});

// ── redactSecrets ──────────────────────────────────────────────────────────

test('redactSecrets: no-op on empty secret list', () => {
  assert.equal(redactSecrets('some output with stuff', []), 'some output with stuff');
});

test('redactSecrets: replaces all occurrences of each secret', () => {
  const text = 'password=abc123 and again abc123 end';
  assert.equal(redactSecrets(text, ['abc123']), 'password=*** and again *** end');
});

test('redactSecrets: multiple secrets all redacted', () => {
  const text = 'tok=T1 pass=P2';
  assert.equal(redactSecrets(text, ['T1', 'P2']), 'tok=*** pass=***');
});

test('redactSecrets: non-secret text unchanged', () => {
  const text = 'no secrets here';
  assert.equal(redactSecrets(text, ['abc123']), 'no secrets here');
});

test('redactSecrets: guards against empty-string secret value (no infinite loop)', () => {
  const text = 'hello world';
  assert.equal(redactSecrets(text, ['', 'world']), 'hello ***');
});
