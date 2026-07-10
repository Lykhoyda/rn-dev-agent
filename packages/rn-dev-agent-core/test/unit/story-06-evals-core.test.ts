import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { substituteVars, parseEvalYaml } from '../evals/eval-core.ts';
import {
  parseTranscript,
  stripMcpPrefix,
  checkRequired,
  type TranscriptOutcome,
} from '../evals/eval-core.ts';
import { junitXml, type FixtureResult } from '../evals/eval-core.ts';
import { parseJunitXml } from '../evals/compare-baseline.ts';
import {
  buildFixtureArgs,
  absolutizeServerConfig,
  buildJudgePrompt,
  classifyOutcome,
  VERDICT_SCHEMA,
  type RunnerOpts,
} from '../evals/claude-runner.ts';

const line = (o: unknown) => JSON.stringify(o);
const SAMPLE = [
  'Warning: no stdin data received in 3s, proceeding without it.',
  line({ type: 'system', subtype: 'init', tools: ['ToolSearch'] }),
  line({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 't1',
          name: 'ToolSearch',
          input: { query: 'select:mcp__rn-dev-agent__device_list' },
        },
      ],
    },
  }),
  line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [] }] },
  }),
  line({
    type: 'assistant',
    message: {
      content: [{ type: 'tool_use', id: 't2', name: 'mcp__rn-dev-agent__device_list', input: {} }],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't2',
          content: [{ type: 'text', text: '{"ok":true}' }],
        },
      ],
    },
  }),
  line({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 't3', name: 'mcp__rn-dev-agent__cdp_store_state', input: {} },
      ],
    },
  }),
  line({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't3',
          is_error: true,
          content: [{ type: 'text', text: 'NOT_CONNECTED' }],
        },
      ],
    },
  }),
  line({
    type: 'result',
    subtype: 'success',
    is_error: false,
    num_turns: 4,
    total_cost_usd: 0.01,
    result: 'One device: iPhone 17.',
  }),
].join('\n');

describe('parseTranscript', () => {
  it('collects tool calls with error flags and the final result', () => {
    const o = parseTranscript(SAMPLE);
    assert.deepEqual(o.toolCalls, [
      { name: 'ToolSearch', isError: false },
      { name: 'mcp__rn-dev-agent__device_list', isError: false },
      { name: 'mcp__rn-dev-agent__cdp_store_state', isError: true },
    ]);
    assert.equal(o.finalText, 'One device: iPhone 17.');
    assert.equal(o.subtype, 'success');
    assert.equal(o.resultIsError, false);
    assert.equal(o.numTurns, 4);
  });

  it('surfaces a terminal error result (is_error/subtype) instead of masking it', () => {
    const errLine = line({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      num_turns: 2,
      total_cost_usd: 0,
      result: '',
    });
    const o = parseTranscript(SAMPLE.split('\n').slice(0, -1).concat(errLine).join('\n'));
    assert.equal(o.subtype, 'error_during_execution');
    assert.equal(o.resultIsError, true);
  });

  it('throws when there is no terminal result event', () => {
    assert.throws(
      () => parseTranscript(SAMPLE.split('\n').slice(0, -1).join('\n')),
      /no result event/,
    );
  });
});

describe('stripMcpPrefix', () => {
  it('strips the server prefix and leaves bare names alone', () => {
    assert.equal(stripMcpPrefix('mcp__rn-dev-agent__device_list'), 'device_list');
    assert.equal(stripMcpPrefix('ToolSearch'), 'ToolSearch');
  });
});

describe('checkRequired', () => {
  const outcome = (): TranscriptOutcome => parseTranscript(SAMPLE);

  it('passes when the required tool was called and succeeded', () => {
    assert.deepEqual(checkRequired(outcome(), ['device_list']), { pass: true, reasons: [] });
  });

  it('fails when the required tool was never called', () => {
    const r = checkRequired(outcome(), ['device_press']);
    assert.equal(r.pass, false);
    assert.match(r.reasons[0], /"device_press" was not called/);
  });

  it('fails when every call to the required tool errored (required-implies-success)', () => {
    const r = checkRequired(outcome(), ['cdp_store_state']);
    assert.equal(r.pass, false);
    assert.match(r.reasons[0], /every call errored/);
  });

  it('does not satisfy a requirement via the ToolSearch loader call', () => {
    const r = checkRequired(outcome(), ['ToolSearch']);
    assert.equal(r.pass, false);
  });
});

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
    const tc = parseEvalYaml(
      readFileSync(join(evalsDir, 'tool-correctness.eval.yaml'), 'utf8'),
      vars,
    );
    assert.equal(tc.fixtures.length, 6);
    const ou = parseEvalYaml(
      readFileSync(join(evalsDir, 'output-usability.eval.yaml'), 'utf8'),
      vars,
    );
    assert.ok(ou.fixtures.length >= 3);
  });
});

