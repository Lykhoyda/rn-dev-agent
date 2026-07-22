import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const DIRECT_DEVICE_ID_RE = /^[A-Za-z0-9._:-]{1,256}$/;
// maestro-runner renders the executing device either as a nested object or as a
// bare identifier, and names the identity field differently across its report
// writers. Each list is a precedence order, not a harvest set: one object
// describes one device, so the most authoritative present key wins and `id` is
// the last resort — it also spells model/device-type names ("iPhone-16-Pro").
const DEVICE_ID_KEYS = ['udid', 'deviceId', 'serial'];
// `id` is the last resort ACROSS the whole report, not just within one object:
// mixing an authoritative `udid` from one writer with an `id` from another
// manufactures two identities for a single device.
const WEAK_DEVICE_ID_KEYS = ['id'];
// `id` is deliberately absent here: on a run/flow container it names the run or
// flow, and harvesting it would inject a foreign identity into the evidence set.
const CONTAINER_DEVICE_ID_KEYS = ['udid', 'deviceId', 'deviceSerial'];
function idsFrom(value, keys) {
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
// A bare string carries no key asserting it is an identity, and this writer
// also spells model names there ("iPhone-16-Pro" satisfies DIRECT_DEVICE_ID_RE).
// Treating it as strong made one such writer a permanent mismatch lockout, so
// it joins `id` in the last-resort tier the other two variants already use.
function weakDeviceIdsFrom(value) {
    if (typeof value === 'string')
        return [value];
    return idsFrom(value, WEAK_DEVICE_ID_KEYS);
}
function containerDeviceIdsFrom(value) {
    return idsFrom(value, CONTAINER_DEVICE_ID_KEYS);
}
function reportDeviceIds(reportDir) {
    const reportPath = join(reportDir, 'report.json');
    if (!existsSync(reportPath))
        return { ids: [], strength: 'none' };
    try {
        const report = JSON.parse(readFileSync(reportPath, 'utf8'));
        const flows = Array.isArray(report.flows) ? report.flows : [];
        const devices = [report.device, ...flows.map((flow) => flow?.device)];
        const strong = [
            ...devices.flatMap((device) => deviceIdsFrom(device)),
            ...[report, ...flows].flatMap((container) => containerDeviceIdsFrom(container)),
        ];
        const usingStrong = strong.length > 0;
        const ids = usingStrong ? strong : devices.flatMap((device) => weakDeviceIdsFrom(device));
        const accepted = [
            ...new Set(ids.map((id) => id.trim()).filter((id) => DIRECT_DEVICE_ID_RE.test(id))),
        ];
        return {
            ids: accepted,
            strength: accepted.length === 0 ? 'none' : usingStrong ? 'strong' : 'weak',
        };
    }
    catch {
        return { ids: [], strength: 'none' };
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
        return { output, reportDeviceIds: [], reportDeviceIdStrength: 'none' };
    const report = reportDeviceIds(reportDir);
    const evidence = {
        output,
        reportDeviceIds: report.ids,
        reportDeviceIdStrength: report.strength,
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
