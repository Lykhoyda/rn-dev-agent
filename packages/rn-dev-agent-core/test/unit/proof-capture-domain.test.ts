import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  durationBounds,
  StrictProofMonitor,
  transitionProofStage,
  validateTrace,
} from '../../dist/domain/proof-capture.js';

test('duration bounds reserve the approved adaptive window', () => {
  assert.deepEqual(durationBounds(20_000), { minimumMs: 16_000, maximumMs: 30_000 });
  assert.deepEqual(durationBounds(50_000), { minimumMs: 40_000, maximumMs: 60_000 });
});

test('proof state follows rehearsal through accepted final review', () => {
  let stage = 'idle';
  for (const action of [
    'begin_rehearsal',
    'finish_rehearsal',
    'arm',
    'start_recording',
    'stop_recording',
    'validate',
    'finalize',
  ]) {
    stage = transitionProofStage(stage, action);
  }
  assert.equal(stage, 'accepted');
});

test('recording rejects repair, reload, and undeclared interactions', () => {
  const result = validateTrace(
    ['cdp_run_action', 'proof_step', 'device_screenshot'],
    [
      { tool: 'cdp_run_action', ok: true, ts: 1, durationMs: 1000 },
      { tool: 'cdp_repair_action', ok: true, ts: 2, durationMs: 10 },
      { tool: 'cdp_reload', ok: true, ts: 3, durationMs: 10 },
    ],
  );
  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ['ACTION_REPAIR_DURING_RECORDING', 'RELOAD_DURING_RECORDING']);
});

test('recording requires declared operations in order', () => {
  const result = validateTrace(
    ['cdp_run_action', 'proof_step'],
    [
      { tool: 'proof_step', ok: true, ts: 1, durationMs: 10 },
      { tool: 'cdp_run_action', ok: true, ts: 2, durationMs: 1000 },
    ],
  );
  assert.equal(result.ok, false);
  assert.match(result.reasons.join(','), /STORYBOARD_ORDER/);
});

test('recording rejects every action-repair alias with one stable reason', () => {
  const result = validateTrace(
    ['proof_step'],
    [
      { tool: 'mcp__rn-dev-agent__cdp_repair_action', ok: true, ts: 1, durationMs: 10 },
      { tool: 'repair-action', ok: true, ts: 2, durationMs: 10 },
      { tool: 'action_repair', ok: true, ts: 3, durationMs: 10 },
      { tool: 'cdpRepairAction', ok: true, ts: 4, durationMs: 10 },
    ],
  );

  assert.deepEqual(result.reasons, ['ACTION_REPAIR_DURING_RECORDING']);
});

test('recording rejects restart, dev-client dismissal, and state reset', () => {
  const result = validateTrace(
    ['proof_step'],
    [
      { tool: 'cdp_restart', ok: true, ts: 1, durationMs: 10 },
      { tool: 'cdp_dismiss_dev_client_picker', ok: true, ts: 2, durationMs: 10 },
      { tool: 'device_reset_state', ok: true, ts: 3, durationMs: 10 },
    ],
  );

  assert.deepEqual(result.reasons, [
    'RESTART_DURING_RECORDING',
    'DEV_CLIENT_DISMISSAL_DURING_RECORDING',
    'STATE_RESET_DURING_RECORDING',
  ]);
});

test('recording rejects failed events and undeclared mutating tools', () => {
  const result = validateTrace(
    ['cdp_run_action'],
    [
      { tool: 'cdp_run_action', ok: false, ts: 1, durationMs: 1000 },
      { tool: 'device_press', ok: true, ts: 2, durationMs: 10 },
    ],
  );

  assert.deepEqual(result.reasons, ['OBSERVED_TOOL_FAILED', 'UNDECLARED_MUTATING_TOOL']);
});

test('recording ignores read-only tools only when allowlisted', () => {
  const allowlisted = validateTrace(
    ['cdp_run_action', 'cdp_status', 'expect_route', 'proof_step'],
    [
      { tool: 'cdp_run_action', ok: true, ts: 1, durationMs: 1000 },
      { tool: 'cdp_status', ok: true, ts: 2, durationMs: 10 },
      { tool: 'expect_route', ok: true, ts: 3, durationMs: 10 },
      { tool: 'proof_step', ok: true, ts: 4, durationMs: 10 },
    ],
  );
  const undeclared = validateTrace(
    ['cdp_run_action', 'proof_step'],
    [
      { tool: 'cdp_run_action', ok: true, ts: 1, durationMs: 1000 },
      { tool: 'cdp_status', ok: true, ts: 2, durationMs: 10 },
      { tool: 'proof_step', ok: true, ts: 3, durationMs: 10 },
    ],
  );

  assert.deepEqual(allowlisted, { ok: true, reasons: [] });
  assert.deepEqual(undeclared.reasons, ['UNDECLARED_READ_ONLY_TOOL']);
});

test('recording rejects a missing declared operation', () => {
  const result = validateTrace(
    ['cdp_run_action', 'proof_step'],
    [{ tool: 'cdp_run_action', ok: true, ts: 1, durationMs: 1000 }],
  );

  assert.deepEqual(result.reasons, ['STORYBOARD_OPERATION_MISSING']);
});

test('strict proof monitor normalizes events and hashes only redacted arguments', (t) => {
  t.mock.method(Date, 'now', () => 1_700_000_000_000);
  const monitor = new StrictProofMonitor();
  monitor.begin();

  monitor.record({
    tool: 'proof_step',
    params: {
      password: 'raw-password-value',
      email: 'person@example.com',
      label: 'profile',
    },
    status: 'PASS',
    latencyMs: 42,
  });

  const argsHash = createHash('sha256')
    .update(
      JSON.stringify({
        password: '[REDACTED:string]',
        email: '[PII_REDACTED]',
        label: 'profile',
      }),
    )
    .digest('hex');
  assert.deepEqual(monitor.snapshot(), [
    {
      tool: 'proof_step',
      ok: true,
      ts: 1_700_000_000_000,
      durationMs: 42,
      argsHash,
    },
  ]);
});

test('strict proof monitor records only its active window and excludes proof capture', () => {
  const monitor = new StrictProofMonitor();
  const event = {
    tool: 'device_screenshot',
    params: {},
    status: 'FAIL' as const,
    latencyMs: 12,
  };

  monitor.record(event);
  monitor.begin();
  monitor.record({ ...event, tool: 'proof_capture' });
  monitor.record(event);
  const stopped = monitor.stop();
  monitor.record({ ...event, tool: 'device_press' });

  assert.equal(stopped.length, 1);
  assert.equal(stopped[0]?.tool, 'device_screenshot');
  assert.equal(stopped[0]?.ok, false);
  assert.deepEqual(monitor.snapshot(), stopped);
});

test('strict proof monitor snapshots are detached and begin resets prior events', () => {
  const monitor = new StrictProofMonitor();
  monitor.begin();
  monitor.record({
    tool: 'proof_step',
    params: {},
    status: 'PASS',
    latencyMs: 1,
  });

  const first = monitor.snapshot();
  const second = monitor.snapshot();
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first[0], second[0]);

  monitor.begin();
  assert.deepEqual(monitor.snapshot(), []);
});
