#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function supervisorCandidates(): string[] {
  const explicit = process.env.RN_DEV_AGENT_CORE_SUPERVISOR;
  const explicitRoot = process.env.RN_DEV_AGENT_CORE_ROOT;

  return [
    explicit,
    explicitRoot ? join(explicitRoot, 'dist', 'supervisor.js') : null,
    join(pluginRoot, 'rn-dev-agent-core', 'dist', 'supervisor.js'),
    join(pluginRoot, '..', 'rn-dev-agent-core', 'dist', 'supervisor.js'),
  ].filter((candidate): candidate is string => Boolean(candidate));
}

const supervisor = supervisorCandidates().find(isFile);
if (!supervisor) {
  console.error('rn-dev-agent: could not locate rn-dev-agent-core/dist/supervisor.js');
  console.error(`rn-dev-agent: plugin root ${pluginRoot}`);
  console.error(
    'rn-dev-agent: run `corepack yarn build:codex-runtime` or set RN_DEV_AGENT_CORE_SUPERVISOR.',
  );
  process.exit(1);
}

const child = spawn(process.execPath, [supervisor, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    RN_DEV_AGENT_CODEX_PLUGIN_ROOT: pluginRoot,
  },
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(`rn-dev-agent: failed to spawn supervisor ${supervisor}: ${error.message}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Process is already gone.
    }
  });
}

child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
  } else {
    process.exit(code ?? 0);
  }
});
