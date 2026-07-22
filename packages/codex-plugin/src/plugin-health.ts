#!/usr/bin/env node
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIVE_REFRESH_FLOOR = '0.145.0';
export const PLUGIN_ID = 'rn-dev-agent@rn-dev-agent';
export const WORKFLOW_SKILLS = [
  'build-and-test',
  'check-env',
  'check-vercel-rules',
  'debug-screen',
  'doctor',
  'list-learned-actions',
  'lock-e2e',
  'nav-graph',
  'observe',
  'proof-capture',
  'rn-feature-dev',
  'run-action',
  'send-feedback',
  'setup',
  'test-feature',
] as const;
export const DOMAIN_SKILLS = [
  'capturing-proof',
  'creating-actions',
  'rn-best-practices',
  'rn-debugging',
  'rn-device-control',
  'rn-feature-development',
  'rn-setup',
  'rn-testing',
  'sending-feedback',
  'using-rn-dev-agent',
] as const;
export const EXPECTED_SKILLS = [...DOMAIN_SKILLS, ...WORKFLOW_SKILLS].map(
  (name) => `rn-dev-agent:${name}`,
);
export const MCP_CANARIES = ['cdp_status', 'observe', 'device_list', 'proof_capture'] as const;
export const PROOF_ACTIONS = [
  'begin_rehearsal',
  'finish_rehearsal',
  'arm',
  'start_recording',
  'stop_recording',
  'validate',
  'finalize',
  'status',
  'discard',
  'contract',
] as const;
const CONTRACT_PROBE_RUNTIME_OVERRIDES = [
  'RN_DEV_AGENT_CORE_SUPERVISOR',
  'RN_DEV_AGENT_CORE_ROOT',
  'RN_BRIDGE_WORKER_PATH',
  'RN_BRIDGE_SUPERVISOR',
  'RN_BRIDGE_MAX_RESPAWNS',
  'RN_BRIDGE_LAST_EXIT',
  'RN_DEV_AGENT_CODEX_PLUGIN_ROOT',
] as const;

export interface ObservationInput {
  taskSkills: string[];
  taskSkillsComplete: boolean;
  taskMcpTools: string[];
  taskMcpComplete: boolean;
  observedTransport: 'healthy' | 'closed' | 'unknown';
  hostProofSchema: 'usable' | 'empty' | 'unknown';
  observedAppStatus: 'connected' | 'disconnected' | 'unknown';
  json: boolean;
}

export interface HealthFacts {
  hostSupport: { status: string; version: string | null; floor: string };
  installation: {
    status: string;
    pluginId: string;
    version: string | null;
    matches: Record<string, unknown>[];
  };
  materialization: {
    status: string;
    packageRoot: string;
    version: string | null;
    missing: string[];
  };
  mcpRegistration: { status: string; server: 'cdp' };
  mcpContractProbe: {
    status: string;
    toolCount: number | null;
    canaries: Record<string, boolean>;
    stderr?: string;
  };
  directProofSchema: { status: 'USABLE' | 'UNUSABLE' | 'UNKNOWN'; actions: string[] };
  taskSkillInventory: { status: string; complete: boolean; observed: string[]; missing: string[] };
  taskMcpInventory: { status: string; complete: boolean; observed: string[]; missing: string[] };
  observedTransport: { status: string; provenance: 'caller' };
  hostProofSchema: { status: string; provenance: 'caller' };
  observedAppStatus: { status: string; provenance: 'caller' };
}

export interface HealthReport extends HealthFacts {
  findings: Array<{ code: string; detail: string }>;
  primaryFinding: string;
  nextActions: string[];
  overall: 'healthy' | 'unhealthy' | 'indeterminate';
}

interface ProbeResult {
  ok: boolean;
  tools: Array<{ name?: string; inputSchema?: unknown }>;
  stderr: string;
  error?: string;
}

function parseVersion(raw: string): [number, number, number] | null {
  const match = raw.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: [number, number, number], floor: [number, number, number]): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i]! > floor[i]!) return true;
    if (actual[i]! < floor[i]!) return false;
  }
  return true;
}

function runJson(
  command: string,
  args: string[],
  timeout = 10_000,
): Promise<{ ok: boolean; value?: unknown }> {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      { encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolveResult({ ok: false });
        try {
          resolveResult({ ok: true, value: JSON.parse(stdout) });
        } catch {
          resolveResult({ ok: false });
        }
      },
    );
  });
}

