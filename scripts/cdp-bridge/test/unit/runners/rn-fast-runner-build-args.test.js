import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunnerXcodebuildArgs } from '../../../dist/runners/rn-fast-runner-client.js';

const BASE = {
  projectPath: '/p/RnFastRunner.xcodeproj',
  scheme: 'RnFastRunner',
  deviceId: 'UDID-123',
  derivedDataPath: '/p/build/DerivedData',
  onlyTesting: 'RnFastRunnerUITests/RnFastRunnerTests/testCommand',
};

test('uses test-without-building when the test product is already built', () => {
  const args = resolveRunnerXcodebuildArgs({ ...BASE, hasBuiltTestProduct: true });
  assert.equal(args[0], 'test-without-building');
  assert.ok(args.includes('-project'));
  assert.ok(args.includes('/p/RnFastRunner.xcodeproj'));
  assert.ok(args.includes('-destination'));
  assert.ok(args.includes('platform=iOS Simulator,id=UDID-123'));
  assert.ok(args.includes('-derivedDataPath'));
  assert.ok(args.includes('/p/build/DerivedData'));
  assert.ok(args.includes('-only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand'));
});

test('falls back to a cold build+test when no test product exists yet (fresh machine)', () => {
  const args = resolveRunnerXcodebuildArgs({ ...BASE, hasBuiltTestProduct: false });
  assert.equal(args[0], 'test');
  assert.ok(!args.includes('test-without-building'), 'must not use test-without-building without artifacts');
  assert.ok(args.includes('-project'));
  assert.ok(args.includes('-scheme'));
  assert.ok(args.includes('RnFastRunner'));
  assert.ok(args.includes('-destination'));
  assert.ok(args.includes('-only-testing:RnFastRunnerUITests/RnFastRunnerTests/testCommand'));
});
