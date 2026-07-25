import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  completeManagedRunnerParkAuthority,
  completeManagedNativeOriginAuthority,
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
    source: { kind: 'git', appRoot: process.cwd() },
    bindings: {
      install: {
        digest: 'install',
        platform: 'ios',
        deviceId: 'device',
        appId: 'dev.example',
      },
      metro: { instanceId: 'metro', port: 8193 },
      bundle: {
        targetId: 'old-target',
        connectionGeneration: 1,
        authorityScope: 'initial-bundle',
        sourceFidelity: 'not-proven',
      },
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
    updateBindings: (_session, input) => {
      status.bindings = { ...status.bindings, ...input.bindings };
      status.authorityVersion += 1;
    },
    endOperationWithBindings: (_operation, bindings) => {
      calls.push('end-with-bindings');
      status.bindings = { ...status.bindings, ...bindings };
      status.authorityVersion += 1;
    },
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

test('finalized proof is discarded when postflight authority changes', async () => {
  const { runtime, status } = fixture();
  const actions = [];
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => ({
      axis,
      identity: phase === 'postflight' && axis === 'D' ? 'foreign-device' : `${axis}-identity`,
    }),
  });
  const result = await gate.wrap('proof_capture', async (args) => {
    actions.push(args.action);
    return okResult(args.action === 'discard' ? { discarded: true } : { stage: 'accepted' });
  })({ action: 'finalize', evidenceReview: {} });

  assert.equal(JSON.parse(result.content[0].text).ok, false);
  assert.deepEqual(actions, ['finalize', 'discard']);
  assert.equal(status.bindings.proof, null);
});

test('finalized proof cleanup retries before releasing its operation fence', async () => {
  const { runtime, registry, status } = fixture();
  const actions = [];
  const endOperationWithBindings = registry.endOperationWithBindings;
  let clearAttempts = 0;
  registry.endOperationWithBindings = (operation, bindings) => {
    clearAttempts += 1;
    if (clearAttempts === 1) throw new Error('transient registry write failure');
    endOperationWithBindings(operation, bindings);
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  const result = await gate.wrap('proof_capture', async (args) => {
    actions.push(args.action);
    return okResult(args.action === 'discard' ? { discarded: true } : { stage: 'accepted' });
  })({ action: 'finalize', evidenceReview: {} });

  assert.equal(JSON.parse(result.content[0].text).ok, false);
  assert.deepEqual(actions, ['finalize', 'discard']);
  assert.equal(clearAttempts, 2);
  assert.equal(status.bindings.proof, null);
});

test('failed finalized proof cleanup retains its operation fence', async () => {
  const { calls, runtime, registry } = fixture();
  const actions = [];
  registry.endOperationWithBindings = () => {
    throw new Error('persistent registry write failure');
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  const result = await gate.wrap('proof_capture', async (args) => {
    actions.push(args.action);
    return okResult(args.action === 'discard' ? { discarded: true } : { stage: 'accepted' });
  })({ action: 'finalize', evidenceReview: {} });

  assert.equal(JSON.parse(result.content[0].text).ok, false);
  assert.deepEqual(actions, ['finalize', 'discard']);
  assert.equal(calls.includes('end'), false);
  assert.equal(calls.includes('cancel'), false);
});

test('authoritative source paths cannot escape the bound app root', async () => {
  const { runtime } = fixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  const result = await gate.wrap('cdp_run_action', async () => {
    dispatched = true;
    return okResult({});
  })({ actionId: 'login', projectRoot: resolve(process.cwd(), '..') });

  const envelope = JSON.parse(result.content[0].text);
  assert.equal(envelope.code, 'SOURCE_WORKTREE_MISMATCH');
  assert.equal(dispatched, false);
});

test('origin-disrupting lifecycle tools replace bundle authority at successful completion', async () => {
  const { runtime, registry, calls, status } = fixture();
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push('replace-binding');
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase, status: probeStatus }) => {
      calls.push(`${phase}:${axis}`);
      return {
        axis,
        identity:
          axis === 'B'
            ? `${probeStatus.bindings.bundle.targetId}:${probeStatus.bindings.bundle.connectionGeneration}`
            : `${axis}-identity`,
      };
    },
    refreshRuntimeBinding: async () => ({
      ...status.bindings.bundle,
      targetId: 'new-target',
      connectionGeneration: 2,
    }),
  });

  const result = await gate.wrap('device_reset_state', async (args) => {
    await completeManagedNativeOriginAuthority(args, true);
    return okResult({ reset: true });
  })({ relaunch: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(calls.includes('preflight:A'), false);
  assert.equal(calls.includes('postflight:A'), true);
  assert.equal(calls.includes('postflight:B'), true);
  assert.equal(status.bindings.bundle.targetId, 'new-target');
  assert.equal(
    envelope.meta.authorityReceipt.nativeAppOrigin.authorityScope,
    'live-metro-target-device',
  );
});

