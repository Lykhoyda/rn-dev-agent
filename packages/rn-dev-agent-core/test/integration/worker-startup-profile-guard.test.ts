// L2: the worker wires assertAuthorityProfilesExhaustive into startup, so an
// unprofiled registered tool must kill the boot before any request is served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startSupervisor } from '../helpers/supervisor-harness.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BRIDGE = resolve(__dirname, '../..');

async function stageWorker() {
  // Staged under the gitignored test-results/ so the copied dist resolves its
  // dependencies through the same node_modules chain as the real dist.
  await mkdir(join(BRIDGE, 'test-results'), { recursive: true });
  const tmp = await mkdtemp(join(BRIDGE, 'test-results', 'profile-guard-'));
  await cp(resolve(BRIDGE, 'dist'), join(tmp, 'dist'), { recursive: true });
  await cp(resolve(BRIDGE, 'package.json'), join(tmp, 'package.json'));
  return tmp;
}

function startWorker(tmp: string) {
  return startSupervisor({
    supervisorPath: join(tmp, 'dist/index.js'),
    cwd: tmp,
    noLock: false,
    env: {
      RN_DEV_AGENT_DECLARED_ROOT: tmp,
      RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
    },
    lineTimeoutMs: 30_000,
  });
}

test(
  'worker startup serves requests once the profile exhaustiveness guard passes',
  { timeout: 120_000 },
  async () => {
    const tmp = await stageWorker();
    let s: ReturnType<typeof startSupervisor> | null = null;
    try {
      s = startWorker(tmp);
      const initId = s.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'profile-guard', version: '0.0.0' },
      });
      const init = JSON.parse(await s.nextLine());
      assert.equal(init.id, initId);
      assert.ok(init.result?.serverInfo?.name, `no serverInfo in ${JSON.stringify(init)}`);
      s.child.kill('SIGTERM');
      s = null;
    } finally {
      if (s) s.child.kill('SIGKILL');
      await rm(tmp, { recursive: true, force: true });
    }
  },
);

test(
  'worker startup fails closed before serving when a registered tool lacks a profile',
  { timeout: 120_000 },
  async () => {
    const tmp = await stageWorker();
    // The registration surface is untouched; deleting one profile entry from the
    // staged copy makes `observe` a registered-but-unprofiled tool at boot.
    await appendFile(join(tmp, 'dist/session/tool-profiles.js'), "\nprofiles.delete('observe');\n");
    let s: ReturnType<typeof startSupervisor> | null = null;
    try {
      s = startWorker(tmp);
      const exitCode = new Promise<number | null>((resolveExit) => {
        s!.child.on('exit', (code) => resolveExit(code));
      });
      s.send('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'profile-guard', version: '0.0.0' },
      });
      await assert.rejects(
        () => s!.nextLine(),
        (error: Error) => error.message.includes('exited'),
        'the worker must die before answering the first request',
      );
      assert.notEqual(await exitCode, 0, 'boot must exit non-zero');
      assert.match(s.stderrText(), /UNPROFILED_AUTHORITY_TOOL/);
      assert.match(s.stderrText(), /missing=observe/);
      s = null;
    } finally {
      if (s) s.child.kill('SIGKILL');
      await rm(tmp, { recursive: true, force: true });
    }
  },
);
