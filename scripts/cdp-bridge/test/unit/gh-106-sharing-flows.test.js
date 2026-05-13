// GH #106: integration tests for the flow + skeleton bundling path
// through sharing.ts. Uses real temp dirs so the readdirSync /
// writeFileSync I/O is exercised end-to-end. Verifies:
//   - export walks .rn-agent/actions/ and includes flows by default
//   - --no-flows / --no-skeleton opt-outs work
//   - import writes flows back, rewriting appId to the local value
//   - conflicting flow ids are suffixed `.imported.yaml`
//   - skeleton bundling + restore works end-to-end
//   - missing project root cleanly skips the flow bundling (no throw)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const MOD_PATH = '../../dist/experience/sharing.js';

function makeWorkspace(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gh106-'));
  const actionsDir = join(root, '.rn-agent', 'actions');
  mkdirSync(actionsDir, { recursive: true });
  if (opts.appJson) {
    writeFileSync(join(root, 'app.json'), JSON.stringify(opts.appJson), 'utf-8');
  }
  // Plausible package.json so findProjectRoot is happy if pointed here.
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    name: 'temp-test-app',
    dependencies: { 'react-native': '0.79.0' },
  }), 'utf-8');
  for (const [name, contents] of Object.entries(opts.flows ?? {})) {
    writeFileSync(join(actionsDir, name), contents, 'utf-8');
  }
  if (opts.skeleton !== undefined) {
    writeFileSync(join(root, '.rn-agent', 'skeleton.yaml'), opts.skeleton, 'utf-8');
  }
  return root;
}

function makeFlow(id, appId = 'com.foo.bar', extra = '') {
  return [
    `appId: ${appId}`,
    '---',
    `# id: ${id}`,
    `# intent: do a thing`,
    `# status: active`,
    ...(extra ? [extra] : []),
    '- launchApp',
    '- tapOn:',
    '    id: "foo-btn"',
  ].join('\n');
}

function makeSkeleton(appId = 'com.foo.bar') {
  return [
    'schemaVersion: 1',
    `appId: ${appId}`,
    'screens:',
    '  home:',
    '    welcome: home-welcome',
  ].join('\n');
}

test('exportExperience: bundles flows + skeleton by default', async () => {
  const { exportExperience } = await import(MOD_PATH);
  const root = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.foo.bar' } } },
    flows: {
      'alpha.yaml': makeFlow('alpha'),
      'beta.yaml': makeFlow('beta', 'com.foo.bar', '- inputText: ${TITLE}'),
    },
    skeleton: makeSkeleton(),
  });
  try {
    const { bundle } = exportExperience({ projectRoot: root });
    assert.ok(Array.isArray(bundle.flows), 'flows array should be present');
    assert.equal(bundle.flows.length, 2);
    const ids = bundle.flows.map(f => f.id).sort();
    assert.deepEqual(ids, ['alpha', 'beta']);
    // Anonymized appId in each
    for (const f of bundle.flows) {
      assert.match(f.yaml, /^appId: com\.example\.foo-bar$/m);
      // Body preserved verbatim — testID still there
      assert.match(f.yaml, /id: "foo-btn"/);
    }
    assert.ok(bundle.skeleton, 'skeleton present');
    assert.match(bundle.skeleton.yaml, /^appId: com\.example\.foo-bar$/m);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportExperience: --no-flows opts out of flow bundling', async () => {
  const { exportExperience } = await import(MOD_PATH);
  const root = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.foo.bar' } } },
    flows: { 'alpha.yaml': makeFlow('alpha') },
    skeleton: makeSkeleton(),
  });
  try {
    const { bundle } = exportExperience({ projectRoot: root, flows: false });
    assert.equal(bundle.flows, undefined);
    assert.ok(bundle.skeleton, 'skeleton still bundled');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportExperience: --no-skeleton opts out of skeleton bundling', async () => {
  const { exportExperience } = await import(MOD_PATH);
  const root = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.foo.bar' } } },
    flows: { 'alpha.yaml': makeFlow('alpha') },
    skeleton: makeSkeleton(),
  });
  try {
    const { bundle } = exportExperience({ projectRoot: root, skeleton: false });
    assert.ok(Array.isArray(bundle.flows));
    assert.equal(bundle.skeleton, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exportExperience: missing project root cleanly skips flow bundling', async () => {
  const { exportExperience } = await import(MOD_PATH);
  // projectRoot: null means "no rooted project found"
  const { bundle } = exportExperience({ projectRoot: null });
  assert.equal(bundle.flows, undefined);
  assert.equal(bundle.skeleton, undefined);
});

