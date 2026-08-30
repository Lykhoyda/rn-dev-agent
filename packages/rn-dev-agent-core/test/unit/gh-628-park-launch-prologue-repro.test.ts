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
import { runInNewContext } from 'node:vm';
import {
  createMaestroRunHandler,
  executeMaestroAuthorityStages,
} from '../../dist/tools/maestro-run.js';
import { createMaestroTestAllHandler } from '../../dist/tools/maestro-test-all.js';
import { generateMaestro } from '../../dist/tools/test-recorder-generators.js';
import {
  _resetState,
  _setRecordingStartRoute,
  _setStoredEvents,
  createRecordTestGenerateHandler,
} from '../../dist/tools/test-recorder.js';
import { createSaveAsActionHandler } from '../../dist/tools/save-as-action.js';
import {
  detectEntryDeclaration,
  parseM7Header,
  serializeM7Header,
} from '../../dist/domain/reusable-action.js';
import { parkedBodyViolation } from '../../dist/domain/park-entry.js';
import { createParkAnchorProbe, type ParkProbeClient } from '../../dist/tools/park-probe.js';
import { prepareActionVerificationSuite } from '../../dist/domain/action-verification-suite.js';
import { loadAction, saveAction } from '../../dist/domain/action-store.js';
import { applyRepair, attemptRepair } from '../../dist/domain/repair-engine.js';
import { lockE2eTestCore } from '../../dist/tools/lock-e2e-test.js';
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

function selectorFailure(
  steps: Array<Record<string, unknown>>,
  completedSteps: number,
): ToolResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          ok: true,
          data: {
            passed: false,
            output: 'Element with id "stale-selector" not found',
            steps,
            terminal: {
              completedSteps,
              failedStep: 'tapOn id: stale-selector',
              exitClass: 'step-failure',
              failureKind: 'SELECTOR_NOT_FOUND',
              failureSelector: 'stale-selector',
            },
          },
        }),
      },
    ],
  };
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

test('GH #628: parked generation refuses every mutation before the shared park anchor', () => {
  const anchor = { type: 'tap', testID: PARK_ANCHOR, t: 2 } as const;
  const openings = [
    { type: 'long_press', testID: 'menu', t: 1 } as const,
    { type: 'swipe', direction: 'up', t: 1 } as const,
    { type: 'submit', t: 1 } as const,
    { type: 'tap', label: 'Continue', t: 1 } as const,
  ];
  for (const opening of openings) {
    assert.throws(
      () => generateMaestro([opening, anchor], { id: 'p', intent: 'x', entry: 'parked' }),
      /no id-bearing assertVisible\/extendedWaitUntil\/tapOn opens the body/,
    );
  }
  assert.doesNotThrow(() => generateMaestro([openings[0]!, anchor], { id: 'c', intent: 'x' }));
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

test('GH #628: repair preserves an empty entry declaration and its replay refusal', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([
      `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
      '- tapOn:\n    id: "stale-selector"',
    ]).replace('# entry: parked', '# entry:'),
    null,
  );
  const action = loadAction(project.root, 'parked-sign-mandate');
  assert.ok(action);
  const repair = attemptRepair(action, 'stale-selector', ['fresh-selector']);
  assert.equal(repair.kind, 'patched');
  if (repair.kind !== 'patched') return;
  saveAction(applyRepair(action, repair));

  const persisted = project.readYaml('parked-sign-mandate');
  assert.deepEqual(
    persisted.split('\n').filter((line: string) => line.startsWith('# entry:')),
    ['# entry:'],
  );
  assert.equal(parseM7Header(persisted)?.entry, '');

  const calls: Array<Record<string, unknown>> = [];
  const result = envelope(
    await handlerWith(calls, { status: 'visible' })({
      actionId: 'parked-sign-mandate',
      projectRoot: project.root,
    }),
  );
  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_RECORDING');
  assert.deepEqual(result.meta?.cause, { invalidEntry: '' });
  assert.equal(calls.length, 0);
});

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

test('GH #628: proof rehearsals keep both park refusals sidecar-free', async () => {
  for (const scenario of [
    {
      probe: { status: 'anchor-missing', reason: 'wrong screen' } as const,
      code: 'PARK_STATE_MISSING',
    },
    {
      probe: { status: 'unreachable', reason: 'transport closed' } as const,
      code: 'CDP_NOT_CONNECTED',
    },
  ]) {
    project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
    const calls: Array<Record<string, unknown>> = [];
    const result = envelope(
      await handlerWith(
        calls,
        scenario.probe,
      )({
        actionId: 'parked-sign-mandate',
        projectRoot: project.root,
        proofReplay: true,
        autoRepair: false,
        forceReload: false,
      }),
    );
    assert.equal(result.code, scenario.code);
    assert.equal(((result.meta?.writes ?? {}) as Record<string, unknown>).runtimeState, 'none');
    assert.equal(sidecarRecords('parked-sign-mandate').length, 0);
    assert.equal(calls.length, 0);
  }
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

test('GH #628: an unreadable subflow reports the actual failing reference', async () => {
  writeFileSync(
    join(project.actionsDir, 'readable-sub.yaml'),
    '- assertVisible:\n    id: "ready"\n',
  );
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([
      `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
      '- runFlow: readable-sub.yaml',
      '- runFlow: missing-sub.yaml',
    ]),
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
  assert.equal(calls.length, 0);
});

test('GH #628: an empty subflow reference has a non-empty structured cause', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- runFlow: ""']),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, { status: 'visible' });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_RECORDING');
  assert.deepEqual(result.meta?.cause, { parkedRunFlowFile: '<empty>' });
  assert.equal(calls.length, 0);
});

