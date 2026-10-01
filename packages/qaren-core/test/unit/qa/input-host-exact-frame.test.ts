import assert from 'node:assert/strict';
import { test } from 'node:test';
import { associateHosts } from '../../../dist/qa/host-association.js';
import type { NativePresence } from '../../../dist/qa/native-presence.js';
import type { NativeNode, ReactHostEvidence } from '../../../dist/qa/screen.js';

function fixture(hostType = 'RCTSinglelineTextInputView', nativeType = 'TextField') {
  const nodes: NativeNode[] = [
    { ref: '@window', type: 'Window', rect: { x: 20, y: 40, width: 400, height: 800 } },
    {
      ref: '@input',
      type: nativeType,
      identifier: 'field',
      parentIndex: 0,
      rect: { x: 30, y: 100, width: 160, height: 40 },
    },
  ];
  const presence: NativePresence = {
    source: 'xcui-live',
    nodes: [
      { status: 'unknown', labelSource: 'none' },
      { status: 'observed', labelSource: 'direct' },
    ],
  };
  const evidence: ReactHostEvidence = {
    complete: true,
    hosts: [
      {
        testID: 'field',
        role: null,
        roleSource: 'none',
        capabilities: { press: true, fill: true },
      },
    ],
    typography: {
      version: 1,
      complete: true,
      durationMs: 1,
      coordinateSpace: 'window-points',
      nodes: [
        {
          hostIndex: 0,
          parentHostIndex: null,
          rootIndex: 0,
          hostType,
          rect: { x: 10, y: 60, width: 160, height: 40 },
          text: { kind: 'none' },
        },
      ],
    },
  };
  return { nodes, evidence, presence };
}

test('known input hosts associate only with their compatible native kinds at equal frames', () => {
  for (const [hostType, supported] of [
    ['TextInput', ['TextField', 'SecureTextField', 'TextView']],
    ['RCTTextInput', ['TextField', 'SecureTextField', 'TextView']],
    ['RCTSinglelineTextInputView', ['TextField', 'SecureTextField']],
    ['RCTMultilineTextInputView', ['TextView']],
    ['AndroidTextInput', ['TextField', 'SecureTextField', 'TextView']],
  ] as const) {
    for (const nativeType of [
      'TextField',
      'SecureTextField',
      'TextView',
      'Other',
      'StaticText',
      'Button',
    ]) {
      const f = fixture(hostType, nativeType);
      const associations = associateHosts(f.nodes, f.evidence, f.presence);
      if (supported.some((type) => type === nativeType))
        assert.deepEqual(
          [...associations],
          [[0, { nativeIndex: 1, anchorIndex: 1 }]],
          `${hostType}/${nativeType}`,
        );
      else assert.equal(associations.size, 0, `${hostType}/${nativeType}`);
    }
  }
});

test('known input kinds still require exact translated frames, not contained backing frames', () => {
  for (const [hostType, nativeType] of [
    ['RCTSinglelineTextInputView', 'TextField'],
    ['RCTSinglelineTextInputView', 'SecureTextField'],
    ['RCTMultilineTextInputView', 'TextView'],
  ]) {
    for (const dimension of ['x', 'y', 'width', 'height'] as const) {
      const f = fixture(hostType, nativeType);
      f.nodes[1].rect![dimension] += 0.25;
      assert.equal(associateHosts(f.nodes, f.evidence, f.presence).size, 0, dimension);
    }
    const f = fixture(hostType, nativeType);
    f.nodes[1].rect = { x: 31, y: 101, width: 158, height: 38 };
    assert.equal(associateHosts(f.nodes, f.evidence, f.presence).size, 0, hostType);
  }
});

test('input compatibility does not bypass existing identity, measurement or presence gates', () => {
  const mutations: Array<[string, (f: ReturnType<typeof fixture>) => void]> = [
    [
      'incomplete hosts',
      (f) => {
        f.evidence.complete = false;
      },
    ],
    [
      'missing measurements',
      (f) => {
        delete f.evidence.typography;
      },
    ],
    [
      'incomplete measurements',
      (f) => {
        f.evidence.typography!.complete = false;
      },
    ],
    [
      'missing host frame',
      (f) => {
        delete f.evidence.typography!.nodes[0].rect;
      },
    ],
    [
      'missing native frame',
      (f) => {
        delete f.nodes[1].rect;
      },
    ],
    [
      'missing host ID',
      (f) => {
        delete f.evidence.hosts[0].testID;
      },
    ],
    [
      'missing native ID',
      (f) => {
        delete f.nodes[1].identifier;
      },
    ],
    [
      'nonexact ID',
      (f) => {
        f.nodes[1].identifier = 'field-other';
      },
    ],
    [
      'duplicate host ID',
      (f) => {
        f.evidence.hosts.push(structuredClone(f.evidence.hosts[0]));
      },
    ],
    [
      'duplicate native ID',
      (f) => {
        f.nodes.push({ ...f.nodes[1], ref: '@duplicate' });
      },
    ],
    [
      'unobserved input',
      (f) => {
        f.presence.nodes[1].status = 'unknown';
      },
    ],
    [
      'outside window',
      (f) => {
        delete f.nodes[1].parentIndex;
      },
    ],
    [
      'unknown host kind',
      (f) => {
        f.evidence.typography!.nodes[0].hostType = null;
      },
    ],
    [
      'non-input host',
      (f) => {
        f.evidence.typography!.nodes[0].hostType = 'RCTView';
      },
    ],
  ];
  for (const [name, mutate] of mutations) {
    const f = fixture();
    mutate(f);
    assert.equal(associateHosts(f.nodes, f.evidence, f.presence).size, 0, name);
  }
});
