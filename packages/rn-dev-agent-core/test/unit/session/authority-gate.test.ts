import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  claimOptionalBundleAuthority,
  createAuthorityGate,
} from '../../../dist/session/authority-gate.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';
import { okResult } from '../../../dist/utils.js';

function fixture() {
  const calls = [];
  const status = {
    available: true,
    sessionId: 'session-a',
    sourceKey: 'source',
    worktreeKey: 'worktree',
    appRootKey: 'app',
    state: 'ready',
    claimEpoch: 4,
    authorityVersion: 9,
    leaseUntilMs: 1000,
    source: { kind: 'git' },
    bindings: {
      install: {
        digest: 'install',
        platform: 'ios',
        deviceId: 'device',
        appId: 'dev.example',
      },
      metro: { instanceId: 'metro', port: 8193 },
      bundle: { authorityScope: 'initial-bundle', sourceFidelity: 'not-proven' },
      device: { platform: 'ios', deviceId: 'device', appId: 'dev.example' },
      runner: { instanceId: 'runner' },
      observe: { instanceId: 'observe' },
      proof: { runId: 'proof' },
    },
    claims: [],
    worker: { instanceId: 'worker', pid: 1, birthAvailable: true },
  };
  const registry = {
    beginOperation: (_session, input) => {
      calls.push(`begin:${input.tool}`);
      return {
        operationId: input.operationId,
        sessionId: 'session-a',
        claimEpoch: 4,
        authorityVersion: 9,
      };
    },
    verifyOperation: () => calls.push('cas'),
    runWithOperation: async (_operation, callback) => callback(),
    commitPlatformAuthorityReceipts: () => calls.push('commit-receipts'),
    endOperation: () => calls.push('end'),
    cancelOperation: () => calls.push('cancel'),
    refreshOperation: (operation) => {
      calls.push('refresh-operation');
      return { ...operation, authorityVersion: status.authorityVersion };
    },
    replaceBindingsDuringOperation: (operation) => {
      calls.push('replace-binding');
      return { ...operation, authorityVersion: operation.authorityVersion + 1 };
    },
  };
  const runtime = {
    requireAvailable: () => ({
      registry,
      session: { sessionId: 'session-a', claimEpoch: 4 },
    }),
    status: () => status,
  };
  return { calls, registry, runtime, status };
}

test('authoritative tools receive preflight/postflight receipts and an immediate CAS', async () => {
  const { calls, runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });
  const wrapped = gate.wrap('cdp_interact', async () => {
    calls.push('dispatch');
    return okResult({ pressed: true });
  });

  const result = await wrapped({});
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityReceipt.bundle.sourceFidelity, 'not-proven');
  assert.deepEqual(
    calls.filter((call) => call.includes(':B')),
    ['preflight:B', 'postflight:B'],
  );
  assert.ok(calls.indexOf('cas') < calls.indexOf('dispatch'));
  assert.equal(calls.at(-1), 'end');
});

test('postflight drift rejects the result instead of returning a false success', async () => {
  const { runtime } = fixture();
  let postflight = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      if (phase === 'postflight') postflight = true;
      return {
        axis,
        identity: postflight && axis === 'D' ? 'foreign-device' : `${axis}-identity`,
      };
    },
  });

  const result = await gate.wrap('cdp_interact', async () => okResult({ pressed: true }))({});
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
  assert.equal(envelope.data, undefined);
});

test('reload atomically replaces target authority and permits only B-axis identity change', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'old-target';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => ({
      axis,
      identity: axis === 'B' ? `${phase}-bundle` : `${axis}-identity`,
    }),
    refreshRuntimeBinding: async () => {
      calls.push('refresh-binding');
      status.authorityVersion += 1;
      status.bindings.bundle = {
        ...status.bindings.bundle,
        targetId: 'new-target',
      };
      return status.bindings.bundle;
    },
  });

  const result = await gate.wrap('cdp_reload', async () => okResult({ reloaded: true }))({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.deepEqual(
    calls.filter((call) => call === 'refresh-binding' || call === 'replace-binding'),
    ['refresh-binding', 'replace-binding'],
  );
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 10);
});

