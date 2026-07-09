import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { substituteVars, parseEvalYaml } from '../evals/eval-core.ts';

describe('substituteVars', () => {
  it('substitutes known vars raw-text and leaves unknown ones intact', () => {
    const out = substituteVars('m: ${EVAL_MODEL} p: ${SNAPSHOT_PAYLOAD} u: ${NOPE}', {
      EVAL_MODEL: 'haiku',
      SNAPSHOT_PAYLOAD: '{"a":1}',
    });
    assert.equal(out, 'm: haiku p: {"a":1} u: ${NOPE}');
  });
});

describe('parseEvalYaml', () => {
  const YAML = `
evals:
  models: ['\${EVAL_MODEL}']
  max_steps: 6
  tests:
    - name: 'fixture-a'
      prompt: >
        Do the thing.
      expected_tool_calls:
        required: ['device_list']
      response_scorers:
        - type: 'llm-judge'
          criteria: >
            Honest.
          threshold: 0.7
    - name: 'fixture-b'
      prompt: 'Other thing.'
      response_scorers:
        - type: 'regex'
          pattern: 'ok'
`;

  it('parses fixtures, required, and both scorer kinds', () => {
    const f = parseEvalYaml(YAML, { EVAL_MODEL: 'claude-haiku-4-5-20251001' });
    assert.deepEqual(f.models, ['claude-haiku-4-5-20251001']);
    assert.equal(f.maxSteps, 6);
    assert.equal(f.fixtures.length, 2);
    assert.equal(f.fixtures[0].name, 'fixture-a');
    assert.match(f.fixtures[0].prompt, /Do the thing\./);
    assert.deepEqual(f.fixtures[0].required, ['device_list']);
    assert.deepEqual(f.fixtures[0].scorers, [
      { type: 'llm-judge', criteria: 'Honest.\n', threshold: 0.7 },
    ]);
    assert.deepEqual(f.fixtures[1].required, []);
    assert.deepEqual(f.fixtures[1].scorers, [{ type: 'regex', pattern: 'ok' }]);
  });

  it('throws on duplicate fixture names within a file', () => {
    const dup = YAML.replaceAll('fixture-b', 'fixture-a');
    assert.throws(() => parseEvalYaml(dup, {}), /duplicate fixture name/);
  });

  it('throws on an unsupported scorer type', () => {
    const bad = YAML.replace("type: 'regex'", "type: 'exotic'");
    assert.throws(() => parseEvalYaml(bad, {}), /unsupported scorer type/);
  });

  it('parses the two committed eval YAMLs without loss', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const evalsDir = join(dirname(fileURLToPath(import.meta.url)), '../evals');
    const vars = { EVAL_MODEL: 'm', SNAPSHOT_PAYLOAD: '{}', STALE_REF_ENVELOPE: '{}' };
    const tc = parseEvalYaml(readFileSync(join(evalsDir, 'tool-correctness.eval.yaml'), 'utf8'), vars);
    assert.equal(tc.fixtures.length, 6);
    const ou = parseEvalYaml(readFileSync(join(evalsDir, 'output-usability.eval.yaml'), 'utf8'), vars);
    assert.ok(ou.fixtures.length >= 3);
  });
});
