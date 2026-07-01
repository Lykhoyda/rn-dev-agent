import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKeyboardGuard } from '../../dist/runners/keyboard-guard.js';

test('defaults ON when unset', () => assert.equal(resolveKeyboardGuard({}), true));

test('OFF for 0/false (case/space-insensitive)', () => {
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: '0' }), false);
  assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: ' False ' }), false);
});

test('ON for any other value', () => assert.equal(resolveKeyboardGuard({ RN_KEYBOARD_GUARD: 'yes' }), true));
