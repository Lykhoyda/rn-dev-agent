// GH#251/B195: Lockfile.acquire was a non-atomic read-then-write — readExisting()
// → live-check → writeFileSync (O_TRUNC). Two bridges starting for the same project
// in the same instant could both see no live lock and both "acquire", the second
// silently truncating the first — defeating the single-bridge-per-project guarantee.
// Fix: the same openSync('wx') atomic exclusive-create pattern as DeviceLock.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Lockfile } from "../../dist/lifecycle/lockfile.js";

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), "lockfile-race-test-"));
}

const NOW = 1_700_000_000_000;
const FOREIGN_PID = 99999;

function foreignLiveBody() {
  return {
    pid: FOREIGN_PID,
    projectRoot: "/fake/project/root",
    startedAt: NOW - 5_000,
    lastHeartbeat: NOW - 1_000,
    ppid: 4242,
    version: "0.99.0-foreign",
  };
}

function makeLockfile(tmpDir, overrides = {}) {
  return new Lockfile({
    projectRoot: "/fake/project/root",
    pid: 12345,
    tmpDir,
    uid: 501,
    version: "0.23.0-test",
    clock: () => NOW,
    processAlive: () => true,
    processName: () => "node cdp-bridge",
    processParent: () => 4242,
    selfPpid: () => 777,
    ...overrides,
  });
}

test("#251 a foreign lock that lands mid-acquire is never silently overwritten", () => {
  const tmpDir = makeTmpDir();
  try {
    const lockPath = join(tmpDir, "rn-dev-agent-cdp-501-" + hashOf("/fake/project/root") + ".lock");
    // Simulate the race deterministically: the injected selfPpid (called while
    // acquire() builds the lock body) plays the part of a second bridge whose
    // exclusive create wins the gap between our liveness check and our write.
    // Conditional on !existsSync, exactly like a real wx create would be.
    let foreignWrote = false;
    const lockfile = makeLockfile(tmpDir, {
      selfPpid: () => {
        if (!existsSync(lockPath)) {
          writeFileSync(lockPath, JSON.stringify(foreignLiveBody(), null, 2), "utf8");
          foreignWrote = true;
        }
        return 777;
      },
    });
    assert.equal(lockfile.lockPath, lockPath, "test must target the real lock path");

    const result = lockfile.acquire();

    if (foreignWrote) {
      // The foreign bridge won the race: we must report conflict and leave its lock intact.
      assert.equal(result.status, "conflict");
      assert.equal(result.pid, FOREIGN_PID);
      const body = JSON.parse(readFileSync(lockPath, "utf8"));
      assert.equal(body.pid, FOREIGN_PID, "foreign lock must not be truncated/overwritten");
    } else {
      // We created the file first (exclusive create won): we own it.
      assert.equal(result.status, "acquired");
      const body = JSON.parse(readFileSync(lockPath, "utf8"));
      assert.equal(body.pid, 12345);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("#251 stale-holder reclaim still works through the exclusive-create path", () => {
  const tmpDir = makeTmpDir();
  try {
    const lockfile = makeLockfile(tmpDir, {
      processAlive: () => false, // holder pid is dead → reclaimable
    });
    writeFileSync(lockfile.lockPath, JSON.stringify(foreignLiveBody(), null, 2), "utf8");

    const result = lockfile.acquire();
    assert.equal(result.status, "acquired");
    const body = JSON.parse(readFileSync(lockfile.lockPath, "utf8"));
    assert.equal(body.pid, 12345, "reclaimed lock is rewritten with our pid");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("#251 live-holder conflict still reported with holder details", () => {
  const tmpDir = makeTmpDir();
  try {
    const lockfile = makeLockfile(tmpDir);
    writeFileSync(lockfile.lockPath, JSON.stringify(foreignLiveBody(), null, 2), "utf8");

    const result = lockfile.acquire();
    assert.equal(result.status, "conflict");
    assert.equal(result.pid, FOREIGN_PID);
    assert.equal(result.projectRoot, "/fake/project/root");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// Mirror of lockfile.ts's path derivation so the race test can pre-compute lockPath.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
function hashOf(projectRoot) {
  return createHash("md5").update(resolve(projectRoot)).digest("hex").slice(0, 8);
}
