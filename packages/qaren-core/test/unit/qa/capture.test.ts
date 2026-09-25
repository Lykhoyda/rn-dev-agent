import assert from 'node:assert/strict';
import { test } from 'node:test';
import { captureScreen } from '../../../dist/qa/capture.js';
import { decideScreen } from '../../../dist/qa/resolve.js';
import type { NativeObservation, ReactObservation } from '../../../dist/qa/capture.js';
import { assertionView, visibilityView } from '../../../dist/qa/screen.js';
import type { DigestEntry, NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';

const nodes: NativeNode[] = [
  {
    ref: '@save',
    index: 7,
    parentIndex: 2,
    depth: 3,
    type: 'Button',
    identifier: 'save',
    label: 'Save',
    hittable: true,
  },
];
const interactive: DigestEntry[] = [
  { role: 'button', testID: 'save', capabilities: { press: true, fill: false } },
  { role: 'button', testID: 'later', text: 'Later' },
];
const snapshotVerdict = {
  state: 'ok',
  source: 'rn-fast-runner',
  nodeCount: 1,
  refMapUpdated: true,
  reasons: [],
};
const verdict = { state: 'ok', path: 'interactive', complete: true };
const hostEvidence: ReactHostEvidence = {
  hosts: [{ testID: 'save', role: 'button', roleSource: 'role', capabilities: { press: true } }],
  complete: true,
};

test('a dropped native observation cannot turn 31 raw controls into an admissible set of 30', async () => {
  const retained = Array.from({ length: 30 }, (_, index) => ({
    ref: `@${index}`,
    type: 'Button',
    label: `Control ${index}`,
    hittable: true,
  }));
  const screen = await captureScreen({
    native: async () => ({
      nodes: retained,
      truncated: false,
      normalizationDroppedNodes: 1,
      snapshotVerdict: { ...snapshotVerdict, nodeCount: 30 },
    }),
    react: async () => ({ interactive: [], verdict }),
  });
  assert.equal(screen.captureCoverage?.native, 'incomplete');
  assert.equal(screen.coverage?.native, 'incomplete');
  const decision = await decideScreen(
    screen,
    {
      calls: [],
      ask: async () => assert.fail('a normalization loss must refuse before Jev'),
    },
    undefined,
    { kind: 'press', target: { phrase: 'the first control' }, line: 1 },
  );
  assert.ok(decision.target && 'refuse' in decision.target);
  assert.equal(decision.target.refuse, 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('complete acquisition preserves legacy joins without claiming semantic enumeration', async () => {
  const screen = await captureScreen({
    native: async () => ({
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict,
    }),
    react: async () => ({ interactive, verdict }),
  });

  assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'complete' });
  assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' });
  assert.equal(screen.reactHostEvidence, undefined);
  assert.deepEqual(
    screen.elements.map((element) => [element.ref, element.testID, element.label]),
    [
      ['@save', 'save', 'Save'],
      ['react:later', 'later', 'Later'],
    ],
  );
  assert.deepEqual(assertionView(screen), ['Save']);
  assert.ok(screen.elements.every((element) => element.semantic?.visibility === 'unknown'));
  assert.ok('refuse' in visibilityView(screen));
});

test('native acquisition coverage needs capture-time readiness as well as untruncated nodes', async () => {
  const cases: Array<[string, NativeObservation, 'unknown' | 'incomplete']> = [
    ['missing normalization coverage', { nodes, truncated: false, snapshotVerdict }, 'unknown'],
    [
      'malformed normalization coverage',
      { nodes, truncated: false, normalizationDroppedNodes: '0', snapshotVerdict },
      'unknown',
    ],
    [
      'negative normalization coverage',
      { nodes, truncated: false, normalizationDroppedNodes: -1, snapshotVerdict },
      'unknown',
    ],
    ['missing metadata', { nodes }, 'unknown'],
    ['missing verdict', { nodes, truncated: false }, 'unknown'],
    ['missing truncation', { nodes, snapshotVerdict }, 'unknown'],
    ['untyped truncation', { nodes, truncated: 'false', snapshotVerdict }, 'unknown'],
    ['false with missing nodes', { truncated: false, snapshotVerdict }, 'unknown'],
    ['false with empty nodes and no verdict', { nodes: [], truncated: false }, 'unknown'],
    ['truncated', { nodes, truncated: true, snapshotVerdict }, 'incomplete'],
    [
      'degraded nonempty capture',
      { nodes, truncated: false, snapshotVerdict: { ...snapshotVerdict, state: 'degraded' } },
      'incomplete',
    ],
    [
      'degraded empty capture',
      {
        nodes: [],
        truncated: false,
        snapshotVerdict: {
          ...snapshotVerdict,
          state: 'degraded',
          nodeCount: 0,
          refMapUpdated: false,
          reasons: ['empty-capture'],
        },
      },
      'incomplete',
    ],
    [
      'empty cannot claim readiness',
      { nodes: [], truncated: false, snapshotVerdict: { ...snapshotVerdict, nodeCount: 0 } },
      'incomplete',
    ],
    [
      'refs not updated',
      { nodes, truncated: false, snapshotVerdict: { ...snapshotVerdict, refMapUpdated: false } },
      'incomplete',
    ],
    [
      'verdict describes a different capture',
      { nodes, truncated: false, snapshotVerdict: { ...snapshotVerdict, nodeCount: 2 } },
      'incomplete',
    ],
    [
      'quality reasons cannot be ignored',
      {
        nodes,
        truncated: false,
        snapshotVerdict: { ...snapshotVerdict, reasons: ['empty-capture'] },
      },
      'incomplete',
    ],
  ];
  for (const [name, observation, expected] of cases) {
    const screen = await captureScreen({
      native: async () => observation,
      react: async () => ({ interactive, verdict }),
    });
    assert.equal(screen.captureCoverage?.native, expected, name);
    assert.equal(screen.captureCoverage?.react, 'complete', name);
    assert.equal(screen.coverage?.native, expected, name);
    assert.equal(screen.coverage?.react, 'unknown', name);
    assert.deepEqual(assertionView(screen), observation.nodes?.length ? ['Save'] : [], name);
    assert.ok('refuse' in visibilityView(screen), name);
  }
});

test('React acquisition coverage never turns unavailable digests into complete emptiness', async () => {
  const cases: Array<[string, ReactObservation, 'unknown' | 'incomplete' | 'complete']> = [
    ['unavailable', {}, 'unknown'],
    ['missing metadata', { interactive }, 'unknown'],
    ['false without metadata', { interactive, truncated: false }, 'unknown'],
    ['missing entries', { truncated: false, verdict }, 'unknown'],
    [
      'missing completeness',
      { interactive, verdict: { state: 'ok', path: 'interactive' } },
      'unknown',
    ],
    ['missing state', { interactive, verdict: { path: 'interactive', complete: true } }, 'unknown'],
    ['missing path', { interactive, verdict: { state: 'ok', complete: true } }, 'unknown'],
    ['untyped truncation', { interactive, verdict, truncated: 'false' }, 'unknown'],
    ['truncated', { interactive, verdict, truncated: true }, 'incomplete'],
    ['failed', { interactive, verdict: { ...verdict, state: 'failed' } }, 'incomplete'],
    ['degraded', { interactive, verdict: { ...verdict, state: 'degraded' } }, 'incomplete'],
    ['incomplete walk', { interactive, verdict: { ...verdict, complete: false } }, 'incomplete'],
    ['wrong path', { interactive, verdict: { ...verdict, path: 'tree' } }, 'incomplete'],
    [
      'no renderer',
      { verdict: { state: 'failed', path: 'none', complete: false, reasons: ['no-renderer'] } },
      'incomplete',
    ],
    [
      'truncation in verdict',
      { interactive, verdict: { ...verdict, reasons: ['output-truncated'] } },
      'incomplete',
    ],
    ['complete empty digest', { interactive: [], verdict }, 'complete'],
    ['explicitly untruncated', { interactive, verdict, truncated: false }, 'complete'],
  ];
  for (const [name, observation, expected] of cases) {
    const screen = await captureScreen({
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
      }),
      react: async () => observation,
    });
    assert.equal(screen.captureCoverage?.native, 'complete', name);
    assert.equal(screen.captureCoverage?.react, expected, name);
    assert.equal(screen.coverage?.native, 'unknown', name);
    assert.equal(
      screen.coverage?.react,
      expected === 'incomplete' ? 'incomplete' : 'unknown',
      name,
    );
    assert.deepEqual(assertionView(screen), ['Save'], name);
    assert.equal(
      screen.elements.some((element) => element.ref === 'react:later'),
      observation.interactive === interactive,
      name,
    );
    assert.ok('refuse' in visibilityView(screen), name);
  }
});

