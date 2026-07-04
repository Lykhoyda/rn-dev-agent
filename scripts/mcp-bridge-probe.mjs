#!/usr/bin/env node
// mcp-bridge-probe.mjs — SessionStart helper (GH #419).
//
// Read-only probe of the cdp-bridge supervisor lockfile. The plugin cache is
// versioned per install, so a bridge that outlives an upgrade keeps running
// from the OLD version directory while holding this project's lock — the new
// session's supervisor then exits on the lock conflict and the MCP server
// contributes zero tools. The hook can't see Claude Code's tool registry, but
// it CAN see the lock holder: this script names a stale holder explicitly and
// gives the cheap recovery path (/mcp reconnect) instead of a full restart.
//
// Contract: stdout is zero or more advisory lines; always exits 0; never
// waits or polls (SessionStart must stay bounded, GH #252).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const RECONNECT_ADVICE =
  'run /mcp and reconnect the rn-dev-agent server (no full Claude Code restart needed)';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function realpathOr(p) {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

try {
  const pluginRoot = arg('--plugin-root');
  const upgraded = arg('--upgraded') === '1';
  if (!pluginRoot) process.exit(0);

  // Mirrors lifecycle/lockfile.ts exactly: tmpdir + uid + md5(projectRoot):8.
  const projectRoot = resolve(process.env.CLAUDE_USER_CWD ?? process.cwd());
  const hash = createHash('md5').update(projectRoot).digest('hex').slice(0, 8);
  const lockPath = join(tmpdir(), `rn-dev-agent-cdp-${userInfo().uid}-${hash}.lock`);

  let lock = null;
  try {
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  } catch {
    lock = null;
  }

  const pid = lock && typeof lock.pid === 'number' ? lock.pid : null;
  let alive = false;
  if (pid !== null) {
    try {
      process.kill(pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
  }

  let psArgs = '';
  if (alive) {
    try {
      psArgs = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
    } catch {
      // Holder identity unknowable (ps unavailable/redacted) — claim nothing.
      process.exit(0);
    }
  }

  // A live holder only BLOCKS the new supervisor if lockfile.ts's isLockLive
  // would refuse to reclaim it. Mirror its checks: argv must prove a bridge
  // (else it's PID reuse — suffix containment, since argv separators and
  // in-path spaces are indistinguishable in ps output); lock mtime >24h is an
  // abandoned lock → reclaimed; a heartbeat >90s stale is a wedged owner →
  // reclaimed; a live PPID differing from the recorded one is an orphan →
  // reclaimed (for pre-0.39 locks with no recorded PPID, reparented-to-init
  // is the orphan signal). Unreadable mtime/PPID never downgrades a holder —
  // matching lockfile.ts fail-safe semantics.
  let liveBlocker =
    alive && /\/scripts\/cdp-bridge\/dist\/(?:supervisor|index)\.js(?:\s|$)/.test(psArgs);
  if (liveBlocker) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 24 * 60 * 60 * 1000) liveBlocker = false;
    } catch {
      /* fail safe: unreadable mtime keeps the holder a blocker */
    }
  }
  if (
    liveBlocker &&
    typeof lock.lastHeartbeat === 'number' &&
    Date.now() - lock.lastHeartbeat > 90_000
  ) {
    liveBlocker = false;
  }
  if (liveBlocker) {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'ppid='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 1000,
      }).trim();
      const livePpid = parseInt(out, 10);
      if (Number.isFinite(livePpid)) {
        if (typeof lock.ppid === 'number') {
          if (livePpid !== lock.ppid) liveBlocker = false;
        } else if (livePpid === 1) {
          // Pre-0.39 lock with no recorded PPID: reparented to init = orphan.
          liveBlocker = false;
        }
      }
    } catch {
      /* fail safe: unknown PPID keeps the holder a blocker */
    }
  }

  if (!liveBlocker) {
    // No blocking holder (lock absent, dead, or one the supervisor would
    // reclaim) is inconclusive at SessionStart: the hook may simply have run
    // before Claude Code spawned the MCP server. Only worth a conditional
    // note in the risky window right after an upgrade.
    if (upgraded) {
      console.log(
        `MCP bridge check: no bridge is running for this project yet. If cdp_*/device_* tools are missing once the session is up, ${RECONNECT_ADVICE}.`,
      );
    }
    process.exit(0);
  }

  const currentDistRaw = join(resolve(pluginRoot), 'scripts', 'cdp-bridge', 'dist');
  const currentDist = realpathOr(currentDistRaw);

  // Current-install check FIRST via exact containment — \S-based parsing
  // cannot span spaces (e.g. an install under "Application Support"), and a
  // parse-truncated path must never make us call the user's own live bridge
  // stale. Both raw and realpath'd forms are tried (symlinked spawns).
  if (psArgs.includes(currentDistRaw) || psArgs.includes(currentDist)) {
    if (upgraded) {
      console.log(`MCP bridge check: a bridge from the current install is running (PID ${pid}).`);
    }
    process.exit(0);
  }

  // Best-effort path extraction, for display and the symlinked-spawn case
  // only. A space-containing path parses truncated or not at all — the stale
  // verdict above is unaffected.
  const m = psArgs.match(/\/\S*\/scripts\/cdp-bridge\/dist\/(?:supervisor|index)\.js/);
  const holderDist = m ? dirname(m[0]) : null;

  if (holderDist !== null && realpathOr(holderDist) === currentDist) {
    if (upgraded) {
      console.log(`MCP bridge check: a bridge from the current install is running (PID ${pid}).`);
    }
    process.exit(0);
  }

  const bridgeVersion =
    lock && typeof lock.version === 'string' && lock.version ? ` bridge v${lock.version},` : '';
  const holderDesc = holderDist ?? 'install path unparsable from ps args';
  console.log(
    `WARNING: an MCP bridge from a different plugin install (usually a previous version) is still running (PID ${pid},${bridgeVersion} ${holderDesc}) and holds this project's bridge lock. This session's MCP server may have failed to register (zero cdp_*/device_* tools). Run /mcp and reconnect the rn-dev-agent server; if reconnect still fails, close the other Claude Code window using this project or run \`kill ${pid}\`, then reconnect.`,
  );
} catch {
  // Never block or fail SessionStart.
}
