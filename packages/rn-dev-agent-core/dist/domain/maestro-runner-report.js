import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
export function createRunnerReportDir(runner, prefix) {
    if (runner !== 'maestro-runner')
        return null;
    return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
export function runnerReportArgs(reportDir) {
    return reportDir ? ['--output', reportDir, '--flatten'] : [];
}
export function withDirectRunnerEvidence(reportDir, output) {
    if (!reportDir)
        return output;
    const logPath = join(reportDir, 'maestro-runner.log');
    if (!existsSync(logPath))
        return output;
    try {
        return `${output}\n${readFileSync(logPath, 'utf8')}`;
    }
    catch {
        return output;
    }
}
// The report tree is scratch space for direct device/WDA evidence only; keeping it
// would leak one full tree (log, html, json, screenshots) per flow into tmpdir.
export function disposeRunnerReportDir(reportDir) {
    if (!reportDir)
        return;
    try {
        rmSync(reportDir, { recursive: true, force: true });
    }
    catch {
        // Best effort: a stale tmp tree must never fail a flow.
    }
}
