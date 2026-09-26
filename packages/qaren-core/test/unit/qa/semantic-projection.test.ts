import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as projection from '../../../dist/qa/screen.js';
import type { Element, Screen } from '../../../dist/qa/screen.js';
import { inputValues, redactEvidence } from '../../../dist/qa/privacy.js';

const complete = { native: 'complete', react: 'complete' } as const;

function element(ref: string, overrides: Partial<Element> = {}): Element {
  return {
    ref,
    kind: 'button',
    label: 'Save',
    hittable: true,
    disabled: false,
    secure: false,
    offscreen: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible' },
    ...overrides,
  };
}

function attested(elements: Element[]): Screen {
  return { elements, visibleText: [], front: 'app', coverage: complete };
}

function refused(result: ReturnType<typeof projection.semanticActionView>, code: string): void {
  assert.ok('refuse' in result, 'projection must refuse rather than select an incomplete subset');
  assert.equal(result.refuse, code);
  assert.ok(result.reason.length > 0);
}

test('join adds native capabilities without upgrading geometry to visibility', () => {
  const screen = projection.join(
    [
      { ref: '@save', type: 'Button', label: 'Save', hittable: true },
      { ref: '@email', type: 'TextField', label: 'Email', value: 'a@example.test' },
      { ref: '@text', type: 'StaticText', label: 'Welcome', hittable: true },
      { ref: '@image', type: 'Image', label: 'Logo', hittable: true },
      { ref: '@wrapper', type: 'Other', hittable: true, index: 4, parentIndex: 0, depth: 1 },
    ],
    [],
    'app',
    complete,
  );

  assert.deepEqual(screen.coverage, complete);
  assert.deepEqual(screen.elements[0].semantic, {
    press: 'supported',
    fill: 'unsupported',
    visibility: 'unknown',
    disabled: false,
  });
  assert.equal(screen.elements[1].semantic?.fill, 'supported');
  assert.deepEqual(
    screen.elements.slice(2).map((e) => e.semantic?.press),
    ['unknown', 'unknown', 'unknown'],
  );
  assert.ok(screen.elements.every((e) => e.semantic?.visibility === 'unknown'));
  assert.deepEqual(projection.assertionView(screen), ['Save', 'Email: a@example.test', 'Welcome']);
  assert.deepEqual(
    projection.actionView(screen).map((e) => e.ref),
    ['@save', '@text', '@image', '@wrapper'],
  );
});

test('native control types supply operation evidence independently of digest roles', () => {
  for (const type of [
    'Button',
    'Switch',
    'Toggle',
    'Link',
    'android.widget.ImageButton',
    'android.widget.ToggleButton',
    'android.widget.CheckBox',
    'android.widget.RadioButton',
  ]) {
    const screen = projection.join(
      [{ ref: '@control', type, hittable: true }],
      [],
      'app',
      complete,
    );
    assert.equal(screen.elements[0].semantic?.press, 'supported', type);
    assert.deepEqual(projection.semanticActionView(screen, 'press'), { elements: screen.elements });
  }
  for (const type of [
    'TextField',
    'SecureTextField',
    'SearchField',
    'TextView',
    'android.widget.EditText',
  ]) {
    const screen = projection.join([{ ref: '@input', type, hittable: true }], [], 'app', complete);
    assert.equal(screen.elements[0].semantic?.fill, 'supported', type);
    assert.deepEqual(projection.semanticActionView(screen, 'fill'), { elements: screen.elements });
  }
});

