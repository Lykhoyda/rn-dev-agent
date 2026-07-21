import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const DIRECT_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
// maestro-runner renders the executing device either as a nested object or as a
// bare identifier, and names the identity field differently across its report
// writers. Each list is a precedence order, not a harvest set: one object
// describes one device, so the most authoritative present key wins and `id` is
// the last resort — it also spells model/device-type names ("iPhone-16-Pro").
const DEVICE_ID_KEYS = ['udid', 'deviceId', 'serial', 'id'];
// `id` is deliberately absent here: on a run/flow container it names the run or
// flow, and harvesting it would inject a foreign identity into the evidence set.
const CONTAINER_DEVICE_ID_KEYS = ['udid', 'deviceId', 'deviceSerial'];
function idsFrom(value, keys) {
    if (typeof value === 'string')
        return [value];
    if (!value || typeof value !== 'object')
        return [];
    const record = value;
    for (const key of keys) {
        const id = record[key];
        if (typeof id === 'string')
            return [id];
    }
    return [];
}
function deviceIdsFrom(value) {
    return idsFrom(value, DEVICE_ID_KEYS);
}
function containerDeviceIdsFrom(value) {
    if (typeof value === 'string')
        return [];
    return idsFrom(value, CONTAINER_DEVICE_ID_KEYS);
}
function reportDeviceIds(reportDir) {
    const reportPath = join(reportDir, 'report.json');
    if (!existsSync(reportPath))
        return [];
    try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        const flows = Array.isArray(report.flows) ? report.flows : [];
        const ids = [
            ...deviceIdsFrom(report.device),
            ...containerDeviceIdsFrom(report),
            ...flows.flatMap((flow) => [
                ...deviceIdsFrom(flow?.device),
                ...containerDeviceIdsFrom(flow),
            ]),
        ];
        return [...new Set(ids.map((id) => id.trim()).filter((id) => DIRECT_DEVICE_ID_RE.test(id)))];
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