function runText(
  command: string,
  args: string[],
  timeout = 10_000,
): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolveResult) => {
    execFile(command, args, { encoding: 'utf8', timeout, maxBuffer: 256 * 1024 }, (error, stdout) =>
      resolveResult({ ok: !error, text: String(stdout).trim() }),
    );
  });
}

function objectsIn(value: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const object = item as Record<string, unknown>;
    found.push(object);
    for (const child of Object.values(object)) {
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(value);
  return found;
}

function exactPluginRows(value: unknown): Record<string, unknown>[] {
  return objectsIn(value).filter((row) => row.pluginId === PLUGIN_ID);
}

function readManifest(packageRoot: string): { name?: string; version?: string } | null {
  try {
    return JSON.parse(readFileSync(join(packageRoot, '.codex-plugin', 'plugin.json'), 'utf8')) as {
      name?: string;
      version?: string;
    };
  } catch {
    return null;
  }
}

function realPathUnder(packageRoot: string, path: string, kind: 'file' | 'directory'): boolean {
  try {
    const lexicalRoot = resolve(packageRoot);
    const lexicalPath = resolve(path);
    const lexicalRel = relative(lexicalRoot, lexicalPath);
    if (lexicalRel === '' || lexicalRel === '..' || lexicalRel.startsWith(`..${sep}`)) return false;
    let cursor = lexicalRoot;
    for (const segment of lexicalRel.split(sep)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return false;
    }
    const root = realpathSync(lexicalRoot);
    const real = realpathSync(lexicalPath);
    const rel = relative(root, real);
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`)) return false;
    const info = lstatSync(real);
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

function materializationFacts(
  packageRoot: string,
  pluginVersion: string | null,
): HealthFacts['materialization'] {
  const manifest = readManifest(packageRoot);
  const requiredFiles = [
    '.codex-plugin/plugin.json',
    '.mcp.json',
    'bin/cdp-supervisor.js',
    'bin/plugin-health.js',
    'rn-dev-agent-core/dist/supervisor.js',
    'rn-dev-agent-core/dist/learned-actions.js',
    'AGENTS-MD-TEMPLATE.md',
    'scripts/collect-feedback.sh',
    'scripts/record_proof.sh',
    'scripts/expo_ensure_running.sh',
    'scripts/eas_resolve_artifact.sh',
    'scripts/check-vercel-rules.mjs',
    'scripts/snapshot_state.sh',
    'scripts/rn-fast-runner/package.json',
    'scripts/rn-android-runner/package.json',
    'templates/rn-agent/.scaffold-version',
    ...WORKFLOW_SKILLS.map((name) => `commands/${name}.md`),
    ...DOMAIN_SKILLS.map((name) => `skills/${name}/SKILL.md`),
    ...WORKFLOW_SKILLS.flatMap((name) => [
      `skills/${name}/SKILL.md`,
      `skills/${name}/agents/openai.yaml`,
    ]),
  ];
  const requiredDirectories = ['templates/rn-agent', 'skills', 'commands', 'scripts'];
  const missing = [
    ...requiredFiles.filter((path) => !realPathUnder(packageRoot, join(packageRoot, path), 'file')),
    ...requiredDirectories.filter(
      (path) => !realPathUnder(packageRoot, join(packageRoot, path), 'directory'),
    ),
  ];
  let status = 'EXACT_HEALTHY';
  if (!manifest || manifest.name !== 'rn-dev-agent' || missing.length > 0) status = 'CORRUPT';
  else if (pluginVersion && manifest.version !== pluginVersion) status = 'VERSION_MISMATCH';
  return { status, packageRoot, version: manifest?.version ?? null, missing };
}

function mcpRegistered(value: unknown): { found: boolean; enabled: boolean } {
  let found = false;
  let enabled = true;
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const object = item as Record<string, unknown>;
    if (object.name === 'cdp' || object.server === 'cdp' || object.id === 'cdp') {
      found = true;
      if (object.enabled === false || object.disabled === true) enabled = false;
    }
    if (Object.prototype.hasOwnProperty.call(object, 'cdp')) {
      found = true;
      const cdp = object.cdp;
      if (cdp && typeof cdp === 'object') {
        const cdpObject = cdp as Record<string, unknown>;
        if (cdpObject.enabled === false || cdpObject.disabled === true) enabled = false;
      }
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === 'object') visit(child);
    }
  };
  visit(value);
  return { found, enabled };
}

function cap(value: string, max = 16_384): string {
  return value.length <= max ? value : value.slice(value.length - max);
}

function redactDiagnostic(value: string, packageRoot: string): string {
  let redacted = value;
  for (const [needle, replacement] of [
    [packageRoot, '<package-root>'],
    [process.env.HOME, '~'],
    [process.env.CODEX_HOME, '<codex-home>'],
  ] as Array<[string | undefined, string]>) {
    if (needle) redacted = redacted.split(needle).join(replacement);
  }
  return redacted
    .replace(/(authorization|token|secret|password)[=:][^\s]+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
}

function redactValue(
  value: unknown,
  packageRoot: string,
  key = '',
): Record<string, unknown> | unknown {
  if (/authorization|token|secret|password/i.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactDiagnostic(value, packageRoot);
  if (Array.isArray(value)) return value.map((child) => redactValue(child, packageRoot));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
      childKey,
      redactValue(child, packageRoot, childKey),
    ]),
  );
}

export function probeMcpContract(packageRoot: string, timeoutMs = 12_000): Promise<ProbeResult> {
  return new Promise((resolveProbe) => {
    const launcher = join(packageRoot, 'bin', 'cdp-supervisor.js');
    const env = { ...process.env };
    for (const name of CONTRACT_PROBE_RUNTIME_OVERRIDES) delete env[name];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(process.execPath, [launcher, '--diagnostic-contract-probe'], {
        cwd: packageRoot,
        env: {
          ...env,
          RN_DEV_AGENT_LOG_LEVEL: 'warn',
          LOG_LEVEL: 'warn',
          RN_AGENT_OBSERVE_AUTOSTART: '0',
          RN_CDP_AUTOCONNECT: '0',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      return resolveProbe({ ok: false, tools: [], stderr: '', error: String(error) });
    }

    let stdout = '';
    let stderr = '';
    let resolved = false;
    let initialized = false;
    let pendingResult: ProbeResult | null = null;
    let shutdownTimer: NodeJS.Timeout | null = null;
    const resolveResult = (result: ProbeResult): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(requestTimer);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      resolveProbe({ ...result, stderr: redactDiagnostic(cap(stderr), packageRoot) });
    };
    const signalOwnedChild = (): void => {
      if (child.exitCode === null && child.pid !== undefined) child.kill('SIGTERM');
    };
    const finish = (result: ProbeResult, timedOut = false): void => {
      if (pendingResult || resolved) return;
      pendingResult = result;
      clearTimeout(requestTimer);
      if (!child.stdin.destroyed) child.stdin.end();
      if (child.exitCode !== null) return resolveResult(result);
      if (timedOut) return signalOwnedChild();
      shutdownTimer = setTimeout(signalOwnedChild, 1_000);
      shutdownTimer.unref();
    };
    const send = (message: unknown): void => child.stdin.write(`${JSON.stringify(message)}\n`);
    const consume = (): void => {
      for (;;) {
        const newline = stdout.indexOf('\n');
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          const result = message.result as {
            tools?: Array<{ name?: string; inputSchema?: unknown }>;
          };
          finish({ ok: Array.isArray(result?.tools), tools: result?.tools ?? [], stderr });
        }
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = cap(stdout + chunk.toString('utf8'), 2 * 1024 * 1024);
      consume();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = cap(stderr + chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      const result = { ok: false, tools: [], stderr, error: error.message };
      if (child.pid === undefined) resolveResult(result);
      else finish(result, true);
    });
    child.on('exit', (code) => {
      resolveResult(
        pendingResult ?? {
          ok: false,
          tools: [],
          stderr,
          error: `launcher exited ${code}`,
        },
      );
    });
    const requestTimer = setTimeout(
      () => finish({ ok: false, tools: [], stderr, error: 'contract probe timed out' }, true),
      timeoutMs,
    );
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'rn-dev-agent-plugin-health', version: '1' },
      },
    });
  });
}

function publishedProofContract(tool: { inputSchema?: unknown } | undefined): {
  actions: string[];
  usableShape: boolean;
} {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== 'object') return { actions: [], usableShape: false };
  const object = schema as Record<string, unknown>;
  const properties = object.properties as Record<string, unknown> | undefined;
  const action = properties?.action as Record<string, unknown> | undefined;
  const actions = Array.isArray(action?.enum)
    ? action.enum.filter((value): value is string => typeof value === 'string')
    : [];
  const required = Array.isArray(object.required) ? object.required : [];
  return {
    actions,
    usableShape: object.type === 'object' && required.includes('action'),
  };
}

export function classifyHealth(
  facts: HealthFacts,
): Pick<HealthReport, 'findings' | 'primaryFinding' | 'nextActions' | 'overall'> {
  const findings: Array<{ code: string; detail: string }> = [];
  const add = (code: string, detail: string): void => {
    if (!findings.some((finding) => finding.code === code)) findings.push({ code, detail });
  };

  if (facts.installation.status === 'MISSING')
    add('MISSING_INSTALLATION', 'Plugin is not installed.');
  else if (facts.installation.status === 'DISABLED')
    add('PLUGIN_DISABLED', 'Plugin is installed but disabled.');
  else if (facts.installation.status === 'AMBIGUOUS')
    add('INSTALLATION_STATE_AMBIGUOUS', 'Codex reported multiple exact plugin rows.');
  else if (facts.installation.status === 'CLI_ERROR')
    add('INSTALLATION_STATE_UNKNOWN', 'Codex plugin inventory failed.');

  if (facts.materialization.status === 'CORRUPT')
    add(
      'CORRUPT_MATERIALIZATION',
      'Required package files are missing or escape the selected package.',
    );
  else if (facts.materialization.status === 'VERSION_MISMATCH')
    add('VERSION_MISMATCH', 'Selected package manifest does not match the enabled plugin version.');

  if (facts.mcpRegistration.status === 'MISSING')
    add('MCP_NOT_REGISTERED', 'Effective Codex MCP config has no cdp server.');
  else if (facts.mcpRegistration.status === 'DISABLED')
    add('MCP_DISABLED', 'Effective cdp server is disabled.');
  else if (facts.mcpRegistration.status === 'UNKNOWN')
    add('MCP_REGISTRATION_UNKNOWN', 'Codex MCP inventory failed.');

  if (facts.mcpContractProbe.status === 'FAILED')
    add(
      'MCP_CONTRACT_PROBE_FAILED',
      'The package launcher could not initialize and list its MCP contract.',
    );

  const directHealthy =
    facts.installation.status === 'ENABLED' &&
    facts.materialization.status === 'EXACT_HEALTHY' &&
    facts.mcpRegistration.status === 'REGISTERED' &&
    facts.mcpContractProbe.status === 'HEALTHY' &&
    facts.directProofSchema.status === 'USABLE';
  const skillAbsent =
    facts.taskSkillInventory.complete && facts.taskSkillInventory.observed.length === 0;
  const mcpAbsent = facts.taskMcpInventory.complete && facts.taskMcpInventory.observed.length === 0;
  const skillIncomplete =
    facts.taskSkillInventory.complete && facts.taskSkillInventory.missing.length > 0;
  const mcpIncomplete =
    facts.taskMcpInventory.complete && facts.taskMcpInventory.missing.length > 0;
  if (directHealthy && skillAbsent && mcpAbsent)
    add(
      'STALE_ACTIVE_TASK_DISCOVERY',
      'Complete active-task inventories contain neither rn-dev-agent skills nor cdp tools.',
    );
  else {
    if (directHealthy && skillIncomplete)
      add(
        'STALE_SKILL_DISCOVERY',
        'Complete active-task skill inventory is missing expected rn-dev-agent skills.',
      );
    if (directHealthy && mcpIncomplete)
      add(
        'STALE_MCP_DISCOVERY',
        'Complete active-task MCP inventory is missing required cdp canaries.',
      );
  }

  if (facts.observedTransport.status === 'closed')
    add('ACTIVE_TRANSPORT_CLOSED', 'A prior active-task MCP call returned transport closure.');
  if (facts.directProofSchema.status === 'UNUSABLE')
    add(
      'SERVER_SCHEMA_EXPOSURE_FAILURE',
      'Direct MCP schema lacks the required proof_capture action contract.',
    );
  else if (facts.hostProofSchema.status === 'empty')
    add(
      'HOST_SCHEMA_EXPOSURE_FAILURE',
      'Direct schema is usable but the caller observed an empty host schema.',
    );
  if (facts.observedAppStatus.status === 'disconnected')
    add(
      'APP_NOT_CONNECTED',
      'A prior structured cdp_status observation reported no app connection.',
    );
  if (facts.hostSupport.status === 'LEGACY_HOST_RESTART_REQUIRED')
    add(
      'LEGACY_HOST_RESTART_REQUIRED',
      'This Codex version has restart-only plugin refresh semantics.',
    );
  else if (facts.hostSupport.status === 'HOST_VERSION_UNKNOWN')
    add('HOST_VERSION_UNKNOWN', 'Codex version could not be classified.');

  const observationsUnknown =
    !facts.taskSkillInventory.complete ||
    !facts.taskMcpInventory.complete ||
    facts.observedTransport.status === 'unknown' ||
    facts.hostProofSchema.status === 'unknown' ||
    facts.observedAppStatus.status === 'unknown';
  if (findings.length === 0 && observationsUnknown)
    add(
      'INDETERMINATE_TASK_STATE',
      'Disk, registration, and contract are healthy; one or more active-task observations are unknown.',
    );
  if (findings.length === 0) add('HEALTHY', 'All requested health axes are healthy.');

  const primaryFinding = findings[0]!.code;
  const nextActions: string[] = [];
  const codes = new Set(findings.map((finding) => finding.code));
  if (codes.has('MISSING_INSTALLATION') || codes.has('PLUGIN_DISABLED')) {
    nextActions.push(
      'Review `codex plugin list --json`, then user-confirm `codex plugin add rn-dev-agent@rn-dev-agent --json`.',
    );
  }
  if (codes.has('INSTALLATION_STATE_AMBIGUOUS') || codes.has('INSTALLATION_STATE_UNKNOWN')) {
    nextActions.push(
      'Inspect `codex plugin list --json`; do not mutate plugin state until exactly one rn-dev-agent@rn-dev-agent row is authoritative.',
    );
  }
  if (
    codes.has('CORRUPT_MATERIALIZATION') ||
    codes.has('VERSION_MISMATCH') ||
    codes.has('MCP_NOT_REGISTERED') ||
    codes.has('MCP_DISABLED') ||
    codes.has('MCP_CONTRACT_PROBE_FAILED')
  ) {
    nextActions.push(
      'User-confirm `codex plugin marketplace upgrade rn-dev-agent`, then `codex plugin add rn-dev-agent@rn-dev-agent --json`.',
    );
  }
  if ([...codes].some((code) => code.startsWith('STALE_'))) {
    nextActions.push(
      'After an external plugin change, exit and relaunch Codex; same-app changes on Codex >= 0.145.0 can refresh on a later turn.',
    );
  }
  if (codes.has('ACTIVE_TRANSPORT_CLOSED'))
    nextActions.push(
      'Exit and relaunch the Codex process that owns the active task, then retry; never kill or signal it automatically.',
    );
  if (codes.has('LEGACY_HOST_RESTART_REQUIRED'))
    nextActions.push(
      'Upgrade Codex to >= 0.145.0 for same-app live refresh, or exit and relaunch this legacy host after plugin changes.',
    );
  if (codes.has('SERVER_SCHEMA_EXPOSURE_FAILURE'))
    nextActions.push(
      'Install a plugin release containing the proof_capture publication fix, then relaunch Codex.',
    );
  if (codes.has('HOST_SCHEMA_EXPOSURE_FAILURE'))
    nextActions.push(
      'Record the Codex/host version and projected schema; report the host conversion defect.',
    );
  if (codes.has('APP_NOT_CONNECTED'))
    nextActions.push(
      'After discovery recovery, run the active `$rn-dev-agent:check-env` or setup workflow to attach the intended app.',
    );
  if (nextActions.length === 0 && primaryFinding === 'INDETERMINATE_TASK_STATE')
    nextActions.push(
      'Run `/mcp verbose`, inspect the skill inventory, and rerun with complete observation flags.',
    );
  if (nextActions.length === 0) nextActions.push('No recovery action required.');

  const overall =
    primaryFinding === 'HEALTHY'
      ? 'healthy'
      : primaryFinding === 'INDETERMINATE_TASK_STATE'
        ? 'indeterminate'
        : 'unhealthy';
  return { findings, primaryFinding, nextActions, overall };
}

export function parseArgs(argv: string[]): ObservationInput {
  const result: ObservationInput = {
    taskSkills: [],
    taskSkillsComplete: false,
    taskMcpTools: [],
    taskMcpComplete: false,
    observedTransport: 'unknown',
    hostProofSchema: 'unknown',
    observedAppStatus: 'unknown',
    json: false,
  };
  const singleton = new Set<string>();
  const readValue = (index: number, flag: string): string => {
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--task-skill') result.taskSkills.push(readValue(i++, arg));
    else if (arg === '--task-mcp-tool') result.taskMcpTools.push(readValue(i++, arg));
    else if (arg === '--task-skills-complete') result.taskSkillsComplete = true;
    else if (arg === '--task-mcp-complete') result.taskMcpComplete = true;
    else if (arg === '--json') result.json = true;
    else if (
      arg === '--observed-transport' ||
      arg === '--host-proof-schema' ||
      arg === '--observed-app-status'
    ) {
      if (singleton.has(arg)) throw new Error(`${arg} may be passed only once`);
      singleton.add(arg);
      const value = readValue(i++, arg);
      if (arg === '--observed-transport' && ['healthy', 'closed', 'unknown'].includes(value))
        result.observedTransport = value as ObservationInput['observedTransport'];
      else if (arg === '--host-proof-schema' && ['usable', 'empty', 'unknown'].includes(value))
        result.hostProofSchema = value as ObservationInput['hostProofSchema'];
      else if (
        arg === '--observed-app-status' &&
        ['connected', 'disconnected', 'unknown'].includes(value)
      )
        result.observedAppStatus = value as ObservationInput['observedAppStatus'];
      else throw new Error(`invalid value for ${arg}: ${value}`);
    } else if (arg === '--help' || arg === '-h') throw new Error('help');
    else throw new Error(`unknown argument: ${arg}`);
  }
  const skillPattern = /^rn-dev-agent:[a-z0-9-]+$/;
  const toolPattern = /^(?:mcp__cdp__)?[a-z][a-z0-9_]*$/;
  if (result.taskSkills.some((name) => !skillPattern.test(name)))
    throw new Error('invalid --task-skill name');
  if (result.taskMcpTools.some((name) => !toolPattern.test(name)))
    throw new Error('invalid --task-mcp-tool name');
  result.taskSkills = [...new Set(result.taskSkills)].sort();
  result.taskMcpTools = [...new Set(result.taskMcpTools)].sort();
  return result;
}

function usage(): string {
  return `Usage: plugin-health [--json] [observations]\n\nObservations (caller supplied; default unknown):\n  --task-skill <rn-dev-agent:name>   repeatable\n  --task-skills-complete\n  --task-mcp-tool <name>             repeatable\n  --task-mcp-complete\n  --observed-transport healthy|closed|unknown\n  --host-proof-schema usable|empty|unknown\n  --observed-app-status connected|disconnected|unknown`;
}

export async function collectHealth(input: ObservationInput): Promise<HealthReport> {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const host = await runText('codex', ['--version']);
  const hostTuple = host.ok ? parseVersion(host.text) : null;
  const floorTuple = parseVersion(LIVE_REFRESH_FLOOR)!;
  const hostSupport = {
    status: hostTuple
      ? atLeast(hostTuple, floorTuple)
        ? 'LIVE_REFRESH_SUPPORTED'
        : 'LEGACY_HOST_RESTART_REQUIRED'
      : 'HOST_VERSION_UNKNOWN',
    version: host.ok ? host.text : null,
    floor: LIVE_REFRESH_FLOOR,
  };

  const pluginList = await runJson('codex', ['plugin', 'list', '--json']);
  const pluginRows = pluginList.ok ? exactPluginRows(pluginList.value) : [];
  const row = pluginRows.length === 1 ? pluginRows[0]! : null;
  const rowVersion = typeof row?.version === 'string' ? row.version : null;
  const disabled = row?.enabled === false || row?.disabled === true || row?.state === 'disabled';
  const installation = {
    status: !pluginList.ok
      ? 'CLI_ERROR'
      : pluginRows.length > 1
        ? 'AMBIGUOUS'
        : !row
          ? 'MISSING'
          : disabled
            ? 'DISABLED'
            : 'ENABLED',
    pluginId: PLUGIN_ID,
    version: rowVersion,
    matches: pluginRows.map((match) => redactValue(match, packageRoot) as Record<string, unknown>),
  };
  const materialization = materializationFacts(packageRoot, rowVersion);

  const mcpList = await runJson('codex', ['mcp', 'list', '--json']);
  const registration = mcpList.ok ? mcpRegistered(mcpList.value) : { found: false, enabled: false };
  const mcpRegistration = {
    status: !mcpList.ok
      ? 'UNKNOWN'
      : !registration.found
        ? 'MISSING'
        : registration.enabled
          ? 'REGISTERED'
          : 'DISABLED',
    server: 'cdp' as const,
  };

  const probe = await probeMcpContract(packageRoot);
  const toolNames = new Set(
    probe.tools.map((tool) => tool.name).filter((name): name is string => Boolean(name)),
  );
  const canaries = Object.fromEntries(MCP_CANARIES.map((name) => [name, toolNames.has(name)]));
  const canariesHealthy = MCP_CANARIES.every((name) => toolNames.has(name));
  const mcpContractProbe = {
    status: probe.ok && canariesHealthy ? 'HEALTHY' : 'FAILED',
    toolCount: probe.ok ? probe.tools.length : null,
    canaries,
    ...(probe.stderr ? { stderr: probe.stderr } : {}),
  };
  const proofTool = probe.tools.find((tool) => tool.name === 'proof_capture');
  const publishedProof = publishedProofContract(proofTool);
  const schemaActions = new Set(publishedProof.actions);
  const directProofSchema = {
    status: !probe.ok
      ? ('UNKNOWN' as const)
      : publishedProof.usableShape && PROOF_ACTIONS.every((action) => schemaActions.has(action))
        ? ('USABLE' as const)
        : ('UNUSABLE' as const),
    actions: publishedProof.actions.sort(),
  };

  const observedSkillSet = new Set(input.taskSkills);
  const observedToolSet = new Set(
    input.taskMcpTools.map((name) => name.replace(/^mcp__cdp__/, '')),
  );
  const taskSkillInventory = {
    status: !input.taskSkillsComplete
      ? 'PARTIAL_OR_UNKNOWN'
      : EXPECTED_SKILLS.every((name) => observedSkillSet.has(name))
        ? 'COMPLETE'
        : input.taskSkills.length === 0
          ? 'ABSENT'
          : 'INCOMPLETE',
    complete: input.taskSkillsComplete,
    observed: input.taskSkills,
    missing: EXPECTED_SKILLS.filter((name) => !observedSkillSet.has(name)),
  };
  const taskMcpInventory = {
    status: !input.taskMcpComplete
      ? 'PARTIAL_OR_UNKNOWN'
      : MCP_CANARIES.every((name) => observedToolSet.has(name))
        ? 'COMPLETE'
        : input.taskMcpTools.length === 0
          ? 'ABSENT'
          : 'INCOMPLETE',
    complete: input.taskMcpComplete,
    observed: input.taskMcpTools,
    missing: MCP_CANARIES.filter((name) => !observedToolSet.has(name)),
  };
  const facts: HealthFacts = {
    hostSupport,
    installation,
    materialization,
    mcpRegistration,
    mcpContractProbe,
    directProofSchema,
    taskSkillInventory,
    taskMcpInventory,
    observedTransport: { status: input.observedTransport, provenance: 'caller' },
    hostProofSchema: { status: input.hostProofSchema, provenance: 'caller' },
    observedAppStatus: { status: input.observedAppStatus, provenance: 'caller' },
  };
  return { ...facts, ...classifyHealth(facts) };
}

async function main(): Promise<void> {
  let input: ObservationInput;
  try {
    input = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(usage());
    if (error instanceof Error && error.message !== 'help')
      console.error(`\nerror: ${error.message}`);
    process.exitCode = error instanceof Error && error.message === 'help' ? 0 : 64;
    return;
  }
  try {
    const report = await collectHealth(input);
    if (input.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`rn-dev-agent Codex health: ${report.primaryFinding}`);
      for (const finding of report.findings) console.log(`- ${finding.code}: ${finding.detail}`);
      console.log('Next actions:');
      for (const action of report.nextActions) console.log(`- ${action}`);
    }
    process.exitCode =
      report.overall === 'healthy' ? 0 : report.overall === 'indeterminate' ? 3 : 2;
  } catch (error) {
    console.error(
      `plugin-health internal error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 70;
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entry === import.meta.url) await main();
