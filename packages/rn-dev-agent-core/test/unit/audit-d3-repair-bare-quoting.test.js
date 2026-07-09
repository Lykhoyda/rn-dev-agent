import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { replaceIdSelector } from '../../dist/domain/repair-engine.js';

// Audit D3: a bare-form `id:` repair wrote the new id unquoted. isSafeMaestroScalar
// permits `:`, `{`, `#`, `"`, so a testID like `button: submit` produced invalid
// YAML that broke the action permanently. The bare form must emit a quoted scalar.

function idOf(body) {
  // Parse the repaired single-step flow and pull the tapOn id back out.
  const doc = parseYaml(body);
  return doc[0].tapOn.id;
}

test('D3: a colon-bearing new id is quoted so the YAML stays valid', () => {
  const body = '- tapOn:\n    id: old-btn';
  const { body: out, replacements } = replaceIdSelector(body, 'old-btn', 'button: submit');
  assert.equal(replacements, 1);
  assert.doesNotThrow(() => parseYaml(out), 'repaired YAML must still parse');
  assert.equal(idOf(out), 'button: submit', 'the id round-trips exactly');
});

test('D3: a brace/hash new id is quoted', () => {
  const body = '- tapOn:\n    id: old';
  const { body: out } = replaceIdSelector(body, 'old', '{fab}#1');
  assert.doesNotThrow(() => parseYaml(out));
  assert.equal(idOf(out), '{fab}#1');
});

test('D3: a plain new id from a bare source is still emitted (now quoted, same meaning)', () => {
  const body = '- tapOn:\n    id: old';
  const { body: out } = replaceIdSelector(body, 'old', 'new-btn');
  assert.equal(idOf(out), 'new-btn');
});

test('D3: a new id containing a double-quote uses single quotes (matched-quote grammar)', () => {
  const body = '- tapOn:\n    id: old';
  const { body: out } = replaceIdSelector(body, 'old', 'say-"hi"');
  assert.doesNotThrow(() => parseYaml(out));
  assert.equal(idOf(out), 'say-"hi"');
});