test('React semantic coverage requires validated opt-in host evidence, not digest quality', async () => {
  const cases: Array<[string, unknown, 'unknown' | 'incomplete' | 'complete']> = [
    ['absent evidence', undefined, 'unknown'],
    ['null evidence', null, 'incomplete'],
    ['non-object evidence', false, 'incomplete'],
    ['array evidence', [], 'incomplete'],
    ['missing hosts', { complete: true }, 'incomplete'],
    ['non-array hosts', { hosts: {}, complete: true }, 'incomplete'],
    ['missing completeness', { hosts: [] }, 'incomplete'],
    ['untyped completeness', { hosts: [], complete: 'true' }, 'incomplete'],
    ['malformed host', { hosts: [null], complete: true }, 'incomplete'],
    [
      'missing host metadata',
      { hosts: [{ testID: 'save', role: 'button' }], complete: true },
      'incomplete',
    ],
    [
      'invalid role source',
      { hosts: [{ ...hostEvidence.hosts[0], roleSource: 'inferred' }], complete: true },
      'incomplete',
    ],
    [
      'invalid capability',
      { hosts: [{ ...hostEvidence.hosts[0], capabilities: { press: false } }], complete: true },
      'incomplete',
    ],
    ['explicitly incomplete hosts', { ...hostEvidence, complete: false }, 'incomplete'],
    ['explicitly incomplete empty hosts', { hosts: [], complete: false }, 'incomplete'],
    ['complete empty hosts', { hosts: [], complete: true }, 'complete'],
    ['complete hosts', hostEvidence, 'complete'],
  ];
  for (const [name, evidence, expected] of cases) {
    const native: NativeObservation = {
      nodes,
      truncated: false,
      normalizationDroppedNodes: 0,
      snapshotVerdict,
    };
    const react: ReactObservation = {
      interactive,
      verdict,
      ...(evidence === undefined ? {} : { hostEvidence: evidence }),
    };
    const before = structuredClone({ native, react });
    const screen = await captureScreen({
      native: async () => native,
      react: async () => react,
      warn: () => assert.fail('host evidence must not be logged'),
    });
    assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'complete' }, name);
    assert.deepEqual(screen.coverage, { native: 'unknown', react: expected }, name);
    assert.deepEqual(assertionView(screen), ['Save'], name);
    const validEvidence =
      expected === 'complete' || name.startsWith('explicitly incomplete') ? evidence : undefined;
    assert.deepEqual(screen.reactHostEvidence, validEvidence, name);

    const decision = await decideScreen(
      screen,
      { calls: [], ask: async () => assert.fail(`${name}: native enumeration is still unknown`) },
      undefined,
      { kind: 'press', target: { phrase: 'the save control' }, line: 1 },
    );
    assert.ok(decision.target && 'refuse' in decision.target, name);
    assert.equal(decision.target.refuse, 'SCREEN_EVIDENCE_INCOMPLETE', name);
    assert.deepEqual({ native, react }, before, `${name}: observations must not be mutated`);
  }
});