test('failed reload invalidates stale bundle authority under the active fence', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'old-target';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('cdp_reload', async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: 'RECONNECT_TIMEOUT',
          error: 'target did not return',
        }),
      },
    ],
    isError: true,
  }))({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'RECONNECT_TIMEOUT');
  assert.equal(envelope.meta.authorityInvalidated, true);
  assert.equal(calls.filter((call) => call === 'replace-binding').length, 1);
  assert.equal(
    calls.some((call) => call === 'postflight:B'),
    false,
  );
});

test('native profiles never request a live bundle probe', async () => {
  const { runtime, calls } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  await gate.wrap('device_press', async () => okResult({ pressed: true }))({});
  assert.equal(
    calls.some((call) => call.endsWith(':B')),
    false,
  );
});

test('run-action claims bundle authority only when its CDP path is used', async () => {
  const native = fixture();
  native.status.bindings.bundle.targetId = 'target-a';
  native.status.bindings.bundle.connectionGeneration = 1;
  const nativeGate = createAuthorityGate(native.runtime, {
    probe: async ({ axis, phase }) => {
      native.calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
    refreshRuntimeBinding: async () => {
      native.calls.push('refresh-binding');
      return native.status.bindings.bundle;
    },
  });

  await nativeGate.wrap('cdp_run_action', async () => okResult({ transport: 'maestro' }))({});
  assert.equal(
    native.calls.some((call) => call.endsWith(':B')),
    false,
  );
  assert.equal(native.calls.includes('refresh-binding'), true);

  const cdp = fixture();
  cdp.status.bindings.bundle.targetId = 'target-a';
  cdp.status.bindings.bundle.connectionGeneration = 1;
  const cdpGate = createAuthorityGate(cdp.runtime, {
    probe: async ({ axis, phase }) => {
      cdp.calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
    refreshRuntimeBinding: async () => cdp.status.bindings.bundle,
  });
  const result = await cdpGate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), true);
    return okResult({ transport: 'cdp-js' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.deepEqual(
    cdp.calls.filter((call) => call.endsWith(':B')),
    ['preflight:B', 'postflight:B'],
  );
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    true,
  );
});

test('optional bundle admission propagates operation fence loss', async () => {
  const { registry, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  let verifications = 0;
  registry.verifyOperation = () => {
    verifications += 1;
    if (verifications === 2) {
      throw new Error('AUTHORITY_LOST_DURING_OPERATION: operation fence was replaced');
    }
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    refreshRuntimeBinding: async () => status.bindings.bundle,
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    await claimOptionalBundleAuthority(args);
    return okResult({ transport: 'cdp-js' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
});

test('optional bundle admission downgrades only a genuine bundle mismatch', async () => {
  const { runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'B') {
        throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: target generation changed');
      }
      return { axis, identity: `${axis}-identity` };
    },
    refreshRuntimeBinding: async () => status.bindings.bundle,
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), false);
    return okResult({ transport: 'maestro' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'), false);
});

test('reactive bundle admission reconciles the target replaced by the native attempt', async () => {
  const { calls, registry, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  let bundleProbes = 0;
  let refreshes = 0;
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push('replace-binding');
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: operation.authorityVersion + 1 };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'B') {
        bundleProbes += 1;
        if (bundleProbes === 1) {
          throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: native attempt not started');
        }
        if (bundleProbes === 2) {
          throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: native attempt replaced the target');
        }
      }
      return { axis, identity: `${axis}-identity` };
    },
    refreshRuntimeBinding: async () => {
      refreshes += 1;
      return {
        ...status.bindings.bundle,
        targetId: 'target-b',
        connectionGeneration: 2,
      };
    },
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), false);
    assert.equal(await claimOptionalBundleAuthority(args), true);
    return okResult({ transport: 'cdp-js' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(refreshes, 2);
  assert.equal(calls.filter((call) => call === 'replace-binding').length, 1);
  assert.equal(envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'), true);
});

test('reactive bundle admission verifies the refreshed target before replacing ownership', async () => {
  const { calls, registry, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  let bundleProbes = 0;
  const replacements = [];
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push('replace-binding');
    replacements.push(input);
    status.bindings = { ...status.bindings, ...input.bindings };
    return operation;
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'B') {
        bundleProbes += 1;
        if (bundleProbes === 1) {
          throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: native attempt not started');
        }
        if (bundleProbes === 2) {
          throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: native attempt replaced the target');
        }
        throw new Error('BUNDLE_IDENTITY_MISMATCH: refreshed target did not verify');
      }
      return { axis, identity: `${axis}-identity` };
    },
    refreshRuntimeBinding: async () => ({
      ...status.bindings.bundle,
      targetId: 'target-b',
      connectionGeneration: 2,
    }),
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), false);
    assert.equal(await claimOptionalBundleAuthority(args), false);
    return okResult({ transport: 'maestro' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityInvalidated, true);
  assert.equal(replacements.length, 1);
  assert.equal(replacements[0].bindings.bundle, null);
  assert.deepEqual(replacements[0].claimResources, undefined);
  assert.equal(status.bindings.bundle, null);
});

test('native run-action invalidates an unrecoverable prior bundle without losing native proof', async () => {
  const { calls, registry, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push('replace-binding');
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: operation.authorityVersion + 1 };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    refreshRuntimeBinding: async () => {
      throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: target did not return');
    },
  });

  const result = await gate.wrap('cdp_run_action', async () =>
    okResult({ transport: 'maestro' }),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityInvalidated, true);
  assert.equal(envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'), false);
  assert.equal(status.bindings.bundle, null);
});

