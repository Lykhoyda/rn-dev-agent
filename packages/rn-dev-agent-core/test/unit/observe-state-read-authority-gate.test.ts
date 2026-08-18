// GH #791: the exact production failure path behind the Observe evidence —
// an install-unbound session must reach the /api/state envelope as a typed
// APP_INSTALL_IDENTITY_CHANGED refusal (code intact), and a fully bound
// session must serve the live payload through the same gate.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAuthorityGate } from '../../dist/session/authority-gate.js';
import { buildStateRead } from '../../dist/observability/state-read.js';
import { okResult, type ToolResult } from '../../dist/utils.js';

interface FixtureStatus {
  bindings: Record<string, unknown>;
  [k: string]: unknown;
}

function fixture({ installBound }: { installBound: boolean }): {
  runtime: { requireAvailable: () => unknown; status: () => FixtureStatus };
} {
  const bindings: Record<string, unknown> = {
    metro: { instanceId: 'metro', port: 8193 },
    bundle: {
      targetId: 'target-1',
      connectionGeneration: 1,
      authorityScope: 'initial-bundle',
      sourceFidelity: 'not-proven',
    },
    device: { platform: 'ios', deviceId: 'device', appId: 'dev.example' },
    runner: { instanceId: 'runner' },
    observe: { instanceId: 'observe' },
  };
  if (installBound) {
    bindings.install = {
      digest: 'install',
      platform: 'ios',
      deviceId: 'device',
      appId: 'dev.example',
    };
  }
  const operationAxes = new Set<string>();
  const status: FixtureStatus = {
    available: true,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git', appRoot: process.cwd() },
    bindings,
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_s: unknown, input: { operationId: string; profile: string[] }) => {
      operationAxes.clear();
      for (const axis of input.profile) operationAxes.add(axis);
      return {
        operationId: input.operationId,
        sessionId: 'session-a',
        claimEpoch: 4,
        authorityVersion: 9,
      };
    },
    getClaim: () => null,
    verifyOperation: () => {},
    operationHasAxis: (_o: unknown, axis: string) => operationAxes.has(axis),
    beginOperationAxisAdmission: () => {},
    completeOperationAxisAdmission: (_o: unknown, axis: string, admitted: boolean) => {
      if (admitted) operationAxes.add(axis);
    },
    runWithOperation: async (_o: unknown, cb: () => unknown) => cb(),
    commitPlatformAuthorityReceipts: () => {},
    endOperation: () => {},
    cancelOperation: () => {},
    updateBindings: () => {},
    endOperationWithBindings: () => {},
    refreshOperation: (operation: object) => ({
      ...operation,
      authorityVersion: status.authorityVersion,
    }),
    replaceBindingsDuringOperation: (operation: object) => operation,
  };
  const runtime = {
    requireAvailable: () => ({
      registry,
      session: { sessionId: 'session-a', claimEpoch: 4 },
    }),
    status: () => status,
  };
  return { runtime };
}

function buildRead(installBound: boolean): (kind: string) => Promise<unknown | null> {
  const { runtime } = fixture({ installBound });
  const gate = createAuthorityGate(runtime as Parameters<typeof createAuthorityGate>[0], {
    probe: async ({ axis }: { axis: string }) => ({
      axis,
      identity: `${axis}-identity`,
    }),
  });
  const handler = async (): Promise<ToolResult> =>
    okResult({
      routeName: 'LiveHome',
      index: 0,
      routes: [{ name: 'LiveHome' }],
    });
  // Mirrors index.ts gatedObserveState: the gate wraps the raw panel handler.
  const wrapped = gate.wrap(
    'cdp_navigation_state',
    handler as (...a: unknown[]) => Promise<unknown>,
  );
  return buildStateRead({
    acquire: () => ({ ok: true, release: () => {} }),
    handlers: {
      route: () => wrapped({}) as Promise<ToolResult>,
      store: () => wrapped({}) as Promise<ToolResult>,
      tree: () => wrapped({}) as Promise<ToolResult>,
    },
  });
}

test('install-unbound session: /api/state envelope is the typed authority refusal', async () => {
  const read = buildRead(false);
  const out = (await read('route')) as {
    ok: boolean;
    code?: string;
    error?: string;
  };
  assert.equal(out.ok, false);
  assert.equal(out.code, 'APP_INSTALL_IDENTITY_CHANGED');
  assert.match(out.error ?? '', /I authority is not bound/);
});

test('fully bound session: the same gate serves the live payload', async () => {
  const read = buildRead(true);
  const out = (await read('route')) as {
    ok: boolean;
    data?: { routeName?: string };
  };
  assert.equal(out.ok, true);
  assert.equal(out.data?.routeName, 'LiveHome');
});
