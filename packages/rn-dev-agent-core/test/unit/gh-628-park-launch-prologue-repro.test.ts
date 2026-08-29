// GH #628 — parked-entry contract (supersedes the pre-correction repro this
// file first carried; see git history for the destruction proof: a launchApp
// {stopApp:false} prologue triggered the managed relaunch and reset the dev
// client before the action's own first assertion).
//
// Post-correction contract (captain decision, Option C):
//   - entry: parked actions carry no launch prologue; replay runs a read-only
//     park preflight and refuses PARK_STATE_MISSING before any step when the
//     declared park state is absent (backgrounded app = distinct cause value).
//   - A parked body containing a lifecycle command (or an uninspectable
//     runFlow file reference) refuses with existing BAD_RECORDING plus a
//     mandatory cause payload. Zero steps run on every refusal.
//   - Cold-entry actions keep today's launch/relaunch behavior unchanged.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeMaestroAuthorityStages } from '../../dist/tools/maestro-run.js';
import { generateMaestro } from '../../dist/tools/test-recorder-generators.js';
import {
  _resetState,
  _setStoredEvents,
  createRecordTestGenerateHandler,
} from '../../dist/tools/test-recorder.js';
import { parseM7Header, serializeM7Header } from '../../dist/domain/reusable-action.js';
import { parkedBodyViolation } from '../../dist/domain/park-entry.js';
import { createParkAnchorProbe, type ParkProbeClient } from '../../dist/tools/park-probe.js';
import type { ParkAnchorProbe, RunActionArgs } from '../../dist/tools/run-action.js';
import type { ToolResult } from '../../dist/utils.js';
import { createPinnedRunActionHandler, createTmpProject } from '../helpers/tmp-project.js';

interface Envelope {
  ok: boolean;
  error?: string;
  code?: string;
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
}

function envelope(result: ToolResult): Envelope {
  return JSON.parse(result.content[0]!.text) as Envelope;
}

type TmpProject = ReturnType<typeof createTmpProject>;
let project: TmpProject;

beforeEach(() => {
  project = createTmpProject();
});

afterEach(() => {
  project.cleanup();
});

const PARK_ANCHOR = 'mandate-sign-anchor';

function parkedYaml(bodyLines: string[], headerExtras: string[] = []): string {
  return [
    'appId: com.test.app',
    '---',
    '# id: parked-sign-mandate',
    '# intent: sign the parked mandate',
    '# mutates: true',
    '# status: experimental',
    '# entry: parked',
    ...headerExtras,
    '# enginePin: maestro-runner@1.1.24',
    '',
    ...bodyLines,
    '',
  ].join('\n');
}

