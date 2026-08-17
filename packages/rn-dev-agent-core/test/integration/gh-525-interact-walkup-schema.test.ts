// GH#525 finding 2: walkUp must be reachable through the registered
// cdp_interact MCP schema as an OPTIONAL boolean. Asserted against the real
// server: tools/list reports the published input schema, and tools/call
// exercises argument validation (a non-boolean walkUp must be rejected before
// the handler runs, while omitting it must reach the handler).
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const supervisor = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/supervisor.js');

test(
  'GH-525 cdp_interact publishes walkUp as an optional boolean',
  { timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'rn-agent-gh525-home-'));
    await writeFile(join(home, 'package.json'), '{"name":"fixture"}\n');
    let harness: ReturnType<typeof startSupervisor> | null = null;
    try {
      harness = startSupervisor({
        supervisorPath: supervisor,
        cwd: home,
        args: ['--diagnostic-contract-probe'],
        env: { HOME: home },
      });
      harness.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gh-525-test', version: '1' },
      });
      await harness.nextLine();
      harness.notify('notifications/initialized');

      const listId = harness.send('tools/list');
      const list = JSON.parse(await harness.nextLine());
      assert.equal(list.id, listId);
      const tools = list.result.tools as Array<{
        name: string;
        inputSchema: {
          required?: string[];
          properties?: Record<string, { type?: string }>;
        };
      }>;
      const interact = tools.find((tool) => tool.name === 'cdp_interact');
      assert.ok(interact, 'cdp_interact must be registered');
      assert.equal(interact.inputSchema.properties?.walkUp?.type, 'boolean');
      assert.ok(
        !(interact.inputSchema.required ?? []).includes('walkUp'),
        'walkUp must stay optional',
      );

      const badId = harness.send('tools/call', {
        name: 'cdp_interact',
        arguments: { action: 'press', testID: 'card', walkUp: 'yes' },
      });
      const bad = JSON.parse(await harness.nextLine());
      assert.equal(bad.id, badId);
      const badText = JSON.stringify(bad);
      assert.match(badText, /walkUp/, 'a non-boolean walkUp must be rejected by validation');
      assert.doesNotMatch(
        badText,
        /DIAGNOSTIC_MODE_READ_ONLY/,
        'validation must refuse before the handler runs',
      );

      const okId = harness.send('tools/call', {
        name: 'cdp_interact',
        arguments: { action: 'press', testID: 'card' },
      });
      const ok = JSON.parse(await harness.nextLine());
      assert.equal(ok.id, okId);
      assert.match(
        JSON.stringify(ok),
        /DIAGNOSTIC_MODE_READ_ONLY/,
        'omitting walkUp must pass validation and reach the handler',
      );

      harness.child.stdin.end();
      await new Promise((resolveExit) => harness!.child.on('exit', resolveExit));
      harness = null;
    } finally {
      if (harness) harness.child.kill('SIGKILL');
      await rm(home, { recursive: true, force: true });
    }
  },
);
