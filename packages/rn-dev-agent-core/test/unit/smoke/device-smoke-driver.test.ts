// Hermetic regression coverage for the GH #666 smoke-driver seams.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  createDeclaredFixtureRoot,
  isSimctlLaunchTimeout,
  launchFixtureWithRetry,
  FIXTURE_MANIFEST,
  LAUNCH_ATTEMPTS,
} from '../../smoke/device-smoke-driver.ts';
import { resolveSourceIdentity } from '../../../dist/session/source-identity.js';

const APP_ID = 'dev.lykhoyda.rndevagent.fixture';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const notAGitRepo = () => {
  throw new Error('fatal: not a git repository (or any of the parent directories): .git');
};

// Use Node's real timeout shape to pin the retry predicate to runtime behavior.
let realTimeoutError: Record<string, unknown> | null = null;
function spawnTimeoutError(): Record<string, unknown> {
  if (!realTimeoutError) {
    try {
      execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
        stdio: 'pipe',
        timeout: 200,
      });
      assert.fail('the probe command must time out');
    } catch (error) {
      realTimeoutError = error as Record<string, unknown>;
    }
  }
  return Object.assign(Object.create(Object.getPrototypeOf(realTimeoutError)), realTimeoutError);
}

function simctlLaunchTimeout(): Error {
  const error = spawnTimeoutError();
  error.path = 'xcrun';
  error.spawnargs = ['simctl', 'launch', 'booted', APP_ID];
  error.syscall = 'spawnSync xcrun';
  (error as { message: string }).message = 'spawnSync xcrun ETIMEDOUT';
  return error as unknown as Error;
}

function fakeClock() {
  let elapsed = 0;
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms;
    },
  };
}

test('spawnSync timeouts really carry code/path/spawnargs', () => {
  const error = spawnTimeoutError();
  assert.equal(error.code, 'ETIMEDOUT');
  assert.equal(typeof error.path, 'string');
  assert.ok(Array.isArray(error.spawnargs));
});

test('the fixture cwd declares a non-Git source identity the shipped resolver accepts', () => {
  const { cwd, env } = createDeclaredFixtureRoot();
  roots.push(cwd);

  assert.equal(env.RN_DEV_AGENT_DECLARED_ROOT, cwd);
  assert.equal(env.RN_DEV_AGENT_DECLARED_MANIFESTS, FIXTURE_MANIFEST);
  assert.ok(JSON.parse(readFileSync(join(cwd, FIXTURE_MANIFEST), 'utf8')).name);

  // Exactly how supervisor.ts reads the two variables it was handed.
  const declaredManifests = env.RN_DEV_AGENT_DECLARED_MANIFESTS.split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const identity = resolveSourceIdentity(cwd, {
    git: notAGitRepo,
    declaredRoot: env.RN_DEV_AGENT_DECLARED_ROOT,
    declaredManifests,
  });

  assert.equal(identity.kind, 'declared-root');
  assert.deepEqual(identity.declaredManifests, [FIXTURE_MANIFEST]);
  assert.match(identity.manifestDigest, /^[a-f0-9]{64}$/);
});

test('the declaration is what makes it resolve — strict non-Git authority is untouched', () => {
  const { cwd } = createDeclaredFixtureRoot();
  roots.push(cwd);

  assert.throws(
    () => resolveSourceIdentity(cwd, { git: notAGitRepo }),
    /NON_GIT_MANIFEST_REQUIRED/,
  );
});

test('one simctl launch timeout consumes an attempt and the relaunch starts the fixture', async () => {
  const clock = fakeClock();
  let launches = 0;
  let probes = 0;

  await launchFixtureWithRetry({
    appId: APP_ID,
    launchOnce: () => {
      launches += 1;
      if (launches === 1) throw simctlLaunchTimeout();
    },
    isRunning: () => (probes += 1) > 2,
    isRetryableLaunchTimeout: isSimctlLaunchTimeout,
    ...clock,
  });

  assert.equal(launches, 2);
  assert.equal(probes, 3);
});