const PARKED_BODY = [`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- tapOn:\n    id: "sign-cta"'];

const PASS_ENV = {
  ok: true,
  data: { passed: true, output: 'Flow passed', flowFile: 'x', platform: 'ios' },
};

function fakeMaestroRun(calls: Array<Record<string, unknown>>) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    calls.push(args);
    return { content: [{ type: 'text', text: JSON.stringify(PASS_ENV) }] };
  };
}

function handlerWith(
  calls: Array<Record<string, unknown>>,
  probe: ParkAnchorProbe | ((anchorId: string) => Promise<ParkAnchorProbe>),
  extras: Record<string, unknown> = {},
) {
  return createPinnedRunActionHandler({
    maestroRun: fakeMaestroRun(calls),
    probeParkAnchor: typeof probe === 'function' ? probe : async () => probe,
    ...extras,
  }) as (args: RunActionArgs) => Promise<ToolResult>;
}

function sidecarRecords(id: string): Array<Record<string, unknown>> {
  const path = project.sidecarPath(id);
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { runHistory: Array<Record<string, unknown>> })
    .runHistory;
}

// ─── Grammar ────────────────────────────────────────────────────────────────

test('GH #628: M7 header round-trips entry and defaults to absent', () => {
  const parsed = parseM7Header(parkedYaml(PARKED_BODY), 'parked-sign-mandate');
  assert.equal(parsed?.entry, 'parked');
  const serialized = serializeM7Header(parsed!);
  assert.match(serialized, /^# entry: parked$/m);
  const cold = parseM7Header('# id: a\n# intent: b\n', 'a');
  assert.equal(cold?.entry, undefined);
});

test('GH #628: generateMaestro omits the launch prologue for parked and keeps it for cold', () => {
  const events = [
    { type: 'tap', testID: PARK_ANCHOR, t: 1 } as const,
    {
      type: 'navigate',
      from: 'onboarding/mandate',
      to: 'onboarding/review',
      t: 2,
    } as const,
    { type: 'tap', testID: 'review-anchor', t: 3 } as const,
  ];
  const parked = generateMaestro(events, {
    id: 'p',
    intent: 'x',
    entry: 'parked',
    startRoute: 'onboarding/mandate',
  });
  assert.ok(!parked.includes('- launchApp'), 'parked emission must not self-bootstrap');
  assert.match(parked, /^# entry: parked$/m);
  assert.deepEqual(parseM7Header(parked)?.expectedRouteSequence, [
    'onboarding/mandate',
    'onboarding/review',
  ]);
  const cold = generateMaestro(events, { id: 'c', intent: 'x' });
  assert.ok(cold.includes('- launchApp'), 'cold emission keeps the self-bootstrap prologue');
  assert.ok(!cold.includes('# entry:'));
  const routedCold = generateMaestro(events, {
    id: 'c',
    intent: 'x',
    startRoute: 'onboarding/mandate',
  });
  assert.equal(parseM7Header(routedCold)?.expectedRouteSequence, undefined);
});

// ─── Parked replay (the regression) ─────────────────────────────────────────

test('GH #628 regression: parked action replays against the running app without any launch stage', async () => {
  project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
  const calls: Array<Record<string, unknown>> = [];
  const probeCalls: string[] = [];
  const handler = handlerWith(calls, async (anchorId: string) => {
    probeCalls.push(anchorId);
    return { status: 'visible' } as const;
  });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, true);
  assert.equal(result.data?.passed, true);
  assert.deepEqual(probeCalls, [PARK_ANCHOR], 'preflight probed the derived anchor exactly once');
  assert.equal(calls.length, 1);
  const dispatchedYaml = String(calls[0]?.inlineYaml ?? '');
  assert.ok(!dispatchedYaml.includes('launchApp'), 'no launch prologue reaches the executor');
});

test('GH #628: a lifecycle-free flow drives zero managed relaunches at the stage owner', async () => {
  // The stage machinery itself is unchanged for cold flows; the parked fix
  // works because parked bodies can never contain a launch stage. Model the
  // parked device and prove its screen survives a parked-shaped flow.
  const device = { screen: PARK_ANCHOR, relaunches: 0 };
  const results = await executeMaestroAuthorityStages(
    [{ assertVisible: { id: PARK_ANCHOR } }, { tapOn: { id: 'sign-cta' } }],
    async (commands: readonly unknown[]) => {
      for (const command of commands) {
        const anchor = (command as { assertVisible?: { id?: string } }).assertVisible;
        if (anchor?.id && anchor.id !== device.screen) {
          throw new Error(`ASSERTION_FAILED: "${anchor.id}" not on screen "${device.screen}"`);
        }
      }
      return 'ok';
    },
    async () => {},
    async () => {},
    async () => {
      device.relaunches += 1;
      device.screen = 'home-anchor';
    },
    async () => {},
  );
  assert.equal(results.length, 1);
  assert.equal(device.relaunches, 0, 'no launch stage means no managed relaunch');
  assert.equal(device.screen, PARK_ANCHOR, 'the park screen survives the replay');
});

// ─── Load-time refusals (existing BAD_RECORDING + mandatory cause) ──────────

const FORBIDDEN_BODIES: Array<{ name: string; body: string[] }> = [
  { name: 'launchApp', body: ['- launchApp:\n    stopApp: false', ...PARKED_BODY] },
  { name: 'stopApp', body: [...PARKED_BODY, '- stopApp'] },
  { name: 'killApp', body: [...PARKED_BODY, '- killApp'] },
  { name: 'clearState', body: ['- clearState', ...PARKED_BODY] },
  {
    name: 'launchApp',
    body: [
      ...PARKED_BODY,
      '- runFlow:\n    when:\n      visible: "picker"\n    commands:\n      - launchApp',
    ],
  },
];

for (const { name, body } of FORBIDDEN_BODIES) {
  test(`GH #628 control: parked body containing ${name} (${body.length} steps) refuses BAD_RECORDING before any dispatch`, async () => {
    project.seedAction('parked-sign-mandate', parkedYaml(body), null);
    const calls: Array<Record<string, unknown>> = [];
    const handler = handlerWith(calls, { status: 'visible' });

    const result = envelope(
      await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_RECORDING');
    assert.deepEqual(result.meta?.cause, { parkedActionLifecycle: name });
    assert.equal(calls.length, 0, 'zero steps ran');
    assert.equal(sidecarRecords('parked-sign-mandate').length, 0);
  });
}