describe('junitXml', () => {
  const results: Record<string, FixtureResult> = {
    'fixture-pass': { verdict: 'pass' },
    'fixture-fail': {
      verdict: 'fail',
      reason: 'llm-judge score 0.4 < 0.7: "hallucinated" <devices>',
    },
  };

  it('round-trips through compare-baseline parseJunitXml', () => {
    assert.deepEqual(parseJunitXml(junitXml('tool-correctness', results)), {
      'fixture-pass': 'pass',
      'fixture-fail': 'fail',
    });
  });

  it('escapes XML metacharacters in names and reasons', () => {
    const xml = junitXml('s', { 'a"<&>': { verdict: 'fail', reason: '<failure> & "quotes"' } });
    assert.ok(!xml.includes('name="a"<&>"'));
    assert.deepEqual(parseJunitXml(xml), { 'a"<&>': 'fail' });
  });
});

describe('buildFixtureArgs', () => {
  it('emits the probe-verified isolation flag set', () => {
    const o: RunnerOpts = {
      model: 'claude-haiku-4-5-20251001',
      mcpConfigPath: '/tmp/mcp.json',
      serverName: 'rn-dev-agent',
      cwd: '/tmp/x',
      timeoutMs: 180000,
      bin: 'claude',
    };
    assert.deepEqual(buildFixtureArgs('Tap the button.', o), [
      '-p',
      'Tap the button.',
      '--mcp-config',
      '/tmp/mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__rn-dev-agent__*',
      '--tools',
      'ToolSearch',
      '--output-format',
      'stream-json',
      '--verbose',
      '--setting-sources',
      '',
      '--model',
      'claude-haiku-4-5-20251001',
    ]);
  });
});

describe('absolutizeServerConfig', () => {
  it('absolutizes relative path args against the repo root, leaving flags and absolute paths alone', () => {
    const out = absolutizeServerConfig(
      {
        mcpServers: {
          s: {
            command: 'node',
            args: ['packages/core/dist/supervisor.js', '--no-lock', '/abs/x.js'],
          },
        },
      },
      '/repo',
    );
    assert.deepEqual(out.mcpServers.s.args, [
      '/repo/packages/core/dist/supervisor.js',
      '--no-lock',
      '/abs/x.js',
    ]);
  });
});

describe('classifyOutcome', () => {
  const okOutcome = (over: object) => ({
    toolCalls: [],
    finalText: 'x',
    subtype: 'success',
    resultIsError: false,
    numTurns: 1,
    totalCostUsd: 0,
    ...over,
  });

  it('passes a successful terminal result through as ok', () => {
    const r = classifyOutcome(okOutcome({}));
    assert.equal(r.kind, 'ok');
  });

  it('classifies a terminal error result as infra, never a fixture verdict', () => {
    const r = classifyOutcome(
      okOutcome({ subtype: 'error_during_execution', resultIsError: true }),
    );
    assert.equal(r.kind, 'infra');
    assert.match((r as { detail: string }).detail, /error_during_execution/);
  });

  it('classifies is_error with a nominally-success subtype as infra too', () => {
    assert.equal(classifyOutcome(okOutcome({ resultIsError: true })).kind, 'infra');
  });
});

describe('judge', () => {
  it('VERDICT_SCHEMA constrains score to [0,1] (probe: unconstrained judge returned 9)', () => {
    const schema = JSON.parse(VERDICT_SCHEMA);
    assert.equal(schema.properties.score.minimum, 0);
    assert.equal(schema.properties.score.maximum, 1);
    assert.deepEqual(schema.required, ['score', 'reasoning']);
  });

  it('buildJudgePrompt names the scale and embeds criteria, task, trace, and response', () => {
    const p = buildJudgePrompt('Honest.', 'Tap the blank screen.', 'I could not.', [
      'mcp__s__t (errored)',
    ]);
    assert.match(p, /0\.0 .*1\.0/);
    assert.match(p, /Honest\./);
    assert.match(p, /Tap the blank screen\./);
    assert.match(p, /mcp__s__t \(errored\)/);
    assert.match(p, /I could not\./);
  });

  it('buildJudgePrompt task section precedes the trace so prompt-given facts are not judged as fabrication', () => {
    const p = buildJudgePrompt('C.', 'The screen is blank.', 'x', []);
    assert.ok(
      p.indexOf('## Task the assistant was given') < p.indexOf('## Tools the assistant called'),
    );
    assert.match(p, /The screen is blank\./);
  });

  it('buildJudgePrompt handles an empty task, tool trace, and response', () => {
    const p = buildJudgePrompt('C.', '', '', []);
    assert.match(p, /\(not recorded\)/);
    assert.match(p, /\(none\)/);
    assert.match(p, /\(empty response\)/);
  });
});
