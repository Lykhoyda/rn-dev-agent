import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { CDPClient } from '../cdp-client.js';
import { filterValidTargets, targetMatchesBundleId } from '../cdp/discovery.js';
import { cwdForPort, pathMatchesRoot } from '../cdp/metro-cwd.js';
import type { HermesTarget } from '../types.js';
import { captureInstalledArtifact, verifyInstalledArtifact } from './install-authority.js';
import type { AuthorityObservation } from './authority-gate.js';
import { verifyMetroAuthorityMarker, type MetroAuthorityMarker } from './metro-authority.js';
import { metroListenerPid } from './metro-binding.js';
import { inspectSessionOwner } from './process-owner.js';
import { readProcessBirth } from './process-birth.js';
import { SessionAuthorityError, type SessionStatus } from './registry.js';
import type { WorkerAuthorityRuntime } from './runtime.js';
import { resolveSourceIdentity, type SourceIdentity } from './source-identity.js';
import {
  proveTargetDeviceAssociations,
  type TargetDeviceAssociations,
} from './target-device-authority.js';
import type { AuthorityAxis } from './tool-profiles.js';

interface LocalAuthorityProbeDependencies {
  runtime: WorkerAuthorityRuntime;
  getClient: () => CDPClient;
  getSecret: () => { signerCapability?: string; observeCapability?: string } | null;
  resolveSource?: (status: SessionStatus) => SourceIdentity;
  fetchText?: (url: string, init?: RequestInit) => Promise<string>;
  fetchJson?: (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
  fetchTargets?: (port: number) => Promise<HermesTarget[]>;
  proveTargetDevices?: (input: TargetDeviceAssociations) => Promise<void>;
  deviceExists?: (platform: 'ios' | 'android', deviceId: string) => boolean;
  proofActive?: (runId: string) => boolean;
  inspectOwner?: typeof inspectSessionOwner;
  captureInstalled?: typeof captureInstalledArtifact;
}

function identity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function objectBinding(status: SessionStatus, name: string): Record<string, unknown> {
  const value = status.bindings[name];
  if (!value || typeof value !== 'object') {
    throw new SessionAuthorityError(
      name === 'bundle' ? 'BUNDLE_HANDSHAKE_UNAVAILABLE' : 'SESSION_AUTHORITY_REQUIRED',
      `${name} authority is not bound`,
    );
  }
  return value as Record<string, unknown>;
}

function defaultSource(status: SessionStatus): SourceIdentity {
  const stored = status.source as unknown as SourceIdentity;
  return resolveSourceIdentity(
    stored.appRoot,
    stored.kind === 'declared-root'
      ? {
          declaredRoot: stored.contentRoot,
          declaredManifests: stored.declaredManifests,
        }
      : {},
  );
}

async function defaultFetchText(url: string, init?: RequestInit): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function defaultFetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  return JSON.parse(await defaultFetchText(url, init)) as Record<string, unknown>;
}