test('GH #628: a lifecycle command hidden in a subflow file still refuses BAD_RECORDING', async () => {
  // The corpus loader inlines readable runFlow files, so the parked scan sees
  // the complete command graph; an unreadable subflow already refuses at YAML
  // validity. The domain function additionally fails closed on any file-form
  // reference that reaches it un-inlined.
  writeFileSync(join(project.actionsDir, 'sub.yaml'), '- launchApp\n');
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- runFlow: sub.yaml']),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, { status: 'visible' });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_RECORDING');
  assert.deepEqual(result.meta?.cause, { parkedActionLifecycle: 'launchApp' });
  assert.equal(calls.length, 0);

  assert.deepEqual(parkedBodyViolation([{ runFlow: 'other.yaml' }]), {
    kind: 'runflow-file',
    reference: 'other.yaml',
  });
});

test('GH #628: non-allowlisted composites refuse upstream; domain scan still catches nested lifecycle', async () => {
  // `repeat` is not in the flow validator's allowlist, so it refuses as
  // invalid YAML before the parked scan; the domain function remains
  // defense-in-depth for any composite that carries a commands array.
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([...PARKED_BODY, '- repeat:\n    times: 2\n    commands:\n      - killApp']),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, { status: 'visible' });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_RECORDING');
  assert.equal(calls.length, 0, 'zero steps ran');

  assert.deepEqual(parkedBodyViolation([{ repeat: { times: 2, commands: ['killApp'] } }]), {
    kind: 'lifecycle',
    command: 'killApp',
  });
});

for (const declaration of [
  { header: '# entry: parkd', value: 'parkd', label: 'unknown' },
  { header: '# entry:', value: '', label: 'empty' },
]) {
  test(`GH #628: an ${declaration.label} entry value refuses instead of downgrading to cold`, async () => {
    project.seedAction(
      'parked-sign-mandate',
      parkedYaml(PARKED_BODY).replace('# entry: parked', declaration.header),
      null,
    );
    const calls: Array<Record<string, unknown>> = [];
    const handler = handlerWith(calls, { status: 'visible' });

    const result = envelope(
      await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_RECORDING');
    assert.deepEqual(result.meta?.cause, { invalidEntry: declaration.value });
    assert.equal(calls.length, 0);
  });
}

// ─── Park preflight negative controls (PARK_STATE_MISSING) ──────────────────

test('GH #628 negative control: absent park anchor refuses PARK_STATE_MISSING before mutations', async () => {
  project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, {
    status: 'anchor-missing',
    reason: 'frontmost check saw route home',
  });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PARK_STATE_MISSING');
  const preflight = (result.meta?.parkPreflight ?? {}) as Record<string, unknown>;
  assert.equal(preflight.cause, 'anchor-missing');
  assert.equal(preflight.anchorId, PARK_ANCHOR);
  assert.equal(calls.length, 0, 'refused before any step ran');
  const records = sidecarRecords('parked-sign-mandate');
  assert.equal(records.length, 1);
  assert.equal(records[0]?.failureCode, 'MUTATE_PRECONDITION_FAILED');
});

