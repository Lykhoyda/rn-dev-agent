#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  doctorPinnedRunner,
  exactPinRefusal,
  getEngineStatus,
  MAESTRO_RUNNER_PIN,
  nodePlatformKey,
  _resetEngineStatusForTest,
} from './domain/engine-pin.js';
import { migrateLearnedActions } from './domain/action-engine-compat.js';
import { classifyLearnedActionPath } from './domain/action-engine-compat.js';
import { prepareActionVerificationSuite } from './domain/action-verification-suite.js';
import { openReadableActionLoadContext } from './domain/action-store.js';
import { filterWithBoundedRegex } from './domain/bounded-regex.js';
import { createMaestroRunHandler } from './tools/maestro-run.js';

const USAGE =
  'usage: maestro-runner-pin [diagnose|install|migrate-actions|verify-actions] [--json] [--root <app>]';

function ensureScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', '..', '..', 'scripts', 'ensure-maestro-runner.sh'),
    join(here, '..', 'scripts', 'ensure-maestro-runner.sh'),
    join(here, '..', '..', 'scripts', 'ensure-maestro-runner.sh'),
  ];
  return candidates.find((path) => existsSync(path)) ?? candidates[0];
}

async function diagnose(json: boolean): Promise<number> {
  _resetEngineStatusForTest();
  const status = await getEngineStatus();
  const report = doctorPinnedRunner(status, nodePlatformKey());
  if (json) {
    console.log(JSON.stringify({ ...report, pin: MAESTRO_RUNNER_PIN.version }, null, 2));
  } else {
    console.log(
      report.ok
        ? `maestro-runner ${report.installedVersion} pinned-ok (${report.provenance}: ${report.selectedPath})`
        : `maestro-runner pin ${report.status}: ${report.correction}`,
    );
  }
  return report.ok ? 0 : 1;
}

function install(): number {
  const script = ensureScriptPath();
  const result = spawnSync('bash', [script], { stdio: 'inherit' });
  return result.status === 0 ? 0 : 1;
}

function migrate(root: string, json: boolean): number {
  const results = migrateLearnedActions(root);
  const failed = results.filter((r) => r.status === 'incompatible' || r.status === 'unreadable');
  if (json) {
    console.log(JSON.stringify({ root, results }, null, 2));
  } else {
    for (const row of results) {
      console.log(`${row.status}\t${row.id}${row.reason ? `\t${row.reason}` : ''}`);
    }
  }
  return failed.length === 0 ? 0 : 1;
}

async function verifyActions(argv: string[]): Promise<number> {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const platform = valueAfter('--platform');
  const flowDirArg = valueAfter('--flow-dir');
  const pattern = valueAfter('--pattern');
  const timeout = Number(valueAfter('--timeout') ?? '120000');
  const stopOnFailure = argv.includes('--stop-on-failure');
  if ((platform !== 'ios' && platform !== 'android') || !flowDirArg) {
    console.error('verify-actions requires --platform ios|android and --flow-dir <directory>');
    return 2;
  }
  if (!Number.isInteger(timeout) || timeout < 5000 || timeout > 300000) {
    console.error('verify-actions --timeout must be an integer from 5000 to 300000');
    return 2;
  }
  if (pattern) {
    if (pattern.length > 256) {
      console.error('verify-actions --pattern must be at most 256 characters');
      return 2;
    }
  }
  const flowDir = resolve(flowDirArg);
  const flowDirClassification = classifyLearnedActionPath(join(flowDir, '__action__.yaml'));
  if (flowDirClassification !== 'action') {
    console.error(
      `Refusing to execute flows outside an owned .rn-agent/actions corpus: ${flowDir}.`,
    );
    return 2;
  }
  _resetEngineStatusForTest();
  const engineStatus = await getEngineStatus();
  const pinRefusal = exactPinRefusal(engineStatus);
  if (pinRefusal) {
    console.error(pinRefusal);
    return 2;
  }
  let files: string[];
  let actionContext: NonNullable<ReturnType<typeof openReadableActionLoadContext>>;
  try {
    const openedContext = openReadableActionLoadContext(dirname(dirname(flowDir)));
    if (!openedContext) throw new Error(`No learned-action corpus found at ${flowDir}`);
    actionContext = openedContext;
    const yamlFiles = actionContext.files.filter((file) => /\.ya?ml$/i.test(file));
    const filtered = pattern
      ? await filterWithBoundedRegex(yamlFiles, pattern)
      : { ok: true as const, matches: yamlFiles };
    if (!filtered.ok) {
      console.error(`verify-actions pattern is ${filtered.reason}: ${filtered.message}`);
      return 2;
    }
    files = filtered.matches.map((file) => join(flowDir, file)).sort();
  } catch (err) {
    console.error(`verify-actions could not read ${flowDir}: ${String(err)}`);
    return 2;
  }
  if (files.length === 0) {
    console.error(`No Maestro flows found in ${flowDir}`);
    return 2;
  }

  const suite = prepareActionVerificationSuite(files, flowDir, engineStatus, actionContext);
  if (suite.errors.length > 0) {
    console.error(
      `Suite preflight refused ${suite.errors.length} of ${files.length} flows before execution.`,
    );
    for (const row of suite.errors) console.error(`  FAIL  ${row.file}: ${row.error}`);
    return 1;
  }

  console.log('rn-verify — Maestro E2E Regression Suite');
  console.log(`Platform:  ${platform}`);
  console.log(`Flow dir:  ${flowDir}`);
  console.log(`Flows:     ${files.length}`);
  console.log(`Timeout:   ${timeout}ms per flow`);
  const run = createMaestroRunHandler();
  let passed = 0;
  let failed = 0;
  for (const flow of suite.prepared) {
    const startedAt = Date.now();
    const result = await run({
      platform,
      inlineYaml: flow.inlineYaml,
      actionMetadata: flow.actionMetadata,
      timeoutMs: timeout,
    });
    const envelope = JSON.parse(result.content[0]!.text) as {
      ok: boolean;
      error?: string;
      data?: { passed?: boolean };
    };
    const ok = envelope.ok && envelope.data?.passed !== false;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${flow.file.split('/').pop()}  (${Date.now() - startedAt}ms)`,
    );
    if (ok) passed += 1;
    else {
      failed += 1;
      if (envelope.error) console.error(`    ${envelope.error}`);
      if (stopOnFailure) break;
    }
  }
  console.log(`Results: ${passed} passed, ${failed} failed (${files.length} total)`);
  return failed === 0 ? 0 : 1;
}

function parseArgs(argv: string[]): {
  cmd: string;
  json: boolean;
  root: string;
} {
  const json = argv.includes('--json');
  const rootIdx = argv.indexOf('--root');
  const root = rootIdx >= 0 ? (argv[rootIdx + 1] ?? process.cwd()) : process.cwd();
  const positional = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--root');
  const cmd = positional[0] ?? 'diagnose';
  return { cmd, json, root };
}

const { cmd, json, root } = parseArgs(process.argv.slice(2));
if (cmd === 'diagnose') {
  process.exit(await diagnose(json));
} else if (cmd === 'install') {
  process.exit(install());
} else if (cmd === 'migrate-actions') {
  process.exit(migrate(root, json));
} else if (cmd === 'verify-actions') {
  process.exit(await verifyActions(process.argv.slice(2)));
} else {
  console.error(USAGE);
  process.exit(2);
}
