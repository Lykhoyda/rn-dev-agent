#!/usr/bin/env node
// Regenerates test/fixtures/tool-registry.json — the committed golden of the
// MCP tool surface asserted by packaged-artifact-smoke.test.js (GH #432).
// Deliberate friction, same philosophy as require-changeset.sh: adding,
// removing, or renaming a tool means running this, reviewing the diff, and
// committing. Run from the repo root AFTER a build:
//   (cd scripts/cdp-bridge && npm run build) && node scripts/update-tool-registry.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { startSupervisor } from './cdp-bridge/test/helpers/supervisor-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(here, 'cdp-bridge');
const GOLDEN = resolve(BRIDGE, 'test/fixtures/tool-registry.json');

const s = startSupervisor({ supervisorPath: resolve(BRIDGE, 'dist/supervisor.js') });
try {
  const initId = s.send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'update-tool-registry', version: '0.0.0' },
  });
  const init = JSON.parse(await s.nextLine());
  if (init.id !== initId || !init.result)
    throw new Error(`initialize failed: ${JSON.stringify(init)}`);
  s.notify('notifications/initialized');
  s.send('tools/list');
  const list = JSON.parse(await s.nextLine());
  const names = (list.result?.tools ?? []).map((t) => t.name).sort();
  if (names.length === 0)
    throw new Error('tools/list returned zero tools — refusing to write an empty golden');
  writeFileSync(GOLDEN, JSON.stringify(names, null, 2) + '\n');
  console.log(`wrote ${names.length} tool names to ${GOLDEN}`);
} finally {
  s.child.kill('SIGTERM');
}