test('native run-action reconciles a replaced runtime target without claiming bundle proof', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    refreshRuntimeBinding: async () => {
      calls.push('refresh-binding');
      status.bindings.bundle = {
        ...status.bindings.bundle,
        targetId: 'target-b',
        connectionGeneration: 2,
      };
      return status.bindings.bundle;
    },
  });

  const result = await gate.wrap('cdp_run_action', async () =>
    okResult({ transport: 'maestro' }),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.deepEqual(
    calls.filter((call) => call === 'refresh-binding' || call === 'replace-binding'),
    ['refresh-binding', 'replace-binding'],
  );
  assert.equal(envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'), false);
});

test('nested suite reload refreshes bundle generation under the outer fence', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => ({
      axis,
      identity:
        axis === 'B'
          ? `${status.bindings.bundle.targetId}:${status.bindings.bundle.connectionGeneration}`
          : `${axis}-identity`,
      detail: { phase },
    }),
    refreshRuntimeBinding: async () => {
      calls.push('refresh-binding');
      status.authorityVersion += 1;
      status.bindings.bundle = {
        ...status.bindings.bundle,
        connectionGeneration: 2,
      };
      return status.bindings.bundle;
    },
  });

  const result = await gate.wrap('cdp_run_e2e_suite', async () =>
    okResult({ verdict: 'passed', metroReloaded: true }),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.deepEqual(
    calls.filter((call) => call === 'refresh-binding' || call === 'replace-binding'),
    ['refresh-binding', 'replace-binding'],
  );
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 10);
});

test('legacy omitted targets are filled from the session before dispatch', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  let dispatched;
  await gate.wrap('device_deeplink', async (args) => {
    dispatched = args;
    return okResult({ opened: true });
  })({ url: 'example://route' });

  assert.equal(dispatched.platform, 'ios');
  assert.equal(dispatched.deviceId, 'device');
  assert.equal(dispatched.appId, 'dev.example');
  assert.equal(dispatched.bundleId, 'dev.example');
  assert.equal(dispatched.metroPort, 8193);
});

