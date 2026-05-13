// GH #106: pure-helper tests for flow + skeleton bundling. Covers
// anonymize/restore appId, M7 header prose truncation, placeholder
// extraction, and the manifest-comment prepend that Codex review locked
// in as the right interpretation of the spec's "unknown placeholder"
// language.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const MOD_PATH = '../../dist/experience/flow-bundle.js';

// ── slug sanitization ───────────────────────────────────────────────────

test('sanitizeAppIdSlug: lowercases, replaces unsafe chars with hyphens, trims length', async () => {
  const { sanitizeAppIdSlug } = await import(MOD_PATH);
  assert.equal(sanitizeAppIdSlug('com.rndevagent.testapp'), 'rndevagent-testapp');
  assert.equal(sanitizeAppIdSlug('com.Foo.Bar'), 'foo-bar');
  assert.equal(sanitizeAppIdSlug('com.foo'), 'foo');
  assert.equal(sanitizeAppIdSlug(''), 'app');
  // Pathological inputs are squashed safely.
  assert.equal(sanitizeAppIdSlug('com.../../weird/$%^app'), 'weird-app');
});

// ── anonymizeFlowYaml ────────────────────────────────────────────────────

test('anonymizeFlowYaml: rewrites appId line to com.example.<slug>', async () => {
  const { anonymizeFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.rndevagent.testapp',
    '---',
    '# id: foo',
    '# intent: do thing',
    '- launchApp',
  ].join('\n');
  const out = anonymizeFlowYaml(input);
  assert.match(out, /^appId: com\.example\.rndevagent-testapp$/m);
  // M7 header preserved verbatim
  assert.match(out, /^# id: foo$/m);
  assert.match(out, /^# intent: do thing$/m);
  // Body preserved verbatim
  assert.match(out, /^- launchApp$/m);
});

test('anonymizeFlowYaml: preserves multi-line top section (leading comments above appId)', async () => {
  // Codex review B (HIGH conf): line-wise rewrite must preserve any
  // pre-existing comments above the appId line.
  const { anonymizeFlowYaml } = await import(MOD_PATH);
  const input = [
    '# shared across envs',
    'appId: com.foo.bar',
    '---',
    '# id: zap',
    '- launchApp',
  ].join('\n');
  const out = anonymizeFlowYaml(input);
  // Leading comment preserved
  assert.match(out, /^# shared across envs$/m);
  // appId rewritten
  assert.match(out, /^appId: com\.example\.foo-bar$/m);
});

test('anonymizeFlowYaml: truncates author-prose comments above the M7 header to 200 chars', async () => {
  const { anonymizeFlowYaml } = await import(MOD_PATH);
  const longProse = '# ' + 'A'.repeat(500);
  const input = [
    'appId: com.foo.app',
    '---',
    longProse,
    '# id: foo',
    '# intent: do thing',
    '- launchApp',
  ].join('\n');
  const out = anonymizeFlowYaml(input);
  // M7 header lines untouched
  assert.match(out, /^# id: foo$/m);
  assert.match(out, /^# intent: do thing$/m);
  // Long prose is truncated — find the line and check its length
  const proseLine = out.split('\n').find(l => l.startsWith('# A'));
  assert.ok(proseLine, 'truncated prose line should still exist');
  assert.ok(proseLine.length <= 202, `prose line should be <= 202 chars (# + 200), got ${proseLine.length}`);
  assert.match(proseLine, /\.\.\.$/, 'should end with ellipsis');
});

test('anonymizeFlowYaml: throws ExportError when topSection lacks appId line', async () => {
  // Codex review B (HIGH conf): the only legitimate hard-fail is "no
  // appId: at all". Surface a clear error rather than silently dropping
  // the flow or producing a malformed export.
  const { anonymizeFlowYaml } = await import(MOD_PATH);
  const input = [
    '# orphan comment only',
    '---',
    '# id: foo',
    '- launchApp',
  ].join('\n');
  assert.throws(() => anonymizeFlowYaml(input), /missing appId:/);
});

test('anonymizeFlowYaml: throws when there is no --- separator at all', async () => {
  const { anonymizeFlowYaml } = await import(MOD_PATH);
  assert.throws(() => anonymizeFlowYaml('- launchApp\n- tapOn: foo'), /missing.*---|missing appId:/);
});

// ── restoreFlowYaml ──────────────────────────────────────────────────────

test('restoreFlowYaml: rewrites com.example.<slug> back to the local appId', async () => {
  const { restoreFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.example.rndevagent-testapp',
    '---',
    '# id: foo',
    '# status: active',
    '- launchApp',
  ].join('\n');
  const out = restoreFlowYaml(input, 'com.myorg.actualapp');
  assert.match(out, /^appId: com\.myorg\.actualapp$/m);
  // M7 header preserved
  assert.match(out, /^# id: foo$/m);
});

test('restoreFlowYaml: forces status: active to status: experimental in M7 header', async () => {
  // Issue acceptance: "Force imported actions to status: experimental
  // until first clean replay locally"
  const { restoreFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.example.foo',
    '---',
    '# id: foo',
    '# status: active',
    '- launchApp',
  ].join('\n');
  const out = restoreFlowYaml(input, 'com.myorg.app');
  assert.match(out, /^#\s*status:\s*experimental$/m);
  assert.doesNotMatch(out, /^#\s*status:\s*active$/m);
});

test('restoreFlowYaml: leaves status: experimental untouched', async () => {
  const { restoreFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.example.foo',
    '---',
    '# id: foo',
    '# status: experimental',
    '- launchApp',
  ].join('\n');
  const out = restoreFlowYaml(input, 'com.myorg.app');
  assert.match(out, /^#\s*status:\s*experimental$/m);
});

test('restoreFlowYaml: prepends placeholder manifest when ${VAR} usages exist', async () => {
  // Codex review A (HIGH conf): prepend a "# placeholders: ..." comment
  // above the M7 header rather than suffix with .needs-review.yaml.
  // Visible, doesn't lie about flow status, grep-able.
  const { restoreFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.example.foo',
    '---',
    '# id: foo',
    '- launchApp',
    '- inputText: ${TITLE}',
    '- inputText: ${DESC}',
    '- tapOn: { id: ${TITLE} }',
  ].join('\n');
  const out = restoreFlowYaml(input, 'com.myorg.app');
  const placeholderLine = out.split('\n').find(l => l.startsWith('# placeholders:'));
  assert.ok(placeholderLine, 'should prepend a # placeholders: comment');
  assert.match(placeholderLine, /TITLE/);
  assert.match(placeholderLine, /DESC/);
  // Dedup: TITLE should appear only once in the manifest line
  const titleCount = (placeholderLine.match(/TITLE/g) || []).length;
  assert.equal(titleCount, 1, 'placeholders should be deduped');
});

test('restoreFlowYaml: deduplicates existing # placeholders: line on re-import (round-trip idempotence)', async () => {
  // Multi-review regression (Codex 92 + Gemini 95): a flow already
  // carrying a "# placeholders:" line from a prior import must NOT get
  // a second one stacked above. After N round-trips there should still
  // be exactly ONE manifest line.
  const { restoreFlowYaml } = await import(MOD_PATH);
  let yaml = [
    'appId: com.example.foo',
    '---',
    '# placeholders: TITLE — supply via -e KEY=VALUE on replay',
    '# id: foo',
    '# status: experimental',
    '- inputText: ${TITLE}',
  ].join('\n');
  yaml = restoreFlowYaml(yaml, 'com.myorg.app');
  yaml = restoreFlowYaml(yaml, 'com.myorg.app');
  yaml = restoreFlowYaml(yaml, 'com.myorg.app');
  const manifestLines = yaml.split('\n').filter(l => /^#\s*placeholders:/i.test(l));
  assert.equal(manifestLines.length, 1, 'should have exactly one manifest line after 3 imports');
});

test('anonymizeFlowYaml: strips # placeholders: line so the bundle never carries it (defense)', async () => {
  // Bundle round-trip A→B→C must not accumulate manifests across
  // machines. The manifest is a local-import annotation — the bundle
  // itself should be clean.
  const { anonymizeFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.foo.bar',
    '---',
    '# placeholders: TITLE — supply via -e KEY=VALUE on replay',
    '# id: foo',
    '- inputText: ${TITLE}',
  ].join('\n');
  const out = anonymizeFlowYaml(input);
  assert.doesNotMatch(out, /^#\s*placeholders:/m);
});

test('restoreFlowYaml: no placeholder manifest when ${VAR} usages are absent', async () => {
  const { restoreFlowYaml } = await import(MOD_PATH);
  const input = [
    'appId: com.example.foo',
    '---',
    '# id: foo',
    '- launchApp',
    '- tapOn: { id: "static-id" }',
  ].join('\n');
  const out = restoreFlowYaml(input, 'com.myorg.app');
  assert.doesNotMatch(out, /^# placeholders:/m);
});

// ── extractActionId ──────────────────────────────────────────────────────

test('extractActionId: reads "# id: <name>" from the M7 header', async () => {
  const { extractActionId } = await import(MOD_PATH);
  assert.equal(extractActionId('appId: x\n---\n# id: wizard-create-task\n- launchApp'), 'wizard-create-task');
  assert.equal(extractActionId('appId: x\n---\n#id:trim-test\n- launchApp'), 'trim-test');
  assert.equal(extractActionId('appId: x\n---\n# intent: missing id\n- launchApp'), null);
});

// ── extractPlaceholders ──────────────────────────────────────────────────

test('extractPlaceholders: returns sorted dedup placeholder names', async () => {
  const { extractPlaceholders } = await import(MOD_PATH);
  const yaml = [
    'appId: com.foo.x',
    '---',
    '- inputText: ${TITLE}',
    '- inputText: ${DESC}',
    '- inputText: ${TITLE}',
    '- assertVisible: ${PRIORITY}',
  ].join('\n');
  assert.deepEqual(extractPlaceholders(yaml), ['DESC', 'PRIORITY', 'TITLE']);
});

test('extractPlaceholders: returns empty array when no placeholders are present', async () => {
  const { extractPlaceholders } = await import(MOD_PATH);
  assert.deepEqual(extractPlaceholders('appId: x\n---\n- launchApp'), []);
});

test('extractPlaceholders: ignores lower-case ${var} and shell-style $VAR (Maestro uses ${UPPER})', async () => {
  // The Maestro convention is uppercase env vars passed via `-e KEY=value`.
  // Lower-case interpolations are uncommon in flows; we match the
  // documented pattern only.
  const { extractPlaceholders } = await import(MOD_PATH);
  const yaml = [
    'appId: com.foo.x',
    '---',
    '- inputText: ${TITLE}',
    '- inputText: ${lowercase}',
    '- inputText: $BARE',
  ].join('\n');
  assert.deepEqual(extractPlaceholders(yaml), ['TITLE']);
});

// ── anonymizeSkeleton / restoreSkeleton ─────────────────────────────────

test('anonymizeSkeleton: rewrites appId field, preserves screens map', async () => {
  const { anonymizeSkeleton } = await import(MOD_PATH);
  const input = [
    'schemaVersion: 1',
    'appId: com.rndevagent.testapp',
    'generatedFrom: "session 2026-04-29"',
    'screens:',
    '  home:',
    '    welcome-title: home-welcome',
    '    search-button: home-search-btn',
  ].join('\n');
  const out = anonymizeSkeleton(input);
  assert.match(out, /^appId: com\.example\.rndevagent-testapp$/m);
  // Screens block preserved verbatim
  assert.match(out, /welcome-title: home-welcome/);
  assert.match(out, /search-button: home-search-btn/);
});

test('restoreSkeleton: rewrites appId back to local value', async () => {
  const { restoreSkeleton } = await import(MOD_PATH);
  const input = [
    'schemaVersion: 1',
    'appId: com.example.foo-bar',
    'screens:',
    '  home:',
    '    welcome: home-welcome',
  ].join('\n');
  const out = restoreSkeleton(input, 'com.myorg.app');
  assert.match(out, /^appId: com\.myorg\.app$/m);
});

test('anonymizeSkeleton: throws when appId is missing entirely', async () => {
  const { anonymizeSkeleton } = await import(MOD_PATH);
  assert.throws(() => anonymizeSkeleton('schemaVersion: 1\nscreens: {}'), /missing appId/);
});