test('GH #628: a non-string runFlow file refuses with a structured cause', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- runFlow:\n    file: 123']),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const handler = handlerWith(calls, { status: 'visible' });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'BAD_RECORDING');
  assert.deepEqual(result.meta?.cause, { parkedRunFlowFile: '<invalid:number>' });
  assert.equal(calls.length, 0);
});

test('GH #628: a nested invalid runFlow file preserves its structured cause', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([
      `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
      '- runFlow:\n    commands:\n      - runFlow:\n          file: 123',
    ]),
    null,
  );
  const calls: Array<Record<string, unknown>> = [];
  const result = envelope(
    await handlerWith(calls, { status: 'visible' })({
      actionId: 'parked-sign-mandate',
      projectRoot: project.root,
    }),
  );
  assert.equal(result.code, 'BAD_RECORDING');
  assert.deepEqual(result.meta?.cause, { parkedRunFlowFile: '<invalid:number>' });
  assert.equal(calls.length, 0);
});

test('GH #628: unsafe runFlow references retain safe bounded structured causes', async () => {
  const references = [
    { yaml: 'missing\\n.yaml', expected: 'missing\\n.yaml' },
    { yaml: 'missing\\u2028.yaml', expected: 'missing\\u2028.yaml' },
    { yaml: `${'a'.repeat(5000)}.yaml`, expected: null },
  ];
  for (const reference of references) {
    project.seedAction(
      'parked-sign-mandate',
      parkedYaml([
        `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
        `- runFlow:\n    file: "${reference.yaml}"`,
      ]),
      null,
    );
    const calls: Array<Record<string, unknown>> = [];
    const result = envelope(
      await handlerWith(calls, { status: 'visible' })({
        actionId: 'parked-sign-mandate',
        projectRoot: project.root,
      }),
    );
    assert.equal(result.code, 'BAD_RECORDING');
    const cause = (result.meta?.cause as Record<string, unknown>)?.parkedRunFlowFile;
    assert.equal(typeof cause, 'string');
    assert.ok(String(cause).length <= 240);
    assert.ok(!String(cause).includes('\n'));
    assert.ok(!String(cause).includes('\u2028'));
    if (reference.expected) assert.equal(cause, reference.expected);
    else assert.match(String(cause), /\.\.\.$/);
    assert.equal(calls.length, 0);
  }
});

test('GH #628: maestro_run refuses parked and invalid learned-action entry modes', async () => {
  project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
  let spawned = false;
  const handler = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });

  const parked = envelope(
    await handler({ platform: 'ios', flowPath: project.yamlPath('parked-sign-mandate') }),
  );
  assert.equal(parked.ok, false);
  assert.equal(parked.code, 'BAD_RECORDING');
  assert.match(parked.error ?? '', /cdp_run_action/);

  // The redesign made raw-preamble detection the only entry source: caller
  // metadata alone (regenerated text, validated upstream by run-action) no
  // longer drives admission, so the declaration must live in the artifact.
  const invalid = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: '# entry: parkd\n- tapOn:\n    id: "continue"\n',
      actionMetadata: { id: 'invalid-entry', entry: 'parkd' as never },
    }),
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'BAD_RECORDING');
  assert.deepEqual(invalid.meta?.cause, { invalidEntry: 'parkd' });
  assert.equal(spawned, false);
});

