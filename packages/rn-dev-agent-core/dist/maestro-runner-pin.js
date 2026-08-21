#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { doctorPinnedRunner, getEngineStatus, MAESTRO_RUNNER_PIN, nodePlatformKey, _resetEngineStatusForTest, } from './domain/engine-pin.js';
import { migrateLearnedActions } from './domain/action-engine-compat.js';
const USAGE = 'usage: maestro-runner-pin [diagnose|install|migrate-actions] [--json] [--root <app>]';
function ensureScriptPath() {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
        join(here, '..', '..', '..', 'scripts', 'ensure-maestro-runner.sh'),
        join(here, '..', 'scripts', 'ensure-maestro-runner.sh'),
        join(here, '..', '..', 'scripts', 'ensure-maestro-runner.sh'),
    ];
    return candidates.find((path) => existsSync(path)) ?? candidates[0];
}
async function diagnose(json) {
    _resetEngineStatusForTest();
    const status = await getEngineStatus();
    const report = doctorPinnedRunner(status, nodePlatformKey());
    if (json) {
        console.log(JSON.stringify({ ...report, pin: MAESTRO_RUNNER_PIN.version }, null, 2));
    }
    else {
        console.log(report.ok
            ? `maestro-runner ${report.installedVersion} pinned-ok (${report.provenance}: ${report.selectedPath})`
            : `maestro-runner pin ${report.status}: ${report.correction}`);
    }
    return report.ok ? 0 : 1;
}
function install() {
    const script = ensureScriptPath();
    const result = spawnSync('bash', [script], { stdio: 'inherit' });
    return result.status === 0 ? 0 : 1;
}
function migrate(root, json) {
    const results = migrateLearnedActions(root);
    const failed = results.filter((r) => r.status === 'incompatible' || r.status === 'unreadable');
    if (json) {
        console.log(JSON.stringify({ root, results }, null, 2));
    }
    else {
        for (const row of results) {
            console.log(`${row.status}\t${row.id}${row.reason ? `\t${row.reason}` : ''}`);
        }
    }
    return failed.length === 0 ? 0 : 1;
}
function parseArgs(argv) {
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
}
else if (cmd === 'install') {
    process.exit(install());
}
else if (cmd === 'migrate-actions') {
    process.exit(migrate(root, json));
}
else {
    console.error(USAGE);
    process.exit(2);
}