function defaultDeviceExists(platform: 'ios' | 'android', deviceId: string): boolean {
  if (platform === 'ios') {
    const output = execFileSync('xcrun', ['simctl', 'list', 'devices', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    const parsed = JSON.parse(output) as {
      devices?: Record<string, Array<{ udid?: string; isAvailable?: boolean }>>;
    };
    return Object.values(parsed.devices ?? {})
      .flat()
      .some((device) => device.udid === deviceId && device.isAvailable !== false);
  }
  const output = execFileSync('adb', ['devices'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  });
  return output
    .split('\n')
    .some((line) => line.split(/\s+/)[0] === deviceId && /\sdevice\s*$/.test(line));
}

function sameSource(expected: SourceIdentity, observed: SourceIdentity): boolean {
  return (
    expected.kind === observed.kind &&
    expected.sourceKey === observed.sourceKey &&
    expected.worktreeKey === observed.worktreeKey &&
    expected.appRootKey === observed.appRootKey &&
    (expected.kind !== 'declared-root' ||
      (observed.kind === 'declared-root' && expected.manifestDigest === observed.manifestDigest))
  );
}

export function createLocalAuthorityProbe(
  dependencies: LocalAuthorityProbeDependencies,
): (input: {
  axis: AuthorityAxis;
  phase: 'preflight' | 'postflight';
  status: SessionStatus;
  tool?: string;
  args?: Record<string, unknown>;
}) => Promise<AuthorityObservation> {
  const fetchText = dependencies.fetchText ?? defaultFetchText;
  const fetchJson = dependencies.fetchJson ?? defaultFetchJson;
  const fetchTargets =
    dependencies.fetchTargets ??
    (async (port: number) =>
      JSON.parse(await fetchText(`http://127.0.0.1:${port}/json/list`)) as HermesTarget[]);
  const proveTargetDevices =
    dependencies.proveTargetDevices ??
    ((input: TargetDeviceAssociations) =>
      proveTargetDeviceAssociations(input, {
        execute: async (file, args) => ({
          stdout: execFileSync(file, args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5_000,
          }),
        }),
      }));
  const sourceResolver = dependencies.resolveSource ?? defaultSource;
  const deviceExists = dependencies.deviceExists ?? defaultDeviceExists;
  const inspectOwner = dependencies.inspectOwner ?? inspectSessionOwner;
  const captureInstalled = dependencies.captureInstalled ?? captureInstalledArtifact;

  return async ({ axis, phase, status, tool, args }) => {
    if (axis === 'C') {
      const { registry, session } = dependencies.runtime.requireAvailable();
      const controller =
        phase === 'preflight' && tool === 'rn_session' && args?.action === 'cancel_handoff'
          ? registry.getHandoffCancellationControllerBinding(session)
          : registry.getControllerBinding(session);
      const supervisor = inspectOwner({
        sessionId: controller.sessionId,
        pid: controller.supervisor.pid,
        token: controller.supervisor.token,
      });
      const workerBirth =
        controller.worker.pid === process.pid && controller.worker.token
          ? readProcessBirth(process.pid)
          : null;
      if (
        supervisor !== 'match' ||
        !controller.worker.instanceId ||
        !workerBirth ||
        workerBirth.token !== controller.worker.token
      ) {
        throw new SessionAuthorityError(
          'SESSION_OWNER_LOST',
          'controller process identity no longer matches the fenced session',
        );
      }
      return { axis, identity: identity(controller) };
    }

    if (axis === 'S') {
      const expected = status.source as unknown as SourceIdentity;
      const observed = sourceResolver(status);
      if (!sameSource(expected, observed)) {
        throw new SessionAuthorityError(
          'SOURCE_WORKTREE_MISMATCH',
          'current source root does not match the session worktree identity',
        );
      }
      return {
        axis,
        identity: identity({
          kind: observed.kind,
          sourceKey: observed.sourceKey,
          worktreeKey: observed.worktreeKey,
          appRootKey: observed.appRootKey,
          ...(observed.kind === 'declared-root' ? { manifestDigest: observed.manifestDigest } : {}),
        }),
      };
    }

    if (axis === 'I') {
      const expected = objectBinding(status, 'install') as unknown as {
        platform: 'ios' | 'android';
        deviceId: string;
        appId: string;
        artifactDigest: string;
        installGeneration: string;
      };
      let observed: ReturnType<typeof captureInstalledArtifact>;
      try {
        observed = captureInstalled(expected);
        verifyInstalledArtifact(expected, observed);
      } catch {
        throw new SessionAuthorityError(
          'APP_INSTALL_IDENTITY_CHANGED',
          'installed artifact bytes no longer match the session build',
        );
      }
      return {
        axis,
        identity: identity({
          platform: expected.platform,
          deviceId: expected.deviceId,
          appId: expected.appId,
          artifactDigest: observed.artifactDigest,
          installGeneration: observed.installGeneration,
        }),
      };
    }

    if (axis === 'M') {
      const metro = objectBinding(status, 'metro');
      const port = Number(metro.port);
      const pid = Number(metro.pid);
      const birth = String(metro.birth ?? '');
      if (
        !Number.isSafeInteger(port) ||
        !Number.isSafeInteger(pid) ||
        !birth ||
        metroListenerPid(port) !== pid ||
        inspectSessionOwner({ sessionId: status.sessionId, pid, token: birth }) !== 'match'
      ) {
        throw new SessionAuthorityError(
          'METRO_INSTANCE_CHANGED',
          'Metro process identity no longer matches the bound instance',
        );
      }
      const statusText = await fetchText(`http://127.0.0.1:${port}/status`);
      if (!statusText.includes('packager-status:running')) {
        throw new SessionAuthorityError(
          'METRO_AUTHORITY_MISMATCH',
          'claimed Metro endpoint is not running',
        );
      }
      const servingRoot =
        cwdForPort(port) ??
        (metro.mode === 'managed' && typeof metro.servingRoot === 'string'
          ? metro.servingRoot
          : null);
      const expectedRoot = String((status.source as Record<string, unknown>).contentRoot ?? '');
      if (!servingRoot || !pathMatchesRoot(servingRoot, expectedRoot)) {
        throw new SessionAuthorityError(
          'METRO_AUTHORITY_MISMATCH',
          'Metro serving root cannot be proven for this worktree',
        );
      }
      return {
        axis,
        identity: identity({
          instanceId: metro.instanceId,
          port,
          pid,
          birth,
          servingRoot,
          buildGeneration: metro.buildGeneration,
        }),
      };
    }

    if (axis === 'A') {
      const metro = objectBinding(status, 'metro');
      const device = objectBinding(status, 'device');
      const port = Number(metro.port);
      const platform = device.platform as 'ios' | 'android';
      const deviceId = String(device.deviceId ?? '');
      const appId = String(device.appId ?? '');
      if (
        !Number.isSafeInteger(port) ||
        (platform !== 'ios' && platform !== 'android') ||
        !deviceId ||
        !appId
      ) {
        throw new SessionAuthorityError(
          'METRO_ORIGIN_MISMATCH',
          'native app origin authority is incomplete',
        );
      }
      let targets: HermesTarget[];
      try {
        targets = filterValidTargets(await fetchTargets(port)).filter((target) =>
          targetMatchesBundleId(target, appId),
        );
      } catch {
        throw new SessionAuthorityError(
          'METRO_ORIGIN_MISMATCH',
          'authority-bound Metro targets could not be inspected',
        );
      }
      try {
        await proveTargetDevices({
          platform,
          deviceId,
          targetDeviceNames: targets.map(({ deviceName }) => deviceName),
        });
      } catch {
        throw new SessionAuthorityError(
          'METRO_ORIGIN_MISMATCH',
          'the claimed device app is not attached to the authority-bound Metro',
        );
      }
      return {
        axis,
        identity: identity({
          port,
          platform,
          deviceId,
          appId,
        }),
        detail: { authorityScope: 'live-metro-target-device' },
      };
    }

    if (axis === 'B') {
      const client = dependencies.getClient();
      const bundle = objectBinding(status, 'bundle');
      if (!client.isConnected || !client.connectedTarget) {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'live CDP runtime is unavailable for bundle verification',
        );
      }
      let evaluated: Awaited<ReturnType<CDPClient['evaluate']>>;
      try {
        evaluated = await client.evaluate(
          'JSON.stringify(globalThis.__RN_DEV_AGENT_AUTHORITY__ ?? null)',
        );
      } catch {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'live CDP runtime could not be evaluated for bundle verification',
        );
      }
      if (typeof evaluated.value !== 'string') {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'runtime did not expose a signed authority marker',
        );
      }
      let outer: { status?: string; marker?: MetroAuthorityMarker } | null;
      try {
        outer = JSON.parse(evaluated.value) as {
          status?: string;
          marker?: MetroAuthorityMarker;
        } | null;
      } catch {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'live CDP runtime returned an invalid bundle authority marker',
        );
      }
      const signerCapability = dependencies.getSecret()?.signerCapability;
      if (!outer?.marker || outer.status !== 'signed' || !signerCapability) {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'signed authority marker or signer capability is unavailable',
        );
      }
      verifyMetroAuthorityMarker(outer.marker, signerCapability, {
        sessionId: status.sessionId,
        metroInstanceId: String(bundle.metroInstanceId),
        worktreeKey: status.worktreeKey,
        appId: String(bundle.appId),
        platform: bundle.platform as 'ios' | 'android',
        buildGeneration: Number(bundle.buildGeneration),
      });
      if (
        client.connectedTarget.id !== bundle.targetId ||
        client.connectionGeneration !== bundle.connectionGeneration
      ) {
        throw new SessionAuthorityError(
          'CDP_TARGET_AUTHORITY_MISMATCH',
          'CDP target generation no longer matches the pinned bundle',
        );
      }
      return {
        axis,
        identity: identity({
          payload: outer.marker.payload,
          targetId: client.connectedTarget.id,
          connectionGeneration: client.connectionGeneration,
        }),
        detail: { authorityScope: 'initial-bundle', sourceFidelity: 'not-proven' },
      };
    }

    if (axis === 'D') {
      const device = objectBinding(status, 'device');
      const platform = device.platform as 'ios' | 'android';
      const deviceId = String(device.deviceId ?? '');
      if (
        (platform !== 'ios' && platform !== 'android') ||
        !deviceId ||
        !deviceExists(platform, deviceId)
      ) {
        throw new SessionAuthorityError(
          'DEVICE_AUTHORITY_MISMATCH',
          'exact claimed device is no longer available',
        );
      }
      return { axis, identity: identity({ platform, deviceId }) };
    }

    if (axis === 'R') {
      const runner = objectBinding(status, 'runner');
      const port = Number(runner.port);
      const pid = Number(runner.pid);
      const processBirth = String(runner.processBirth ?? '');
      const capability = String(runner.capability ?? '');
      if (
        !Number.isSafeInteger(port) ||
        !Number.isSafeInteger(pid) ||
        !processBirth ||
        !capability ||
        inspectOwner({ sessionId: status.sessionId, pid, token: processBirth }) !== 'match'
      ) {
        throw new SessionAuthorityError(
          'RUNNER_OWNERSHIP_MISMATCH',
          'runner process identity and endpoint capability no longer match the binding',
        );
      }
      const health = await fetchJson(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${capability}` },
      });
      for (const key of ['instanceId', 'sessionId', 'claimEpoch', 'deviceId', 'appId']) {
        if (health[key] !== runner[key]) {
          throw new SessionAuthorityError(
            'RUNNER_OWNERSHIP_MISMATCH',
            `runner ${key} no longer matches the session binding`,
          );
        }
      }
      return { axis, identity: identity({ health, pid, processBirth }) };
    }

    if (axis === 'O') {
      const observe = objectBinding(status, 'observe');
      const port = Number(observe.port);
      const capability = dependencies.getSecret()?.observeCapability ?? '';
      const observed = await fetchJson(`http://127.0.0.1:${port}/api/authority`, {
        headers: {
          authorization: `Bearer ${capability}`,
          'x-rn-observe-instance': String(observe.instanceId ?? ''),
        },
      });
      if (observed.sessionId !== status.sessionId || observed.instanceId !== observe.instanceId) {
        throw new SessionAuthorityError(
          'OBSERVE_AUTHORITY_MISMATCH',
          'Observe endpoint no longer matches the session binding',
        );
      }
      return { axis, identity: identity(observed) };
    }

    const proof = objectBinding(status, 'proof');
    const runId = String(proof.runId ?? '');
    if (!runId || !dependencies.proofActive?.(runId)) {
      throw new SessionAuthorityError(
        'PROOF_AUTHORITY_MISMATCH',
        'strict proof run is not active under this session',
      );
    }
    return { axis, identity: identity({ runId, claimEpoch: status.claimEpoch }) };
  };
}
