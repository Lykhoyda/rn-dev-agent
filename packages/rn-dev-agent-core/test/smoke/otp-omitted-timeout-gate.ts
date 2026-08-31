import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// @ts-expect-error -- untyped JS test helper
import { startSupervisor } from '../helpers/supervisor-harness.js';

const APP_ROOT = process.env.OTP_FIXTURE_ROOT;
const DEVICE_ID = process.env.OTP_FIXTURE_DEVICE_ID;
const APP_ID = 'com.rndevagent.expo55devclient';
const ACTION_ID = 'otp-omitted-timeout';
const EVIDENCE_PATH = '/tmp/maestro-login-action-capability-evidence.json';
const STATUS_PATH = '/tmp/maestro-login-action-capability-status.json';
const SUPERVISOR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../claude-plugin/rn-dev-agent-core/dist/supervisor.js',
);

assert.ok(APP_ROOT, 'OTP_FIXTURE_ROOT is required');
assert.ok(DEVICE_ID, 'OTP_FIXTURE_DEVICE_ID is required');

async function rpc(supervisor: any, method: string, params?: unknown) {
  const id = supervisor.send(method, params);
  for (;;) {
    const line = JSON.parse(await supervisor.nextLine());
    if (line.id === id) return line;
  }
}

async function callTool(supervisor: any, name: string, args: Record<string, unknown> = {}) {
  const line = await rpc(supervisor, 'tools/call', { name, arguments: args });
  const text = line.result?.content?.[0]?.text ?? '';
  let envelope: any = null;
  try {
    envelope = JSON.parse(text);
  } catch {}
  return { envelope, isError: Boolean(line.result?.isError), text };
}

function totalRuns(): number {
  const statePath = join(APP_ROOT!, '.rn-agent/state', `${ACTION_ID}.state.json`);
  if (!existsSync(statePath)) return 0;
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  return state.stats?.totalRuns ?? 0;
}

async function requireOk(supervisor: any, name: string, args: Record<string, unknown> = {}) {
  const result = await callTool(supervisor, name, args);
  assert.equal(result.envelope?.ok, true, `${name}: ${result.text.slice(0, 800)}`);
  return result.envelope;
}

function collectTestIds(value: unknown, ids: Set<string> = new Set()): Set<string> {
  if (!value || typeof value !== 'object') return ids;
  const record = value as Record<string, unknown>;
  if (typeof record.testID === 'string') ids.add(record.testID);
  if (typeof record.nativeID === 'string') ids.add(record.nativeID);
  for (const child of [record.tree, record.children, record.nodes, record.matches]) {
    if (Array.isArray(child)) {
      for (const item of child) collectTestIds(item, ids);
    } else {
      collectTestIds(child, ids);
    }
  }
  return ids;
}

function assertCompleteExactTree(
  result: Awaited<ReturnType<typeof callTool>>,
  testId: string,
): void {
  assert.equal(result.envelope?.ok, true, `CDP modal probe: ${result.text.slice(0, 800)}`);
  assert.notEqual(result.envelope?.data?.__agent_truncated, true);
  assert.notEqual(result.envelope?.data?.truncated, true);
  assert.equal(result.envelope?.meta?.treeVerdict?.state, 'ok');
  assert.equal(result.envelope?.meta?.treeVerdict?.path, 'filter');
  assert.deepEqual(result.envelope?.meta?.treeVerdict?.reasons, []);
  assert.equal(collectTestIds(result.envelope?.data).has(testId), true, `${testId} is absent`);
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (hasExited(child)) return true;
  return new Promise((resolveExit) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolveExit(exited);
    };
    const onExit = (): void => finish(true);
    const timer = setTimeout(() => finish(hasExited(child)), timeoutMs);
    child.once('exit', onExit);
  });
}

