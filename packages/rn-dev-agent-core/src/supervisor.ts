#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lockfile, formatLockConflictMessage } from './lifecycle/lockfile.js';
import { startParentDeathWatch } from './lifecycle/parent-watch.js';
import { LineSplitter } from './lifecycle/stdio-frames.js';
import { SupervisorCore, type SupervisorAction } from './lifecycle/supervisor-core.js';
import { logger } from './logger.js';
import { inspectSessionOwner } from './session/process-owner.js';
import { readProcessBirth } from './session/process-birth.js';
import { resolveSourceIdentity } from './session/source-identity.js';
import {
  createSupervisorAuthority,
  type SupervisorAuthority,
} from './session/supervisor-authority.js';
import { sqliteFlagForNode, supervisorRelaunchArgs, workerSpawnArgs } from './supervisor-args.js';

// GH#264 Phase 5: the component that owns stdio with Claude Code must hold
// ZERO network sockets — `lsof -ti tcp:8081 | xargs kill -9` (a documented
// Metro-recovery step) kills every pid on the port, which used to include
// the whole MCP server. All networked state lives in the spawned worker
// (./index.js); this process only pipes stdio, owns the single-instance
// lock, and respawns the worker when it dies.
const here = dirname(fileURLToPath(import.meta.url));
const sqliteWarningFilterPath = join(here, 'sqlite-warning-filter.js');
const supervisorFlag = sqliteFlagForNode();

if (
  supervisorFlag.length > 0 &&
  !process.execArgv.includes('--experimental-sqlite') &&
  process.env.RN_DEV_AGENT_SQLITE_RELAUNCHED !== '1'
) {
  const child = spawn(
    process.execPath,
    supervisorRelaunchArgs(
      fileURLToPath(import.meta.url),
      sqliteWarningFilterPath,
      undefined,
      process.argv.slice(2),
    ),
    {
      stdio: 'inherit',
      env: { ...process.env, RN_DEV_AGENT_SQLITE_RELAUNCHED: '1' },
    },
  );
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGUSR2'] as const) {
    process.on(signal, () => child.kill(signal));
  }
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  if (outcome.signal) {
    process.removeAllListeners(outcome.signal);
    process.kill(process.pid, outcome.signal);
  }
  process.exit(outcome.code ?? 1);
}

if (process.env.RN_BRIDGE_SUPERVISOR === '0') {
  // Escape hatch: legacy single-process bridge (debugging / bisecting).
  await import('./index.js');
} else {
  const workerPath = process.env.RN_BRIDGE_WORKER_PATH ?? join(here, 'index.js');
  const noLock = process.argv.includes('--no-lock');

  let lockfile: Lockfile | null = null;
  if (!noLock) {
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    lockfile = new Lockfile({ version: pkg.version });
    const lockResult = lockfile.acquire();
    if (lockResult.status === 'conflict') {
      process.stderr.write(formatLockConflictMessage(lockResult) + '\n');
      process.exit(11);
    }
    process.on('exit', () => lockfile?.release());
  }

  let authority: SupervisorAuthority | null = null;
  let authorityError: string | null = null;
  try {
    const declaredManifests = process.env.RN_DEV_AGENT_DECLARED_MANIFESTS?.split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const source = resolveSourceIdentity(process.cwd(), {
      declaredRoot: process.env.RN_DEV_AGENT_DECLARED_ROOT,
      declaredManifests,
    });
    authority = createSupervisorAuthority({
      source,
      supervisorBirth: readProcessBirth(process.pid),
      uid:
        typeof process.getuid === 'function'
          ? String(process.getuid())
          : (process.env.USER ?? 'unknown'),
      ownerStatus: inspectSessionOwner,
    });
  } catch (error) {
    authorityError =
      error instanceof Error
        ? error.message
        : 'AUTHORITY_STORE_UNAVAILABLE: authority session could not be initialized';
    process.stderr.write(`rn-dev-agent authority diagnostic: ${authorityError}\n`);
  }

  const core = new SupervisorCore({
    maxRespawns: Number(process.env.RN_BRIDGE_MAX_RESPAWNS ?? '3') || 3,
    logPath: logger.logFilePath,
  });
  const clientLines = new LineSplitter();
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
    const workerInstance = randomUUID();
    const child = spawn(
      process.execPath,
      workerSpawnArgs(workerPath, sqliteWarningFilterPath, undefined, process.argv.slice(2)),
      {
        stdio: ['pipe', 'pipe', 'inherit'],
        env: {
          ...process.env,
          RN_BRIDGE_SUPERVISED: '1',
          RN_DEV_AGENT_SESSION_CLI: join(here, 'rn-session.js'),
          RN_BRIDGE_RESTARTS: String(core.restartCount),
          ...(core.lastExit ? { RN_BRIDGE_LAST_EXIT: core.lastExit } : {}),
          ...(authority
            ? authority.workerEnvironment(workerInstance)
            : { RN_DEV_AGENT_AUTHORITY_ERROR: authorityError ?? 'AUTHORITY_STORE_UNAVAILABLE' }),
        },
      },
    );
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
    child.stdin?.on('error', () => {
      /* EPIPE on a dying worker — exit handler covers it */
    });
    child.on('error', (err) => onDeath(null, null, `spawn failed: ${err.message}`));
    if (child.stdout) {
      // setEncoding makes Node's StringDecoder hold partial UTF-8 sequences —
      // a multi-byte codepoint split across 'data' events must not corrupt
      // the JSON (the SDK's own ReadBuffer does the equivalent).
      child.stdout.setEncoding('utf8');
      // Per-child splitter: a worker killed mid-write leaves an unterminated
      // tail; a shared splitter would prefix the NEXT worker's first line
      // with it, corrupting the replayed-initialize answer. Scoping the
      // buffer to the child makes that impossible.
      const childLines = new LineSplitter();
      child.stdout.on('data', (chunk: string) => {
        // Node can emit 'exit' before stdout fully drains; once this child's
        // death was handled (pending ids errored, replacement possibly
        // spawned), a late line must not double-answer an errored id or
        // satisfy the replayed-initialize gate in the fresh worker's place.
        if (handled) return;
        for (const line of childLines.push(chunk)) apply(core.onWorkerLine(line));
      });
    }
    child.on('exit', (code, signal) => onDeath(code, signal, ''));
  }

  function beginShutdown(why: string): void {
    if (shutdownRequested) return;
    shutdownRequested = true;
    process.stderr.write(`rn-bridge-supervisor: shutdown (${why})\n`);
    const child = worker;
    if (!child || child.exitCode !== null) {
      authority?.close();
      process.exit(0);
    }
    child.kill('SIGTERM');
    const force = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, 3000);
    force.unref();
    child.on('exit', () => {
      authority?.close();
      process.exit(0);
    });
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
        if (lockfile && !lockfile.touch())
          beginShutdown('single-instance lock reclaimed by another bridge');
      } catch {
        /* best-effort heartbeat */
      }
    },
  });

  spawnWorker();
}
