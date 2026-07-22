import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EXPECTED_SKILLS, MCP_CANARIES } from '../../../codex-plugin/src/plugin-health.ts';

const pexecFile = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../codex-plugin');
const health = join(packageRoot, 'bin', 'plugin-health.js');
const manifest = JSON.parse(
  await readFile(join(packageRoot, '.codex-plugin', 'plugin.json'), 'utf8'),
) as { version: string };

test(
  'GH-575 generated health entry classifies exact package and explicit task observations',
  { timeout: 30_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'rn-agent-health-'));
    const bin = join(home, 'bin');
    await mkdir(bin);
    const codex = join(bin, 'codex');
    const poisonMarker = join(home, 'runtime-override-executed');
    const poisonSupervisor = join(home, 'poison-supervisor.js');
    const poisonWorker = join(home, 'poison-worker.js');
    await writeFile(
      poisonSupervisor,
      `require('node:fs').writeFileSync(process.env.POISON_MARKER, 'supervisor')\n`,
    );
    await writeFile(
      poisonWorker,
      `require('node:fs').writeFileSync(process.env.POISON_MARKER, 'worker')\n`,
    );
    await writeFile(
      codex,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo 'codex-cli 0.145.0'
elif [ "$1 $2 $3" = "plugin list --json" ]; then
  echo '${JSON.stringify([
    {
      pluginId: 'rn-dev-agent@rn-dev-agent',
      version: manifest.version,
      enabled: true,
      source: { path: join(home, 'cache') },
      authToken: 'must-not-leak',
    },
  ])}'
elif [ "$1 $2 $3" = "mcp list --json" ]; then
  echo '{"cdp":{"enabled":true}}'
else
  exit 2
fi
`,
    );
    await chmod(codex, 0o755);
    try {
      const args = [
        '--json',
        '--task-skills-complete',
        '--task-mcp-complete',
        '--observed-transport',
        'healthy',
        '--host-proof-schema',
        'usable',
        '--observed-app-status',
        'connected',
        ...EXPECTED_SKILLS.flatMap((name) => ['--task-skill', name]),
        ...MCP_CANARIES.flatMap((name) => ['--task-mcp-tool', `mcp__cdp__${name}`]),
      ];
      const { stdout } = await pexecFile(process.execPath, [health, ...args], {
        cwd: packageRoot,
        env: {
          ...process.env,
          HOME: home,
          PATH: `${bin}:${process.env.PATH}`,
          POISON_MARKER: poisonMarker,
          RN_DEV_AGENT_CORE_SUPERVISOR: poisonSupervisor,
          RN_DEV_AGENT_CORE_ROOT: home,
          RN_BRIDGE_WORKER_PATH: poisonWorker,
          RN_BRIDGE_SUPERVISOR: '0',
          RN_BRIDGE_MAX_RESPAWNS: '0',
          RN_BRIDGE_LAST_EXIT: 'poisoned diagnostic state',
          RN_DEV_AGENT_CODEX_PLUGIN_ROOT: join(home, 'foreign-plugin'),
        },
        timeout: 25_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const report = JSON.parse(stdout) as {
        primaryFinding: string;
        overall: string;
        materialization: { status: string };
        mcpContractProbe: { status: string; toolCount: number };
        directProofSchema: { status: string };
        installation: { matches: Array<Record<string, unknown>> };
      };
      assert.equal(report.primaryFinding, 'HEALTHY');
      assert.equal(report.overall, 'healthy');
      assert.equal(report.materialization.status, 'EXACT_HEALTHY');
      assert.equal(report.mcpContractProbe.status, 'HEALTHY');
      assert.equal(report.mcpContractProbe.toolCount, 79);
      assert.equal(report.directProofSchema.status, 'USABLE');
      assert.equal(existsSync(poisonMarker), false);
      assert.deepEqual(report.installation.matches, [
        {
          pluginId: 'rn-dev-agent@rn-dev-agent',
          version: manifest.version,
          enabled: true,
          source: { path: '~/cache' },
          authToken: '[REDACTED]',
        },
      ]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
