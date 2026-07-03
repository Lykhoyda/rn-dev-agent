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
import { readFileSync, realpathSync } from 'node:fs';
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

  if (!alive) {
    // Absent/dead lock is inconclusive at SessionStart: the hook may simply
    // have run before Claude Code spawned the MCP server. Only worth a
    // conditional note in the risky window right after an upgrade.
    if (upgraded) {
      console.log(
        `MCP bridge check: no bridge is running for this project yet. If cdp_*/device_* tools are missing once the session is up, ${RECONNECT_ADVICE}.`,
      );
    }
    process.exit(0);
  }

  let psArgs = '';
  try {
    psArgs = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 1000,
    }).trim();
  } catch {
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

  // Identify the running bridge's install dir from its argv. No match → not
  // provably a bridge (PID reuse, redacted ps) → stay silent (fail open).
  // A space-containing FOREIGN path parses truncated here — the stale verdict
  // still holds (the current-install case already returned above); only the
  // displayed path is shortened.
  const m = psArgs.match(/\/\S*\/scripts\/cdp-bridge\/dist\/(?:supervisor|index)\.js/);
  if (!m) process.exit(0);

  const runningDist = realpathOr(dirname(m[0]));

  if (runningDist === currentDist) {
    if (upgraded) {
      console.log(`MCP bridge check: a bridge from the current install is running (PID ${pid}).`);
    }
    process.exit(0);
  }

  const bridgeVersion =
    lock && typeof lock.version === 'string' && lock.version ? ` bridge v${lock.version},` : '';
  console.log(
    `WARNING: an MCP bridge from a different plugin install (usually a previous version) is still running (PID ${pid},${bridgeVersion} ${dirname(m[0])}) and holds this project's bridge lock. This session's MCP server may have failed to register (zero cdp_*/device_* tools). Run /mcp and reconnect the rn-dev-agent server; if reconnect still fails, close the other Claude Code window using this project or run \`kill ${pid}\`, then reconnect.`,
  );
} catch {
  // Never block or fail SessionStart.
}