test('a default React button role without producer capabilities remains unknown', () => {
  const screen = projection.join(
    [{ ref: '@custom', type: 'Other', identifier: 'custom', hittable: true }],
    [{ role: 'button', testID: 'custom' }],
    'app',
    complete,
  );
  assert.equal(screen.elements[0].kind, 'button');
  refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('only a unique exact-ID association can supply React capabilities', () => {
  const screen = projection.join(
    [
      { ref: '@custom', type: 'Other', identifier: 'custom' },
      { ref: '@label', type: 'Other', label: 'Save' },
      { ref: '@a', type: 'Other', identifier: 'duplicate-native' },
      { ref: '@b', type: 'Other', identifier: 'duplicate-native' },
      { ref: '@c', type: 'Other', identifier: 'duplicate-react' },
      { ref: '@false', type: 'Other', identifier: 'no-handler' },
    ],
    [
      { role: 'button', testID: 'custom', capabilities: { press: true, fill: true } },
      { role: 'button', text: 'Save', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'duplicate-native', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'duplicate-react', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'duplicate-react', capabilities: { press: true, fill: false } },
      { role: 'button', testID: 'no-handler', capabilities: { press: false, fill: false } },
    ],
  );

  assert.deepEqual(screen.elements[0].semantic, {
    press: 'supported',
    fill: 'supported',
    visibility: 'unknown',
    disabled: false,
  });
  assert.equal(screen.elements[1].kind, 'button', 'legacy label enrichment is unchanged');
  assert.deepEqual(
    screen.elements.slice(1, 6).map((e) => e.semantic?.press),
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'],
  );
  assert.equal(screen.elements[5].semantic?.fill, 'unknown');
  assert.equal(screen.semanticUnassociatedReact, 4);
  assert.equal(screen.coverage, undefined);
});

test('legacy identifier trimming does not grant semantic exact-ID authority', () => {
  const screen = projection.join(
    [{ ref: '@custom', type: 'Other', identifier: ' custom ' }],
    [{ role: 'button', testID: 'custom', capabilities: { press: true, fill: true } }],
  );
  assert.equal(screen.elements[0].testID, 'custom');
  assert.equal(screen.elements[0].kind, 'button');
  assert.deepEqual(screen.elements[0].semantic, {
    press: 'unknown',
    fill: 'unknown',
    visibility: 'unknown',
    disabled: false,
  });
});

test('semantic actions keep separate native controls with equal IDs and exclude disabled controls', () => {
  const screen = projection.join(
    [
      { ref: '@a', type: 'Button', identifier: 'save', label: 'Save', hittable: true },
      { ref: '@b', type: 'Button', identifier: 'save', label: 'Save', hittable: true },
      { ref: '@disabled', type: 'Other', enabled: false },
    ],
    [],
    'app',
    complete,
  );
  assert.deepEqual(projection.semanticActionView(screen, 'press'), {
    elements: screen.elements.slice(0, 2),
  });
  assert.equal(screen.elements.length, 3);
});

test('unknown capabilities, missing facts and non-hittable controls cannot create an action winner', () => {
  for (const competitor of [
    element('@unknown', { semantic: { press: 'unknown', fill: 'unknown', visibility: 'visible' } }),
    element('@missing', { semantic: undefined }),
    element('@no-hit', { hittable: false }),
    element('react:later', {
      hittable: false,
      offscreen: true,
      semantic: { press: 'supported', fill: 'unknown', visibility: 'unknown' },
    }),
  ]) {
    refused(
      projection.semanticActionView(attested([element('@save'), competitor]), 'press'),
      'SCREEN_EVIDENCE_INCOMPLETE',
    );
  }
});

test('operation exclusions and attested offscreen evidence are independent of legacy flags', () => {
  const input = element('@input', {
    kind: 'input',
    semantic: { press: 'unsupported', fill: 'supported', visibility: 'visible' },
  });
  const later = element('react:later', {
    hittable: false,
    offscreen: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'offscreen' },
  });
  const hidden = element('@hidden', {
    semantic: { press: 'unknown', fill: 'unknown', visibility: 'hidden' },
  });
  const screen = attested([input, later, hidden]);
  assert.deepEqual(projection.semanticActionView(screen, 'fill'), { elements: [input] });
  assert.deepEqual(projection.semanticActionView(screen, 'press'), { elements: [later] });
  assert.equal(later.offscreen, false, 'semantic projection does not rewrite legacy observations');
});

test('visibility keeps independent readable contributions and disabled controls', () => {
  const text = element('@text', {
    kind: 'text',
    hittable: false,
    semantic: { press: 'unknown', fill: 'unsupported', visibility: 'visible' },
  });
  const disabled = element('@disabled', { disabled: true, testID: 'save' });
  const duplicate = element('@duplicate', { disabled: true, testID: 'save' });
  const hidden = element('@hidden', {
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'hidden' },
  });
  const offscreen = element('@offscreen', {
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'offscreen' },
  });
  const structural = element('@structural', {
    kind: 'other',
    label: undefined,
    semantic: { press: 'unsupported', fill: 'unsupported', visibility: 'unknown' },
  });
  const screen = attested([text, disabled, duplicate, hidden, offscreen, structural]);

  assert.deepEqual(projection.visibilityView(screen), { elements: [text, disabled, duplicate] });
  assert.equal(screen.elements.length, 6);
  assert.deepEqual(projection.assertionView(screen), [], 'semantic evidence is not literal text');
});

