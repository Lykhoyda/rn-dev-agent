import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const supervisor = resolve(dirname(fileURLToPath(import.meta.url)), '../../dist/supervisor.js');
const proofActions = [
  'begin_rehearsal',
  'finish_rehearsal',
  'arm',
  'start_recording',
  'stop_recording',
  'validate',
  'finalize',
  'status',
  'discard',
  'contract',
].sort();

async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const absolute = join(current, entry.name);
      const relative = join(prefix, entry.name);
      const info = await stat(absolute);
      if (entry.isDirectory()) {
        result[`${relative}/`] = `${info.mode}:${info.mtimeMs}`;
        await walk(absolute, relative);
      } else {
        result[relative] =
          `${info.mode}:${info.mtimeMs}:${(await readFile(absolute)).toString('base64')}`;
      }
    }
  };
  await walk(path, '.');
  return result;
}

test(
  'GH-575 diagnostic contract mode lists schemas and performs no persistent cleanup',
  { timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'rn-agent-gh575-home-'));
    const project = join(home, 'project');
    const daemon = join(home, '.agent-device');
    const requests = join(project, '.rn-agent', 'e2e', 'runs', 'requests');
    await mkdir(daemon, { recursive: true });
    await mkdir(requests, { recursive: true });
    await writeFile(join(project, 'package.json'), '{"name":"fixture"}\n');
    await writeFile(join(daemon, 'daemon.json'), '{"pid":99999999}\n');
    await writeFile(join(daemon, 'daemon.lock'), 'canary\n');
    await writeFile(
      join(requests, 'stale.json'),
      JSON.stringify({
        runId: 'stale',
        status: 'running',
        pid: 99999999,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const before = await snapshot(home);
    const foreign = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    let harness: ReturnType<typeof startSupervisor> | null = null;
    try {
      harness = startSupervisor({
        supervisorPath: supervisor,
        cwd: project,
        args: ['--diagnostic-contract-probe'],
        env: {
          HOME: home,
          LOG_LEVEL: 'debug',
          CLAUDE_PLUGIN_DATA: join(home, 'plugin-data'),
          RN_AGENT_OBSERVE_AUTOSTART: '1',
        },
      });
      const initId = harness.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'gh-575-test', version: '1' },
      });
      const init = JSON.parse(await harness.nextLine());
      assert.equal(init.id, initId);
      harness.notify('notifications/initialized');

      const listId = harness.send('tools/list');
      const list = JSON.parse(await harness.nextLine());
      assert.equal(list.id, listId);
      const tools = list.result.tools as Array<{
        name: string;
        inputSchema: {
          type?: string;
          required?: string[];
          properties?: { action?: { enum?: string[] } };
        };
      }>;
      assert.equal(tools.length, 80);
      const proof = tools.find((tool) => tool.name === 'proof_capture');
      assert.ok(proof);
      assert.equal(proof.inputSchema.type, 'object');
      assert.ok(proof.inputSchema.required?.includes('action'));
      assert.deepEqual(
        [...(proof.inputSchema.properties?.action?.enum ?? [])].sort(),
        proofActions,
      );

      const callId = harness.send('tools/call', {
        name: 'observe',
        arguments: { action: 'start' },
      });
      const call = JSON.parse(await harness.nextLine());
      assert.equal(call.id, callId);
      const envelope = JSON.parse(call.result.content[0].text);
      assert.equal(envelope.ok, false);
      assert.equal(envelope.code, 'DIAGNOSTIC_MODE_READ_ONLY');

      harness.child.stdin.end();
      const exit = await new Promise<number | null>((resolveExit) =>
        harness!.child.on('exit', resolveExit),
      );
      assert.equal(exit, 0);
      harness = null;

      assert.equal(foreign.exitCode, null, 'foreign canary process must remain alive');
      assert.equal(
        existsSync(join(home, 'plugin-data')),
        false,
        'debug logging must not create plugin data',
      );
      assert.deepEqual(await snapshot(home), before);
    } finally {
      if (harness) harness.child.kill('SIGKILL');
      foreign.kill('SIGKILL');
      await rm(home, { recursive: true, force: true });
    }
  },
);
