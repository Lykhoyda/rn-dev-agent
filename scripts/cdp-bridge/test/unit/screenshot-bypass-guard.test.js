import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { captureAndResizeScreenshot } from '../../dist/tools/device-list.js';

// B121: regression guard. The B120 sips-resize wrapper produced ~46% byte
// savings on direct `device_screenshot` calls, but `device_batch` (4 sites)
// and `proof_step` (1 site) bypassed the wrapper entirely by calling
// runAgentDevice(['screenshot', ...]) directly. This test fails if any new
// caller in scripts/cdp-bridge/src/ reintroduces the bypass.
//
// Allowed: agent-device-wrapper.ts itself (it IS the wrapper) and the
// device-list.ts handler internals (which call buildScreenshotArgs that
// emits ['screenshot', '--out', ...]).

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, '../../src');

const ALLOWED_BYPASS_FILES = new Set([
  'agent-device-wrapper.ts',
  // device-list.ts uses buildScreenshotArgs which produces ['screenshot', '--out', ...]
  // — it's the canonical wrapper, not a bypass.
  'device-list.ts',
]);

const BYPASS_PATTERN = /runAgentDevice\(\s*\[\s*['"]screenshot['"]/;

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}

test('B121: no source file outside the allowlist calls runAgentDevice([\"screenshot\", ...]) directly', () => {
  const bypasses = [];
  for (const file of walk(SRC_DIR)) {
    const basename = file.split('/').pop();
    if (ALLOWED_BYPASS_FILES.has(basename)) continue;
    const content = readFileSync(file, 'utf8');
    if (BYPASS_PATTERN.test(content)) {
      bypasses.push(file.replace(SRC_DIR + '/', ''));
    }
  }
  assert.deepEqual(
    bypasses,
    [],
    `Found bypass(es) of B120 resize wrapper. Use captureAndResizeScreenshot from './device-list.js' instead. Bypass sites: ${bypasses.join(', ')}`,
  );
});

test('captureAndResizeScreenshot is exported from device-list', () => {
  assert.equal(typeof captureAndResizeScreenshot, 'function');
});
