import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const supervisor = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/supervisor.js');

test('GH #628: cdp_record_test_generate publishes the optional entry enum', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'rn-agent-gh628-schema-'));
  await writeFile(join(projectRoot, 'package.json'), '{"name":"fixture"}\n');
  let harness: ReturnType<typeof startSupervisor> | null = null;
  try {
    harness = startSupervisor({
      supervisorPath: supervisor,
      cwd: projectRoot,
      args: ['--diagnostic-contract-probe'],
      env: { HOME: projectRoot },
    });
    harness.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'gh-628-test', version: '1' },
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
        properties?: Record<string, { enum?: string[] }>;
      };
    }>;
    const generate = tools.find((tool) => tool.name === 'cdp_record_test_generate');
    assert.ok(generate);
    assert.deepEqual(generate.inputSchema.properties?.entry?.enum, ['cold', 'parked']);
    assert.ok(!(generate.inputSchema.required ?? []).includes('entry'));

    harness.child.stdin.end();
    await new Promise((resolveExit) => harness!.child.on('exit', resolveExit));
    harness = null;
  } finally {
    if (harness) harness.child.kill('SIGKILL');
    await rm(projectRoot, { recursive: true, force: true });
  }
});
