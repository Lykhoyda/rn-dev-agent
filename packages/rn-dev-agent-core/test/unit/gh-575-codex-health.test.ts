import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DOMAIN_SKILLS,
  EXPECTED_SKILLS,
  MCP_CANARIES,
  WORKFLOW_SKILLS,
  classifyHealth,
  parseArgs,
  type HealthFacts,
} from '../../../codex-plugin/src/plugin-health.ts';

function healthyFacts(): HealthFacts {
  return {
    hostSupport: {
      status: 'LIVE_REFRESH_SUPPORTED',
      version: 'codex-cli 0.145.0',
      floor: '0.145.0',
    },
    installation: {
      status: 'ENABLED',
      pluginId: 'rn-dev-agent@rn-dev-agent',
      version: '1.0.0',
      matches: [{ pluginId: 'rn-dev-agent@rn-dev-agent', version: '1.0.0' }],
    },
    materialization: {
      status: 'EXACT_HEALTHY',
      packageRoot: '/tmp/plugin',
      version: '1.0.0',
      missing: [],
    },
    mcpRegistration: { status: 'REGISTERED', server: 'cdp' },
    mcpContractProbe: {
      status: 'HEALTHY',
      toolCount: 79,
      canaries: Object.fromEntries(MCP_CANARIES.map((name) => [name, true])),
    },
    directProofSchema: { status: 'USABLE', actions: ['contract'] },
    taskSkillInventory: {
      status: 'COMPLETE',
      complete: true,
      observed: [...EXPECTED_SKILLS],
      missing: [],
    },
    taskMcpInventory: {
      status: 'COMPLETE',
      complete: true,
      observed: [...MCP_CANARIES],
      missing: [],
    },
    observedTransport: { status: 'healthy', provenance: 'caller' },
    hostProofSchema: { status: 'usable', provenance: 'caller' },
    observedAppStatus: { status: 'connected', provenance: 'caller' },
  };
}

test('GH-575 inventory contract is exactly 10 domain + 15 workflow = 25', () => {
  assert.equal(DOMAIN_SKILLS.length, 10);
  assert.equal(WORKFLOW_SKILLS.length, 15);
  assert.equal(EXPECTED_SKILLS.length, 25);
  assert.equal(new Set(EXPECTED_SKILLS).size, 25);
});

test('GH-575 observation parser preserves explicit complete empty inventories', () => {
  const parsed = parseArgs([
    '--task-skills-complete',
    '--task-mcp-complete',
    '--observed-transport',
    'closed',
    '--host-proof-schema',
    'empty',
    '--observed-app-status',
    'disconnected',
    '--json',
  ]);
  assert.deepEqual(parsed.taskSkills, []);
  assert.equal(parsed.taskSkillsComplete, true);
  assert.equal(parsed.taskMcpComplete, true);
  assert.equal(parsed.observedTransport, 'closed');
  assert.equal(parsed.hostProofSchema, 'empty');
  assert.equal(parsed.observedAppStatus, 'disconnected');
  assert.throws(() => parseArgs(['--task-skill', 'bad name']), /invalid/);
  assert.throws(
    () => parseArgs(['--observed-transport', 'closed', '--observed-transport', 'healthy']),
    /only once/,
  );
});

test('GH-575 healthy direct state plus unknown task state is indeterminate, never stale', () => {
  const facts = healthyFacts();
  facts.taskSkillInventory = {
    status: 'PARTIAL_OR_UNKNOWN',
    complete: false,
    observed: [],
    missing: [...EXPECTED_SKILLS],
  };
  facts.taskMcpInventory = {
    status: 'PARTIAL_OR_UNKNOWN',
    complete: false,
    observed: [],
    missing: [...MCP_CANARIES],
  };
  const result = classifyHealth(facts);
  assert.equal(result.primaryFinding, 'INDETERMINATE_TASK_STATE');
  assert.equal(
    result.findings.some((finding) => finding.code.startsWith('STALE_')),
    false,
  );
});

test('GH-575 unknown caller observations remain indeterminate with complete inventories', () => {
  const facts = healthyFacts();
  facts.observedTransport.status = 'unknown';
  facts.hostProofSchema.status = 'unknown';
  facts.observedAppStatus.status = 'unknown';
  const result = classifyHealth(facts);
  assert.equal(result.primaryFinding, 'INDETERMINATE_TASK_STATE');
  assert.equal(result.overall, 'indeterminate');
});

