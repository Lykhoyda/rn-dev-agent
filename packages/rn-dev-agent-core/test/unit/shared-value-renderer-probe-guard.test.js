import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// B133 / M8 regression guard. M8 (D663) replaced renderers.keys() in the
// single-active-renderer readiness path with a numeric getFiberRoots probe;
// B133 (D664) ported that fix into index.ts::cdp_set_shared_value. GH #597
// routes all registry enumeration through getRegisteredRendererIds (which
// isolates malformed/overflowing iterators), with the M8 numeric probe
// retained as fallback when the registry is empty or malformed. Direct
// renderers.keys() access stays confined to that single helper.

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../../src');

function* walkTs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkTs(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

test('B133 + GH #597: renderers.keys is limited to the all-roots iterator', () => {
  const violations = [];
  for (const file of walkTs(SRC_DIR)) {
    const content = readFileSync(file, 'utf8');
    if (
      /hook\.renderers\.keys\s*\(/.test(content) &&
      relative(SRC_DIR, file) !== 'injected-helpers.ts'
    ) {
      violations.push(relative(SRC_DIR, file));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Files using renderers.keys() outside the GH #597 all-roots iterator: ${violations.join(', ')}`,
  );

  const injected = readFileSync(join(SRC_DIR, 'injected-helpers.ts'), 'utf8');
  const findActive = injected.split('function findActiveRenderer')[1]?.split('function ')[0] ?? '';
  assert.doesNotMatch(
    findActive,
    /renderers\.keys\s*\(/,
    'findActiveRenderer must not touch renderers.keys() directly — registry access goes through getRegisteredRendererIds',
  );
  assert.match(
    findActive,
    /getRegisteredRendererIds\(hook\)/,
    'findActiveRenderer must union registered renderer IDs with the numeric probe (GH #597)',
  );
  assert.match(
    findActive,
    /fallbackId <= MAX_RENDERER_IDS/,
    'findActiveRenderer must retain the numeric probe for empty renderer registries',
  );
  assert.match(
    injected,
    /function getRegisteredRendererIds\(hook\)/,
    'the intentional GH #597 registry enumeration helper is missing',
  );
});

test('B133: cdp_set_shared_value uses the 1..5 getFiberRoots probe pattern', () => {
  const content = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
  assert.match(
    content,
    /for \(var i = 1; i <= 5; i\+\+\) \{\s*\n\s*var r = hook\.getFiberRoots\(i\);/,
    'cdp_set_shared_value expression should use the 1..5 probe pattern after B133 fix',
  );
});

test('B133: cdp_set_shared_value guards on typeof hook.getFiberRoots === "function"', () => {
  const content = readFileSync(join(SRC_DIR, 'index.ts'), 'utf8');
  assert.match(
    content,
    /typeof hook\.getFiberRoots !== 'function'/,
    'cdp_set_shared_value should guard on getFiberRoots being a function (matches findActiveRenderer and REACT_READY_PROBE_JS)',
  );
});