test('GH #628: maestro_run admits external M7 flows only through the shared entry contract', async () => {
  const parkedPath = join(project.root, 'external-parked.yaml');
  const invalidPath = join(project.root, 'external-invalid.yaml');
  writeFileSync(parkedPath, parkedYaml(PARKED_BODY), 'utf8');
  writeFileSync(
    invalidPath,
    parkedYaml(PARKED_BODY).replace('# entry: parked', '# entry: parkd'),
    'utf8',
  );
  let spawned = false;
  const handler = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });

  const parked = envelope(await handler({ platform: 'ios', flowPath: parkedPath }));
  assert.equal(parked.ok, false);
  assert.equal(parked.code, 'BAD_RECORDING');
  assert.match(parked.error ?? '', /cdp_run_action/);

  const invalid = envelope(await handler({ platform: 'ios', flowPath: invalidPath }));
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, 'BAD_RECORDING');
  assert.deepEqual(invalid.meta?.cause, { invalidEntry: 'parkd' });
  assert.equal(spawned, false);
});

test('GH #628: maestro_run admits inline M7 flows through the shared entry contract', async () => {
  let spawned = false;
  const handler = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });

  const parked = envelope(await handler({ platform: 'ios', inlineYaml: parkedYaml(PARKED_BODY) }));
  assert.equal(parked.code, 'BAD_RECORDING');
  assert.match(parked.error ?? '', /cdp_run_action/);

  const invalid = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: parkedYaml(PARKED_BODY).replace('# entry: parked', '# entry: parkd'),
    }),
  );
  assert.equal(invalid.code, 'BAD_RECORDING');
  assert.deepEqual(invalid.meta?.cause, { invalidEntry: 'parkd' });
  assert.equal(spawned, false);
});

