import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import {
  completeManagedRunnerParkAuthority,
  completeManagedNativeOriginAuthority,
  claimOptionalBundleAuthority,
  createAuthorityGate,
  relaunchManagedNativeOriginApp,
  reproveManagedNativeOrigin,
} from '../../../dist/session/authority-gate.js';
import { SessionAuthorityError } from '../../../dist/session/registry.js';
import { failResult, okResult } from '../../../dist/utils.js';

function fixture() {
  const calls = [];
  const operationAxes = new Set();
  const pendingOperationAxes = new Set();
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
      operationAxes.clear();
      pendingOperationAxes.clear();
      for (const axis of input.profile) operationAxes.add(axis);
      return {
        operationId: input.operationId,
        sessionId: 'session-a',
        claimEpoch: 4,
        authorityVersion: 9,
      };
    },
    beginHandoffCancellationOperation: (_session, input) => {
      calls.push(`begin-handoff-cancellation:${input.tool}`);
      return {
        operationId: input.operationId,
        sessionId: 'session-a',
        claimEpoch: 4,
        authorityVersion: 9,
      };
    },
    getClaim: (type, key) => {
      calls.push(`claim:${type}:${key}`);
      return status.claims.find((claim) => claim.type === type && claim.key === key) ?? null;
    },
    verifyOperation: () => calls.push('cas'),
    operationHasAxis: (_operation, axis) => operationAxes.has(axis),
    beginOperationAxisAdmission: (_operation, axis) => {
      calls.push(`begin-operation-axis:${axis}`);
      pendingOperationAxes.add(axis);
    },
    completeOperationAxisAdmission: (_operation, axis, admitted) => {
      calls.push(`complete-operation-axis:${axis}:${admitted}`);
      pendingOperationAxes.delete(axis);
      if (admitted) operationAxes.add(axis);
    },
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
    replaceBindingsDuringOperation: (operation, input) => {
      calls.push('replace-binding');
      status.bindings = { ...status.bindings, ...input.bindings };
      status.authorityVersion += 1;
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

test('restored authoritative sessions reconnect and rebind before B preflight', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'persisted-target';
  status.bindings.bundle.connectionGeneration = 1;
  let recovered = false;
  const gate = createAuthorityGate(runtime, {
    recoverRuntimeConnection: async () => {
      calls.push('recover-runtime');
      recovered = true;
      return true;
    },
    refreshRuntimeBinding: async () => {
      calls.push('refresh-binding');
      return {
        ...status.bindings.bundle,
        targetId: 'restored-target',
        connectionGeneration: 2,
      };
    },
    probe: async ({ axis, phase, status: probedStatus }) => {
      if (axis === 'B') {
        assert.equal(recovered, true);
        assert.equal(probedStatus.bindings.bundle.targetId, 'restored-target');
        assert.equal(probedStatus.bindings.bundle.connectionGeneration, 2);
      }
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('cdp_console_log', async () => okResult({ entries: [] }))({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.ok(calls.indexOf('recover-runtime') < calls.indexOf('preflight:B'));
  assert.ok(calls.indexOf('replace-binding') < calls.indexOf('preflight:B'));
});

test('disconnected sessions without recoverable policy fail before dispatch', async () => {
  const { runtime } = fixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    recoverRuntimeConnection: async () => false,
    probe: async ({ axis }) => {
      if (axis === 'B') {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'persisted exact session policy is unavailable',
        );
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('cdp_console_log', async () => {
    dispatched = true;
    return okResult({ entries: [] });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'BUNDLE_HANDSHAKE_UNAVAILABLE');
  assert.equal(dispatched, false);
});

test('handler-time reconnect is rebound before bundle postflight', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'preflight-target';
  status.bindings.bundle.connectionGeneration = 1;
  let recoveryCalls = 0;
  const gate = createAuthorityGate(runtime, {
    recoverRuntimeConnection: async () => {
      recoveryCalls += 1;
      calls.push(`recover-runtime:${recoveryCalls}`);
      return recoveryCalls === 2;
    },
    refreshRuntimeBinding: async () => ({
      ...status.bindings.bundle,
      targetId: 'post-handler-target',
      connectionGeneration: 2,
    }),
    probe: async ({ axis, phase, status: probedStatus }) => {
      if (axis === 'B' && phase === 'postflight') {
        assert.equal(probedStatus.bindings.bundle.targetId, 'post-handler-target');
        assert.equal(probedStatus.bindings.bundle.connectionGeneration, 2);
      }
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('cdp_console_log', async () => okResult({ entries: [] }))({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.ok(calls.indexOf('recover-runtime:2') < calls.indexOf('postflight:B'));
  assert.ok(calls.indexOf('replace-binding') < calls.indexOf('postflight:B'));
});

test('failed handler preserves its error after reconnect reconciliation', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'preflight-target';
  status.bindings.bundle.connectionGeneration = 1;
  let recoveryCalls = 0;
  const gate = createAuthorityGate(runtime, {
    recoverRuntimeConnection: async () => {
      recoveryCalls += 1;
      return false;
    },
    runtimeConnectionChanged: () => true,
    refreshRuntimeBinding: async () => ({
      ...status.bindings.bundle,
      targetId: 'error-target',
      connectionGeneration: 2,
    }),
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('cdp_console_log', async () =>
    failResult('runtime loader rejected the bundle', 'LOAD_FAILED'),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'LOAD_FAILED');
  assert.equal(envelope.error, 'runtime loader rejected the bundle');
  assert.equal(status.bindings.bundle.targetId, 'error-target');
  assert.equal(status.bindings.bundle.connectionGeneration, 2);
  assert.ok(calls.includes('replace-binding'));
  assert.equal(recoveryCalls, 1);
});

test('failed reconnect does not start a second recovery cycle', async () => {
  const { runtime } = fixture();
  let recoveryCalls = 0;
  let changedChecks = 0;
  const gate = createAuthorityGate(runtime, {
    recoverRuntimeConnection: async () => {
      recoveryCalls += 1;
      return false;
    },
    runtimeConnectionChanged: () => {
      changedChecks += 1;
      return false;
    },
    refreshRuntimeBinding: async () => {
      throw new Error('unexpected binding refresh');
    },
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('cdp_console_log', async () =>
    failResult('Reconnection timed out. Call cdp_status to retry.', 'RECONNECT_TIMEOUT'),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'RECONNECT_TIMEOUT');
  assert.equal(recoveryCalls, 1);
  assert.equal(changedChecks, 1);
});

test('optional bundle admission records durable operation ownership', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  let recoveryCalls = 0;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    recoverRuntimeConnection: async () => {
      recoveryCalls += 1;
      return false;
    },
    refreshRuntimeBinding: async () => status.bindings.bundle,
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), true);
    return okResult({ transport: 'cdp-js' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.ok(calls.includes('begin-operation-axis:B'));
  assert.ok(calls.includes('complete-operation-axis:B:true'));
  assert.equal(recoveryCalls, 1);
});

test('optional bundle rejection clears pending ownership before native fallback', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  let recoveryCalls = 0;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'B') {
        throw new SessionAuthorityError(
          'BUNDLE_HANDSHAKE_UNAVAILABLE',
          'optional runtime marker is unavailable',
        );
      }
      return { axis, identity: `${axis}-identity` };
    },
    recoverRuntimeConnection: async () => {
      recoveryCalls += 1;
      throw new Error('unexpected optional fallback recovery');
    },
    refreshRuntimeBinding: async () => {
      throw new Error('unexpected optional fallback refresh');
    },
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), false);
    return okResult({ transport: 'maestro' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.ok(calls.includes('begin-operation-axis:B'));
  assert.ok(calls.includes('complete-operation-axis:B:false'));
  assert.equal(recoveryCalls, 0);
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

test('managed Android relaunch publishes only after staged proof and atomic promotion', async () => {
  const { runtime, registry, status } = fixture();
  status.bindings.device.platform = 'android';
  status.bindings.install.platform = 'android';
  const events: string[] = [];
  const candidate = {
    ...status.bindings.bundle,
    targetId: 'new-target',
    connectionGeneration: 2,
  };
  let publishedTarget = 'old-target';
  registry.replaceBindingsDuringOperation = (operation, input) => {
    input.assertBeforeCommit?.();
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    events.push('atomic-commit');
    const committedOperation = { ...operation, authorityVersion: status.authorityVersion };
    input.onCommitted?.(committedOperation);
    return committedOperation;
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-ambient` }),
    relaunchBoundRuntime: async () => {
      events.push('relaunch');
      return {
        probe: async ({ axis }) => {
          events.push(`staged-probe:${axis}`);
          return { axis, identity: `${axis}-staged` };
        },
        refreshRuntimeBinding: async () => {
          events.push('signed-marker');
          return candidate;
        },
        assertActive: () => events.push('deadline-check'),
        publish: (publishedStatus) => {
          assert.deepEqual(publishedStatus.bindings.bundle, candidate);
          publishedTarget = candidate.targetId;
          events.push('publish');
        },
        cancel: () => events.push('cancel'),
      };
    },
  });

  const result = await gate.wrap('device_reset_state', async (args) => {
    await relaunchManagedNativeOriginApp(args);
    assert.equal(publishedTarget, 'old-target');
    await completeManagedNativeOriginAuthority(args, true);
    return okResult({ reset: true });
  })({ relaunch: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(publishedTarget, 'new-target');
  assert.deepEqual(events, [
    'relaunch',
    'staged-probe:A',
    'signed-marker',
    'staged-probe:B',
    'deadline-check',
    'atomic-commit',
    'deadline-check',
    'publish',
  ]);
});

test('managed Android deferred re-prove stages the late target until atomic promotion', async () => {
  const { runtime, registry, status } = fixture();
  status.bindings.device.platform = 'android';
  status.bindings.install.platform = 'android';
  const events: string[] = [];
  const candidate = {
    ...status.bindings.bundle,
    targetId: 'late-target',
    connectionGeneration: 3,
  };
  let publishedTarget = 'old-target';
  registry.replaceBindingsDuringOperation = (operation, input) => {
    input.assertBeforeCommit?.();
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    events.push('atomic-commit');
    const committedOperation = { ...operation, authorityVersion: status.authorityVersion };
    input.onCommitted?.(committedOperation);
    return committedOperation;
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-ambient` }),
    relaunchBoundRuntime: async () => {
      events.push('relaunch');
      throw new Error('CDP_TARGET_AUTHORITY_MISMATCH: target registered after the flow resumed');
    },
    reconnectBoundRuntime: async () => {
      events.push('reprove');
      return {
        probe: async ({ axis }) => {
          events.push(`staged-probe:${axis}`);
          return { axis, identity: `${axis}-staged` };
        },
        refreshRuntimeBinding: async () => {
          events.push('signed-marker');
          return candidate;
        },
        assertActive: () => events.push('deadline-check'),
        publish: () => {
          publishedTarget = candidate.targetId;
          events.push('publish');
        },
        cancel: () => events.push('cancel'),
      };
    },
  });

  const result = await gate.wrap('device_reset_state', async (args) => {
    await assert.rejects(
      relaunchManagedNativeOriginApp(args),
      /target registered after the flow resumed/,
    );
    await reproveManagedNativeOrigin(args);
    assert.equal(publishedTarget, 'old-target');
    await completeManagedNativeOriginAuthority(args, true);
    return okResult({ reset: true });
  })({ relaunch: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(publishedTarget, 'late-target');
  assert.deepEqual(events, [
    'relaunch',
    'reprove',
    'staged-probe:A',
    'signed-marker',
    'staged-probe:B',
    'deadline-check',
    'atomic-commit',
    'deadline-check',
    'publish',
  ]);
});

test('managed Android relaunch compensates a post-commit hardening failure', async () => {
  const { runtime, registry, status } = fixture();
  status.bindings.device.platform = 'android';
  status.bindings.install.platform = 'android';
  const priorBundle = status.bindings.bundle;
  const candidate = { ...priorBundle, targetId: 'new-target', connectionGeneration: 2 };
  const events: string[] = [];
  let replacementCount = 0;
  registry.replaceBindingsDuringOperation = (operation, input) => {
    replacementCount += 1;
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    if (replacementCount === 1) {
      input.assertBeforeCommit?.();
      events.push('candidate-commit');
      input.onCommitted?.({ ...operation, authorityVersion: status.authorityVersion });
      throw new Error('registry permissions hardening failed');
    }
    events.push('compensating-commit');
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-ambient` }),
    relaunchBoundRuntime: async () => ({
      probe: async ({ axis }) => ({ axis, identity: `${axis}-staged` }),
      refreshRuntimeBinding: async () => candidate,
      assertActive: () => events.push('deadline-check'),
      publish: () => events.push('publish'),
      cancel: () => events.push('cancel'),
    }),
  });

  const result = await gate.wrap('device_reset_state', async (args) => {
    await relaunchManagedNativeOriginApp(args);
    await completeManagedNativeOriginAuthority(args, true);
    return okResult({ reset: true });
  })({ relaunch: true });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.deepEqual(status.bindings.bundle, priorBundle);
  assert.deepEqual(events, ['deadline-check', 'candidate-commit', 'compensating-commit', 'cancel']);
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

test('inline Maestro parking tolerates its own authenticated controller generation advance', async () => {
  const { runtime, registry, status } = fixture();
  status.bindings.runner = {
    platform: 'ios',
    deviceId: 'device',
    port: 9100,
    instanceId: 'runner',
  };
  registry.replaceBindingsDuringOperation = (operation, input) => {
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({
      axis,
      identity: axis === 'C' ? `controller-v${status.authorityVersion}` : `${axis}-identity`,
    }),
  });

  const result = await gate.wrap('device_pick_date', async (args) => {
    await completeManagedRunnerParkAuthority(args);
    return okResult({ picked: true });
  })({ date: '1990-06-15', platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 10);
  assert.equal(status.bindings.runner, null);
});

test('inline Maestro parking still rejects an external controller generation advance', async () => {
  const { runtime, registry, status } = fixture();
  status.bindings.runner = {
    platform: 'ios',
    deviceId: 'device',
    port: 9100,
    instanceId: 'runner',
  };
  registry.replaceBindingsDuringOperation = (operation, input) => {
    status.bindings = { ...status.bindings, ...input.bindings };
    status.authorityVersion += 1;
    return { ...operation, authorityVersion: status.authorityVersion };
  };
  registry.verifyOperation = (operation) => {
    if (operation.authorityVersion !== status.authorityVersion) {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'an external controller generation replaced the active operation fence',
      );
    }
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({
      axis,
      identity: axis === 'C' ? `controller-v${status.authorityVersion}` : `${axis}-identity`,
    }),
  });

  const result = await gate.wrap('device_pick_date', async (args) => {
    await completeManagedRunnerParkAuthority(args);
    status.authorityVersion += 1;
    return okResult({ picked: true });
  })({ date: '1990-06-15', platform: 'ios' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
  assert.equal(envelope.data, undefined);
});

test('nested action replay can park runner authority without stranding a stale R binding', async () => {
  const { runtime, registry, status, calls } = fixture();
  const released: Array<Record<string, unknown>> = [];
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
    onRunnerReleased: async (runner) => {
      released.push(runner);
    },
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    await completeManagedRunnerParkAuthority(args);
    return failResult('selector refused', 'SELECTOR_NOT_FOUND');
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(status.bindings.runner, null);
  assert.ok(calls.includes('release:ios:device:9100'));
  assert.equal(calls.includes('postflight:R'), false);
  assert.deepEqual(released, [
    {
      platform: 'ios',
      deviceId: 'device',
      port: 9100,
      instanceId: 'runner',
    },
  ]);
});

test('contained runner timeout atomically releases authority and preserves its typed result', async () => {
  const { runtime, registry, status, calls } = fixture();
  status.bindings.runner = {
    platform: 'ios',
    deviceId: 'device',
    port: 9100,
    pid: 4321,
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
      if (axis === 'R' && phase === 'postflight') {
        throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'runner was reaped');
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_press', async () =>
    failResult('runner timed out', 'RUNNER_TIMEOUT', {
      runnerTimeoutRecovery: {
        poisoned: true,
        reapDisposition: 'reaped',
        runner: {
          before: { pid: 4321, port: 9100, deviceId: 'device' },
          stateCleared: true,
        },
      },
    }),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'RUNNER_TIMEOUT');
  assert.equal(status.bindings.runner, null);
  assert.ok(calls.includes('release:ios:device:9100'));
  assert.equal(calls.includes('postflight:R'), false);
});

test('contained timeout retains the cleanup fence for a preserved replacement runner', async () => {
  const { runtime, registry, status, calls } = fixture();
  const runner = {
    platform: 'ios',
    deviceId: 'device',
    port: 9100,
    pid: 4321,
    instanceId: 'runner',
  };
  status.bindings.runner = runner;
  registry.replaceBindingsDuringOperation = () => {
    throw new Error('replacement runner must retain the cleanup fence');
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      if (axis === 'R' && phase === 'postflight') {
        throw new SessionAuthorityError('RUNNER_OWNERSHIP_MISMATCH', 'runner was replaced');
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_press', async () =>
    failResult('runner timed out', 'RUNNER_TIMEOUT', {
      runnerTimeoutRecovery: {
        poisoned: true,
        reapDisposition: 'replacement-preserved',
        runner: {
          before: { pid: 4321, port: 9100, deviceId: 'device' },
          stateCleared: false,
        },
      },
    }),
  )({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'RUNNER_TIMEOUT');
  assert.equal(status.bindings.runner, runner);
  assert.equal(calls.includes('postflight:R'), false);
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
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 11);
});

test('failed reload invalidates stale bundle authority under the active fence', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.metro.port = 8193;
  status.bindings.bundle.targetId = 'old-target';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    onRuntimeBundleInvalidated: () => calls.push('clear-client-policy'),
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
  assert.equal(calls.filter((call) => call === 'clear-client-policy').length, 1);
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

test('raw native reads run on exact control authority and label unavailable origin', async () => {
  const { runtime } = fixture();
  let dispatched = false;
  let promoted = false;
  const gate = createAuthorityGate(runtime, {
    snapshotCaptureCheckpoint: () => 17,
    promoteSnapshotOrigin: () => {
      promoted = true;
    },
    probe: async ({ axis }) => {
      if (axis === 'A') {
        throw new SessionAuthorityError(
          'METRO_ORIGIN_MISMATCH',
          'the claimed device is not attached to this Metro',
        );
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_screenshot', async () => {
    dispatched = true;
    return okResult({ path: '/tmp/foreign-device.png' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, true);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.path, '/tmp/foreign-device.png');
  assert.equal(envelope.meta.originAuthority, 'not-proven');
  assert.equal(envelope.meta.authorityReceipt.originAuthority, 'not-proven');
  assert.equal(promoted, false);
  assert.equal(
    envelope.meta.authorityReceipt.axes.some(({ axis }) => axis === 'M' || axis === 'A'),
    false,
  );
});

test('raw native control upgrades only a fully stable optional origin', async () => {
  const { runtime } = fixture();
  const promotedCheckpoints: number[] = [];
  const gate = createAuthorityGate(runtime, {
    snapshotCaptureCheckpoint: () => 23,
    promoteSnapshotOrigin: (checkpoint) => promotedCheckpoints.push(checkpoint),
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  for (const tool of ['device_screenshot', 'device_batch']) {
    const result = await gate.wrap(tool, async () => okResult({ controlled: true }))({});
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.ok, true);
    assert.equal(envelope.meta.originAuthority, 'proven');
    assert.equal(envelope.meta.authorityReceipt.originAuthority, 'proven');
    assert.deepEqual(
      envelope.meta.authorityReceipt.axes
        .map(({ axis }) => axis)
        .filter((axis) => axis === 'M' || axis === 'A'),
      ['M', 'A'],
    );
  }
  assert.deepEqual(promotedCheckpoints, [23, 23]);
});

test('raw native reads cannot launder an origin-unproven cached snapshot', async () => {
  const { runtime } = fixture();
  let promoted = false;
  const gate = createAuthorityGate(runtime, {
    snapshotCaptureCheckpoint: () => 23,
    promoteSnapshotOrigin: () => {
      promoted = true;
    },
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('device_find', async () =>
    okResult(
      { ref: '@e0', label: 'Continue' },
      {
        meta: {
          snapshotProvenance: { source: 'cache', originAuthority: 'not-proven' },
        },
      },
    ),
  )({ text: 'Continue' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.originAuthority, 'not-proven');
  assert.equal(envelope.meta.authorityReceipt.originAuthority, 'not-proven');
  assert.equal(promoted, false);
  assert.equal(
    envelope.meta.authorityReceipt.axes.some(({ axis }) => axis === 'M' || axis === 'A'),
    false,
  );
});

test('strict verdict, learned-action, and proof consumers refuse missing managed origin', async () => {
  for (const [tool, args] of [
    ['cross_platform_verify', {}],
    ['cdp_repair_action', {}],
    ['proof_capture', { action: 'finalize' }],
  ] as const) {
    const { runtime } = fixture();
    let dispatched = false;
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis }) => {
        if (axis === 'A') {
          throw new SessionAuthorityError('METRO_ORIGIN_MISMATCH', 'no exact product target');
        }
        return { axis, identity: `${axis}-identity` };
      },
    });

    const result = await gate.wrap(tool, async () => {
      dispatched = true;
      return okResult({ verdict: 'PASS' });
    })(args);
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(dispatched, false, tool);
    assert.equal(envelope.ok, false, tool);
    assert.equal(envelope.code, 'METRO_ORIGIN_MISMATCH', tool);
    assert.equal(envelope.meta.originAuthority, 'not-proven', tool);
  }
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
  assert.equal(native.calls.includes('refresh-binding'), false);

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
    ['begin-operation-axis:B', 'preflight:B', 'postflight:B'],
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

test('optional bundle admission allows native replay when live B is unavailable', async () => {
  const { runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => {
      if (axis === 'B') {
        throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: runtime marker is temporarily absent');
      }
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('cdp_run_action', async (args) => {
    assert.equal(await claimOptionalBundleAuthority(args), false);
    return okResult({ transport: 'maestro' });
  })({});
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityInvalidated, undefined);
  assert.equal(status.bindings.bundle.targetId, 'target-a');
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    false,
  );
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

test('native run-action does not demand optional bundle recovery', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    refreshRuntimeBinding: async () => {
      throw new Error('BUNDLE_HANDSHAKE_UNAVAILABLE: optional target did not return');
    },
  });

  const result = await gate.wrap('cdp_run_action', async () => okResult({ transport: 'maestro' }))(
    {},
  );
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityInvalidated, undefined);
  assert.equal(status.bindings.bundle.targetId, 'target-a');
  assert.equal(calls.includes('refresh-binding'), false);
  assert.equal(
    envelope.meta.authorityReceipt.axes.some((axis) => axis.axis === 'B'),
    false,
  );
});

test('native run-action leaves an unclaimed optional bundle untouched', async () => {
  const { calls, runtime, status } = fixture();
  status.bindings.bundle.targetId = 'target-a';
  status.bindings.bundle.connectionGeneration = 1;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    refreshRuntimeBinding: async () => {
      calls.push('refresh-binding');
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
    [],
  );
  assert.equal(status.bindings.bundle.targetId, 'target-a');
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
  assert.equal(envelope.meta.authorityReceipt.authorityVersion, 11);
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

test('bind_device can replace iOS authority with an exact Android device', async () => {
  const { runtime, status } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  let dispatched: Record<string, unknown> | undefined;
  const result = await gate.wrap('rn_session', async (args) => {
    dispatched = args;
    status.bindings.device = {
      platform: args.platform,
      deviceId: args.deviceId,
      appId: args.appId,
    };
    status.authorityVersion += 1;
    return okResult({ rebound: true });
  })({
    action: 'bind_device',
    platform: 'android',
    deviceId: 'emulator-5554',
    appId: 'dev.example',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(dispatched?.platform, 'android');
  assert.equal(dispatched?.deviceId, 'emulator-5554');
});

test('raw native control isolates the exact session and refuses a foreign device before mutation', async () => {
  const { runtime } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });
  let dispatched = false;
  const result = await gate.wrap('device_press', async () => {
    dispatched = true;
    return okResult({ pressed: true });
  })({ deviceId: 'foreign-device' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(dispatched, false);
  assert.equal(envelope.code, 'DEVICE_AUTHORITY_MISMATCH');
  assert.equal(envelope.meta.originAuthority, 'not-proven');
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

test('stale-device release refuses a success envelope when no scoped commit advanced authority', async () => {
  const { runtime, status } = fixture();
  status.bindings.staleDeviceRelease = {
    platform: 'ios',
    deviceId: 'device',
    priorSessionId: 'dead-owner',
    priorClaimEpoch: 3,
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('rn_session', async () =>
    okResult({ released: { platform: 'ios', cleanupCompleted: ['runner'] } }),
  )({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'device',
    releaseHandle: 'authenticated-handle',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
  assert.ok(status.bindings.staleDeviceRelease, 'the no-commit registry state is unchanged');
});

test('stale-device release refuses a changed contender generation', async () => {
  const { runtime, registry, status } = fixture();
  status.bindings.staleDeviceRelease = {
    platform: 'ios',
    deviceId: 'device',
    priorSessionId: 'dead-owner',
    priorClaimEpoch: 3,
  };
  registry.verifyOperation = (operation) => {
    if (operation.authorityVersion !== status.authorityVersion) {
      throw new SessionAuthorityError(
        'AUTHORITY_LOST_DURING_OPERATION',
        'contender generation changed during stale-device release',
      );
    }
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('rn_session', async () => {
    status.authorityVersion += 1;
    return okResult({ released: { platform: 'ios', cleanupCompleted: ['runner'] } });
  })({
    action: 'release_stale_device',
    platform: 'ios',
    deviceId: 'device',
    releaseHandle: 'authenticated-handle',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
  assert.ok(status.bindings.staleDeviceRelease, 'changed authority cannot consume the offer');
});

test('repeated managed Metro stop remains fenced without requiring a generation advance', async () => {
  const { runtime, status, calls } = fixture();
  status.bindings.metro = null;
  status.bindings.bundle = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('rn_session', async () =>
    okResult({ stopped: false, alreadyStopped: true }),
  )({ action: 'stop_metro' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.data.alreadyStopped, true);
  assert.equal(envelope.meta.authorityTransition, true);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    ['postflight:C', 'postflight:S'],
  );
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
    ['preflight:C', 'preflight:S'],
  );
});

test('Observe stop requires only controller and source authority', async () => {
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
    ['preflight:C', 'preflight:S'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    ['postflight:C', 'postflight:S'],
  );
});

test('Observe start and restart admit with a live Session only, matching autostart degraded mode', async () => {
  for (const action of ['start', 'restart']) {
    const { runtime, status, calls } = fixture();
    status.state = 'source_bound';
    status.bindings = {
      install: null,
      metro: null,
      bundle: null,
      device: null,
      runner: null,
      observe: null,
      proof: null,
    };
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis, phase }) => {
        calls.push(`${phase}:${axis}`);
        return { axis, identity: `${axis}-identity` };
      },
    });

    const result = await gate.wrap('observe', async () => {
      status.bindings.observe = { instanceId: 'observe-new' };
      status.authorityVersion += 1;
      return okResult({ running: true });
    })({ action });
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(envelope.ok, true, `observe ${action} must admit at source_bound`);
    assert.equal(envelope.meta.authorityTransition, true);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('preflight:')),
      ['preflight:C', 'preflight:S'],
    );
    assert.deepEqual(
      calls.filter((call) => call.startsWith('postflight:')),
      ['postflight:C', 'postflight:S'],
    );
  }
});

test('Observe stop with no bound child is an idempotent authoritative no-op', async () => {
  const { runtime, status, calls } = fixture();
  status.bindings.observe = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('observe', async () => okResult({ running: false }))({
    action: 'stop',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityTransition, undefined);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S'],
  );
});

test('Observe e2e panel tools still require full authority at a session-bound-only state', async () => {
  for (const tool of ['cdp_run_e2e_suite', 'cdp_run_action']) {
    const { runtime, status } = fixture();
    status.state = 'source_bound';
    status.bindings = {
      install: null,
      metro: null,
      bundle: null,
      device: null,
      runner: null,
      observe: null,
      proof: null,
    };
    let dispatched = false;
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
    });

    const result = await gate.wrap(tool, async () => {
      dispatched = true;
      return okResult({ started: true });
    })({});
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(envelope.ok, false, `${tool} must refuse without full authority`);
    assert.equal(envelope.code, 'APP_INSTALL_IDENTITY_CHANGED');
    assert.equal(dispatched, false);
  }
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
  status.bindings.proof = null;
  registry.replaceBindingsDuringOperation = () => {
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
  assert.equal(status.bindings.proof, null);
});

test('failed proof postflight discards the rehearsal state created by the handler', async () => {
  const { runtime, status } = fixture();
  const actions: string[] = [];
  status.bindings.proof = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => ({
      axis,
      identity: phase === 'postflight' && axis === 'D' ? 'foreign-device' : `${axis}-identity`,
    }),
  });

  const result = await gate.wrap('proof_capture', async (args: { action: string }) => {
    actions.push(args.action);
    return okResult(args.action === 'discard' ? { discarded: true } : { rehearsing: true });
  })({ action: 'begin_rehearsal', runId: 'proof-new' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.equal(envelope.code, 'AUTHORITY_LOST_DURING_OPERATION');
  assert.deepEqual(actions, ['begin_rehearsal', 'discard']);
  assert.equal(status.bindings.proof, null);
});

test('failed rehearsal rollback retains its operation fence', async () => {
  const { calls, runtime, registry, status } = fixture();
  status.bindings.proof = null;
  registry.replaceBindingsDuringOperation = () => {
    throw new Error('registry write failed');
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('proof_capture', async (args: { action: string }) =>
    args.action === 'discard' ? okResult({ discarded: false }) : okResult({ rehearsing: true }),
  )({ action: 'begin_rehearsal', runId: 'proof-new' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, false);
  assert.match(envelope.error, /rehearsal rollback failed/);
  assert.equal(calls.includes('end'), false);
  assert.equal(calls.includes('cancel'), false);
});

test('proof rehearsal refuses a durable active binding before dispatch', async () => {
  const { runtime } = fixture();
  let dispatched = false;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('proof_capture', async () => {
    dispatched = true;
    return okResult({ rehearsing: true });
  })({ action: 'begin_rehearsal', runId: 'proof-new' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'PROOF_AUTHORITY_MISMATCH');
  assert.equal(dispatched, false);
});

test('proof discard retains its durable binding when in-memory cleanup is absent', async () => {
  const { runtime, status } = fixture();
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('proof_capture', async () =>
    okResult({ stage: 'idle', discarded: false }),
  )({ action: 'discard' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'PROOF_AUTHORITY_MISMATCH');
  assert.deepEqual(status.bindings.proof, { runId: 'proof' });
});

test('proof discard remains authoritative after runtime and install loss', async () => {
  const { runtime, status, calls } = fixture();
  status.bindings.install = null;
  status.bindings.metro = null;
  status.bindings.bundle = null;
  status.bindings.runner = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('proof_capture', async () => okResult({ discarded: true }))({
    action: 'discard',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(status.bindings.proof, null);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:D', 'preflight:P'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    ['postflight:C', 'postflight:S', 'postflight:D'],
  );
});

test('recorder cleanup remains authoritative after install loss', async () => {
  for (const action of ['status', 'stop'] as const) {
    const { runtime, status, calls } = fixture();
    status.bindings.install = null;
    const gate = createAuthorityGate(runtime, {
      probe: async ({ axis, phase }) => {
        calls.push(`${phase}:${axis}`);
        return { axis, identity: `${axis}-identity` };
      },
    });

    const result = await gate.wrap('device_record', async () => okResult({ action }))({ action });
    const envelope = JSON.parse(result.content[0].text);

    assert.equal(envelope.ok, true);
    assert.deepEqual(
      calls.filter((call) => call.startsWith('preflight:')),
      ['preflight:C', 'preflight:S', 'preflight:D'],
    );
    assert.deepEqual(
      calls.filter((call) => call.startsWith('postflight:')),
      ['postflight:C', 'postflight:S', 'postflight:D'],
    );
  }
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
    ['preflight:C', 'preflight:S', 'preflight:I', 'preflight:D', 'preflight:M', 'preflight:A'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    [
      'postflight:C',
      'postflight:S',
      'postflight:I',
      'postflight:D',
      'postflight:R',
      'postflight:M',
      'postflight:A',
    ],
  );

  calls.length = 0;
  status.bindings.observe = { instanceId: 'observe' };
  await gate.wrap('observe', async () => {
    return okResult({ running: true });
  })({ action: 'start' });
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    ['postflight:C', 'postflight:S'],
  );
});

test('runner close authenticates dead retained ownership after runtime loss', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.install = null;
  status.bindings.metro = null;
  status.bindings.runner = {
    platform: 'ios',
    deviceId: 'device',
    appId: 'dev.example',
    port: 9100,
    sessionId: 'session-a',
    claimEpoch: 4,
    instanceId: 'runner',
    capability: 'capability',
    pid: 42,
    processBirth: 'process-birth',
  };
  status.claims = [
    {
      type: 'runner',
      key: 'ios:device:9100',
      sessionId: 'session-a',
      claimEpoch: 4,
      leaseUntilMs: 1000,
    },
  ];
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      if (axis === 'R') throw new Error('dead runner must not receive a live probe');
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_snapshot', async () => {
    status.bindings.runner = null;
    status.authorityVersion += 1;
    return okResult({ closed: true });
  })({ action: 'close' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.ok(calls.includes('claim:runner:ios:device:9100'));
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:D'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    ['postflight:C', 'postflight:S', 'postflight:D'],
  );
});

test('runner close rejects a retained binding without its cleanup claim', async () => {
  const { runtime, status } = fixture();
  let dispatched = false;
  status.bindings.runner = {
    platform: 'ios',
    deviceId: 'device',
    appId: 'dev.example',
    port: 9100,
    sessionId: 'session-a',
    claimEpoch: 4,
    instanceId: 'runner',
    capability: 'capability',
    pid: 42,
    processBirth: 'process-birth',
  };
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis }) => ({ axis, identity: `${axis}-identity` }),
  });

  const result = await gate.wrap('device_snapshot', async () => {
    dispatched = true;
    return okResult({ closed: true });
  })({ action: 'close' });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.code, 'RUNNER_OWNERSHIP_MISMATCH');
  assert.equal(dispatched, false);
});

test('runner close is idempotent after timeout containment released its binding', async () => {
  const { runtime, calls, status } = fixture();
  status.bindings.runner = null;
  const gate = createAuthorityGate(runtime, {
    probe: async ({ axis, phase }) => {
      calls.push(`${phase}:${axis}`);
      return { axis, identity: `${axis}-identity` };
    },
  });

  const result = await gate.wrap('device_snapshot', async () => okResult({ closed: true }))({
    action: 'close',
  });
  const envelope = JSON.parse(result.content[0].text);

  assert.equal(envelope.ok, true);
  assert.equal(envelope.meta.authorityTransition, true);
  assert.equal(status.authorityVersion, 9);
  assert.deepEqual(
    calls.filter((call) => call.startsWith('preflight:')),
    ['preflight:C', 'preflight:S', 'preflight:D', 'preflight:M', 'preflight:A'],
  );
  assert.deepEqual(
    calls.filter((call) => call.startsWith('postflight:')),
    ['postflight:C', 'postflight:S', 'postflight:D', 'postflight:M', 'postflight:A'],
  );
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
