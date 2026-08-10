import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceLock, DEVICE_LOCK_STALE_MS } from '../../dist/lifecycle/device-lock.js';
import type { DeviceLockOptions } from '../../dist/lifecycle/device-lock.js';
import {
  DEVICE_BUSY_ALTERNATE_GUIDANCE,
  DEVICE_BUSY_CLOSE_GUIDANCE,
  DEVICE_BUSY_OWNERSHIP_GUIDANCE,
  DEVICE_BUSY_STALE_GUIDANCE,
  deviceBusyHolderSummary,
  deviceBusyMessage,
} from '../../dist/tools/device-session.js';

const DEVICE_ID = 'SIMULATOR-654';
const NOW = 1_700_000_100_000;
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function makeLock(dir: string, overrides: Partial<DeviceLockOptions> = {}): DeviceLock {
  return new DeviceLock({
    platform: 'ios',
    deviceId: DEVICE_ID,
    projectRoot: '/private/holder-worktree',
    appId: 'com.private.holder',
    pid: 1111,
    uid: 501,
    tmpDir: dir,
    clock: () => NOW,
    processAlive: () => true,
    ...overrides,
  });
}

test('GH#654: a fresh live holder refuses without mutating its lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'device-busy-live-'));
  try {
    const holder = makeLock(dir);
    assert.equal(holder.acquire().status, 'acquired');
    const before = readFileSync(holder.lockPath, 'utf8');

    const contender = makeLock(dir, {
      pid: 2222,
      projectRoot: '/private/requester-worktree',
      clock: () => NOW + 12_000,
      processAlive: () => true,
    });
    const result = contender.acquire();

    assert.equal(result.status, 'conflict');
    assert.equal(readFileSync(holder.lockPath, 'utf8'), before);
    assert.equal(JSON.parse(before).pid, 1111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GH#654: live-holder guidance is actionable, bounded, and sanitized', () => {
  const holder = {
    pid: 1111,
    projectRoot: '/private/secret/holder-worktree',
    platform: 'ios' as const,
    deviceId: DEVICE_ID,
    appId: 'com.private.holder',
    startedAt: NOW - 60_000,
    lastHeartbeat: NOW - 12_001,
  };
  const summary = deviceBusyHolderSummary(holder, {
    now: NOW,
    processAlive: () => true,
  });
  const message = deviceBusyMessage(DEVICE_ID, holder, summary);

  assert.deepEqual(summary, {
    alive: true,
    heartbeatAgeMs: 12_001,
    heartbeatAgeCapped: false,
  });
  assert.match(message, /Holder is alive; heartbeat age is 13s \(bounded to 0–90s\)/);
  assert.match(message, /device_snapshot action=close/);
  assert.match(message, /holder worktree/);
  assert.match(message, /dedicated simulator/);
  assert.match(message, /rn_session action=bind_device/);
  assert.match(message, /attachOnly=true/);
  assert.match(message, /Dead holders self-heal on the next open attempt/);
  assert.match(message, /existing 90s recovery window/);
  assert.match(message, /never stolen or changed/);
  assert.doesNotMatch(message, /1111|secret|com\.private|PID|project path/i);

  const source = readFileSync(
    join(REPO_ROOT, 'packages/rn-dev-agent-core/src/tools/device-session.ts'),
    'utf8',
  );
  assert.doesNotMatch(source, /holder:\s*lockResult\.holder/);
  assert.match(source, /code: 'DEVICE_BUSY',[\s\S]{0,80}holder,/);
});

test('GH#654: heartbeat diagnostics clamp clock skew and excessive ages', () => {
  const holder = {
    pid: 1111,
    projectRoot: '/private/holder',
    platform: 'ios' as const,
    deviceId: DEVICE_ID,
    startedAt: NOW,
    lastHeartbeat: NOW,
  };

  assert.deepEqual(deviceBusyHolderSummary(holder, { now: NOW - 1, processAlive: () => true }), {
    alive: true,
    heartbeatAgeMs: 0,
    heartbeatAgeCapped: false,
  });
  assert.deepEqual(
    deviceBusyHolderSummary(holder, {
      now: NOW + DEVICE_LOCK_STALE_MS * 100,
      processAlive: () => false,
    }),
    {
      alive: false,
      heartbeatAgeMs: DEVICE_LOCK_STALE_MS,
      heartbeatAgeCapped: true,
    },
  );
});

test('GH#654: dead and heartbeat-stale holders retain existing reclaim behavior', () => {
  for (const scenario of ['dead', 'heartbeat-stale'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `device-busy-${scenario}-`));
    try {
      const holder = makeLock(dir);
      assert.equal(holder.acquire().status, 'acquired');
      const contender = makeLock(dir, {
        pid: 2222,
        clock: () => NOW + (scenario === 'heartbeat-stale' ? DEVICE_LOCK_STALE_MS + 1 : 1),
        processAlive: () => scenario !== 'dead',
      });

      assert.equal(contender.acquire().status, 'acquired', scenario);
      assert.equal(JSON.parse(readFileSync(holder.lockPath, 'utf8')).pid, 2222, scenario);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('GH#654: authoritative device-control docs preserve runtime guidance verbatim', () => {
  const docs = [
    'packages/shared-agent-knowledge/skills/rn-device-control/SKILL.md',
    'packages/claude-plugin/skills/rn-device-control/SKILL.md',
    'packages/codex-plugin/skills/rn-device-control/SKILL.md',
    'apps/docs-site/src/content/docs/troubleshooting.mdx',
  ];
  const guidance = [
    DEVICE_BUSY_CLOSE_GUIDANCE,
    DEVICE_BUSY_ALTERNATE_GUIDANCE,
    DEVICE_BUSY_STALE_GUIDANCE,
    DEVICE_BUSY_OWNERSHIP_GUIDANCE,
  ];

  for (const relativePath of docs) {
    const doc = readFileSync(join(REPO_ROOT, relativePath), 'utf8');
    for (const sentence of guidance)
      assert.ok(doc.includes(sentence), `${relativePath}: ${sentence}`);
    assert.match(doc, /heartbeat\s+age bounded to 0–90s/);
    assert.match(doc, /does not expose the holder PID, project path, or app ID/);
  }
});