test('exportExperience: skips malformed flow files (one bad file does not kill the export)', async () => {
  const { exportExperience } = await import(MOD_PATH);
  const root = makeWorkspace({
    flows: {
      'good.yaml': makeFlow('good'),
      'bad.yaml': '- this has no appId line\n- launchApp',
    },
  });
  try {
    const { bundle } = exportExperience({ projectRoot: root });
    assert.equal(bundle.flows.length, 1);
    assert.equal(bundle.flows[0].id, 'good');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('importExperience: writes flows to .rn-agent/actions/, rewrites appId to local', async () => {
  const { exportExperience, importExperience } = await import(MOD_PATH);
  const sourceRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.original.app' } } },
    flows: { 'alpha.yaml': makeFlow('alpha', 'com.original.app') },
  });
  const targetRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.target.testapp' } } },
  });
  try {
    const { path: bundlePath } = exportExperience({ projectRoot: sourceRoot, skeleton: false });
    const result = importExperience(bundlePath, { projectRoot: targetRoot });
    assert.equal(result.flows_imported, 1);
    const imported = readFileSync(join(targetRoot, '.rn-agent', 'actions', 'alpha.yaml'), 'utf-8');
    // appId rewritten to TARGET's bundleId
    assert.match(imported, /^appId: com\.target\.testapp$/m);
    // status forced to experimental
    assert.match(imported, /^#\s*status:\s*experimental$/m);
    // Body preserved
    assert.match(imported, /id: "foo-btn"/);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importExperience: conflicting flow id lands at <id>.imported.yaml', async () => {
  const { exportExperience, importExperience } = await import(MOD_PATH);
  const sourceRoot = makeWorkspace({
    flows: { 'alpha.yaml': makeFlow('alpha', 'com.source.app') },
  });
  // Pre-populate target with an existing alpha.yaml
  const targetRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.target.app' } } },
    flows: { 'alpha.yaml': makeFlow('alpha', 'com.target.app') },
  });
  try {
    const { path: bundlePath } = exportExperience({ projectRoot: sourceRoot, skeleton: false });
    const result = importExperience(bundlePath, { projectRoot: targetRoot });
    assert.equal(result.flows_imported, 1);
    assert.deepEqual(result.flows_renamed, ['alpha.imported.yaml']);
    // Original alpha.yaml unchanged
    const original = readFileSync(join(targetRoot, '.rn-agent', 'actions', 'alpha.yaml'), 'utf-8');
    assert.match(original, /^appId: com\.target\.app$/m); // unchanged
    // Imported variant exists side-by-side
    const importedPath = join(targetRoot, '.rn-agent', 'actions', 'alpha.imported.yaml');
    assert.ok(existsSync(importedPath));
    const imported = readFileSync(importedPath, 'utf-8');
    assert.match(imported, /^appId: com\.target\.app$/m);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importExperience: second collision lands at <id>.imported.2.yaml (no silent overwrite)', async () => {
  // Gemini multi-review (conf 90): when both <id>.yaml AND
  // <id>.imported.yaml already exist, the next import MUST not clobber
  // the first imported variant — the user may be mid-merge on it. Use a
  // numbered suffix instead.
  const { exportExperience, importExperience } = await import(MOD_PATH);
  const sourceRoot = makeWorkspace({
    flows: { 'alpha.yaml': makeFlow('alpha', 'com.source.app') },
  });
  const targetRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.target.app' } } },
    flows: {
      'alpha.yaml': makeFlow('alpha', 'com.target.app', '# version: original'),
      'alpha.imported.yaml': makeFlow('alpha', 'com.target.app', '# version: first-import-being-merged'),
    },
  });
  try {
    const { path: bundlePath } = exportExperience({ projectRoot: sourceRoot, skeleton: false });
    const result = importExperience(bundlePath, { projectRoot: targetRoot });
    assert.equal(result.flows_imported, 1);
    assert.deepEqual(result.flows_renamed, ['alpha.imported.2.yaml']);
    // Original alpha.imported.yaml UNCHANGED (the merge-in-progress)
    const firstImport = readFileSync(join(targetRoot, '.rn-agent', 'actions', 'alpha.imported.yaml'), 'utf-8');
    assert.match(firstImport, /# version: first-import-being-merged/);
    // New variant exists at the numbered path
    const secondImport = readFileSync(join(targetRoot, '.rn-agent', 'actions', 'alpha.imported.2.yaml'), 'utf-8');
    assert.match(secondImport, /^appId: com\.target\.app$/m);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importExperience: skeleton written to .rn-agent/skeleton.yaml with rewritten appId', async () => {
  const { exportExperience, importExperience } = await import(MOD_PATH);
  const sourceRoot = makeWorkspace({
    flows: {},
    skeleton: makeSkeleton('com.source.app'),
  });
  const targetRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.target.app' } } },
  });
  try {
    const { path: bundlePath } = exportExperience({ projectRoot: sourceRoot });
    const result = importExperience(bundlePath, { projectRoot: targetRoot });
    assert.equal(result.skeleton_imported, true);
    const imported = readFileSync(join(targetRoot, '.rn-agent', 'skeleton.yaml'), 'utf-8');
    assert.match(imported, /^appId: com\.target\.app$/m);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importExperience: --no-flows opts out of flow restoration', async () => {
  const { exportExperience, importExperience } = await import(MOD_PATH);
  const sourceRoot = makeWorkspace({
    flows: { 'alpha.yaml': makeFlow('alpha') },
  });
  const targetRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.target.app' } } },
  });
  try {
    const { path: bundlePath } = exportExperience({ projectRoot: sourceRoot, skeleton: false });
    const result = importExperience(bundlePath, { projectRoot: targetRoot, flows: false });
    assert.equal(result.flows_imported, undefined);
    assert.ok(!existsSync(join(targetRoot, '.rn-agent', 'actions', 'alpha.yaml')));
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importExperience: target with no app.json falls back to com.example.unknownapp', async () => {
  // Edge case: target project has no app.json, so readAppId returns null.
  // Importer should still write the flow with a sentinel appId so the
  // user can see what landed and edit the appId line.
  const { exportExperience, importExperience } = await import(MOD_PATH);
  const sourceRoot = makeWorkspace({
    flows: { 'alpha.yaml': makeFlow('alpha') },
  });
  const targetRoot = makeWorkspace({ /* no appJson */ });
  try {
    const { path: bundlePath } = exportExperience({ projectRoot: sourceRoot, skeleton: false });
    const result = importExperience(bundlePath, { projectRoot: targetRoot });
    assert.equal(result.flows_imported, 1);
    const imported = readFileSync(join(targetRoot, '.rn-agent', 'actions', 'alpha.yaml'), 'utf-8');
    assert.match(imported, /^appId: com\.example\.unknownapp$/m);
  } finally {
    rmSync(sourceRoot, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});

test('importExperience: malformed bundle flow id is skipped (defense in depth)', async () => {
  // The export path validates ids, but a hand-crafted/tampered bundle
  // could carry a malicious id. The writeImportedFlow guard rejects
  // anything not matching ^[A-Za-z0-9_-]+$.
  const { importExperience } = await import(MOD_PATH);
  const bundlesDir = mkdtempSync(join(tmpdir(), 'gh106-bundle-'));
  const targetRoot = makeWorkspace({
    appJson: { expo: { ios: { bundleIdentifier: 'com.target.app' } } },
  });
  const bundlePath = join(bundlesDir, 'bad.yaml');
  // Hand-craft a bundle with a path-traversal id
  const bundle = {
    version: 1,
    exported_at: '2026-04-01T00:00:00Z',
    env: {},
    heuristics: [],
    failure_stats: [],
    flows: [{
      id: '../../../etc/passwd',
      yaml: makeFlow('safe-id', 'com.example.foo'),
    }],
  };
  const { stringify } = await import('yaml');
  writeFileSync(bundlePath, stringify(bundle), 'utf-8');
  try {
    const result = importExperience(bundlePath, { projectRoot: targetRoot });
    assert.equal(result.flows_imported ?? 0, 0);
    // No file written under any traversal-like path
    assert.ok(!existsSync(join(targetRoot, '.rn-agent', 'actions', '..', '..', '..', 'etc', 'passwd')));
  } finally {
    rmSync(bundlesDir, { recursive: true, force: true });
    rmSync(targetRoot, { recursive: true, force: true });
  }
});
