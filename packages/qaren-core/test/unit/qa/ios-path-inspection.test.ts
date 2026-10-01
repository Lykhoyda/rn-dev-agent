import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  hasUnresolvedIosPathPattern,
  probeIosExternalRunnerStrict,
} from '../../../dist/runners/external-runner-detect.js';

const device = 'AAAAAAAA-1111-2222-3333-BBBBBBBBBBBB';
test('quote-heavy non-path rows remain clear within the scan budget', async (t) => {
  const command = `/usr/local/bin/node -e /maestro.${'x'.repeat(7500)}+${'"'.repeat(7500)}`;
  assert.ok(command.length < 16_384);
  const stdout = Array.from({ length: 64 }, (_, i) => `${20 + i} ${command}\n`).join('');
  assert.ok(Buffer.byteLength(stdout) < 1024 * 1024);
  const scan = (async () => ({ stdout, stderr: '' })) as unknown as typeof execFile;
  const started = performance.now();
  const status = await probeIosExternalRunnerStrict(scan, device);
  const elapsed = performance.now() - started;
  t.diagnostic(`64-row quote-heavy scan: ${elapsed.toFixed(1)}ms`);
  assert.equal(status, 'clear');
  assert.ok(elapsed < 2_000, `quote-heavy scan took ${elapsed.toFixed(1)}ms`);
});

test('shared Rust/TypeScript fixtures retain the original unresolved-path predicate', () => {
  const fixtures: Array<[string, boolean]> = JSON.parse(
    readFileSync(new URL('./ios-path-patterns.json', import.meta.url), 'utf8'),
  );
  const original = (command: string) => {
    const components = command.split('/').slice(1);
    return components.some(
      (component, index) =>
        /^(?:maestro(?:-driver-iosUITests-Runner|\.\w+)?|WebDriverAgent(?:Runner)?(?:-Runner)?|RnFastRunner\S*|XCTRunner|xcodebuild|\S*UITests-?Runner)(?=$|[\s"'])/i.test(
          component,
        ) ||
        (index < components.length - 1 && /(?:UITests-?Runner|XCTRunner)\.app/i.test(component)) ||
        (/(?:^|\s)maestro\.cli\.[\w.$]+(?:\s|$)/i.test(command) &&
          /^java(?=$|[\s"'])/i.test(component)),
    );
  };
  for (const [fixture, expected] of fixtures) {
    for (const prefix of ['', `/bin/node -e ${'x'.repeat(30_001)} `]) {
      const command = prefix + fixture;
      assert.equal(hasUnresolvedIosPathPattern(command), expected, fixture);
      assert.equal(hasUnresolvedIosPathPattern(command), original(command), fixture);
    }
  }
  const fragments = [
    'maestro.',
    'x_1',
    '+',
    '-',
    '"',
    "'",
    ' ',
    '\t',
    '\u00a0',
    '\ufeff',
    'é',
    '/',
    'java',
    ' maestro.cli.AppKt ',
    'UITestsRunner',
    'UITests-Runner',
    'XCTRunner.app',
    'RnFastRunner',
    'WebDriverAgent',
  ];
  let seed = 12345;
  for (let sample = 0; sample < 150_000; sample++) {
    let command = '/tools/maestro.';
    for (let part = 0; part < 8; part++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      command += fragments[seed % fragments.length];
    }
    assert.equal(hasUnresolvedIosPathPattern(command), original(command), command);
  }
});