test('complete host evidence cannot repair missing or incomplete interactive acquisition', async () => {
  const cases: Array<[string, ReactObservation, 'unknown' | 'incomplete' | 'complete']> = [
    ['missing digest', { verdict }, 'unknown'],
    ['missing verdict', { interactive }, 'unknown'],
    ['failed digest', { interactive, verdict: { ...verdict, state: 'failed' } }, 'incomplete'],
    ['truncated digest', { interactive, verdict, truncated: true }, 'incomplete'],
    ['wrong path', { interactive, verdict: { ...verdict, path: 'tree' } }, 'incomplete'],
    ['successful digest', { interactive, verdict }, 'complete'],
    ['successful empty digest', { interactive: [], verdict }, 'complete'],
  ];
  for (const [name, observation, expected] of cases) {
    const screen = await captureScreen({
      native: async () => ({ nodes }),
      react: async () => ({ ...observation, hostEvidence }),
    });
    assert.equal(screen.captureCoverage?.react, expected, name);
    assert.equal(screen.coverage?.react, expected, name);
    assert.deepEqual(screen.reactHostEvidence, hostEvidence, name);
    assert.deepEqual(assertionView(screen), ['Save'], name);
  }
});

test('invalid or explicitly incomplete host evidence dominates unknown acquisition', async () => {
  for (const evidence of [null, { hosts: [], complete: false }]) {
    const screen = await captureScreen({
      native: async () => ({ nodes }),
      react: async () => ({ hostEvidence: evidence }),
    });
    assert.equal(screen.captureCoverage?.react, 'unknown');
    assert.equal(screen.coverage?.react, 'incomplete');
    assert.deepEqual(assertionView(screen), ['Save']);
  }
});