test('both projections require complete coverage, including for an empty observation list', () => {
  for (const coverage of [
    undefined,
    { native: 'unknown', react: 'complete' },
    { native: 'complete', react: 'unknown' },
    { native: 'incomplete', react: 'complete' },
    { native: 'complete', react: 'incomplete' },
  ] satisfies Array<Screen['coverage']>) {
    const screen = { ...attested([]), coverage };
    refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.semanticActionView(screen, 'fill'), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.visibilityView(screen), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
  assert.deepEqual(projection.semanticActionView(attested([]), 'press'), { elements: [] });
  assert.deepEqual(projection.visibilityView(attested([])), { elements: [] });
});

test('reference collisions refuse before any exclusions or content coalescing', () => {
  const screen = attested([element('@same'), element('@same', { disabled: true })]);
  refused(projection.semanticActionView(screen, 'press'), 'AMBIGUOUS_REFS');
  refused(projection.visibilityView(screen), 'AMBIGUOUS_REFS');
  assert.equal(screen.elements.length, 2);
  const duplicatedReact = projection.join(
    [],
    [
      { role: 'button', testID: 'save' },
      { role: 'button', testID: 'save' },
    ],
    'app',
    complete,
  );
  refused(projection.semanticActionView(duplicatedReact, 'press'), 'AMBIGUOUS_REFS');
  refused(projection.visibilityView(duplicatedReact), 'AMBIGUOUS_REFS');
  assert.equal(duplicatedReact.semanticUnassociatedReact, 2);
  refused(
    projection.semanticActionView({ ...duplicatedReact, coverage: undefined }, 'press'),
    'AMBIGUOUS_REFS',
  );
  refused(projection.visibilityView({ ...duplicatedReact, coverage: undefined }), 'AMBIGUOUS_REFS');
});

test('unknown visibility refuses even when native geometry or legacy flags suggest visibility', () => {
  const screen = projection.join(
    [
      {
        ref: '@native',
        type: 'Button',
        label: 'Save',
        hittable: true,
        rect: { x: 0, y: 0, width: 40, height: 40 },
      },
    ],
    [],
    'app',
    complete,
  );
  refused(projection.visibilityView(screen), 'SCREEN_EVIDENCE_INCOMPLETE');
  const disabled = projection.join(
    [{ ref: '@disabled', type: 'Button', enabled: false }],
    [],
    'app',
    complete,
  );
  assert.deepEqual(projection.semanticActionView(disabled, 'press'), { elements: [] });
  refused(projection.visibilityView(disabled), 'SCREEN_EVIDENCE_INCOMPLETE');
  refused(
    projection.visibilityView(attested([element('@missing', { semantic: undefined })])),
    'SCREEN_EVIDENCE_INCOMPLETE',
  );
  for (const type of ['Application', 'Window', 'Other', 'StaticText', 'Image', undefined]) {
    const unknown = projection.join([{ ref: '@unknown', type }], [], 'app', complete);
    refused(projection.visibilityView(unknown), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.semanticActionView(unknown, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
});

test('accessibility-only labels do not become readable assertions without control evidence', () => {
  for (const kind of ['image', 'other'] as const) {
    const screen = attested([
      element('@label', {
        kind,
        semantic: { press: 'unknown', fill: 'unknown', visibility: 'visible' },
      }),
    ]);
    refused(projection.visibilityView(screen), 'SCREEN_EVIDENCE_INCOMPLETE');
  }
});

test('unmatched React observations remain unknown, not proven offscreen', () => {
  const screen = projection.join(
    [],
    [{ role: 'button', testID: 'later', capabilities: { press: true, fill: false } }],
    'app',
    complete,
  );
  assert.deepEqual(screen.elements[0].semantic, {
    press: 'supported',
    fill: 'unknown',
    visibility: 'unknown',
    disabled: false,
  });
  assert.equal(screen.elements[0].offscreen, true, 'legacy exact paths remain unchanged');
  refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  refused(projection.visibilityView(screen), 'SCREEN_EVIDENCE_INCOMPLETE');
});

test('unaddressable React observations cannot disappear to manufacture complete empty evidence', () => {
  const screen = projection.join(
    [],
    [{ role: 'button', text: 'Save', capabilities: { press: true, fill: false } }],
    'app',
    complete,
  );
  assert.deepEqual(screen.elements, [], 'legacy identity output still omits unaddressable entries');
  for (const copy of [screen, { ...screen }, structuredClone(screen)]) {
    refused(projection.semanticActionView(copy, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.visibilityView(copy), 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.equal(copy.semanticUnassociatedReact, 1);
  }
});

test('anonymous same-label controls are not removed from semantic accounting by the legacy join', () => {
  const screen = projection.join(
    [{ ref: '@save', type: 'Button', label: 'Save', hittable: true }],
    [{ role: 'button', text: 'Save', capabilities: { press: true, fill: false } }],
    'app',
    complete,
  );
  assert.equal(screen.elements.length, 1, 'legacy label association is unchanged');
  assert.deepEqual(projection.actionView(screen), screen.elements);
  assert.deepEqual(projection.assertionView(screen), ['Save']);
  screen.elements[0].semantic!.visibility = 'visible';
  for (const copy of [
    screen,
    { ...screen, elements: screen.elements.map((e) => ({ ...e })) },
    structuredClone(screen),
  ]) {
    refused(projection.semanticActionView(copy, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
    refused(projection.visibilityView(copy), 'SCREEN_EVIDENCE_INCOMPLETE');
    assert.equal(copy.semanticUnassociatedReact, 1);
  }
});

test('ambiguous React association refuses without hiding either enabled native control', () => {
  const screen = projection.join(
    [
      { ref: '@a', type: 'Button', identifier: 'save', hittable: true, enabled: true },
      { ref: '@b', type: 'Button', identifier: 'save', hittable: true, enabled: true },
    ],
    [
      {
        role: 'button',
        testID: 'save',
        disabled: true,
        capabilities: { press: true, fill: false },
      },
    ],
    'app',
    complete,
  );
  assert.equal(screen.elements[0].disabled, true, 'legacy enrichment is preserved');
  assert.deepEqual(
    screen.elements.map((e) => [e.ref, e.semantic?.press]),
    [
      ['@a', 'supported'],
      ['@b', 'supported'],
    ],
  );
  assert.deepEqual(screen.elements.map(projection.semanticDisabled), [false, false]);
  assert.deepEqual(
    screen.elements.map((e) => projection.semanticDisabled({ ...e })),
    [false, false],
  );
  refused(projection.semanticActionView(screen, 'press'), 'SCREEN_EVIDENCE_INCOMPLETE');
  assert.equal(screen.semanticUnassociatedReact, 1);
});

test('joined disabled facts survive spreading and cloning native and unique React evidence', () => {
  const screen = projection.join(
    [
      { ref: '@enabled', type: 'Button', identifier: 'enabled', enabled: true, hittable: true },
      {
        ref: '@native-disabled',
        type: 'Button',
        identifier: 'native-disabled',
        enabled: false,
        hittable: true,
      },
      {
        ref: '@react-disabled',
        type: 'Button',
        identifier: 'react-disabled',
        enabled: true,
        hittable: true,
      },
    ],
    [
      { role: 'button', testID: 'enabled', disabled: false },
      { role: 'button', testID: 'native-disabled', disabled: false },
      { role: 'button', testID: 'react-disabled', disabled: true },
    ],
    'app',
    complete,
  );
  for (const copy of [
    screen,
    { ...screen, elements: screen.elements.map((e) => ({ ...e, semantic: { ...e.semantic! } })) },
    structuredClone(screen),
  ]) {
    assert.equal(copy.semanticUnassociatedReact, 0);
    assert.deepEqual(
      copy.elements.map((e) => e.semantic?.disabled),
      [false, true, true],
    );
    assert.deepEqual(copy.elements.map(projection.semanticDisabled), [false, true, true]);
    assert.deepEqual(projection.semanticActionView(copy, 'press'), {
      elements: [copy.elements[0]],
    });
  }
});

test('semanticDisabled is the action owner and falls back only when its fact is missing', () => {
  const enabled = element('@enabled', {
    disabled: true,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible', disabled: false },
  });
  const disabled = element('@disabled', {
    disabled: false,
    semantic: { press: 'supported', fill: 'unsupported', visibility: 'visible', disabled: true },
  });
  const copied = attested([
    { ...enabled, semantic: { ...enabled.semantic! } },
    { ...disabled, semantic: { ...disabled.semantic! } },
  ]);
  assert.equal(projection.semanticDisabled(copied.elements[0]), false);
  assert.equal(projection.semanticDisabled(copied.elements[1]), true);
  assert.deepEqual(projection.semanticActionView(copied, 'press'), {
    elements: [copied.elements[0]],
  });
  assert.deepEqual(projection.visibilityView(copied), { elements: copied.elements });
  assert.equal(
    projection.semanticDisabled(element('@legacy', { semantic: undefined, disabled: true })),
    true,
  );
  assert.equal(projection.semanticDisabled(element('@missing', { disabled: true })), true);
  assert.equal(projection.semanticDisabled(element('@enabled-legacy')), false);
});

test('projections retain private source values before excluding observations', () => {
  const screen = projection.join(
    [
      {
        ref: '@secure',
        type: 'SecureTextField',
        identifier: 'password',
        label: 'Password',
        value: 'native-secret',
        enabled: false,
      },
      { ref: '@save', type: 'Button', label: 'Save', hittable: true },
    ],
    [{ role: 'textinput', testID: 'password', text: 'Password', value: 'react-secret' }],
    'app',
    complete,
  );
  assert.deepEqual(projection.semanticActionView(screen, 'press'), {
    elements: [screen.elements[1]],
  });
  assert.equal(screen.elements[0].value, undefined);
  assert.deepEqual(inputValues(screen), ['native-secret', 'react-secret']);
  assert.equal(redactEvidence(screen, 'native-secret react-secret'), '••• •••');
  assert.equal(projection.assertionView(screen)[0], 'Password');
  screen.elements[0].semantic!.visibility = 'hidden';
  screen.elements[1].semantic!.visibility = 'visible';
  assert.deepEqual(projection.visibilityView(screen), { elements: [screen.elements[1]] });
  assert.deepEqual(inputValues(screen), ['native-secret', 'react-secret']);
});

test('the domain retains all 31 independent candidates and contributions for resolver budgeting', () => {
  const controls = Array.from({ length: 31 }, (_, i) => element(`@${i}`, { testID: 'save' }));
  const screen = attested(controls);
  const action = projection.semanticActionView(screen, 'press');
  const visibility = projection.visibilityView(screen);
  assert.deepEqual(action, { elements: controls });
  assert.deepEqual(visibility, { elements: controls });
  assert.ok('elements' in action && action.elements.every((e, i) => e === controls[i]));
  assert.ok('elements' in visibility && visibility.elements.every((e, i) => e === controls[i]));
});
