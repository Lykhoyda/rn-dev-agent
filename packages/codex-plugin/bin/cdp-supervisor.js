#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function supervisorCandidates() {
  const explicit = process.env.RN_DEV_AGENT_CORE_SUPERVISOR;
  const explicitRoot = process.env.RN_DEV_AGENT_CORE_ROOT;

  return [
    explicit,
    explicitRoot ? join(explicitRoot, 'dist', 'supervisor.js') : null,
    join(pluginRoot, 'rn-dev-agent-core', 'dist', 'supervisor.js'),
    join(pluginRoot, '..', 'rn-dev-agent-core', 'dist', 'supervisor.js'),
  ].filter(Boolean);
}

const supervisor = supervisorCandidates().find(isFile);
if (!supervisor) {
  console.error('rn-dev-agent: could not locate rn-dev-agent-core/dist/supervisor.js');
  console.error(`rn-dev-agent: plugin root ${pluginRoot}`);
  console.error(
    'rn-dev-agent: run `corepack yarn build:host-runtimes` or set RN_DEV_AGENT_CORE_SUPERVISOR.',
  );
  process.exit(1);
}

// Codex can keep an older MCP process alive while reconnecting or opening a
// second session for the same project. The core's Claude-oriented singleton
// lock exits immediately in that case, which Codex reports only as
// `Transport closed`. Cross-process device ownership is already guarded by
// the device lock, so keep the Codex transport alive and let each session own
// its supervised worker.
const child = spawn(process.execPath, [supervisor, '--no-lock', ...process.argv.slice(2)], {
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

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
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
