import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runSrc = readFileSync(resolve(__dirname, '../../src/tools/maestro-run.ts'), 'utf8');
const indexSrc = readFileSync(resolve(__dirname, '../../src/index.ts'), 'utf8');

test('GH#201 maestro-run auto-resolves appFile for iOS clearState flows', () => {
  assert.match(runSrc, /flowUsesClearState\(/);
  assert.match(runSrc, /resolveIosAppFile\(headerAppId\)/);
  assert.match(runSrc, /dispatch\.buildArgs\(platform, flowFile, appFile\)/);
});

test('GH#201 maestro_run exposes an appFile param', () => {
  assert.match(indexSrc, /appFile:\s*z\.string\(\)\.optional\(\)/);
});
