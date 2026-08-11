import type { CDPClient } from '../cdp-client.js';
import { CDPProbeTimeoutError } from '../cdp/connect.js';
import { targetMatchesSession } from '../tools/status.js';
import {
  filterTargetsForExactDevice,
  proveTargetDeviceAssociation,
  type TargetDeviceAuthorityDependencies,
} from './target-device-authority.js';

export interface ExactSessionTargetInput {
  metroPort: number;
  platform: 'ios' | 'android';
  appId: string;
  deviceId: string;
}

export interface ExactSessionTargetDependencies extends TargetDeviceAuthorityDependencies {
  getClient(): CDPClient;
  setClient(client: CDPClient): void;
  publishClient?(expected: CDPClient, replacement: CDPClient): boolean;
  createClient(port: number): CDPClient;
  createAttemptClient?(port: number): CDPClient;
  now?(): number;
  wait?(ms: number): Promise<void>;
  setDeadlineTimer?(callback: () => void, ms: number): unknown;
  clearDeadlineTimer?(timer: unknown): void;
}

export interface ExactSessionTargetConnection {
  targetId: string;
  connectionGeneration: number;
  deviceId: string;
  client: CDPClient;
  assertActive(): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  publish(): void;
  cancel(): void;
}

// GH #750: iOS dev-client re-registration after terminate+relaunch can exceed
// 15s, and each connect attempt restarts that clock — match Android (GH #724).
const IOS_EXACT_TARGET_READINESS_TIMEOUT_MS = 120_000;
const ANDROID_EXACT_TARGET_READINESS_TIMEOUT_MS = 120_000;