test('GH-575 complete explicit absence is stale and retains simultaneous findings', () => {
  const facts = healthyFacts();
  facts.taskSkillInventory = {
    status: 'ABSENT',
    complete: true,
    observed: [],
    missing: [...EXPECTED_SKILLS],
  };
  facts.taskMcpInventory = {
    status: 'ABSENT',
    complete: true,
    observed: [],
    missing: [...MCP_CANARIES],
  };
  facts.observedTransport.status = 'closed';
  facts.hostSupport.status = 'LEGACY_HOST_RESTART_REQUIRED';
  const result = classifyHealth(facts);
  assert.equal(result.primaryFinding, 'STALE_ACTIVE_TASK_DISCOVERY');
  assert.deepEqual(
    new Set(result.findings.map((finding) => finding.code)),
    new Set([
      'STALE_ACTIVE_TASK_DISCOVERY',
      'ACTIVE_TRANSPORT_CLOSED',
      'LEGACY_HOST_RESTART_REQUIRED',
    ]),
  );
  assert.ok(result.nextActions.some((action) => action.includes('relaunch')));
  assert.ok(result.nextActions.some((action) => action.includes('>= 0.145.0')));
  assert.ok(result.nextActions.some((action) => action.includes('after plugin changes')));
});

test('GH-575 stale classification requires every direct-health prerequisite', () => {
  const disabled = healthyFacts();
  disabled.installation.status = 'DISABLED';
  disabled.taskSkillInventory = {
    status: 'ABSENT',
    complete: true,
    observed: [],
    missing: [...EXPECTED_SKILLS],
  };
  disabled.taskMcpInventory = {
    status: 'ABSENT',
    complete: true,
    observed: [],
    missing: [...MCP_CANARIES],
  };
  const unusableSchema = structuredClone(disabled);
  unusableSchema.installation.status = 'ENABLED';
  unusableSchema.directProofSchema.status = 'UNUSABLE';

  for (const facts of [disabled, unusableSchema]) {
    const result = classifyHealth(facts);
    assert.equal(
      result.findings.some((finding) => finding.code.startsWith('STALE_')),
      false,
    );
  }
});

test('GH-575 failed contract probe leaves direct proof schema unknown', () => {
  const facts = healthyFacts();
  facts.mcpContractProbe.status = 'FAILED';
  facts.directProofSchema.status = 'UNKNOWN';
  const result = classifyHealth(facts);
  assert.equal(result.primaryFinding, 'MCP_CONTRACT_PROBE_FAILED');
  assert.equal(
    result.findings.some((finding) => finding.code === 'SERVER_SCHEMA_EXPOSURE_FAILURE'),
    false,
  );
});

test('GH-575 installation/materialization failures outrank task observations', () => {
  const facts = healthyFacts();
  facts.installation.status = 'MISSING';
  facts.materialization.status = 'CORRUPT';
  facts.taskSkillInventory = {
    status: 'ABSENT',
    complete: true,
    observed: [],
    missing: [...EXPECTED_SKILLS],
  };
  facts.taskMcpInventory = {
    status: 'ABSENT',
    complete: true,
    observed: [],
    missing: [...MCP_CANARIES],
  };
  const result = classifyHealth(facts);
  assert.equal(result.primaryFinding, 'MISSING_INSTALLATION');
  assert.equal(
    result.findings.some((finding) => finding.code.startsWith('STALE_')),
    false,
  );
});

test('GH-575 complete but incomplete inventories report each stale projection', () => {
  const facts = healthyFacts();
  facts.taskSkillInventory.missing = [EXPECTED_SKILLS[0]!];
  facts.taskSkillInventory.observed = EXPECTED_SKILLS.slice(1);
  facts.taskMcpInventory.missing = [MCP_CANARIES[0]!];
  facts.taskMcpInventory.observed = MCP_CANARIES.slice(1);
  const result = classifyHealth(facts);
  assert.deepEqual(
    result.findings.map((finding) => finding.code),
    ['STALE_SKILL_DISCOVERY', 'STALE_MCP_DISCOVERY'],
  );
});

test('GH-575 transport closure has standalone owning-process recovery', () => {
  const facts = healthyFacts();
  facts.observedTransport.status = 'closed';
  const result = classifyHealth(facts);
  assert.equal(result.primaryFinding, 'ACTIVE_TRANSPORT_CLOSED');
  assert.ok(result.nextActions.some((action) => action.includes('owns the active task')));
  assert.ok(result.nextActions.some((action) => action.includes('never kill or signal')));
  assert.equal(
    result.nextActions.some((action) => action.includes('external plugin change')),
    false,
  );
});