test('digest errors preserve native literals and warn without logging private payloads', async () => {
  const warnings: string[] = [];
  const error = new Error('digest contained password=sensitive-value and token=private-token');
  error.toString = () => assert.fail('capture must not stringify the digest error');
  for (const warn of [undefined, (message: string) => warnings.push(message)]) {
    const screen = await captureScreen({
      native: async () => ({
        nodes,
        truncated: false,
        normalizationDroppedNodes: 0,
        snapshotVerdict,
      }),
      react: async () => {
        throw error;
      },
      warn,
    });
    assert.deepEqual(screen.captureCoverage, { native: 'complete', react: 'unknown' });
    assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' });
    assert.deepEqual(assertionView(screen), ['Save']);
    assert.deepEqual(
      screen.elements.map((element) => element.ref),
      ['@save'],
    );
  }
  assert.deepEqual(warnings, ['interactive digest unavailable; React coverage is unknown']);
});

test('non-array adapter data stays unknown rather than masquerading as a complete empty capture', async () => {
  for (const raw of ['null', 'false', '{}', '"unavailable"']) {
    const screen = await captureScreen({
      native: async () => ({ nodes: JSON.parse(raw), truncated: false, snapshotVerdict }),
      react: async () => ({ interactive: JSON.parse(raw), truncated: false, verdict }),
    });
    assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' }, raw);
    assert.deepEqual(screen.captureCoverage, { native: 'unknown', react: 'unknown' }, raw);
    assert.deepEqual(screen.elements, [], raw);
    assert.ok('refuse' in visibilityView(screen), raw);
  }
});

test('malformed verdicts do not establish coverage from false truncation flags', async () => {
  for (const metadata of [undefined, null, false, 'ok', [], {}, { complete: true }]) {
    const screen = await captureScreen({
      native: async () => ({ nodes, truncated: false, snapshotVerdict: metadata }),
      react: async () => ({ interactive, truncated: false, verdict: metadata }),
    });
    assert.deepEqual(screen.coverage, { native: 'unknown', react: 'unknown' });
    assert.deepEqual(screen.captureCoverage, { native: 'unknown', react: 'unknown' });
    assert.deepEqual(assertionView(screen), ['Save']);
  }
});

test('capture awaits one native read before one React read and leaves native hierarchy intact', async () => {
  const calls: string[] = [];
  const read = Promise.withResolvers<NativeObservation>();
  const nativeNodes: NativeNode[] = [
    { ref: '@dialog', type: 'Alert', index: 0, parentIndex: -1, depth: 0 },
    { ref: '@confirm', type: 'Button', label: 'Confirm', index: 4, parentIndex: 0, depth: 1 },
  ];
  nativeNodes.forEach(Object.freeze);
  Object.freeze(nativeNodes);
  const pending = captureScreen({
    native: () => {
      calls.push('native');
      return read.promise;
    },
    react: async () => {
      calls.push('react');
      return { interactive: [], verdict };
    },
    warn: () => assert.fail('successful reads must not log their contents'),
  });

  await Promise.resolve();
  assert.deepEqual(calls, ['native']);
  read.resolve({ nodes: nativeNodes });
  const screen = await pending;
  assert.deepEqual(calls, ['native', 'react']);
  assert.equal(screen.front, 'dialog');
  assert.deepEqual(assertionView(screen), ['Confirm']);
  assert.deepEqual(nativeNodes, [
    { ref: '@dialog', type: 'Alert', index: 0, parentIndex: -1, depth: 0 },
    { ref: '@confirm', type: 'Button', label: 'Confirm', index: 4, parentIndex: 0, depth: 1 },
  ]);
});

test('surface observations retain the existing dev-menu and picker classification', async () => {
  for (const [surface, front] of [
    ['expo_dev_menu', 'dev-menu'],
    ['react_native_dev_menu', 'dev-menu'],
    ['dev_client_picker', 'picker'],
    ['first_run_tutorial', 'picker'],
    ['unknown', 'app'],
  ]) {
    const screen = await captureScreen({
      native: async () => ({ nodes, surface }),
      react: async () => ({}),
    });
    assert.equal(screen.front, front, surface);
  }
});

test('native errors propagate unchanged without reading React or logging payloads', async () => {
  const failure = new Error('native capture failed');
  let reads = 0;
  await assert.rejects(
    captureScreen({
      native: async () => {
        reads += 1;
        throw failure;
      },
      react: () => assert.fail('React cannot be read after native failure'),
      warn: () => assert.fail('native errors must not be swallowed or logged'),
    }),
    (error) => error === failure,
  );
  assert.equal(reads, 1);
});
