#!/usr/bin/env node
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lockfile, formatLockConflictMessage } from './lifecycle/lockfile.js';
import { startParentDeathWatch } from './lifecycle/parent-watch.js';
import { LineSplitter } from './lifecycle/stdio-frames.js';
import { SupervisorCore, type SupervisorAction } from './lifecycle/supervisor-core.js';
import { logger } from './logger.js';

// GH#264 Phase 5: the component that owns stdio with Claude Code must hold
// ZERO network sockets — `lsof -ti tcp:8081 | xargs kill -9` (a documented
// Metro-recovery step) kills every pid on the port, which used to include
// the whole MCP server. All networked state lives in the spawned worker
// (./index.js); this process only pipes stdio, owns the single-instance
// lock, and respawns the worker when it dies.
const here = dirname(fileURLToPath(import.meta.url));

if (process.env.RN_BRIDGE_SUPERVISOR === '0') {
  // Escape hatch: legacy single-process bridge (debugging / bisecting).
  await import('./index.js');
} else {
  const workerPath = process.env.RN_BRIDGE_WORKER_PATH ?? join(here, 'index.js');
  const noLock = process.argv.includes('--no-lock');

  let lockfile: Lockfile | null = null;
  if (!noLock) {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string };
    lockfile = new Lockfile({ version: pkg.version });
    const lockResult = lockfile.acquire();
    if (lockResult.status === 'conflict') {
      process.stderr.write(formatLockConflictMessage(lockResult) + '\n');
      process.exit(11);
    }
    process.on('exit', () => lockfile?.release());
  }

  const core = new SupervisorCore({
    maxRespawns: Number(process.env.RN_BRIDGE_MAX_RESPAWNS ?? '3') || 3,
    logPath: logger.logFilePath,
  });
  const clientLines = new LineSplitter();
  const workerLines = new LineSplitter();
  let worker: ChildProcess | null = null;
  let shutdownRequested = false;

  function apply(actions: SupervisorAction[]): void {
    for (const action of actions) {
      if (action.kind === 'toWorker') worker?.stdin?.write(action.line + '\n');
      else if (action.kind === 'toClient') process.stdout.write(action.line + '\n');
      else if (action.kind === 'spawn') {
        spawnWorker();
        apply(core.onSpawned());
      } else process.exit(action.code);
    }
  }

  function spawnWorker(): void {
    const child = spawn(process.execPath, [workerPath, '--no-lock'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: {
        ...process.env,
        RN_BRIDGE_SUPERVISED: '1',
        RN_BRIDGE_RESTARTS: String(core.restartCount),
        ...(core.lastExit ? { RN_BRIDGE_LAST_EXIT: core.lastExit } : {}),
      },
    });
    worker = child;
    process.stderr.write(`rn-bridge-supervisor: worker pid ${child.pid}\n`);
    // 'error' + 'exit' can both fire (or only 'error' for ENOENT) — funnel
    // both into ONE death-handling pass per child or the budget double-counts.
    let handled = false;
    const onDeath = (code: number | null, signal: NodeJS.Signals | null, cause: string): void => {
      if (handled) return;
      handled = true;
      if (cause) process.stderr.write(`rn-bridge-supervisor: worker ${cause}\n`);
      if (worker === child) worker = null;
      apply(core.onWorkerExit(code, signal, shutdownRequested));
    };
    child.stdin?.on('error', () => { /* EPIPE on a dying worker — exit handler covers it */ });
    child.on('error', (err) => onDeath(null, null, `spawn failed: ${err.message}`));
    if (child.stdout) {
      // setEncoding makes Node's StringDecoder hold partial UTF-8 sequences —
      // a multi-byte codepoint split across 'data' events must not corrupt
      // the JSON (plan-review BLOCKER; the SDK's own ReadBuffer does the same).
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const line of workerLines.push(chunk)) apply(core.onWorkerLine(line));
      });
    }
    child.on('exit', (code, signal) => onDeath(code, signal, ''));
  }

  function beginShutdown(why: string): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    process.stderr.write(`rn-bridge-supervisor: shutdown (${why})\n`);
    const child = worker;
    if (!child || child.exitCode !== null) process.exit(0);
    child.kill('SIGTERM');
    const force = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000);
    force.unref();
    child.on('exit', () => process.exit(0));
  }

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    for (const line of clientLines.push(chunk)) apply(core.onClientLine(line));
  });
  process.stdin.on('end', () => beginShutdown('stdin closed — host disconnected'));
  process.on('SIGTERM', () => beginShutdown('SIGTERM'));
  process.on('SIGINT', () => beginShutdown('SIGINT'));
  process.on('SIGHUP', () => beginShutdown('SIGHUP'));
  // Hot reload, now real: flag the core FIRST (so the exit-1 is treated as
  // requested — never charged to the crash budget), then forward to the
  // worker, whose documented SIGUSR2 path exits 1 → respawn + replay.
  process.on('SIGUSR2', () => {
    if (!worker) return;
    core.onHotReloadRequested();
    worker.kill('SIGUSR2');
  });

  startParentDeathWatch({
    onOrphaned: () => beginShutdown('parent host gone (PPID changed)'),
    onHeartbeat: () => {
      try {
        if (lockfile && !lockfile.touch()) beginShutdown('single-instance lock reclaimed by another bridge');
      } catch { /* best-effort heartbeat */ }
    },
  });

  spawnWorker();
}