test('origin-disrupting lifecycle tools invalidate bundle authority when no target remains', async () => {
  const { runtime, registry, status } = fixture();
  registry.replaceBindingsDuringOperation = (operation, input) => {
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('maestro_run', async (args) => {
    await completeManagedNativeOriginAuthority(args, false);
    return okResult({ stopped: true });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(status.bindings.bundle, null);
  assert.equal(envelope.meta.authorityReceipt.nativeAppOrigin, undefined);
});

test('Maestro parking transactionally releases runner authority before dispatch', async () => {
  const { runtime, registry, status, calls } = fixture();
  status.bindings.runner = {
    platform: 'ios',
    deviceId: 'device',
    port: 9100,
    instanceId: 'runner',
  };
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push(`release:${input.releaseResources?.[0]?.key}`);
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('maestro_run', async (args) => {
    await completeManagedRunnerParkAuthority(args);
    return okResult({ passed: true });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(status.bindings.runner, null);
  assert.ok(calls.includes('release:ios:device:9100'));
  assert.equal(calls.includes('postflight:R'), false);
  assert.equal(envelope.meta.authorityReceipt.axes.includes('R'), false);
});

test('failed managed origin proof invalidates prior bundle authority', async () => {
  const { runtime, registry, status } = fixture();
  registry.replaceBindingsDuringOperation = (operation, input) => {
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'A') {
        throw new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'foreign Metro target');
      }
      return { axis, identity: `${axis}-identity` };
    },
    refreshRuntimeBinding: async () => {
      throw new Error('must not refresh after failed origin proof');
    },
  });

  const result = await gate.wrap('maestro_run', async (args) => {
    await completeManagedNativeOriginAuthority(args, true);
    return okResult({ launched: true });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'METRO_ORIGIN_MISMATCH');
  assert.equal(status.bindings.bundle, null);
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
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    false,
  );
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
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    true,
  );
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

test('later verified bundle admission clears an earlier recovery failure', async () => {
  const { calls, registry, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  let bundleProbes = 0;
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
        if (bundleProbes === 1 || bundleProbes === 3) {
          throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: native attempt replaced the target');
        }
        if (bundleProbes === 2) {
          throw new Error('BUNDLE_IDENTITY_MISMATCH: refreshed target was not ready');
        }
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
    assert.equal(await claimOptionalBundleAuthority(args), true);
    return okResult({ transport: 'cdp-js' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityInvalidated, undefined);
  assert.equal(status.bindings.bundle.targetId, 'target-b');
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    true,
  );
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

  const result = await gate.wrap('cdp_run_action', async () => okResult({ transport: 'maestro' }))(
    {},
  );
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityInvalidated, true);
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    false,
  );
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

  const result = await gate.wrap('cdp_run_action', async () => okResult({ transport: 'maestro' }))(
    {},
  );
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.deepEqual(
    calls.filter((call) => call === 'refresh-binding' || call === 'replace-binding'),
    ['refresh-binding', 'replace-binding'],
  );
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    false,
  );
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

test('repeated Observe start is an authoritative idempotent read of the existing binding', async () => {
  const { runtime, calls } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('observe', async () => okResult({ running: true }))({
    action: 'start',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityTransition, undefined);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:O'],
  );
});

test('Observe stop requires only controller, source, and Observe authority', async () => {
  const { runtime, status, calls } = fixture();
  status.bindings.bundle = null;
  status.bindings.runner = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('observe', async () => {
    status.bindings.observe = null;
    status.authorityVersion += 1;
    return okResult({ running: false });
  })({ action: 'stop' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:O'],
  );
});

test('unbound CDP disconnect is an idempotent authoritative operation', async () => {
  const { runtime, status, calls } = fixture();
  status.bindings.bundle = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('cdp_disconnect', async () => okResult({ disconnected: true }))(
    {},
  );
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityTransition, undefined);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S'],
  );
});

test('failed proof binding discards the rehearsal state created by the handler', async () => {
  const { runtime, registry, status } = fixture();
  const actions: string[] = [];
  (registry as typeof registry & { updateBindings(): never }).updateBindings = () => {
    throw new Error('registry write failed');
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('proof_capture', async (args: { action: string }) => {
    actions.push(args.action);
    return okResult(args.action === 'discard' ? { discarded: true } : { rehearsing: true });
  })({ action: 'begin_rehearsal', runId: 'proof-new' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /registry write failed/);
  assert.deepEqual(actions, ['begin_rehearsal', 'discard']);
  assert.equal(status.bindings.proof.runId, 'proof');
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

test('warning lifecycle transitions reconcile and commit staged platform receipts', async () => {
  const { runtime, status, calls } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_snapshot', async () => {
    status.authorityVersion += 1;
    return okResult({ opened: true }, { meta: { warning: 'snapshot is partial' } });
  })({
    action: 'open',
    platform: 'ios',
    deviceId: 'device',
    appId: 'dev.example',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.meta.warning, 'snapshot is partial');
  assert.equal(envelope.meta.authorityTransition, true);
  assert.equal(calls.includes('postflight:R'), true);
  assert.equal(calls.includes('commit-receipts'), true);
});

test('runner transitions and idempotent Observe starts probe their exact axes', async () => {
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
    return okResult({ running: true });
  })({ action: 'start' });
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:O'],
  );
  assert.ok(calls.includes('postflight:O'));
});

test('iOS hard reset resolves its runner transition after session argument binding', async () => {
  const { runtime, registry, calls, status } = fixture();
  status.bindings.bundle.targetId = 'old-target';
  status.bindings.bundle.connectionGeneration = 1;
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push('replace-binding');
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase, status: probeStatus }) => {
      calls.push(`${phase}:${axis}`);
      const bundle = probeStatus.bindings.bundle;
      return {
        axis,
        identity:
          axis === 'B' ? `${bundle.targetId}:${bundle.connectionGeneration}` : `${axis}-identity`,
      };
    },
    refreshRuntimeBinding: async () => ({
      ...status.bindings.bundle,
      targetId: 'new-target',
      connectionGeneration: 2,
    }),
  });
  const input: Record<string, unknown> = { hardReset: true };

  const result = await gate.wrap('cdp_restart', async () => {
    status.bindings.runner = null;
    status.authorityVersion += 1;
    return okResult({ restarted: true });
  })(input);
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(input.platform, 'ios');
  assert.equal(calls.includes('preflight:R'), true);
  assert.equal(calls.includes('postflight:R'), false);
  assert.equal(status.bindings.bundle.targetId, 'new-target');
  assert.equal(calls.includes('replace-binding'), true);
});

test('failed iOS hard reset invalidates stale bundle authority', async () => {
  const { runtime, registry, calls, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'old-target';
  const replacements = [];
  registry.replaceBindingsDuringOperation = (operation, input) => {
    calls.push('replace-binding');
    replacements.push(input);
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('cdp_restart', async () => {
    status.bindings.runner = null;
    status.authorityVersion += 1;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: false,
            code: 'APP_NOT_INSTALLED',
            error: 'app is not installed',
          }),
        },
      ],
      isError: true,
    };
  })({ hardReset: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'APP_NOT_INSTALLED');
  assert.equal(envelope.meta.authorityInvalidated, true);
  assert.equal(status.bindings.bundle, null);
  assert.deepEqual(replacements[0].releaseResources, [{ type: 'target', key: '8193:old-target' }]);
  assert.equal(
    calls.some((call) => call.startsWith('postflight:')),
    false,
  );
});

test('iOS hard reset returns a typed failure for conflicting session arguments', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('cdp_restart', async () => okResult({ restarted: true }))({
    hardReset: true,
    platform: 'android',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'DEVICE_AUTHORITY_MISMATCH');
});