export function exactSessionTargetReadinessTimeoutMs(platform: 'ios' | 'android'): number {
  return platform === 'android'
    ? ANDROID_EXACT_TARGET_READINESS_TIMEOUT_MS
    : IOS_EXACT_TARGET_READINESS_TIMEOUT_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AndroidExactTargetDeadlineError extends Error {
  constructor(timeoutMs: number, leafError?: unknown) {
    const leaf =
      leafError === undefined ? 'no exact target was advertised' : errorMessage(leafError);
    super(
      `CDP_TARGET_AUTHORITY_MISMATCH: Android exact-target readiness exceeded its absolute ${timeoutMs}ms deadline. Last exact-connect failure: ${leaf}`,
      { cause: leafError },
    );
    this.name = 'AndroidExactTargetDeadlineError';
  }
}

async function connectExactAndroidSessionTarget(
  input: ExactSessionTargetInput,
  timeoutMs: number,
  dependencies: ExactSessionTargetDependencies,
): Promise<ExactSessionTargetConnection> {
  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const setDeadlineTimer =
    dependencies.setDeadlineTimer ??
    ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearDeadlineTimer =
    dependencies.clearDeadlineTimer ?? ((timer: unknown) => clearTimeout(timer as NodeJS.Timeout));
  const deadline = now() + timeoutMs;
  const ambientClient = dependencies.getClient();
  const ownedClients = new Set<CDPClient>();
  const closedClients = new Set<CDPClient>();
  const createAttemptClient = dependencies.createAttemptClient ?? dependencies.createClient;
  let exactClient = createAttemptClient(input.metroPort);
  ownedClients.add(exactClient);
  let lastError: unknown;
  let firstProbeError: CDPProbeTimeoutError | undefined;
  let expired = false;

  const closeOwned = (client: CDPClient): void => {
    if (!ownedClients.has(client) || closedClients.has(client)) return;
    closedClients.add(client);
    void client.disconnect().catch(() => {});
  };
  let published = false;
  const detachAttempt = (): void => {
    expired = true;
    if (!published) for (const client of ownedClients) closeOwned(client);
  };
  const deadlineError = (operationError?: unknown): AndroidExactTargetDeadlineError => {
    const leaf = firstProbeError ?? operationError ?? lastError;
    return new AndroidExactTargetDeadlineError(timeoutMs, leaf);
  };
  const awaitWithinDeadline = async <T>(operation: () => Promise<T>): Promise<T> => {
    const remainingMs = deadline - now();
    if (remainingMs <= 0 || expired) {
      detachAttempt();
      throw deadlineError();
    }
    let timer: unknown;
    const pendingOperation = operation();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setDeadlineTimer(() => {
        detachAttempt();
        reject(deadlineError());
      }, remainingMs);
    });
    try {
      return await Promise.race([
        pendingOperation.then(
          (value) => {
            if (expired || now() >= deadline) {
              detachAttempt();
              throw deadlineError();
            }
            return value;
          },
          (error: unknown) => {
            if (expired || now() >= deadline) {
              detachAttempt();
              throw deadlineError(error);
            }
            throw error;
          },
        ),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearDeadlineTimer(timer);
    }
  };
  const boundedAuthorityDependencies: TargetDeviceAuthorityDependencies = {
    ...dependencies,
    awaitWithinBoundary: awaitWithinDeadline,
  };

  while (now() < deadline) {
    try {
      const listed = await awaitWithinDeadline(() => exactClient.listTargetsExact(input.metroPort));
      if (listed.port !== input.metroPort) {
        throw new Error(
          'CDP_TARGET_AUTHORITY_MISMATCH: target discovery escaped the allocated Metro port',
        );
      }
      const sessionCandidates = listed.targets.filter((candidate) =>
        targetMatchesSession(candidate, {
          platform: input.platform,
          bundleId: input.appId,
        }),
      );
      const exactCandidates = await filterTargetsForExactDevice(
        {
          platform: input.platform,
          deviceId: input.deviceId,
          targets: sessionCandidates,
        },
        boundedAuthorityDependencies,
      );
      if (exactCandidates.length !== 1) {
        throw new Error(
          `CDP_TARGET_AUTHORITY_MISMATCH: expected one target on the exact device, found ${exactCandidates.length}`,
        );
      }

      await awaitWithinDeadline(() =>
        exactClient.connectExact(
          input.metroPort,
          {
            platform: input.platform,
            bundleId: input.appId,
            targetId: exactCandidates[0]!.id,
          },
          'default',
          1,
          awaitWithinDeadline,
        ),
      );
      const target = exactClient.connectedTarget;
      const connectionGeneration = exactClient.connectionGeneration;
      if (
        !target ||
        exactClient.metroPort !== input.metroPort ||
        !targetMatchesSession(target, {
          platform: input.platform,
          bundleId: input.appId,
        })
      ) {
        throw new Error(
          'CDP_TARGET_AUTHORITY_MISMATCH: exact dev-client target was not found on the claimed Metro',
        );
      }
      await proveTargetDeviceAssociation(
        {
          platform: input.platform,
          deviceId: input.deviceId,
          targetDeviceName: target.deviceName,
        },
        boundedAuthorityDependencies,
      );
      const assertStagedLive = (): void => {
        if (
          dependencies.getClient() !== ambientClient ||
          !exactClient.isConnected ||
          exactClient.metroPort !== input.metroPort ||
          exactClient.connectionGeneration !== connectionGeneration ||
          exactClient.connectedTarget?.id !== target.id ||
          !targetMatchesSession(exactClient.connectedTarget, {
            platform: input.platform,
            bundleId: input.appId,
          })
        ) {
          throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: staged exact client is no longer live');
        }
      };
      const assertActive = (): void => {
        if (expired || published || now() >= deadline) {
          detachAttempt();
          throw deadlineError();
        }
        try {
          assertStagedLive();
        } catch (error) {
          detachAttempt();
          throw error;
        }
      };
      assertStagedLive();
      return {
        targetId: target.id,
        connectionGeneration,
        deviceId: input.deviceId,
        client: exactClient,
        assertActive,
        run: awaitWithinDeadline,
        publish: () => {
          assertActive();
          const didPublish = dependencies.publishClient
            ? dependencies.publishClient(ambientClient, exactClient)
            : dependencies.getClient() === ambientClient
              ? (dependencies.setClient(exactClient), true)
              : false;
          if (!didPublish) {
            detachAttempt();
            throw new Error(
              'CDP_TARGET_AUTHORITY_MISMATCH: global client changed before exact publication',
            );
          }
          published = true;
          exactClient.publishLifecycleState();
          if (ambientClient !== exactClient) void ambientClient.disconnect().catch(() => {});
        },
        cancel: detachAttempt,
      };
    } catch (error) {
      if (error instanceof AndroidExactTargetDeadlineError) throw error;
      lastError = error;
      if (error instanceof CDPProbeTimeoutError) firstProbeError ??= error;
      closeOwned(exactClient);
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      detachAttempt();
      throw deadlineError();
    }
    await awaitWithinDeadline(() => wait(Math.min(250, remainingMs)));
    exactClient = createAttemptClient(input.metroPort);
    ownedClients.add(exactClient);
  }

  detachAttempt();
  throw deadlineError();
}

export async function connectExactSessionTarget(
  input: ExactSessionTargetInput,
  timeoutMs: number,
  dependencies: ExactSessionTargetDependencies,
): Promise<ExactSessionTargetConnection> {
  if (input.platform === 'android') {
    return connectExactAndroidSessionTarget(input, timeoutMs, dependencies);
  }

  const now = dependencies.now ?? Date.now;
  const wait =
    dependencies.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  let exactClient = dependencies.getClient();
  if (exactClient.metroPort !== input.metroPort) {
    await exactClient.disconnect();
    exactClient = dependencies.createClient(input.metroPort);
    dependencies.setClient(exactClient);
  }

  const deadline = now() + timeoutMs;
  let lastError: unknown;
  do {
    try {
      const listed = await exactClient.listTargetsExact(input.metroPort);
      if (listed.port !== input.metroPort) {
        throw new Error(
          'CDP_TARGET_AUTHORITY_MISMATCH: target discovery escaped the allocated Metro port',
        );
      }
      const sessionCandidates = listed.targets.filter((candidate) =>
        targetMatchesSession(candidate, {
          platform: input.platform,
          bundleId: input.appId,
        }),
      );
      const exactCandidates = await filterTargetsForExactDevice(
        {
          platform: input.platform,
          deviceId: input.deviceId,
          targets: sessionCandidates,
        },
        dependencies,
      );
      if (exactCandidates.length !== 1) {
        throw new Error(
          `CDP_TARGET_AUTHORITY_MISMATCH: expected one target on the exact device, found ${exactCandidates.length}`,
        );
      }

      await exactClient.connectExact(
        input.metroPort,
        {
          platform: input.platform,
          bundleId: input.appId,
          targetId: exactCandidates[0]!.id,
        },
        'default',
        5,
      );
      const target = exactClient.connectedTarget;
      if (
        !target ||
        exactClient.metroPort !== input.metroPort ||
        !targetMatchesSession(target, {
          platform: input.platform,
          bundleId: input.appId,
        })
      ) {
        throw new Error(
          'CDP_TARGET_AUTHORITY_MISMATCH: exact dev-client target was not found on the claimed Metro',
        );
      }
      await proveTargetDeviceAssociation(
        {
          platform: input.platform,
          deviceId: input.deviceId,
          targetDeviceName: target.deviceName,
        },
        dependencies,
      );
      return {
        targetId: target.id,
        connectionGeneration: exactClient.connectionGeneration,
        deviceId: input.deviceId,
        client: exactClient,
        assertActive: () => {},
        run: (operation) => operation(),
        publish: () => {},
        cancel: () => {},
      };
    } catch (error) {
      lastError = error;
    }

    const remainingMs = deadline - now();
    if (remainingMs > 0) await wait(Math.min(250, remainingMs));
  } while (now() < deadline);

  const leafError = lastError;
  const leaf = leafError === undefined ? 'no exact target was advertised' : errorMessage(leafError);
  throw new Error(
    `CDP_TARGET_AUTHORITY_MISMATCH: exact managed-Metro target did not re-register after launch. Last exact-connect failure: ${leaf}`,
    { cause: leafError },
  );
}