const PARTIAL_PARKED_YAML = [
  'appId: com.test.app',
  '---',
  '# entry: parked',
  '',
  `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
  '- tapOn:\n    id: "sign-cta"',
  '',
].join('\n');

test('GH #628 regression: a partial parked declaration (no M7 identity) cannot bypass admission', async () => {
  let spawned = false;
  const handler = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });

  const inline = envelope(await handler({ platform: 'ios', inlineYaml: PARTIAL_PARKED_YAML }));
  assert.equal(inline.ok, false);
  assert.equal(inline.code, 'BAD_RECORDING');
  assert.match(inline.error ?? '', /cdp_run_action/);

  const filePath = join(project.root, 'partial-parked.yaml');
  writeFileSync(filePath, PARTIAL_PARKED_YAML, 'utf8');
  const file = envelope(await handler({ platform: 'ios', flowPath: filePath }));
  assert.equal(file.code, 'BAD_RECORDING');
  assert.match(file.error ?? '', /cdp_run_action/);

  const invalid = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: PARTIAL_PARKED_YAML.replace('# entry: parked', '# entry: parkd'),
    }),
  );
  assert.equal(invalid.code, 'BAD_RECORDING');
  assert.deepEqual(invalid.meta?.cause, { invalidEntry: 'parkd' });

  const empty = envelope(
    await handler({
      platform: 'ios',
      inlineYaml: PARTIAL_PARKED_YAML.replace('# entry: parked', '# entry:'),
    }),
  );
  assert.equal(empty.code, 'BAD_RECORDING');
  assert.deepEqual(empty.meta?.cause, { invalidEntry: '' });

  const suitePath = join(project.actionsDir, 'partial-parked.yaml');
  writeFileSync(suitePath, PARTIAL_PARKED_YAML, 'utf8');
  const verification = prepareActionVerificationSuite([suitePath], project.actionsDir, null);
  assert.equal(verification.prepared.length, 0);
  assert.equal(verification.errors[0]?.code, 'BAD_RECORDING');
  assert.match(verification.errors[0]?.error ?? '', /cdp_run_action/);

  assert.equal(spawned, false, 'no partial declaration reached execution');
});

test('GH #628 control: an entry token in body text never triggers admission', async () => {
  const bodyTextYaml = [
    'appId: com.test.app',
    '---',
    `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
    '# entry: parked',
    '- tapOn:\n    id: "sign-cta"',
    '',
  ].join('\n');

  assert.equal(detectEntryDeclaration(bodyTextYaml), undefined, 'body comment is not a preamble');
  assert.equal(detectEntryDeclaration(PARTIAL_PARKED_YAML), 'parked');
  assert.equal(detectEntryDeclaration('# entry:\n- tapOn:\n    id: "x"\n'), '');
  assert.equal(detectEntryDeclaration('- tapOn:\n    id: "x"\n'), undefined);
  assert.equal(
    detectEntryDeclaration('# id: a\n# intent: b\n\n# entry: parked\n- tapOn:\n    id: "x"\n'),
    'parked',
    'a detached pre-body declaration still admits (fail-closed) — only body text never can',
  );
  assert.equal(
    detectEntryDeclaration('# banner\nappId: com.x\n---\n# entry: parked\n- tapOn:\n    id: "x"\n'),
    'parked',
    'a top-section banner comment does not hide the M7 declaration after ---',
  );
  assert.equal(
    detectEntryDeclaration('# entry: cold\n# entry: parked\n- tapOn:\n    id: "x"\n'),
    'cold | parked',
    'duplicate declarations never pick a winner — the joined value refuses downstream',
  );
  assert.equal(
    detectEntryDeclaration('appId: com.x\n---\nfoo: bar\n# entry: parked\n- tapOn:\n    id: "x"\n'),
    undefined,
    'content after the divider ends detection before any later comment',
  );

  const handler = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => ({ stdout: '', stderr: '' }),
  });
  // Every entry-admission refusal carries BAD_RECORDING with zero dispatch, so
  // any other outcome — including reaching the post-admission authority claim,
  // which throws in this session-less harness — proves admission passed.
  let outcome: string;
  try {
    const result = envelope(await handler({ platform: 'ios', inlineYaml: bodyTextYaml }));
    outcome = result.code ?? 'ok';
    assert.ok(
      !/cdp_run_action|entry mode|invalidEntry/.test(result.error ?? ''),
      `body text must not trigger entry admission, got: ${result.error ?? 'ok'}`,
    );
    assert.equal(result.meta?.cause, undefined);
  } catch (err) {
    outcome = (err as { code?: string }).code ?? String(err);
  }
  // The session-less harness throws exactly at the post-admission native-origin
  // claim — reaching it is a deterministic proof the flow passed admission.
  assert.equal(outcome, 'METRO_ORIGIN_MISMATCH', `expected post-admission claim, got ${outcome}`);
});

test('GH #628: suite executors refuse parked actions before execution', async () => {
  project.seedAction('parked-sign-mandate', parkedYaml(PARKED_BODY), null);
  let executed = false;
  const suite = envelope(
    await createMaestroTestAllHandler({
      getActiveSession: () => null,
      runFlow: async () => {
        executed = true;
        return { content: [{ type: 'text', text: JSON.stringify(PASS_ENV) }] };
      },
    })({ platform: 'ios', flowDir: project.actionsDir }),
  );
  assert.equal(suite.ok, false);
  assert.equal(suite.code, 'BAD_RECORDING');

  const verification = prepareActionVerificationSuite(
    [project.yamlPath('parked-sign-mandate')],
    project.actionsDir,
    null,
  );
  assert.equal(verification.prepared.length, 0);
  assert.equal(verification.errors[0]?.code, 'BAD_RECORDING');
  assert.match(verification.errors[0]?.error ?? '', /cdp_run_action/);
  assert.equal(executed, false);
});

test('GH #628: lock-e2e preserves shared parked entry refusal envelopes', async () => {
  let spawned = false;
  const maestroRun = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => {
      spawned = true;
      return { stdout: '', stderr: '' };
    },
  });
  for (const declaration of [
    { header: '# entry: parked', invalidEntry: null },
    { header: '# entry: parkd', invalidEntry: 'parkd' },
  ]) {
    project.seedAction(
      'parked-sign-mandate',
      parkedYaml(PARKED_BODY).replace('# entry: parked', declaration.header),
      null,
    );
    const result = envelope(
      await lockE2eTestCore(
        { actionId: 'parked-sign-mandate', projectRoot: project.root },
        {
          maestroRun,
          getSession: () => ({
            name: 'test',
            platform: 'ios',
            deviceId: 'device',
            appId: 'com.test.app',
            openedAt: '',
          }),
        },
      ),
    );
    assert.equal(result.code, 'BAD_RECORDING');
    if (declaration.invalidEntry) {
      assert.deepEqual(result.meta?.cause, { invalidEntry: declaration.invalidEntry });
    } else {
      assert.match(result.error ?? '', /cdp_run_action/);
    }
    assert.equal(
      existsSync(join(project.root, '.rn-agent', 'e2e', 'parked-sign-mandate.yaml')),
      false,
    );
  }
  assert.equal(spawned, false);
});

