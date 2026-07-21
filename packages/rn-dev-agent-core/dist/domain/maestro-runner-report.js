import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const DIRECT_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
function reportDeviceIds(reportDir) {
    const reportPath = join(reportDir, 'report.json');
    if (!existsSync(reportPath))
        return [];
    try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        const ids = [report.device?.id, ...(report.flows ?? []).map((flow) => flow.device?.id)];
        return [
            ...new Set(ids
                .filter((id) => typeof id === 'string')
                .map((id) => id.trim())
                .filter((id) => DIRECT_DEVICE_ID_RE.test(id))),
        ];
    }
    catch {
        return [];
    }
}
export function createRunnerReportDir(runner, prefix) {
    if (runner !== 'maestro-runner')
        return null;
    return join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}
export function runnerReportArgs(reportDir) {
    return reportDir ? ['--output', reportDir, '--flatten'] : [];
}
export function collectDirectRunnerEvidence(reportDir, output) {
    if (!reportDir)
        return { output, reportDeviceIds: [] };
    const evidence = {
        output,
        reportDeviceIds: reportDeviceIds(reportDir),
    };
    const logPath = join(reportDir, 'maestro-runner.log');
    if (!existsSync(logPath))
        return evidence;
    try {
        evidence.output = `${output}\n${readFileSync(logPath, 'utf8')}`;
    }
    catch {
        // Structured report evidence remains available when the log is unreadable.
    }
    return evidence;
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
