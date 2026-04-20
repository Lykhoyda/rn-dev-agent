import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Lockfile, formatLockConflictMessage, defaultProcessName } from '../../dist/lifecycle/lockfile.js';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'lockfile-test-'));
}

function writeLockBody(lockPath, body) {
  writeFileSync(lockPath, JSON.stringify(body, null, 2), 'utf8');
}

function makeLockfile(overrides = {}) {
  const tmpDir = overrides.tmpDir ?? makeTmpDir();
  return {
    tmpDir,
    lockfile: new Lockfile({
      projectRoot: '/fake/project/root',
      pid: 12345,
      tmpDir,
      uid: 501,
      version: '0.23.0-test',
      clock: overrides.clock ?? (() => 1_700_000_000_000),
      processAlive: overrides.processAlive ?? (() => false),
      processName: overrides.processName ?? (() => null),
      maxAgeMs: overrides.maxAgeMs ?? 24 * 60 * 60 * 1000,
      processNameNeedle: overrides.processNameNeedle ?? 'cdp-bridge',
      ...overrides,
    }),
  };
}

test('Lockfile: acquires on clean state and writes lock body', () => {
  const { tmpDir, lockfile } = makeLockfile();
  try {
    const result = lockfile.acquire();
    assert.equal(result.status, 'acquired');
    assert.equal(result.lockPath, lockfile.lockPath);
    assert.ok(existsSync(lockfile.lockPath), 'lock file exists on disk');

    const body = JSON.parse(readFileSync(lockfile.lockPath, 'utf8'));
    assert.equal(body.pid, 12345);
    assert.equal(body.projectRoot, '/fake/project/root');
    assert.equal(body.startedAt, 1_700_000_000_000);
    assert.equal(body.version, '0.23.0-test');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: returns conflict when valid live lock exists (same project)', () => {
  const tmpDir = makeTmpDir();
  try {
    const preExistingLock = new Lockfile({
      projectRoot: '/fake/project/root',
      pid: 99999,
      tmpDir,
      uid: 501,
      clock: () => 1_700_000_000_000,
      processAlive: () => true,
      processName: () => 'node cdp-bridge',
    });
    preExistingLock.acquire();

    const { lockfile } = makeLockfile({
      tmpDir,
      processAlive: (pid) => pid === 99999,
      processName: (pid) => (pid === 99999 ? 'node cdp-bridge' : null),
      clock: () => 1_700_000_000_000 + 5 * 60 * 1000, // 5 minutes later
    });

    const result = lockfile.acquire();
    assert.equal(result.status, 'conflict');
    assert.equal(result.pid, 99999);
    assert.equal(result.projectRoot, '/fake/project/root');
    assert.equal(result.startedAt, 1_700_000_000_000);
    assert.equal(result.ageMs, 5 * 60 * 1000);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: reclaims stale lock when PID is dead', () => {
  const tmpDir = makeTmpDir();
  try {
    writeLockBody(join(tmpDir, 'rn-dev-agent-cdp-501-bb3fe5be.lock'), {
      pid: 88888,
      projectRoot: '/fake/project/root',
      startedAt: 1_700_000_000_000,
      version: '0.20.0',
    });

    const { lockfile } = makeLockfile({
      tmpDir,
      processAlive: () => false, // dead PID
    });

    const result = lockfile.acquire();
    assert.equal(result.status, 'acquired', 'reclaimed when PID is dead');

    const body = JSON.parse(readFileSync(lockfile.lockPath, 'utf8'));
    assert.equal(body.pid, 12345, 'new lock body has our PID');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: reclaims stale lock when process name does not match cdp-bridge', () => {
  const tmpDir = makeTmpDir();
  try {
    const { lockfile: first } = makeLockfile({
      tmpDir,
      processAlive: () => true,
      processName: () => 'some-random-other-process',
    });
    // Pre-populate with a "live PID but wrong process name" scenario — as if the PID was reused.
    writeLockBody(first.lockPath, {
      pid: 77777,
      projectRoot: '/fake/project/root',
      startedAt: 1_700_000_000_000,
    });

    const { lockfile } = makeLockfile({
      tmpDir,
      processAlive: (pid) => pid === 77777,
      processName: () => 'bash', // PID reused by unrelated process
    });

    const result = lockfile.acquire();
    assert.equal(result.status, 'acquired', 'reclaimed when process name mismatch');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: reclaims lock older than maxAgeMs (SIGKILL orphan)', () => {
  const tmpDir = makeTmpDir();
  try {
    const lockPath = join(tmpDir, 'rn-dev-agent-cdp-501-bb3fe5be.lock');
    writeLockBody(lockPath, {
      pid: 66666,
      projectRoot: '/fake/project/root',
      startedAt: 1_700_000_000_000 - 48 * 60 * 60 * 1000, // 48h old
    });
    // Backdate mtime to 48h ago so the age check trips.
    const past = new Date(1_700_000_000_000 - 48 * 60 * 60 * 1000);
    utimesSync(lockPath, past, past);

    const { lockfile } = makeLockfile({
      tmpDir,
      clock: () => 1_700_000_000_000,
      processAlive: () => true, // pretend PID is alive (OS recycled it)
      processName: () => 'node cdp-bridge', // pretend name matches
      maxAgeMs: 24 * 60 * 60 * 1000,
    });

    const result = lockfile.acquire();
    assert.equal(result.status, 'acquired', 'reclaimed stale (48h) lock despite live PID and matching name');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: different project roots coexist (different hash ⇒ different file)', () => {
  const tmpDir = makeTmpDir();
  try {
    const lockA = new Lockfile({
      projectRoot: '/fake/project/alpha',
      pid: 11111,
      tmpDir,
      uid: 501,
      clock: () => 1_700_000_000_000,
      processAlive: () => true,
      processName: () => 'cdp-bridge',
    });
    const lockB = new Lockfile({
      projectRoot: '/fake/project/beta',
      pid: 22222,
      tmpDir,
      uid: 501,
      clock: () => 1_700_000_000_000,
      processAlive: () => true,
      processName: () => 'cdp-bridge',
    });

    assert.notEqual(lockA.lockPath, lockB.lockPath, 'distinct lock paths for distinct projects');

    const rA = lockA.acquire();
    const rB = lockB.acquire();
    assert.equal(rA.status, 'acquired');
    assert.equal(rB.status, 'acquired', 'second project acquires independently');
    assert.ok(existsSync(lockA.lockPath));
    assert.ok(existsSync(lockB.lockPath));
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: release() unlinks lock file when we own it', () => {
  const { tmpDir, lockfile } = makeLockfile();
  try {
    lockfile.acquire();
    assert.ok(existsSync(lockfile.lockPath), 'lock exists after acquire');

    lockfile.release();
    assert.ok(!existsSync(lockfile.lockPath), 'lock removed after release');

    // Second release is a no-op, not an error.
    lockfile.release();
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: release() is a no-op when acquire was never called', () => {
  const { tmpDir, lockfile } = makeLockfile();
  try {
    // No acquire. Release should not throw or try to unlink anything.
    lockfile.release();
    assert.ok(!existsSync(lockfile.lockPath), 'no lock file was ever created');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: release() does NOT unlink if another process took over our lock slot', () => {
  const tmpDir = makeTmpDir();
  try {
    const { lockfile } = makeLockfile({ tmpDir });
    lockfile.acquire();

    // Simulate another process overwriting the lock file (e.g. after we stall, another
    // MCP reclaims our slot via the stale-check). Our release() must not clobber their lock.
    writeLockBody(lockfile.lockPath, {
      pid: 99999,
      projectRoot: '/fake/project/root',
      startedAt: 1_700_000_000_500,
    });
    const replacementMtime = statSync(lockfile.lockPath).mtimeMs;

    lockfile.release();

    assert.ok(existsSync(lockfile.lockPath), 'replacement lock preserved — we did not clobber it');
    const body = JSON.parse(readFileSync(lockfile.lockPath, 'utf8'));
    assert.equal(body.pid, 99999, 'replacement pid still in file');
    assert.equal(statSync(lockfile.lockPath).mtimeMs, replacementMtime, 'file untouched');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: lock filename includes uid and project hash (collision-safe shape)', () => {
  const { tmpDir, lockfile } = makeLockfile();
  try {
    assert.match(
      lockfile.lockPath,
      /\/rn-dev-agent-cdp-501-[0-9a-f]{8}\.lock$/,
      'filename pattern: ${uid}-${8-char-hex}',
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Lockfile: ignores malformed lock file body and reclaims', () => {
  const tmpDir = makeTmpDir();
  try {
    const { lockfile } = makeLockfile({ tmpDir });
    writeFileSync(lockfile.lockPath, '{this is not valid json', 'utf8');

    const result = lockfile.acquire();
    assert.equal(result.status, 'acquired', 'malformed body treated as no-lock');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('formatLockConflictMessage: renders all fields for human diagnosis', () => {
  const msg = formatLockConflictMessage({
    status: 'conflict',
    lockPath: '/tmp/rn-dev-agent-cdp-501-abcd1234.lock',
    pid: 54321,
    projectRoot: '/Users/anton/GitHub/my-app',
    startedAt: 1_700_000_000_000,
    ageMs: 5 * 60 * 1000,
  });

  assert.match(msg, /Another rn-dev-agent MCP is running/);
  assert.match(msg, /PID:\s+54321/);
  assert.match(msg, /Project:\s+\/Users\/anton\/GitHub\/my-app/);
  assert.match(msg, /Started:\s+5m ago/);
  assert.match(msg, /Lock:\s+\/tmp\/rn-dev-agent-cdp-501-abcd1234\.lock/);
  assert.match(msg, /kill 54321/);
  assert.match(msg, /--no-lock/);
});

test('formatLockConflictMessage: seconds age rendering for young locks', () => {
  const msg = formatLockConflictMessage({
    status: 'conflict',
    lockPath: '/tmp/fake.lock',
    pid: 1,
    projectRoot: '/x',
    startedAt: 0,
    ageMs: 42 * 1000,
  });
  assert.match(msg, /Started:\s+42s ago/);
});

test('formatLockConflictMessage: hours+minutes age rendering for old locks', () => {
  const msg = formatLockConflictMessage({
    status: 'conflict',
    lockPath: '/tmp/fake.lock',
    pid: 1,
    projectRoot: '/x',
    startedAt: 0,
    ageMs: (3 * 60 * 60 + 12 * 60) * 1000,
  });
  assert.match(msg, /Started:\s+3h 12m ago/);
});

// ── D652 multi-review fix: real-process verification for defaultProcessName ──
//
// The original implementation used `ps -o comm=` which returns only the executable
// basename ("node") for Node-launched scripts. That meant our needle match against
// "cdp-bridge" could NEVER succeed in production — every live MCP would be flagged
// stale and reclaimed, defeating the single-instance gate. Switched to `-o args=`
// which returns the full command line on both BSD (macOS) and procps (Linux).
//
// This test exercises the REAL `defaultProcessName` against a REAL spawned child
// process. It would have failed with the original `-o comm=` implementation because
// the uniqueToken we pass via `-e` appears ONLY in the command-line args, never in
// the executable basename. Keeps the hermetic-unit-tests spirit (no reliance on
// anything about the cdp-bridge path on this machine) while proving the args-style
// output that the needle match depends on.

test('defaultProcessName: returns non-null for live PID', () => {
  const name = defaultProcessName(process.pid);
  assert.ok(name !== null, 'ps -p <self> returned non-null');
  assert.ok(name.length > 0, `expected non-empty output, got: ${JSON.stringify(name)}`);
});

test('defaultProcessName: returns null for non-existent PID', () => {
  // PID 1 is almost always init — call with a wildly invalid PID instead
  const name = defaultProcessName(999999999);
  assert.equal(name, null, 'non-existent PID should return null');
});

test('defaultProcessName: returns full command line (args=), not just basename (comm=)', async () => {
  // Spawn a Node child with a unique token in its -e script body. With `-o args=`
  // the token appears in the output; with `-o comm=` it would NOT (comm= is just
  // "node"). This test fails loudly on the original bug and passes after the fix.
  const uniqueToken = `M3_TEST_TOKEN_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const child = spawn(
    process.execPath,
    ['-e', `/* ${uniqueToken} */ setTimeout(() => {}, 10000)`],
    { stdio: 'ignore', detached: false },
  );

  try {
    // Give the OS a moment to materialize the process so ps can find it
    await new Promise((r) => setTimeout(r, 150));
    const name = defaultProcessName(child.pid);
    assert.ok(name !== null, `ps returned null for live child PID ${child.pid}`);
    assert.ok(
      name.includes(uniqueToken),
      `expected args= output containing ${uniqueToken}, got: ${JSON.stringify(name)}`,
    );
  } finally {
    child.kill('SIGKILL');
    // Don't leave zombie children
    await new Promise((r) => setTimeout(r, 50));
  }
});

test('Lockfile: default processName stale check matches real node scripts (D652 regression guard)', async () => {
  // End-to-end: spawn a child whose command line contains "cdp-bridge", write its PID
  // to a lock file, then call acquire() using the REAL defaultProcessName. If the
  // needle match works against `ps -o args=`, isLockLive returns true and acquire
  // returns 'conflict'. With the original `-o comm=` bug, this test would incorrectly
  // return 'acquired' because "node" doesn't contain "cdp-bridge".
  const uniqueToken = 'cdp-bridge'; // the actual needle we match on
  const child = spawn(
    process.execPath,
    ['-e', `/* ${uniqueToken} marker */ setTimeout(() => {}, 10000)`],
    { stdio: 'ignore', detached: false },
  );

  const tmpDir = makeTmpDir();
  try {
    await new Promise((r) => setTimeout(r, 150));

    // Pre-write a lock body claiming the live child owns the lock
    const preLock = new Lockfile({
      projectRoot: '/fake/project/root',
      pid: child.pid,
      tmpDir,
      uid: 501,
      clock: () => Date.now(),
      // Use the REAL processAlive AND REAL processName — no stubs
    });
    preLock.acquire();

    // New Lockfile instance with different PID tries to acquire — should conflict
    const contender = new Lockfile({
      projectRoot: '/fake/project/root',
      pid: 99999, // different PID than the child
      tmpDir,
      uid: 501,
      clock: () => Date.now(),
      // No processAlive/processName overrides — exercises the real defaults
    });

    const result = contender.acquire();
    assert.equal(
      result.status,
      'conflict',
      `expected conflict (live child PID ${child.pid} owns lock, real processName should match "cdp-bridge"), got: ${JSON.stringify(result)}`,
    );
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 50));
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