test('GH #628: alternate executors preserve parked body refusal causes', async () => {
  let executed = false;
  const maestroRun = createMaestroRunHandler({
    getActiveSession: () => null,
    execFile: async () => {
      executed = true;
      return { stdout: '', stderr: '' };
    },
  });
  for (const scenario of [
    {
      body: [`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- launchApp'],
      cause: { parkedActionLifecycle: 'launchApp' },
    },
    {
      body: [
        `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
        '- runFlow:\n    file: "missing-sub.yaml"',
      ],
      cause: { parkedRunFlowFile: 'missing-sub.yaml' },
    },
  ]) {
    project.seedAction('parked-sign-mandate', parkedYaml(scenario.body), null);

    const maestro = envelope(
      await maestroRun({
        platform: 'ios',
        flowPath: project.yamlPath('parked-sign-mandate'),
      }),
    );
    assert.equal(maestro.code, 'BAD_RECORDING');
    assert.deepEqual(maestro.meta?.cause, scenario.cause);

    const suite = envelope(
      await createMaestroTestAllHandler({
        getActiveSession: () => null,
        runFlow: async () => {
          executed = true;
          return { content: [{ type: 'text', text: JSON.stringify(PASS_ENV) }] };
        },
      })({ platform: 'ios', flowDir: project.actionsDir }),
    );
    assert.equal(suite.code, 'BAD_RECORDING');
    assert.deepEqual(suite.meta?.cause, scenario.cause);

    const verification = prepareActionVerificationSuite(
      [project.yamlPath('parked-sign-mandate')],
      project.actionsDir,
      null,
    );
    assert.equal(verification.prepared.length, 0);
    assert.deepEqual(verification.errors[0]?.cause, scenario.cause);

    const lock = envelope(
      await lockE2eTestCore(
        { actionId: 'parked-sign-mandate', projectRoot: project.root },
        { maestroRun },
      ),
    );
    assert.equal(lock.code, 'BAD_RECORDING');
    assert.deepEqual(lock.meta?.cause, scenario.cause);
  }
  assert.equal(executed, false);
});

test('GH #628: invalid entry outranks malformed bodies in every alternate executor', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- runFlow:\n    file: 123']).replace(
      '# entry: parked',
      '# entry: parkd',
    ),
    null,
  );
  let executed = false;
  const maestro = envelope(
    await createMaestroRunHandler({
      getActiveSession: () => null,
      execFile: async () => {
        executed = true;
        return { stdout: '', stderr: '' };
      },
    })({ platform: 'ios', flowPath: project.yamlPath('parked-sign-mandate') }),
  );
  assert.equal(maestro.code, 'BAD_RECORDING');
  assert.deepEqual(maestro.meta?.cause, { invalidEntry: 'parkd' });

  const suite = envelope(
    await createMaestroTestAllHandler({
      getActiveSession: () => null,
      runFlow: async () => {
        executed = true;
        return { content: [{ type: 'text', text: JSON.stringify(PASS_ENV) }] };
      },
    })({ platform: 'ios', flowDir: project.actionsDir }),
  );
  assert.equal(suite.code, 'BAD_RECORDING');
  assert.deepEqual(suite.meta?.cause, { invalidEntry: 'parkd' });

  const verification = prepareActionVerificationSuite(
    [project.yamlPath('parked-sign-mandate')],
    project.actionsDir,
    null,
  );
  assert.equal(verification.prepared.length, 0);
  assert.equal(verification.errors[0]?.code, 'BAD_RECORDING');
  assert.deepEqual(verification.errors[0]?.cause, { invalidEntry: 'parkd' });

  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([`- assertVisible:\n    id: "${PARK_ANCHOR}"`, '- runFlow:\n    file: 123']).replace(
      '# entry: parked',
      '# entry: cold',
    ),
    null,
  );
  const malformedCold = envelope(
    await createMaestroRunHandler({
      getActiveSession: () => null,
      execFile: async () => {
        executed = true;
        return { stdout: '', stderr: '' };
      },
    })({ platform: 'ios', flowPath: project.yamlPath('parked-sign-mandate') }),
  );
  assert.equal(malformedCold.code, 'BAD_RECORDING');
  assert.equal(malformedCold.meta?.cause, undefined);
  assert.equal(executed, false);
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