for (const probe of [
  { status: 'unresponsive', reason: 'no answer in 4000ms' } as const,
  { status: 'backgrounded', reason: 'AppState.currentState is "background"' } as const,
]) {
  test(`GH #628: a ${probe.status} app refuses with the distinct app-backgrounded cause`, async () => {
    project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
    const calls: Array<Record<string, unknown>> = [];
    const handler = handlerWith(calls, probe);

    const result = envelope(
      await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
    );

    assert.equal(result.ok, false);
    assert.equal(result.code, 'PARK_STATE_MISSING');
    assert.equal(
      ((result.meta?.parkPreflight ?? {}) as Record<string, unknown>).cause,
      'app-backgrounded',
    );
    assert.equal(calls.length, 0);
  });
}

test('GH #628: a parked body with no id-bearing anchor refuses before the probe even runs', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml(['- assertVisible: "Sign your mandate"', '- tapOn: "Sign"']),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const probeCalls: string[] = [];
  const handler = handlerWith(calls, async (anchorId: string) => {
    probeCalls.push(anchorId);
    return { status: 'visible' } as const;
  });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PARK_STATE_MISSING');
  assert.equal(
    ((result.meta?.parkPreflight ?? {}) as Record<string, unknown>).cause,
    'anchor-missing',
  );
  assert.equal(probeCalls.length, 0, 'no anchor to probe — refused before the probe');
  assert.equal(calls.length, 0);
});

test('GH #628: a parameterized park anchor resolves from args.params before probing', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml(
      ['- assertVisible:\n    id: "${ANCHOR}"', '- tapOn:\n    id: "sign-cta"'],
      ['# params: [ANCHOR]'],
    ),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const probeCalls: string[] = [];
  const handler = handlerWith(calls, async (anchorId: string) => {
    probeCalls.push(anchorId);
    return { status: 'visible' } as const;
  });

  const result = envelope(
    await handler({
      actionId: 'parked-sign-mandate',
      projectRoot: project.root,
      params: { ANCHOR: PARK_ANCHOR },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(probeCalls, [PARK_ANCHOR], 'the probe received the substituted anchor');
  assert.equal(calls.length, 1);
});

test('GH #628: an unreadable subflow reference refuses BAD_RECORDING with zero dispatches', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- runFlow: missing-sub.yaml']),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, { status: 'visible' });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_RECORDING');
  assert.deepEqual(result.meta?.cause, { parkedRunFlowFile: 'missing-sub.yaml' });
  assert.equal(calls.length, 0, 'the uninspectable graph never dispatched');
});

test('GH #628: generated parked metadata refuses replay off the recorded start route', async () => {
  const generated = generateMaestro([{ type: 'tap', testID: PARK_ANCHOR, t: 1 }], {
    bundleId: 'com.test.app',
    id: 'parked-sign-mandate',
    intent: 'sign the parked mandate',
    mutates: true,
    status: 'experimental',
    entry: 'parked',
    startRoute: 'MandateSign',
  });
  project.seedAction('parked-sign-mandate', generated, null);
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, { status: 'visible' }, { getLiveRoute: async () => 'Home' });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'PARK_STATE_MISSING');
  const preflight = (result.meta?.parkPreflight ?? {}) as Record<string, unknown>;
  assert.equal(preflight.cause, 'route-mismatch');
  assert.equal(preflight.expectedRoute, 'MandateSign');
  assert.equal(preflight.liveRoute, 'Home');
  assert.equal(calls.length, 0);
});

test('GH #628: an unwired or unreachable probe fails closed without inventing park evidence', async () => {
  project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
  const calls: Array<Record<string, unknown>> = [];
  const handler = createPinnedRunActionHandler({ maestroRun: fakeMaestroRun(calls) }) as (
    args: RunActionArgs,
  ) => Promise<ToolResult>;

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'CDP_NOT_CONNECTED');
  assert.equal(calls.length, 0);
});

// ─── Probe adapter (real classification over a controllable client) ─────────