test('a second launch timeout fails truthfully with both attempts and the underlying error', async () => {
  const clock = fakeClock();
  let launches = 0;
  let probes = 0;
  const second = simctlLaunchTimeout();

  await assert.rejects(
    launchFixtureWithRetry({
      appId: APP_ID,
      launchOnce: () => {
        launches += 1;
        if (launches === 2) throw second;
        throw simctlLaunchTimeout();
      },
      isRunning: () => {
        probes += 1;
        return true;
      },
      isRetryableLaunchTimeout: isSimctlLaunchTimeout,
      ...clock,
    }),
    (error: Error) => {
      assert.match(error.message, /attempt 1 launch timed out \(spawnSync xcrun ETIMEDOUT\)/);
      assert.match(error.message, /attempt 2 launch timed out \(spawnSync xcrun ETIMEDOUT\)/);
      // It must not claim the fixture launched and failed to come up.
      assert.doesNotMatch(error.message, /was not running within/);
      assert.equal(error.cause, second);
      return true;
    },
  );

  assert.equal(launches, LAUNCH_ATTEMPTS);
  assert.equal(probes, 0);
});

test('a timeout followed by a fixture that never foregrounds reports both attempts', async () => {
  const clock = fakeClock();
  let launches = 0;

  await assert.rejects(
    launchFixtureWithRetry({
      appId: APP_ID,
      launchOnce: () => {
        launches += 1;
        if (launches === 1) throw simctlLaunchTimeout();
      },
      isRunning: () => false,
      isRetryableLaunchTimeout: isSimctlLaunchTimeout,
      foregroundTimeoutMs: 1_000,
      ...clock,
    }),
    (error: Error) => {
      assert.match(error.message, /attempt 1 launch timed out/);
      assert.match(error.message, /attempt 2 launched but .* was not running within 1000ms/);
      return true;
    },
  );

  assert.equal(launches, 2);
});

test('a non-timeout launch failure aborts immediately with the original error', async () => {
  const clock = fakeClock();
  let launches = 0;
  let probes = 0;
  const refusal = Object.assign(new Error('Command failed: xcrun simctl launch booted'), {
    status: 3,
  });

  await assert.rejects(
    launchFixtureWithRetry({
      appId: APP_ID,
      launchOnce: () => {
        launches += 1;
        throw refusal;
      },
      isRunning: () => {
        probes += 1;
        return true;
      },
      isRetryableLaunchTimeout: isSimctlLaunchTimeout,
      ...clock,
    }),
    (error: unknown) => error === refusal,
  );

  assert.equal(launches, 1);
  assert.equal(probes, 0);
});

test('only an xcrun simctl launch timeout is retryable', () => {
  assert.equal(isSimctlLaunchTimeout(simctlLaunchTimeout()), true);

  const terminate = simctlLaunchTimeout();
  (terminate as unknown as { spawnargs: string[] }).spawnargs = [
    'simctl',
    'terminate',
    'booted',
    APP_ID,
  ];
  assert.equal(isSimctlLaunchTimeout(terminate), false);

  const adb = simctlLaunchTimeout();
  Object.assign(adb, { path: 'adb', spawnargs: ['shell', 'monkey', '-p', APP_ID] });
  assert.equal(isSimctlLaunchTimeout(adb), false);

  const missingBinary = Object.assign(new Error('spawnSync xcrun ENOENT'), {
    code: 'ENOENT',
    path: 'xcrun',
    spawnargs: ['simctl', 'launch', 'booted', APP_ID],
  });
  assert.equal(isSimctlLaunchTimeout(missingBinary), false);

  assert.equal(isSimctlLaunchTimeout(new Error('boom')), false);
  assert.equal(isSimctlLaunchTimeout(null), false);
});
