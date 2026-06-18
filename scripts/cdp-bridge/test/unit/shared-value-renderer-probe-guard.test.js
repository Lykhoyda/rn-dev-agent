import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// B133 / M8 regression guard. M8 (D663) replaced the `hook.renderers.keys()`
// pattern in injected-helpers.ts::findActiveRenderer with a 1..5 getFiberRoots
// probe. B133 (D664) ported the same fix into index.ts::cdp_set_shared_value.
// This test fails if any new source file reintroduces the stale pattern —
// which would silently break apps where `__REACT_DEVTOOLS_GLOBAL_HOOK__.renderers`
// is empty or missing (React Native macros, Reanimated worklets, early render).

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

test('B133: no src file uses stale hook.renderers.keys pattern', () => {
  const violations = [];
  for (const file of walkTs(SRC_DIR)) {
    const content = readFileSync(file, 'utf8');
    if (/hook\.renderers\.keys\s*\(/.test(content)) {
      violations.push(relative(SRC_DIR, file));
    }
  }
  assert.deepEqual(
    violations,
    [],
    `Files using stale hook.renderers.keys() pattern — use 1..5 getFiberRoots probe (see injected-helpers.ts::findActiveRenderer or REACT_READY_PROBE_JS). Violations: ${violations.join(', ')}`,
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