async function terminateChild(child: ChildProcess, label: string): Promise<void> {
  if (hasExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForExit(child, 10_000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForExit(child, 5_000), true, `${label} did not terminate`);
}

async function run() {
  const declaredEnv = {
    RN_DEV_AGENT_DECLARED_ROOT: APP_ROOT!,
    RN_DEV_AGENT_DECLARED_MANIFESTS: 'package.json',
  };
  const supervisor = startSupervisor({
    supervisorPath: SUPERVISOR,
    cwd: APP_ROOT,
    lineTimeoutMs: 600_000,
    env: declaredEnv,
  });
  const evidence: Record<string, unknown> = {
    appRoot: APP_ROOT,
    appId: APP_ID,
    deviceId: DEVICE_ID,
  };
  let adapter: ChildProcess | undefined;
  let runnerOpened = false;
  let primaryError: unknown;
  const cleanupErrors: Error[] = [];
  let finalStatus: Awaited<ReturnType<typeof callTool>> | undefined;

  try {
    const init = await rpc(supervisor, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'otp-omitted-timeout-gate', version: '1.0.0' },
    });
    assert.ok(init.result);
    supervisor.notify('notifications/initialized');

    evidence.initialStatus = (
      await callTool(supervisor, 'rn_session', { action: 'status' })
    ).envelope;
    evidence.initialCdp = (await callTool(supervisor, 'cdp_status', { platform: 'ios' })).envelope;
    evidence.devices = (await callTool(supervisor, 'device_list')).envelope;

    await requireOk(supervisor, 'rn_session', {
      action: 'bind_source',
      projectRoot: APP_ROOT,
    });
    let bound = await callTool(supervisor, 'rn_session', {
      action: 'bind_device',
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: APP_ID,
    });
    if (bound.envelope?.code === 'STALE_DEVICE_RELEASE_REQUIRED') {
      bound = await callTool(supervisor, 'rn_session', {
        action: 'bind_device',
        platform: 'ios',
        deviceId: DEVICE_ID,
        appId: APP_ID,
        confirmed: true,
      });
    }
    assert.equal(bound.envelope?.ok, true, `bind_device: ${bound.text.slice(0, 800)}`);
    await requireOk(supervisor, 'rn_session', { action: 'preview_integration' });
    await requireOk(supervisor, 'rn_session', { action: 'apply_integration', confirmed: true });

    adapter = spawn('corepack', ['pnpm', 'run', 'ios'], {
      cwd: APP_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${join(APP_ROOT!, 'node_modules', '.bin')}:${process.env.PATH ?? ''}`,
      },
    });
    adapter.stdout?.on('data', (chunk) => process.stdout.write(`[fixture] ${chunk}`));
    adapter.stderr?.on('data', (chunk) => process.stderr.write(`[fixture] ${chunk}`));

    const readyDeadline = Date.now() + 1_500_000;
    for (;;) {
      assert.ok(Date.now() < readyDeadline, 'managed fixture bring-up timed out');
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      const status = await requireOk(supervisor, 'rn_session', { action: 'status' });
      const authority = status.data?.authority ?? {};
      console.log(
        `authority device=${authority.deviceBound} install=${authority.installBound} metro=${authority.metroBound} bundle=${authority.bundleBound}`,
      );
      if (authority.installBound && authority.metroBound) break;
    }

    await requireOk(supervisor, 'device_snapshot', {
      action: 'open',
      platform: 'ios',
      deviceId: DEVICE_ID,
      appId: APP_ID,
      attachOnly: true,
    });
    runnerOpened = true;
    const launchSurface = await requireOk(supervisor, 'device_snapshot', { action: 'snapshot' });
    console.log(`launch surface: ${JSON.stringify(launchSurface.data).slice(0, 1_500)}`);
    await requireOk(supervisor, 'cdp_connect', { platform: 'ios', bundleId: APP_ID });
    await requireOk(supervisor, 'cdp_error_log', { clear: true });

    await requireOk(supervisor, 'cdp_interact', {
      action: 'press',
      testID: 'open_otp',
    });
    const nativeVisibility = await callTool(supervisor, 'expect_visible_by_testid', {
      testID: 'otp_email-pressable',
      timeoutMs: 7_000,
    });
    const cdpVisibility = await callTool(supervisor, 'cdp_component_tree', {
      filter: 'otp_email-pressable',
      depth: 6,
    });
    const wdaProbe = await callTool(supervisor, 'maestro_run', {
      platform: 'ios',
      appId: APP_ID,
      deviceId: DEVICE_ID,
      inlineYaml: `appId: ${APP_ID}\n---\n- assertVisible: otp_email-pressable\n`,
      timeoutMs: 10_000,
    });
    evidence.surfaceBoundary = {
      nativeVisibility: nativeVisibility.envelope,
      cdpVisibility: cdpVisibility.envelope,
      wdaProbe: wdaProbe.envelope,
      wdaBlind: false,
    };
    assertCompleteExactTree(cdpVisibility, 'otp_email-pressable');
    assert.equal(
      wdaProbe.envelope?.code,
      'NATIVE_SURFACE_BLIND',
      `owned OTP fixture did not reproduce the WDA-blind boundary: ${wdaProbe.text.slice(0, 800)}`,
    );
    assert.equal(wdaProbe.envelope?.meta?.proofDomain, 'xctest-native');
    assert.equal(wdaProbe.envelope?.meta?.cleanup?.cleanupProven, true);
    assert.equal(wdaProbe.envelope?.meta?.cleanup?.wdaProcessSettled, true);
    assert.equal(wdaProbe.envelope?.meta?.cleanup?.runnerParkCommitted, true);
    (evidence.surfaceBoundary as Record<string, unknown>).wdaBlind = true;
    await requireOk(supervisor, 'cdp_interact', { action: 'press', testID: 'otp_cancel' });

    const beforeRuns = totalRuns();
    const action = await requireOk(supervisor, 'cdp_run_action', {
      actionId: ACTION_ID,
      projectRoot: APP_ROOT,
      platform: 'ios',
      autoRepair: false,
      trigger: 'agent',
    });
    const afterRuns = totalRuns();
    assert.equal(action.data?.passed, true);
    assert.equal(action.data?.proofDomain, 'partitioned');
    assert.equal(afterRuns, beforeRuns + 1);
    const actionTrace = action.data?.perStepReadback?.steps ?? [];
    assert.equal(action.data?.perStepReadback?.complete, true);
    assert.deepEqual(
      actionTrace.map((step: any) => step.index),
      [0, 1, 2, 3, 4, 5, 6],
      `incomplete or repeated action trace: ${JSON.stringify(actionTrace)}`,
    );
    assert.deepEqual(
      actionTrace.slice(0, 2).map((step: any) => [step.index, step.status]),
      [
        [0, 'pass'],
        [1, 'pass'],
      ],
    );
    const waitStep = actionTrace.find(
      (step: any) => step.index === 2 && step.verb === 'waitVisible',
    );
    assert.ok(waitStep, `missing wait trace: ${JSON.stringify(action.data?.perStepReadback)}`);
    assert.ok(waitStep.durationMs >= 500, `wait mounted too early: ${waitStep.durationMs}ms`);
    const completionTree = await requireOk(supervisor, 'cdp_component_tree', {
      filter: 'otp_done',
      depth: 4,
    });
    await requireOk(supervisor, 'expect_visible_by_testid', {
      testID: 'otp_done',
      timeoutMs: 2_000,
    });
    evidence.action = { beforeRuns, afterRuns, result: action, completionTree };

    const wrongStartedAt = Date.now();
    const wrongId = await callTool(supervisor, 'maestro_run', {
      platform: 'ios',
      appId: APP_ID,
      deviceId: DEVICE_ID,
      inlineYaml: `appId: ${APP_ID}\n---\n- tapOn:\n    id: open_otp\n- extendedWaitUntil:\n    visible:\n      id: missing_otp\n`,
    });
    const wrongElapsedMs = Date.now() - wrongStartedAt;
    assert.equal(wrongId.envelope?.code, 'TESTID_NOT_FOUND', wrongId.text.slice(0, 800));
    assert.equal(wrongId.envelope?.meta?.failedStepIndex, 1);
    assert.ok(wrongElapsedMs >= 16_500, `default timeout ended after ${wrongElapsedMs}ms`);
    evidence.wrongIdControl = { elapsedMs: wrongElapsedMs, result: wrongId.envelope };
    await requireOk(supervisor, 'cdp_interact', { action: 'press', testID: 'otp_cancel' });

    const shortStartedAt = Date.now();
    const shortTimeout = await callTool(supervisor, 'maestro_run', {
      platform: 'ios',
      appId: APP_ID,
      deviceId: DEVICE_ID,
      inlineYaml: `appId: ${APP_ID}\n---\n- tapOn:\n    id: open_otp\n- extendedWaitUntil:\n    visible:\n      id: otp_email-pressable\n    timeout: 300\n`,
    });
    const shortElapsedMs = Date.now() - shortStartedAt;
    assert.equal(shortTimeout.envelope?.code, 'TESTID_NOT_FOUND', shortTimeout.text.slice(0, 800));
    assert.equal(shortTimeout.envelope?.meta?.failedStepIndex, 1);
    assert.ok(
      shortElapsedMs >= 250 && shortElapsedMs < 2_000,
      `300ms control took ${shortElapsedMs}ms`,
    );
    evidence.shortTimeoutControl = { elapsedMs: shortElapsedMs, result: shortTimeout.envelope };
    await new Promise((resolve) => setTimeout(resolve, 5_500));
    await requireOk(supervisor, 'cdp_interact', { action: 'press', testID: 'otp_cancel' });
    evidence.errors = (await callTool(supervisor, 'cdp_error_log')).envelope;
  } catch (error) {
    primaryError = error;
  } finally {
    const teardown: Array<[string, string, Record<string, unknown>]> = [];
    if (runnerOpened)
      teardown.push(['device_snapshot.close', 'device_snapshot', { action: 'close' }]);
    teardown.push(['cdp_disconnect', 'cdp_disconnect', {}]);
    teardown.push(['rn_session.stop_metro', 'rn_session', { action: 'stop_metro' }]);
    teardown.push([
      'rn_session.restore_integration',
      'rn_session',
      { action: 'restore_integration', confirmed: true },
    ]);
    teardown.push(['rn_session.release', 'rn_session', { action: 'release' }]);
    const cleanup: Record<string, unknown> = {};
    for (const [label, name, args] of teardown) {
      try {
        const result = await callTool(supervisor, name, args);
        cleanup[label] = result.envelope ?? { text: result.text.slice(0, 800) };
        assert.equal(result.envelope?.ok, true, `${label}: ${result.text.slice(0, 800)}`);
      } catch (error) {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        cleanup[label] = { error: cleanupError.message };
        cleanupErrors.push(cleanupError);
      }
    }
    evidence.cleanup = cleanup;
    try {
      finalStatus = await callTool(supervisor, 'rn_session', { action: 'status' });
      evidence.finalStatus = finalStatus.envelope;
      assert.equal(finalStatus.envelope?.ok, true, finalStatus.text.slice(0, 800));
      assert.ok(
        ['released', 'selected'].includes(finalStatus.envelope?.data?.authority?.state),
        `unexpected post-release state: ${finalStatus.text.slice(0, 800)}`,
      );
      assert.equal(finalStatus.envelope?.data?.authority?.deviceBound, false);
      assert.equal(finalStatus.envelope?.data?.authority?.installBound, false);
      assert.equal(finalStatus.envelope?.data?.authority?.metroBound, false);
      assert.equal(finalStatus.envelope?.data?.authority?.bundleBound, false);
      assert.equal(finalStatus.envelope?.data?.authority?.runnerBound, false);
      assert.equal(finalStatus.envelope?.data?.authority?.recorderBound, false);
      assert.equal(
        finalStatus.envelope?.data?.authority?.migration?.packageIntegration?.installed,
        false,
      );
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    const processes: Record<string, unknown> = {};
    if (adapter) {
      try {
        await terminateChild(adapter, 'fixture adapter');
        processes.adapter = {
          exited: true,
          exitCode: adapter.exitCode,
          signalCode: adapter.signalCode,
        };
      } catch (error) {
        const cleanupError = error instanceof Error ? error : new Error(String(error));
        processes.adapter = { error: cleanupError.message };
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      await terminateChild(supervisor.child, 'supervisor');
      processes.supervisor = {
        exited: true,
        exitCode: supervisor.child.exitCode,
        signalCode: supervisor.child.signalCode,
      };
    } catch (error) {
      const cleanupError = error instanceof Error ? error : new Error(String(error));
      processes.supervisor = { error: cleanupError.message };
      cleanupErrors.push(cleanupError);
    }
    evidence.processes = processes;
    evidence.cleanupErrors = cleanupErrors.map((error) => error.message);
    try {
      writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
    try {
      writeFileSync(STATUS_PATH, JSON.stringify(finalStatus?.envelope ?? null, null, 2));
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      'OTP proof failed and reverse cleanup was incomplete',
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'OTP proof reverse cleanup was incomplete');
  }
  if (primaryError) throw primaryError;
}

await run();
console.log(`evidence=${EVIDENCE_PATH}`);
console.log(`status=${STATUS_PATH}`);
