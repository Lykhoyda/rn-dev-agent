import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

type MatrixEntry = { language?: string; 'config-file'?: string };

function readYaml<T>(relativePath: string): T {
  return parse(readFileSync(join(repoRoot, relativePath), 'utf8')) as T;
}

const GLOBSTAR_SLASH = '\u0001';
const GLOBSTAR = '\u0002';
const STAR = '\u0003';
const QUESTION = '\u0004';

function codeqlGlobToRegExp(pattern: string): RegExp {
  const body = pattern
    .replace(/\*\*\//g, GLOBSTAR_SLASH)
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, STAR)
    .replace(/\?/g, QUESTION)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll(GLOBSTAR_SLASH, '(?:.*/)?')
    .replaceAll(GLOBSTAR, '.*')
    .replaceAll(STAR, '[^/]*')
    .replaceAll(QUESTION, '[^/]');
  return new RegExp(`^${body}$`);
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

function jsMatrixEntry(): MatrixEntry {
  const workflow = readYaml<{
    jobs: { analyze: { strategy: { matrix: { include: MatrixEntry[] } } } };
  }>('.github/workflows/codeql.yml');
  const entry = workflow.jobs.analyze.strategy.matrix.include.find(
    (candidate) => candidate.language === 'javascript-typescript',
  );
  assert.ok(entry, 'the CodeQL matrix must still analyze javascript-typescript');
  return entry;
}

test('GH-783 CodeQL scope: the javascript-typescript leg loads an existing config file', () => {
  const configFile = jsMatrixEntry()['config-file'];
  assert.ok(configFile, 'the javascript-typescript matrix leg must declare a CodeQL config-file');
  assert.ok(
    existsSync(join(repoRoot, configFile)),
    `declared CodeQL config-file ${configFile} does not exist`,
  );
});

test('GH-783 CodeQL scope: generated bundles are excluded, hand-written sources are not', () => {
  const configFile = jsMatrixEntry()['config-file']!;
  const config = readYaml<{ 'paths-ignore'?: string[] }>(configFile);
  const ignored = (config['paths-ignore'] ?? []).map(codeqlGlobToRegExp);
  assert.ok(ignored.length > 0, 'the CodeQL config must declare paths-ignore entries');

  const isIgnored = (path: string) => ignored.some((matcher) => matcher.test(path));
  const analyzable = /\.(js|mjs|cjs|jsx|ts|tsx)$/;
  const scanned = trackedFiles().filter((path) => analyzable.test(path) && !isIgnored(path));

  const generated = scanned.filter((path) => path.includes('/dist/') || path.startsWith('.yarn/'));
  assert.deepEqual(generated, [], 'committed build output must stay out of the CodeQL database');

  for (const source of [
    'packages/rn-dev-agent-core/src/tools/session.ts',
    'packages/rn-dev-agent-core/src/session/registry.ts',
  ]) {
    assert.ok(scanned.includes(source), `${source} must still be analyzed by CodeQL`);
  }
});
