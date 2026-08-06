// Seams of device-smoke.ts that can be proven without a device: the fixture
// cwd's declared (non-Git) source identity and the fixture-launch retry policy.
// Covered by test/unit/smoke/device-smoke-driver.test.ts.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIXTURE_MANIFEST = 'package.json';
export const LAUNCH_ATTEMPTS = 2;
export const FOREGROUND_TIMEOUT_MS = 30_000;

export interface DeclaredIdentityEnv {
  RN_DEV_AGENT_DECLARED_ROOT: string;
  RN_DEV_AGENT_DECLARED_MANIFESTS: string;
}

export interface DeclaredFixtureRoot {
  cwd: string;
  env: DeclaredIdentityEnv;
}

// The supervisor resolves source identity from its cwd; a bare temp dir is
// neither a Git worktree nor a declared root, so it must declare both axes
// (NON_GIT_MANIFEST_REQUIRED otherwise — GH #666).
export function createDeclaredFixtureRoot(): DeclaredFixtureRoot {
  const cwd = mkdtempSync(join(tmpdir(), 'rn-agent-smoke-'));
  writeFileSync(join(cwd, FIXTURE_MANIFEST), '{"name":"rn-agent-smoke-fixture","private":true}\n');
  return {
    cwd,
    env: {
      RN_DEV_AGENT_DECLARED_ROOT: cwd,
      RN_DEV_AGENT_DECLARED_MANIFESTS: FIXTURE_MANIFEST,
    },
  };
}

// Exactly `xcrun simctl launch` hitting its own timeout — the only launch
// failure the nightly proved to be runner-side CoreSimulator wedging rather
// than a real fault. A missing binary, a non-zero simctl status, or any other
// spawn is a truthful failure and must not be retried.
export function isSimctlLaunchTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const spawned = error as { code?: unknown; path?: unknown; spawnargs?: unknown };
  if (spawned.code !== 'ETIMEDOUT' || spawned.path !== 'xcrun') return false;
  const args: unknown[] = Array.isArray(spawned.spawnargs) ? spawned.spawnargs : [];
  return args[0] === 'simctl' && args[1] === 'launch';
}

export interface LaunchFixtureDeps {
  appId: string;
  launchOnce: () => void;
  isRunning: () => boolean;
  isRetryableLaunchTimeout: (error: unknown) => boolean;
  foregroundTimeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const describeFailure = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function launchFixtureWithRetry({
  appId,
  launchOnce,
  isRunning,
  isRetryableLaunchTimeout,
  foregroundTimeoutMs = FOREGROUND_TIMEOUT_MS,
  pollIntervalMs = 500,
  now = Date.now,
  sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
}: LaunchFixtureDeps): Promise<void> {
  const failures: string[] = [];
  let lastError: unknown;

  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    try {
      launchOnce();
    } catch (error) {
      if (!isRetryableLaunchTimeout(error)) throw error;
      lastError = error;
      failures.push(`attempt ${attempt} launch timed out (${describeFailure(error)})`);
      continue;
    }
    const deadline = now() + foregroundTimeoutMs;
    while (now() < deadline) {
      if (isRunning()) return;
      await sleep(pollIntervalMs);
    }
    failures.push(
      `attempt ${attempt} launched but ${appId} was not running within ${foregroundTimeoutMs}ms`,
    );
  }

  throw new Error(
    `fixture ${appId} did not start after ${LAUNCH_ATTEMPTS} launch attempts: ${failures.join('; ')}`,
    lastError === undefined ? undefined : { cause: lastError },
  );
}
