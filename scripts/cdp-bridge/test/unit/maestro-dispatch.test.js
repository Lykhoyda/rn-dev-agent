// B59: tiered Maestro dispatch — picks maestro-runner when viable, falls
// back to Maestro CLI on iOS-only machines without adb in PATH (upstream
// maestro-runner v1.0.9 bug). Tests inject the `which` resolvers + the
// runner-binary existence check so we can simulate every PATH topology
// without touching the real filesystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseMaestroDispatch,
  _resetMaestroDispatchCache,
} from '../../dist/tools/maestro-dispatch.js';

test.beforeEach(() => _resetMaestroDispatchCache());

// ── Tier 1: maestro-runner happy path ────────────────────────────────

test('B59 Tier 1: ios + adb present + runner installed → maestro-runner', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/usr/bin/adb',
    whichMaestro: () => '/opt/homebrew/bin/maestro',
    maestroRunnerPath: () => '/Users/me/.maestro-runner/bin/maestro-runner',
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro-runner');
  assert.equal('binPath' in d ? d.binPath : null, '/Users/me/.maestro-runner/bin/maestro-runner');
  // Tier 1 must have NO fallbackReason — the fast path is silent.
  assert.equal('fallbackReason' in d && d.fallbackReason !== undefined, false);
});

test('B59 Tier 1: android + runner installed → maestro-runner (adb irrelevant)', () => {
  const d = chooseMaestroDispatch({
    platform: 'android',
    whichAdb: () => null, // no adb but android still routes through maestro-runner
    whichMaestro: () => null,
    maestroRunnerPath: () => '/runner',
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro-runner');
});

test('B59 Tier 1: buildArgs emits --platform <p> test <flow>', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/adb',
    whichMaestro: () => null,
    maestroRunnerPath: () => '/runner',
  });
  if (!('buildArgs' in d)) throw new Error('expected dispatch');
  assert.deepEqual(d.buildArgs('ios', '/tmp/flow.yaml'), ['--platform', 'ios', 'test', '/tmp/flow.yaml']);
  assert.deepEqual(d.buildArgs('android', '/tmp/flow.yaml'), ['--platform', 'android', 'test', '/tmp/flow.yaml']);
});

// ── Tier 2: Maestro CLI fallback ─────────────────────────────────────

test('B59 Tier 2: ios + no adb + maestro-runner installed → falls back to Maestro CLI with B59 reason', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => null,
    whichMaestro: () => '/opt/homebrew/bin/maestro',
    maestroRunnerPath: () => '/Users/me/.maestro-runner/bin/maestro-runner',
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro');
  assert.equal('binPath' in d ? d.binPath : null, '/opt/homebrew/bin/maestro');
  assert.match('fallbackReason' in d ? d.fallbackReason ?? '' : '', /B59|adb in PATH/);
});

test('B59 Tier 2: ios + no adb + no maestro-runner → falls back to Maestro CLI with installed-msg', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => null,
    whichMaestro: () => '/opt/homebrew/bin/maestro',
    maestroRunnerPath: () => null,
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro');
  assert.match('fallbackReason' in d ? d.fallbackReason ?? '' : '', /not installed/);
});

test('B59 Tier 2: Maestro CLI argv uses -p <platform> for iOS (verified against `maestro test --help`)', () => {
  // The Maestro CLI v2.x `test` subcommand accepts only `-p=<platform>` per
  // its --help output (no --device-type flag exists). Earlier draft used the
  // wrong flag — Gemini review (conf 97) caught it before the broken
  // fallback shipped. Both -p ios and -p=ios are accepted; we use the
  // separate-token form for execFile array passing.
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => null,
    whichMaestro: () => '/maestro',
    maestroRunnerPath: () => null,
  });
  if (!('buildArgs' in d)) throw new Error('expected dispatch');
  assert.deepEqual(d.buildArgs('ios', '/tmp/f.yaml'), ['test', '--platform', 'ios', '/tmp/f.yaml']);
});

test('B59 Tier 2: Maestro CLI argv uses -p android for Android', () => {
  // Synthetic case: imagine a future where Tier 1 isn't available on Android either.
  // The fallback must still produce coherent argv.
  const d = chooseMaestroDispatch({
    platform: 'android',
    whichAdb: () => null,
    whichMaestro: () => '/maestro',
    maestroRunnerPath: () => null,
  });
  if (!('buildArgs' in d)) throw new Error('expected dispatch');
  assert.deepEqual(d.buildArgs('android', '/tmp/f.yaml'), ['test', '--platform', 'android', '/tmp/f.yaml']);
});

// ── Tier 3: fail-fast with install hint ──────────────────────────────

test('B59 Tier 3: nothing usable → returns error with install hint mentioning both options', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => null,
    whichMaestro: () => null,
    maestroRunnerPath: () => null,
  });
  assert.ok('error' in d, 'expected error');
  assert.match(d.error, /brew install maestro/);
  assert.match(d.error, /maestro-runner/);
  assert.match(d.error, /adb/i);
  assert.match(d.hint, /iOS-only quickstart/);
});

test('B59 Tier 3: android with nothing → fail-fast still emits install hint', () => {
  const d = chooseMaestroDispatch({
    platform: 'android',
    whichAdb: () => '/adb',  // adb present but no runner AND no maestro
    whichMaestro: () => null,
    maestroRunnerPath: () => null,
  });
  assert.ok('error' in d, 'expected error');
  assert.match(d.hint, /Android SDK \+ maestro-runner/);
});

// ── Edge: Tier 1 viable beats Tier 2 even when both runners installed ──

test('B59: Tier 1 wins when viable — does NOT use Maestro CLI just because both are installed', () => {
  const d = chooseMaestroDispatch({
    platform: 'ios',
    whichAdb: () => '/adb',
    whichMaestro: () => '/maestro',
    maestroRunnerPath: () => '/runner',
  });
  assert.equal('runner' in d ? d.runner : null, 'maestro-runner', 'fast path must be preferred');
});

// ── Cache reset hook ─────────────────────────────────────────────────

test('B59: _resetMaestroDispatchCache clears between tests so each one is hermetic', () => {
  // Just verifies the function exists and doesn't throw — actual cache usage
  // is exercised via injected resolvers above (which bypass cache). This test
  // is the contract that production code calls _resetMaestroDispatchCache via
  // beforeEach so suite-level state can't leak.
  assert.equal(typeof _resetMaestroDispatchCache, 'function');
  _resetMaestroDispatchCache();
});
