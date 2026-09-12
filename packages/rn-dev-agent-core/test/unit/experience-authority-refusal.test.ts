import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  AUTHORITY_REFUSAL_CODES,
  authorityRefusalFacts,
  authorityRefusalFamily,
  authorityRefusalSystemicKey,
  mergeAuthorityRefusalFacts,
} from '../../dist/experience/authority-refusal.js';
import {
  decodeAuthorityRefusal,
  MAX_AUTHORITY_ENVELOPE_BYTES,
} from '../../dist/experience/evidence.js';
import type { ToolObserverInput } from '../../dist/observability/instrumentation.js';

function event(result: unknown, error?: string): ToolObserverInput {
  return { tool: 'rn_session', params: {}, status: 'FAIL', latencyMs: 0, result, error };
}

const code = 'METRO_ORIGIN_MISMATCH';
const facts = { code, axis: 'M', cause: null } as const;
const content = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });

for (const code of AUTHORITY_REFUSAL_CODES) {
  test(`${code}: direct, first-content, and anchored thrown observations`, () => {
    const envelope = { code, error: 'redbox not connected', meta: { axis: 'M', cause: 'private' } };
    for (const result of [envelope, content(envelope)]) {
      assert.deepEqual(decodeAuthorityRefusal(event(result)), { code, axis: 'M', cause: null });
    }
    assert.deepEqual(
      decodeAuthorityRefusal({ ...event(undefined, `${code}: redbox`), status: 'ERROR' }),
      {
        code,
        axis: null,
        cause: null,
      },
    );
    assert.equal(authorityRefusalFamily(code), `FF_${code}`);
    for (const prefix of ['Error: ', ' ', 'nested ', '\n    at ']) {
      assert.equal(
        decodeAuthorityRefusal({
          ...event(undefined, `${prefix}${code}: failure`),
          status: 'ERROR',
        }),
        null,
      );
    }
    assert.equal(decodeAuthorityRefusal(event(undefined, `${code}: not thrown`)), null);
    assert.equal(decodeAuthorityRefusal({ ...event(envelope), status: 'PASS' }), null);
  });
}

test('structured code wins over other envelopes, thrown prefixes, and conflicting prose', () => {
  assert.deepEqual(
    decodeAuthorityRefusal(
      event(
        {
          code,
          meta: { axis: 'M' },
          ...content({ code: 'SESSION_AUTHORITY_REQUIRED', meta: { axis: 'S' } }),
        },
        'SESSION_AUTHORITY_REQUIRED: redbox',
      ),
    ),
    facts,
  );
  for (const unknown of ['FUTURE_AUTHORITY_CODE', '', null, 42, {}, ['METRO_ORIGIN_MISMATCH']]) {
    for (const result of [
      { code: unknown, ...content({ code }) },
      content({ code: unknown, error: `${code}: failure` }),
    ]) {
      assert.equal(
        decodeAuthorityRefusal({ ...event(result, `${code}: failure`), status: 'ERROR' }),
        null,
      );
    }
  }
});

test('only fixed envelope fields and the first content item are eligible', () => {
  for (const result of [
    { meta: { code } },
    { content: [{ text: '{}' }, { text: JSON.stringify({ code }) }] },
    { content: [{ text: '{invalid' }, { text: JSON.stringify({ code }) }] },
    content([{ code }]),
    content(null),
    content(42),
    content(code),
    [{ code }],
    { content: [{ text: JSON.stringify(content({ code })) }] },
  ])
    assert.equal(decodeAuthorityRefusal(event(result)), null);
  assert.deepEqual(
    decodeAuthorityRefusal(event({ code, details: { axis: 'M', cause: 'private' } })),
    {
      code,
      axis: null,
      cause: null,
    },
  );
});

test('JSON parsing is bounded by UTF-8 bytes including the exact 16 KiB boundary', () => {
  const base = JSON.stringify({ code, padding: '' });
  const exact = JSON.stringify({
    code,
    padding: ' '.repeat(MAX_AUTHORITY_ENVELOPE_BYTES - Buffer.byteLength(base)),
  });
  assert.equal(Buffer.byteLength(exact), 16 * 1024);
  assert.deepEqual(decodeAuthorityRefusal(event({ content: [{ text: exact }] })), {
    code,
    axis: null,
    cause: null,
  });
  for (const text of [exact + ' ', JSON.stringify({ code, padding: '\u00e9'.repeat(9000) })]) {
    assert.equal(decodeAuthorityRefusal(event({ content: [{ text }] })), null);
  }
});

test('axes are observed, never inferred, and no code admits a cause yet', () => {
  for (const code of AUTHORITY_REFUSAL_CODES) {
    for (const axis of ['C', 'S', 'I', 'M', 'A', 'B', 'D', 'R', 'P']) {
      assert.deepEqual(authorityRefusalFacts(code, axis, 'managed-metro-stop-proof-missing'), {
        code,
        axis,
        cause: null,
      });
    }
    for (const axis of [undefined, null, 'm', '', 'Metro', 1, {}, ['M']]) {
      for (const cause of [
        undefined,
        null,
        'private remedy',
        'managed-metro-stop-proof-missing',
        {},
      ]) {
        assert.deepEqual(authorityRefusalFacts(code, axis, cause), {
          code,
          axis: null,
          cause: null,
        });
      }
    }
  }
});

test('systemic identity is a versioned tuple with explicit unknown slots', () => {
  const expected = createHash('sha256')
    .update(JSON.stringify(['rn-dev-agent/authority-refusal/1', code, 'M', null, 'ios']))
    .digest('hex');
  assert.equal(authorityRefusalSystemicKey(facts, 'ios'), expected);
  for (const other of [
    authorityRefusalSystemicKey(facts, null),
    authorityRefusalSystemicKey(facts, 'android'),
    authorityRefusalSystemicKey({ ...facts, axis: null }, 'ios'),
    authorityRefusalSystemicKey({ ...facts, code: 'SESSION_AUTHORITY_REQUIRED' }, 'ios'),
  ])
    assert.notEqual(other, expected);
  assert.notEqual(
    authorityRefusalSystemicKey(facts, null),
    authorityRefusalSystemicKey(facts, 'unknown'),
  );
});

test('common metadata stays unknown after missing or conflicting observations', () => {
  assert.deepEqual(mergeAuthorityRefusalFacts(facts, facts), facts);
  for (const previous of [undefined, { ...facts, axis: null }, { ...facts, axis: 'S' as const }]) {
    const merged = mergeAuthorityRefusalFacts(previous, facts);
    assert.deepEqual(merged, { code, axis: null, cause: null });
    assert.deepEqual(mergeAuthorityRefusalFacts(merged, facts), merged);
  }
});