function fakeProbeClient(handlers: {
  connected?: boolean;
  appState?: () => Promise<{ value?: unknown; error?: string }>;
  frontmost?: () => Promise<{ value?: unknown; error?: string }>;
}): ParkProbeClient {
  return {
    isConnected: handlers.connected ?? true,
    bridgeWithFallback: (call: string) => call,
    evaluate: (expression: string) =>
      expression.includes('isTestIdFrontmost')
        ? (handlers.frontmost ?? (async () => ({ value: '{"visible":true}' })))()
        : (handlers.appState ?? (async () => ({ value: '{"state":"active"}' })))(),
  };
}

test('GH #628 probe adapter: classifies visible / missing / backgrounded / timeout / transport honestly', async () => {
  const probeWith = (handlers: Parameters<typeof fakeProbeClient>[0]) =>
    createParkAnchorProbe(() => fakeProbeClient(handlers))(PARK_ANCHOR);

  assert.deepEqual(await probeWith({}), { status: 'visible' });
  assert.deepEqual(
    await probeWith({ frontmost: async () => ({ value: '{"visible":false,"reason":"r"}' }) }),
    { status: 'anchor-missing', reason: 'r' },
  );
  assert.equal(
    (await probeWith({ appState: async () => ({ value: '{"state":"background"}' }) })).status,
    'backgrounded',
  );
  assert.equal(
    (
      await probeWith({
        frontmost: async () => {
          throw new Error('CDP timeout (Runtime.evaluate after 4000ms)');
        },
      })
    ).status,
    'unresponsive',
  );
  assert.equal(
    (
      await probeWith({
        appState: async () => {
          throw new Error('CDP timeout (Runtime.evaluate after 4000ms)');
        },
      })
    ).status,
    'unresponsive',
  );
  assert.equal((await probeWith({ connected: false })).status, 'unreachable');
  assert.equal(
    (
      await probeWith({
        frontmost: async () => {
          throw new Error('WebSocket closed');
        },
      })
    ).status,
    'unreachable',
  );
  assert.equal(
    (await probeWith({ frontmost: async () => ({ error: 'helpers stale' }) })).status,
    'unreachable',
  );
  assert.equal(
    (await probeWith({ frontmost: async () => ({ value: '{"visible":"false"}' }) })).status,
    'unreachable',
    'a non-boolean visible field never counts as anchor evidence',
  );
  assert.equal(
    (await probeWith({ appState: async () => ({ value: '{"state":"unknown"}' }) })).status,
    'visible',
    'unknown AppState stays fail-open; the anchor check decides',
  );
});

test('GH #628: recorder handler forwards entry: parked to the Detox refusal', async () => {
  _setStoredEvents([{ type: 'tap', testID: PARK_ANCHOR, t: 1 }]);
  try {
    const result = envelope(
      await createRecordTestGenerateHandler()({
        format: 'detox',
        id: 'p',
        intent: 'x',
        entry: 'parked',
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_RECORDING');
    assert.match(result.error ?? '', /parked is supported for Maestro actions only/);
  } finally {
    _resetState();
  }
});

// ─── Cold-entry behavior unchanged ──────────────────────────────────────────

test('GH #628 control: cold actions keep their launch prologue and never probe', async () => {
  project.seedAction(
    'cold-create-task',
    [
      'appId: com.test.app',
      '---',
      '# id: cold-create-task',
      '# intent: create a task from cold start',
      '# mutates: true',
      '# status: experimental',
      '# enginePin: maestro-runner@1.1.24',
      '',
      '- launchApp:\n    stopApp: false',
      '- tapOn:\n    id: "fab-create-task"',
      '',
    ].join('\n'),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const probeCalls: string[] = [];
  const handler = handlerWith(calls, async () => {
    probeCalls.push('probed');
    return { status: 'visible' } as const;
  });

  const result = envelope(
    await handler({ actionId: 'cold-create-task', projectRoot: project.root }),
  );

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0]?.inlineYaml ?? '').includes('launchApp'), 'cold keeps its prologue');
  assert.equal(probeCalls.length, 0, 'cold entry never runs the park preflight');
});