test('GH #628 probe adapter reads explicit AppState from a Metro Map registry', async () => {
  const modules = new Map([
    [
      1,
      {
        isInitialized: true,
        verboseName: 'node_modules/react-native/Libraries/AppState/AppState.js',
        publicModule: { exports: { default: { currentState: 'background' } } },
      },
    ],
  ]);
  const probe = createParkAnchorProbe(() => ({
    isConnected: true,
    bridgeWithFallback: (call: string) => call,
    evaluate: async (expression: string) => ({
      value: runInNewContext(expression, {
        globalThis: { __r: { getModules: () => modules } },
      }) as unknown,
    }),
  }));

  assert.deepEqual(await probe(PARK_ANCHOR), {
    status: 'backgrounded',
    reason: 'AppState.currentState is "background"',
  });
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

test('GH #628: parked save refuses a destination anchor reached after a label-only tap', async () => {
  _setStoredEvents([
    { type: 'tap', label: 'Continue', route: 'Start', t: 1 },
    { type: 'navigate', from: 'Start', to: 'Destination', t: 2 },
    { type: 'tap', testID: 'destination-anchor', route: 'Destination', t: 3 },
  ]);
  _setRecordingStartRoute('Start');
  try {
    const result = envelope(
      await createSaveAsActionHandler()({
        id: 'parked-destination-anchor',
        intent: 'continue from the parked screen',
        bundleId: 'com.test.app',
        projectRoot: project.root,
        entry: 'parked',
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_RECORDING');
    assert.ok(
      typeof result.meta?.cause === 'object' &&
        result.meta.cause !== null &&
        'parkedAnchorUnresolvable' in result.meta.cause,
    );
    assert.equal(project.yamlExists('parked-destination-anchor'), false);
  } finally {
    _resetState();
  }
});

test('GH #628: parked save preserves a selectorless opening mutation as a refusal', async () => {
  _setStoredEvents([
    { type: 'tap', route: 'Start', t: 1 },
    { type: 'navigate', from: 'Start', to: 'Destination', t: 2 },
    { type: 'tap', testID: 'destination-anchor', route: 'Destination', t: 3 },
  ]);
  _setRecordingStartRoute('Start');
  try {
    const result = envelope(
      await createSaveAsActionHandler()({
        id: 'parked-selectorless-opening',
        intent: 'continue after a selectorless opening interaction',
        bundleId: 'com.test.app',
        projectRoot: project.root,
        entry: 'parked',
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_RECORDING');
    assert.match(
      String((result.meta?.cause as Record<string, unknown>)?.parkedAnchorUnresolvable),
      /recorded tap interaction.*no testID or label/,
    );
    assert.equal(project.yamlExists('parked-selectorless-opening'), false);
  } finally {
    _resetState();
  }
});

test('GH #628: parked save refuses an unpaired navigation before its destination anchor', async () => {
  _setStoredEvents([
    { type: 'navigate', from: 'Start', to: 'Destination', t: 1 },
    { type: 'tap', testID: 'destination-anchor', route: 'Destination', t: 2 },
  ]);
  _setRecordingStartRoute('Start');
  try {
    const result = envelope(
      await createSaveAsActionHandler()({
        id: 'parked-unpaired-navigation',
        intent: 'continue after an unpaired recorded navigation',
        bundleId: 'com.test.app',
        projectRoot: project.root,
        entry: 'parked',
      }),
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'BAD_RECORDING');
    assert.match(
      String((result.meta?.cause as Record<string, unknown>)?.parkedAnchorUnresolvable),
      /recorded navigation to Destination.*before a probeable park anchor/,
    );
    assert.equal(project.yamlExists('parked-unpaired-navigation'), false);
  } finally {
    _resetState();
  }
});

test('GH #628: parked save accepts an opening parameterized anchor', async () => {
  _setStoredEvents([{ type: 'tap', testID: '${ANCHOR}', route: 'Start', t: 1 }]);
  _setRecordingStartRoute('Start');
  try {
    const result = envelope(
      await createSaveAsActionHandler()({
        id: 'parked-parameter-anchor',
        intent: 'continue from a parameterized park state',
        bundleId: 'com.test.app',
        projectRoot: project.root,
        entry: 'parked',
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(project.yamlExists('parked-parameter-anchor'), true);
  } finally {
    _resetState();
  }
});

test('GH #628: parked auto-repair never retries after a completed mutation', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([
      `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
      '- tapOn:\n    id: "delete-item"',
      '- tapOn:\n    id: "stale-selector"',
    ]),
    null,
  );
  let maestroCalls = 0;
  let repairCalls = 0;
  const handler = createPinnedRunActionHandler({
    probeParkAnchor: async () => ({ status: 'visible' as const }),
    maestroRun: async () => {
      maestroCalls += 1;
      return selectorFailure(
        [
          { index: 0, verb: 'assertVisible', status: 'pass' },
          { index: 1, verb: 'tapOn', status: 'pass' },
          { index: 2, verb: 'tapOn', status: 'fail' },
        ],
        2,
      );
    },
    repairAction: async () => {
      repairCalls += 1;
      throw new Error('repair must not run after a parked mutation');
    },
  });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TESTID_NOT_FOUND');
  assert.equal(
    (result.meta?.autoRepair as Record<string, unknown>)?.refusedReason,
    'NOT_REPAIRABLE_KIND',
  );
  assert.equal(maestroCalls, 1);
  assert.equal(repairCalls, 0);
});

test('GH #628: parked auto-repair refuses before lifecycle-mutating repair', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([
      `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
      '- tapOn:\n    id: "stale-selector"',
    ]),
    null,
  );
  let maestroCalls = 0;
  let repairCalls = 0;
  let probeCalls = 0;
  const handler = createPinnedRunActionHandler({
    probeParkAnchor: async () => {
      probeCalls += 1;
      return { status: 'visible' as const };
    },
    maestroRun: async () => {
      maestroCalls += 1;
      return selectorFailure(
        [
          { index: 0, verb: 'assertVisible', status: 'pass' },
          { index: 1, verb: 'tapOn', status: 'fail' },
        ],
        1,
      );
    },
    repairAction: async () => {
      repairCalls += 1;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              data: {
                patched: true,
                oldSelector: 'stale-selector',
                newSelector: 'fresh-selector',
              },
            }),
          },
        ],
      };
    },
  });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, false);
  assert.equal(result.code, 'TESTID_NOT_FOUND');
  assert.match(result.error ?? '', /repair relaunches the app.*cannot preserve entry: parked/);
  assert.equal(
    (result.meta?.autoRepair as Record<string, unknown>)?.refusedReason,
    'NOT_REPAIRABLE_KIND',
  );
  assert.equal(probeCalls, 1);
  assert.equal(maestroCalls, 1);
  assert.equal(repairCalls, 0);
});

test('GH #628 control: cold auto-repair still repairs and retries', async () => {
  project.seedAction(
    'parked-sign-mandate',
    parkedYaml([
      `- assertVisible:\n    id: "${PARK_ANCHOR}"`,
      '- tapOn:\n    id: "stale-selector"',
    ]).replace('# entry: parked', '# entry: cold'),
    null,
  );
  let maestroCalls = 0;
  let repairCalls = 0;
  let probeCalls = 0;
  const handler = createPinnedRunActionHandler({
    probeParkAnchor: async () => {
      probeCalls += 1;
      return { status: 'visible' as const };
    },
    maestroRun: async () => {
      maestroCalls += 1;
      return maestroCalls === 1
        ? selectorFailure(
            [
              { index: 0, verb: 'assertVisible', status: 'pass' },
              { index: 1, verb: 'tapOn', status: 'fail' },
            ],
            1,
          )
        : { content: [{ type: 'text' as const, text: JSON.stringify(PASS_ENV) }] };
    },
    repairAction: async () => {
      repairCalls += 1;
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              ok: true,
              data: {
                patched: true,
                oldSelector: 'stale-selector',
                newSelector: 'fresh-selector',
              },
            }),
          },
        ],
      };
    },
  });

  const result = envelope(
    await handler({ actionId: 'parked-sign-mandate', projectRoot: project.root }),
  );

  assert.equal(result.ok, true);
  assert.equal(maestroCalls, 2);
  assert.equal(repairCalls, 1);
  assert.equal(probeCalls, 0);
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
