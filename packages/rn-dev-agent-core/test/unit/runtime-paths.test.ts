import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import {
  candidateNativeRunnerDirs,
  candidatePluginManifestFiles,
  candidateRunnerManifestFiles,
} from '../../dist/runners/runtime-paths.js';

test('native runner candidates include source-checkout package path', () => {
  const base = join('/repo', 'packages', 'rn-dev-agent-core', 'dist', 'runners');

  assert.ok(
    candidateNativeRunnerDirs('rn-fast-runner', base).includes(
      join('/repo', 'packages', 'rn-fast-runner'),
    ),
  );
});

test('native runner candidates include bundled Codex plugin scripts path', () => {
  const base = join('/repo', 'packages', 'codex-plugin', 'rn-dev-agent-core', 'dist');

  assert.ok(
    candidateNativeRunnerDirs('rn-android-runner', base).includes(
      join('/repo', 'packages', 'codex-plugin', 'scripts', 'rn-android-runner'),
    ),
  );
});

test('runner manifest candidates include source root and bundled Codex plugin root', () => {
  const sourceBase = join('/repo', 'packages', 'rn-dev-agent-core', 'dist', 'runners');
  const codexBase = join('/repo', 'packages', 'codex-plugin', 'rn-dev-agent-core', 'dist');

  assert.ok(
    candidateRunnerManifestFiles(sourceBase).includes(join('/repo', 'runner-manifest.json')),
  );
  assert.ok(
    candidateRunnerManifestFiles(codexBase).includes(
      join('/repo', 'packages', 'codex-plugin', 'runner-manifest.json'),
    ),
  );
});

test('plugin manifest candidates include Claude package and Codex package manifests', () => {
  const sourceBase = join('/repo', 'packages', 'rn-dev-agent-core', 'dist', 'runners');
  const codexBase = join('/repo', 'packages', 'codex-plugin', 'rn-dev-agent-core', 'dist');

  assert.ok(
    candidatePluginManifestFiles(sourceBase).includes(
      join('/repo', 'packages', 'claude-plugin', '.claude-plugin', 'plugin.json'),
    ),
  );
  assert.ok(
    candidatePluginManifestFiles(codexBase).includes(
      join('/repo', 'packages', 'codex-plugin', '.codex-plugin', 'plugin.json'),
    ),
  );
});