test('explicit target conflicts fail before the handler runs', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  let dispatched = false;
  const result = await gate.wrap('cdp_interact', async () => {
    dispatched = true;
    return okResult({ pressed: true });
  })({ deviceId: 'foreign-device' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(envelope.meta.axis, 'D');
  assert.match(envelope.meta.expected, /^[a-f0-9]{16}$/);
  assert.match(envelope.meta.observed, /^[a-f0-9]{16}$/);
  assert.match(envelope.meta.nextAction, /rn_session/);
});

test('diagnostic tools stay passive and explicitly non-authoritative', async () => {
  const gate = createAuthorityGate(
    {
      requireAvailable: () => {
        throw new Error('must not be called');
      },
      status: () => ({ available: false }),
    },
    {
      probe: async () => {
        throw new Error('must not probe');
      },
    },
  );
  const result = await gate.wrap('device_list', async () => okResult({ devices: [] }))({});
  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authoritative, false);
});

test('transition handlers remain fenced across their expected authority version advance', async () => {
  const { runtime, status, calls } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return {
        axis,
        identity: axis === 'C' ? `controller-v${status.authorityVersion}` : `${axis}-identity`,
      };
    },
  });

  const result = await gate.wrap('rn_session', async () => {
    status.authorityVersion += 1;
    return okResult({ bound: true });
  })({ action: 'bind_metro' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityTransition, true);
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 10);
  assert.equal(calls[0], 'begin:rn_session');
  assert.equal(calls.at(-1), 'end');
});

test('handoff cancellation requires controller authority and runs as a fenced transition', async () => {
  const { runtime, status, calls } = fixture();
  status.state = 'handoff';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('rn_session', async () => {
    status.state = 'ready';
    status.authorityVersion += 1;
    return okResult({ cancelled: true });
  })({ action: 'cancel_handoff', handoffId: 'handoff-a' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityTransition, true);
  assert.deepEqual(
    calls.filter((call) => call.endsWith(':C')),
    ['preflight:C', 'postflight:C'],
  );
});

test('handoff cancellation rejects a superseded controller before mutation', async () => {
  const { runtime, status } = fixture();
  status.state = 'handoff';
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'C') {
        throw new SessionAuthorityError('SESSION_OWNER_LOST', 'controller was superseded');
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('rn_session', async () => {
    dispatched = true;
    return okResult({ cancelled: true });
  })({ action: 'cancel_handoff', handoffId: 'handoff-a' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'SESSION_OWNER_LOST');
  assert.equal(dispatched, false);
});

test('warning results never receive an authoritative receipt', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('collect_logs', async () =>
    okResult(
      { sources: ['native'] },
      {
        meta: { warning: 'JavaScript logs unavailable' },
      },
    ),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authoritative, false);
  assert.equal(envelope.meta.authorityReceipt, undefined);
});

test('runner and Observe lifecycle transitions probe complete before and after axes', async () => {
  const { runtime, calls, status } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  await gate.wrap('device_snapshot', async () => {
    status.authorityVersion += 1;
    return okResult({ opened: true });
  })({
    action: 'open',
    platform: 'ios',
    deviceId: 'device',
    appId: 'dev.example',
  });
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:I', 'preflight:M', 'preflight:D'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    [
      'postflight:C',
      'postflight:S',
      'postflight:I',
      'postflight:M',
      'postflight:D',
      'postflight:R',
    ],
  );

  calls.length = 0;
  status.bindings.observe = { instanceId: 'observe' };
  await gate.wrap('observe', async () => {
    status.authorityVersion += 1;
    return okResult({ running: true });
  })({ action: 'start' });
  assert.ok(calls.includes('preflight:R'));
  assert.ok(calls.includes('postflight:O'));
});
