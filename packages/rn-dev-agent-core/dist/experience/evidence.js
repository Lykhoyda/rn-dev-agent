import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, } from 'node:fs';
import { homedir, platform as hostPlatform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retainRunnerDiagnosticEvents, } from './runner-diagnostics.js';
export const UNKNOWN_CLASSIFICATION = 'UNKNOWN';
export const DEFAULT_MAX_RECORDS = 500;
export const DEFAULT_RETENTION_DAYS = 14;
export const MAX_EVIDENCE_POINTERS = 3;
export const EXPERIENCE_DIRECTORY = join(homedir(), '.claude', 'rn-agent', 'experience');
export const EXPERIENCE_STORE_NAME = 'patterns.jsonl';
export const MAX_SYMPTOM_LENGTH = 2048;
export const RUNNER_DIAGNOSTICS_MAX_BYTES = 256 * 1024;
export const RUNNER_DIAGNOSTICS_RETENTION = 5;
export const RUNNER_DIAGNOSTICS_MAX_SCALAR_CHARS = 1024;
export const OWNED_TEST_APP_BUNDLE_ID = 'com.rndevagent.testapp';
export function configuredExperienceDirectory() {
    return process.env.RN_DEV_AGENT_EXPERIENCE_DIR ?? EXPERIENCE_DIRECTORY;
}
const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTION_FAILED = '[REDACTION_FAILED]';
const SYMPTOM_TRUNCATED = '[TRUNCATED]';
// Keep this list aligned with scripts/collect-feedback.sh. That collector is the
// public sanitization contract; this in-process form exists so private tool
// payloads never have to cross a process boundary.
const REDACTION_RULES = [
    [/(sk|pk|api|key|token|secret|password|auth)[-_]?[A-Za-z0-9_-]{20,}/gi, '[REDACTED_SECRET]'],
    [/Bearer [A-Za-z0-9_./+=-]{20,}/g, 'Bearer [REDACTED]'],
    [/ghp_[A-Za-z0-9_]{36}/g, '[REDACTED_GH_TOKEN]'],
    [/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, '[REDACTED_JWT]'],
    [/AKIA[0-9A-Z]{16}/g, '[REDACTED_AWS]'],
    [/xox[baprs]-[A-Za-z0-9-]+/g, '[REDACTED_SLACK]'],
    [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]'],
    [
        /(^|[^0-9])(192|10|172|169)\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}([^0-9]|$)/g,
        '$1[IP_REDACTED]$3',
    ],
    [/(^|[^0-9])[0-9]{1,3}(?:\.[0-9]{1,3}){3}([^0-9]|$)/g, '$1[IP_REDACTED]$2'],
    [
        /(?:https?:\/\/)?(?:localhost|127\.0\.0\.1)(?::[0-9]{2,5})?(?:\/[^\s]*)?/gi,
        '[LOOPBACK_ENDPOINT_REDACTED]',
    ],
    [/"(metroPort|observePort|port)"\s*:\s*[0-9]+/g, '"$1":"[PORT_REDACTED]"'],
    [/\bport\s*[:=]?\s*[0-9]{2,5}\b/gi, '[PORT_REDACTED]'],
    [/:([0-9]{2,5})(?=\/|\s|$)/g, ':[PORT_REDACTED]'],
    [/~\/[A-Za-z0-9_./-]+/g, '[PATH_REDACTED]'],
    [/\/(Users|home|opt|var|tmp|etc|private|Volumes)\/[A-Za-z0-9_./-]+/g, '[PATH_REDACTED]'],
    [/(com|org|io|dev|net)\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+/g, '[BUNDLE_REDACTED]'],
];
// The shell contract catches keyword-adjacent values. Structured tool errors
// commonly use `token=...`, so retain the same secret vocabulary while also
// handling the separator explicitly.
const KEYED_SECRET = /((?:token|secret|password|auth|api[_-]?key)\s*[:=]\s*)[^\s,;}]{6,}/gi;
// Bump whenever a redaction rule changes: stored records stamped with an older
// version are re-sanitized under the current rules before the next rewrite.
export const REDACTION_RULES_VERSION = 1;
export function sanitizeString(value, redact = applyRedactionRules) {
    try {
        return redact(value);
    }
    catch {
        return REDACTION_FAILED;
    }
}
export function sanitizeForEvidence(value, redact) {
    if (value === null ||
        value === undefined ||
        typeof value === 'boolean' ||
        typeof value === 'number') {
        return value;
    }
    if (typeof value === 'string')
        return sanitizeString(value, redact);
    if (Array.isArray(value))
        return value.map((item) => sanitizeForEvidence(item, redact));
    if (typeof value === 'object') {
        const sanitized = {};
        for (const [key, nested] of Object.entries(value)) {
            sanitized[key] = sanitizeForEvidence(nested, redact);
        }
        return sanitized;
    }
    return REDACTION_FAILED;
}
function applyRedactionRules(value) {
    let result = value.replaceAll(homedir(), '~').replace(KEYED_SECRET, '$1[REDACTED_SECRET]');
    for (const [pattern, replacement] of REDACTION_RULES) {
        pattern.lastIndex = 0;
        result = result.replace(pattern, replacement);
    }
    const identity = readAppIdentity();
    if (identity.name)
        result = result.replaceAll(identity.name, '[APP_NAME_REDACTED]');
    if (identity.slug)
        result = result.replaceAll(identity.slug, '[APP_SLUG_REDACTED]');
    return result;
}
let appIdentityCache = null;
// Mirrors the app.json stage of scripts/collect-feedback.sh. An unreadable
// manifest throws, so sanitizeString fails closed instead of shipping the name.
function readAppIdentity() {
    const root = process.env.RN_PROJECT_ROOT ?? process.env.CLAUDE_USER_CWD ?? process.cwd();
    if (appIdentityCache?.root !== root) {
        appIdentityCache = { root, identity: loadAppIdentity(root) };
    }
    if (appIdentityCache.identity === null) {
        throw new Error('app identity could not be read for redaction');
    }
    return appIdentityCache.identity;
}
function loadAppIdentity(root) {
    const manifest = join(root, 'app.json');
    try {
        if (!existsSync(manifest))
            return { name: null, slug: null };
        const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
        const expo = parsed.expo ?? parsed;
        return { name: usableIdentity(expo?.name), slug: usableIdentity(expo?.slug) };
    }
    catch {
        return null;
    }
}
function usableIdentity(value) {
    return typeof value === 'string' && value.trim().length > 2 ? value : null;
}
export class ExperienceRecorder {
    directory;
    path;
    candidate;
    environment;
    sessionId;
    maxRecords;
    retentionMs;
    now;
    schedule;
    previousFailure = null;
    constructor(options) {
        this.directory = options.directory ?? configuredExperienceDirectory();
        this.path = join(this.directory, EXPERIENCE_STORE_NAME);
        this.candidate = {
            pluginVersion: options.pluginVersion ?? null,
            coreVersion: options.coreVersion,
        };
        this.environment = { os: `${hostPlatform()} ${release()}`, node: process.version };
        this.sessionId =
            options.sessionId === undefined
                ? (process.env.RN_DEV_AGENT_SESSION_ID ?? null)
                : options.sessionId;
        this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
        this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
        this.now = options.now ?? (() => new Date());
        this.schedule = options.schedule ?? ((work) => setImmediate(work));
    }
    /** Queue only: persistence never executes in the observed tool's call stack. */
    observe(event) {
        try {
            this.schedule(() => this.recordNonLoadBearing(event));
        }
        catch {
            /* experience evidence is non-load-bearing */
        }
    }
    /** Test and CLI support; returns a sanitized, deduplicated view. */
    read() {
        return readExperienceStore(this.path);
    }
    recordNonLoadBearing(event) {
        try {
            this.record(event);
        }
        catch {
            /* an unwritable/corrupt store must never affect tool behavior */
        }
    }
    record(event) {
        if (!event || typeof event.tool !== 'string') {
            this.previousFailure = null;
            return;
        }
        if (event.status === 'PASS') {
            const recovery = this.previousFailure;
            this.previousFailure = null;
            if (recovery?.tool === event.tool)
                this.persistRecovery(recovery.signature, event.tool);
            return;
        }
        if (event.status !== 'FAIL' && event.status !== 'ERROR') {
            this.previousFailure = null;
            return;
        }
        this.persistRunnerDiagnostics(event);
        const record = this.buildFailureRecord(event);
        this.persistFailure(record);
        this.previousFailure =
            event.status === 'FAIL' ? { tool: event.tool, signature: record.signature } : null;
    }
    persistRunnerDiagnostics(event) {
        const trace = event.runnerDiagnostics;
        if (!trace || trace.rootTool !== event.tool || trace.events.length === 0)
            return;
        const failure = runnerFailureEnvelope(event);
        if (!failure)
            return;
        const bundle = buildRunnerDiagnosticsBundle({
            event,
            trace,
            failureCode: failure.code,
            candidate: this.candidate,
            environment: this.environment,
            directory: this.directory,
            sessionId: this.sessionId,
        });
        writeRunnerDiagnosticsBundle(this.directory, bundle);
    }
    buildFailureRecord(event) {
        const now = this.now().toISOString();
        const tool = sanitizeString(event.tool);
        const symptom = sanitizeString(boundSymptom(extractSymptom(event)));
        const platform = sanitizeNullable(extractScalar(event, ['platform']));
        const deviceName = extractScalar(event, ['deviceName', 'deviceModel', 'model']);
        const hasDeviceId = extractScalar(event, ['deviceId', 'udid']) !== null;
        const device = sanitizeNullable(deviceName ?? (hasDeviceId ? 'identified-device' : null));
        const runtime = sanitizeNullable(extractScalar(event, ['runtime', 'engine']));
        const classification = classifyExperience(symptom, tool, platform);
        const normalizedSymptomShape = normalizeSymptomShape(symptom);
        const signature = experienceSignature({
            classification,
            tool,
            normalizedSymptomShape,
            platform,
        });
        const unknownReasons = {};
        if (this.candidate.pluginVersion === null) {
            unknownReasons['candidate.pluginVersion'] =
                'plugin manifest was not available to the core runtime';
        }
        if (platform === null)
            unknownReasons.platform = 'tool event did not expose a platform';
        if (device === null)
            unknownReasons.device = 'tool event did not expose a device name or identifier';
        if (runtime === null)
            unknownReasons.runtime = 'tool event did not expose a runtime';
        unknownReasons.maskingCondition = 'not derivable from a single tool event';
        unknownReasons.recovery = 'no immediate successful retry has been observed';
        unknownReasons.cleanup = 'tool events do not report cleanup actions';
        const raw = {
            signature,
            candidate: this.candidate,
            environment: this.environment,
            platform,
            device,
            runtime,
            phase: 'tool',
            trigger: `${event.status} reported by ${tool}`,
            maskingCondition: null,
            symptom,
            recovery: null,
            cleanup: null,
            classification,
            evidencePointers: [`event:${randomUUID()}`],
            tool,
            status: event.status === 'ERROR' ? 'ERROR' : 'FAIL',
            normalizedSymptomShape,
            count: 1,
            recoveryCount: 0,
            firstSeen: now,
            lastSeen: now,
            lastRecoveredAt: null,
            unknownReasons,
            redactionVersion: REDACTION_RULES_VERSION,
        };
        return sanitizeForEvidence(raw);
    }
    persistFailure(incoming) {
        const records = readExperienceStore(this.path);
        const existing = records.find((record) => record.signature === incoming.signature);
        if (existing) {
            existing.count += 1;
            existing.lastSeen = incoming.lastSeen;
            if (incoming.status === 'ERROR' && existing.status !== 'ERROR') {
                existing.status = 'ERROR';
                existing.trigger = incoming.trigger;
            }
            existing.symptom = incoming.symptom;
            existing.candidate = incoming.candidate;
            existing.environment = incoming.environment;
            adoptLateFact(existing, incoming, 'device');
            adoptLateFact(existing, incoming, 'runtime');
            existing.evidencePointers = boundedPointers(existing.evidencePointers, incoming.evidencePointers);
        }
        else {
            records.push(incoming);
        }
        this.write(pruneExperienceRecords(records, this.now(), this.maxRecords, this.retentionMs));
    }
    persistRecovery(signature, tool) {
        const records = readExperienceStore(this.path);
        const existing = records.find((record) => record.signature === signature);
        if (!existing)
            return;
        const now = this.now().toISOString();
        existing.recovery = sanitizeString(`PASS immediately followed FAIL for ${tool}`);
        existing.recoveryCount += 1;
        existing.lastRecoveredAt = now;
        delete existing.unknownReasons.recovery;
        existing.evidencePointers = boundedPointers(existing.evidencePointers, [
            `event:${randomUUID()}`,
        ]);
        this.write(pruneExperienceRecords(records, this.now(), this.maxRecords, this.retentionMs));
    }
    write(records) {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 });
        const temp = join(this.directory, `.${EXPERIENCE_STORE_NAME}.${process.pid}.${randomUUID()}`);
        try {
            const sanitized = records.map((record) => record.redactionVersion === REDACTION_RULES_VERSION
                ? record
                : {
                    ...sanitizeForEvidence(record),
                    redactionVersion: REDACTION_RULES_VERSION,
                });
            const contents = sanitized.map((record) => JSON.stringify(record)).join('\n');
            writeFileSync(temp, contents.length > 0 ? `${contents}\n` : '', {
                encoding: 'utf8',
                flag: 'wx',
                mode: 0o600,
            });
            renameSync(temp, this.path);
            chmodSync(this.path, 0o600);
        }
        catch (error) {
            try {
                unlinkSync(temp);
            }
            catch {
                /* nothing to clean */
            }
            throw error;
        }
    }
}
export function discoverPluginVersion(fromUrl = import.meta.url) {
    if (process.env.RN_DEV_AGENT_PLUGIN_VERSION)
        return process.env.RN_DEV_AGENT_PLUGIN_VERSION;
    const start = dirname(fileURLToPath(fromUrl));
    const candidates = [
        join(start, '..', '..', '.claude-plugin', 'plugin.json'),
        join(start, '..', '..', '.codex-plugin', 'plugin.json'),
        join(start, '..', '..', '..', 'claude-plugin', '.claude-plugin', 'plugin.json'),
        join(start, '..', '..', '..', 'codex-plugin', '.codex-plugin', 'plugin.json'),
    ];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(readFileSync(candidate, 'utf8'));
            if (typeof parsed.version === 'string')
                return sanitizeString(parsed.version);
        }
        catch {
            /* try the next installed/source layout */
        }
    }
    return null;
}
export function readExperienceStore(path) {
    if (!existsSync(path))
        return [];
    const contents = readFileSync(path, 'utf8');
    if (!contents.trim())
        return [];
    const records = [];
    for (const line of contents.split('\n')) {
        if (line.trim().length === 0)
            continue;
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            continue;
        }
        records.push(parsed);
    }
    return records;
}
export function pruneExperienceRecords(records, now, maxRecords = DEFAULT_MAX_RECORDS, retentionMs = DEFAULT_RETENTION_DAYS * DAY_MS) {
    const cutoff = now.getTime() - retentionMs;
    return records
        .filter((record) => {
        const lastSeen = Date.parse(record.lastSeen);
        return Number.isFinite(lastSeen) && lastSeen >= cutoff;
    })
        .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || a.signature.localeCompare(b.signature))
        .slice(0, Math.max(0, maxRecords))
        .sort((a, b) => a.signature.localeCompare(b.signature));
}
export function experienceSignature(input) {
    return createHash('sha256')
        .update(JSON.stringify([
        input.classification,
        input.tool,
        input.normalizedSymptomShape,
        input.platform ?? 'unknown',
    ]))
        .digest('hex');
}
export function normalizeSymptomShape(symptom) {
    return symptom
        .toLowerCase()
        .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
        .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
        .replace(/\b(?=[a-z0-9_-]{12,}\b)(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/gi, '<id>')
        .replace(/\b\d+\b/g, '#')
        .replace(/\s+/g, ' ')
        .trim();
}
const CLASSIFICATION_RULES = [
    ['FF_REDBOX', /redbox|logbox|error overlay|hasredbox/],
    ['FF_DEBUGGER_PAUSED', /debugger paused|ispaused\s*[=:]\s*true|execution (?:is )?halted/],
    [
        'FF_STALE_CDP',
        /websocket (?:close )?1006|target not found|cdp_status.*time(?:d)?out|not connected/,
    ],
    ['FF_FAST_REFRESH_STALE', /fast refresh|ui unchanged|old exports|old module path/],
    ['FF_METRO_CACHE', /metro.*(?:stale|cache)|config change not reflected/],
    [
        'FF_BINARY_MISMATCH',
        /turbomoduleregistry|getenforcing|native module (?:cannot be null|mismatch|not found)/,
    ],
    ['FF_EXPO_DIALOG', /open-in-app|system confirmation dialog/],
    ['FF_DEV_CLIENT_PICKER', /no hermes target|development servers|devclientlauncher|server picker/],
    ['FF_KEYBOARD_OVERLAY', /keyboard.*(?:obscur|behind|cover)|element behind keyboard/],
    ['FF_MAESTRO_GRPC_ANDROID', /unavailable:\s*io exception|androiddriver.*grpc|maestro.*grpc/],
    [
        'FF_ANDROID_TEXT_INPUT_CRASH',
        /(?:text input|mobile_type_keys|adb.*input text).*(?:crash|anr|home screen|disappear)/,
    ],
    ['FF_AUTH_GATE', /(?:stuck|blocked|remains?).*(?:login|welcome|register|auth) (?:screen|route)/],
    [
        'FF_PERMISSION_ALREADY_GRANTED',
        /permission already granted|prompt (?:was )?not shown|flow completes instantly/,
    ],
    ['EG_EXPO_GO_SDK_MISMATCH', /incompatible with this version of expo go|expo go sdk.*mismatch/],
    ['EG_NATIVEWIND_JSX_SOURCE', /nativewind.*jsximportsource|styles.*(?:unstyled|don.t apply)/],
    ['EG_EXPO_GO_NATIVE_MODULES', /expo go.*custom native module/],
    ['EG_DEV_CLIENT_CLEARSTATE', /clearstate.*(?:dev client|metro connection|launcher)/],
    ['EG_MSW_HERMES', /msw.*(?:hermes|react native|initialize)/],
    ['EG_EXPO_ROUTER_DEEP_LINK', /expo router.*deep link|deep link.*confirmation dialog/],
    ['EG_DEV_MENU_INTERFERENCE', /dev menu.*(?:overlay|recording|blocking)/],
    ['EG_NEW_ARCH_CDP_TARGET', /bridgeless.*(?:target|app\.dev)|new architecture.*cdp target/],
    ['PQ_IOS_RECORDVIDEO_CODEC', /simctl recordvideo.*codec.*fail|recordvideo.*h264/],
    ['PQ_ANDROID_SCREENRECORD_LIMIT', /screenrecord.*180|screenrecord.*3 minute/],
    ['PQ_ANDROID_BOOT_DELAY', /sys\.boot_completed|emulator.*grpc.*ready/],
    ['PQ_ANDROID_PLAY_PROTECT', /play protect.*(?:block|apk|install)/],
];
export const EXPERIENCE_FAMILY_IDS = CLASSIFICATION_RULES.map(([id]) => id);
export function classifyExperience(symptom, tool, platform) {
    const haystack = `${tool} ${platform ?? ''} ${symptom}`.toLowerCase();
    return (CLASSIFICATION_RULES.find(([, pattern]) => pattern.test(haystack))?.[0] ??
        UNKNOWN_CLASSIFICATION);
}
function extractSymptom(event) {
    if (typeof event.error === 'string' && event.error.length > 0)
        return event.error;
    if (event.result && typeof event.result === 'object') {
        const envelope = event.result;
        if (typeof envelope.error === 'string')
            return envelope.error;
        const content = envelope.content;
        if (Array.isArray(content)) {
            const first = content[0];
            if (typeof first?.text === 'string')
                return first.text;
        }
    }
    return `${event.tool} reported ${event.status} without an error message`;
}
// Bounding happens before redaction so the regex pass stays linear on huge
// payloads; the trailing partial token goes too, so nothing can survive the cut
// as a half-redacted secret.
function boundSymptom(symptom) {
    if (symptom.length <= MAX_SYMPTOM_LENGTH)
        return symptom;
    const head = symptom.slice(0, MAX_SYMPTOM_LENGTH).replace(/\S+$/, '');
    return `${head}${SYMPTOM_TRUNCATED}`;
}
function extractScalar(event, keys) {
    const sources = [event.params, event.result];
    for (const source of sources) {
        const value = findScalar(source, keys, 0);
        if (value !== null)
            return value;
    }
    return null;
}
function findScalar(value, keys, depth) {
    if (!value || typeof value !== 'object' || depth > 3)
        return null;
    const object = value;
    for (const key of keys) {
        const candidate = object[key];
        if (typeof candidate === 'string' && candidate.length > 0)
            return candidate;
    }
    for (const nested of Object.values(object)) {
        if (nested && typeof nested === 'object') {
            const found = findScalar(nested, keys, depth + 1);
            if (found !== null)
                return found;
        }
    }
    return null;
}
function sanitizeNullable(value) {
    return value === null ? null : sanitizeString(value);
}
function adoptLateFact(existing, incoming, field) {
    if (existing[field] !== null || incoming[field] === null)
        return;
    existing[field] = incoming[field];
    delete existing.unknownReasons[field];
}
function boundedPointers(existing, incoming) {
    return [...new Set([...existing, ...incoming])].slice(-MAX_EVIDENCE_POINTERS);
}
const RUNNER_FAILURE_CODES = new Set([
    'WDA_BOOTSTRAP_FAILED',
    'RUNNER_CACHE_UNAVAILABLE',
    'RUNNER_PIN_CHANGED',
    'RUNNER_OWNERSHIP_MISMATCH',
]);
function runnerFailureEnvelope(event) {
    const envelope = parseResultEnvelope(event.result);
    const code = typeof envelope?.code === 'string' ? envelope.code : null;
    if (code && RUNNER_FAILURE_CODES.has(code))
        return { code };
    const message = event.error ?? '';
    const matched = [...RUNNER_FAILURE_CODES].find((candidate) => message.includes(candidate));
    return matched ? { code: matched } : null;
}
function parseResultEnvelope(value) {
    if (!value || typeof value !== 'object')
        return null;
    const object = value;
    if (typeof object.code === 'string')
        return object;
    const content = object.content;
    if (!Array.isArray(content))
        return object;
    const text = content[0]?.text;
    if (typeof text !== 'string')
        return object;
    try {
        const parsed = JSON.parse(text);
        return parsed && typeof parsed === 'object' ? parsed : object;
    }
    catch {
        return object;
    }
}
function buildRunnerDiagnosticsBundle(input) {
    const envelope = parseResultEnvelope(input.event.result);
    const sources = [input.trace.rootParams, input.event.params, envelope];
    const scalar = (keys) => {
        for (const source of sources) {
            const value = findScalar(source, keys, 0);
            if (value !== null)
                return value;
        }
        return null;
    };
    const deviceId = scalar(['deviceId', 'udid']);
    const bundleId = scalar(['appId', 'bundleId']);
    const payloadEvent = input.trace.events.find((event) => event.type === 'payload-verify');
    const runnerVersion = stringDetail(payloadEvent, 'runnerPinVersion');
    const provenance = stringDetail(payloadEvent, 'provenance');
    const payloadShaPrefix = stringDetail(payloadEvent, 'payloadShaPrefix');
    const metroPort = findNumberInSources(sources, ['metroPort']);
    const actionId = scalar(['actionId']);
    const runtime = scalar(['runtime', 'runtimeVersion', 'osVersion']) ?? input.environment.node;
    const platform = scalar(['platform']);
    const sanitizedEvents = sanitizeForEvidence(input.trace.events);
    return {
        schema: 'rn-dev-agent/runner-diagnostics/1',
        candidate: {
            ...input.candidate,
            releaseCommit: process.env.RN_DEV_AGENT_RELEASE_COMMIT ?? null,
        },
        runner: { version: runnerVersion, provenance, payloadShaPrefix },
        context: {
            platform,
            os: input.environment.os,
            runtime,
            sessionId: input.sessionId,
            actionId,
            deviceIdHash: deviceId ? stableDeviceHash(input.directory, deviceId) : null,
            bundleId: bundleId === null
                ? null
                : bundleId === OWNED_TEST_APP_BUNDLE_ID
                    ? OWNED_TEST_APP_BUNDLE_ID
                    : '[BUNDLE_REDACTED]',
            metroPort,
        },
        failureCode: input.failureCode,
        events: sanitizedEvents,
        truncated: input.trace.truncated,
    };
}
function stringDetail(event, key) {
    const value = event?.detail[key];
    return typeof value === 'string' ? value : null;
}
function findNumberInSources(sources, keys) {
    for (const source of sources) {
        const found = findNumber(source, keys, 0);
        if (found !== null)
            return found;
    }
    return null;
}
function findNumber(value, keys, depth) {
    if (!value || typeof value !== 'object' || depth > 3)
        return null;
    const object = value;
    for (const key of keys) {
        const candidate = object[key];
        if (typeof candidate === 'number' && Number.isSafeInteger(candidate))
            return candidate;
    }
    for (const nested of Object.values(object)) {
        const found = findNumber(nested, keys, depth + 1);
        if (found !== null)
            return found;
    }
    return null;
}
function stableDeviceHash(directory, deviceId) {
    return createHash('sha256')
        .update(readOrCreateRunnerDiagnosticsSalt(directory))
        .update('\0')
        .update(deviceId)
        .digest('hex');
}
function readOrCreateRunnerDiagnosticsSalt(directory) {
    const path = join(directory, '.runner-diagnostics-salt');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
        const existing = readFileSync(path);
        if (existing.length === 32)
            return existing;
    }
    catch { }
    const salt = randomBytes(32);
    try {
        writeFileSync(path, salt, { flag: 'wx', mode: 0o600 });
        return salt;
    }
    catch {
        const raced = readFileSync(path);
        if (raced.length !== 32)
            throw new Error('runner diagnostics salt is invalid');
        return raced;
    }
}
export function writeRunnerDiagnosticsBundle(directory, bundle) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const files = runnerDiagnosticsFiles(directory);
    const nextSequence = files.reduce((maximum, file) => Math.max(maximum, runnerDiagnosticsSequence(file)), 0) + 1;
    const sessionKey = (bundle.context.sessionId ?? 'unknown')
        .slice(0, 64)
        .replace(/[^A-Za-z0-9_-]/g, '-');
    const outputPath = join(directory, `runner-diagnostics-${sessionKey}-${nextSequence}.json`);
    const bounded = boundRunnerDiagnosticsBundle(bundle);
    let serialized = `${JSON.stringify(bounded, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > RUNNER_DIAGNOSTICS_MAX_BYTES) {
        const events = bounded.events;
        let maximum = events.length;
        while (Buffer.byteLength(serialized) > RUNNER_DIAGNOSTICS_MAX_BYTES && maximum > 0) {
            maximum -= 1;
            bounded.events = retainRunnerDiagnosticEvents(events, maximum);
            bounded.truncated = true;
            serialized = `${JSON.stringify(bounded, null, 2)}\n`;
        }
    }
    if (Buffer.byteLength(serialized) > RUNNER_DIAGNOSTICS_MAX_BYTES) {
        throw new Error('Runner diagnostics bundle exceeds the 256 KB limit after truncation.');
    }
    const temporary = join(directory, `.runner-diagnostics.${process.pid}.${randomUUID()}`);
    writeFileSync(temporary, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    renameSync(temporary, outputPath);
    chmodSync(outputPath, 0o600);
    const retained = runnerDiagnosticsFiles(directory)
        .map((file) => ({
        file,
        mtimeMs: statSync(join(directory, file)).mtimeMs,
        sequence: runnerDiagnosticsSequence(file),
    }))
        .sort((left, right) => left.mtimeMs - right.mtimeMs ||
        left.sequence - right.sequence ||
        left.file.localeCompare(right.file));
    for (const stale of retained.slice(0, Math.max(0, retained.length - RUNNER_DIAGNOSTICS_RETENTION))) {
        unlinkSync(join(directory, stale.file));
    }
    return outputPath;
}
function boundRunnerDiagnosticsBundle(bundle) {
    let truncated = bundle.truncated || bundle.events.length > 200;
    const bound = (value) => {
        if (value === null)
            return null;
        const suffix = '[TRUNCATED]';
        let candidate = value;
        if (candidate.length > RUNNER_DIAGNOSTICS_MAX_SCALAR_CHARS) {
            truncated = true;
            candidate = `${candidate.slice(0, RUNNER_DIAGNOSTICS_MAX_SCALAR_CHARS - suffix.length)}${suffix}`;
        }
        const sanitized = sanitizeString(candidate);
        if (sanitized.length <= RUNNER_DIAGNOSTICS_MAX_SCALAR_CHARS)
            return sanitized;
        truncated = true;
        return `${sanitized.slice(0, RUNNER_DIAGNOSTICS_MAX_SCALAR_CHARS - suffix.length)}${suffix}`;
    };
    const events = sanitizeForEvidence(retainRunnerDiagnosticEvents(bundle.events, 200));
    return {
        schema: 'rn-dev-agent/runner-diagnostics/1',
        candidate: {
            pluginVersion: bound(bundle.candidate.pluginVersion),
            coreVersion: bound(bundle.candidate.coreVersion) ?? 'unknown',
            releaseCommit: bound(bundle.candidate.releaseCommit),
        },
        runner: {
            version: bound(bundle.runner.version),
            provenance: bound(bundle.runner.provenance),
            payloadShaPrefix: bound(bundle.runner.payloadShaPrefix),
        },
        context: {
            platform: bound(bundle.context.platform),
            os: bound(bundle.context.os) ?? 'unknown',
            runtime: bound(bundle.context.runtime),
            sessionId: bound(bundle.context.sessionId),
            actionId: bound(bundle.context.actionId),
            deviceIdHash: bound(bundle.context.deviceIdHash),
            bundleId: bundle.context.bundleId === null
                ? null
                : bundle.context.bundleId === OWNED_TEST_APP_BUNDLE_ID
                    ? OWNED_TEST_APP_BUNDLE_ID
                    : '[BUNDLE_REDACTED]',
            metroPort: bundle.context.metroPort,
        },
        failureCode: bound(bundle.failureCode) ?? 'UNKNOWN',
        events,
        truncated,
    };
}
function runnerDiagnosticsFiles(directory) {
    try {
        return readdirSync(directory).filter((file) => /^runner-diagnostics-.+-\d+\.json$/.test(file));
    }
    catch {
        return [];
    }
}
function runnerDiagnosticsSequence(file) {
    const matched = /-(\d+)\.json$/.exec(file);
    return matched ? Number(matched[1]) : 0;
}
export function latestRunnerDiagnosticsPath(sessionId, directory = configuredExperienceDirectory()) {
    if (sessionId.length === 0)
        return null;
    const files = runnerDiagnosticsFiles(directory)
        .map((file) => ({
        file,
        mtimeMs: statSync(join(directory, file)).mtimeMs,
        sequence: runnerDiagnosticsSequence(file),
    }))
        .sort((left, right) => right.mtimeMs - left.mtimeMs ||
        right.sequence - left.sequence ||
        right.file.localeCompare(left.file));
    for (const file of files) {
        const path = join(directory, file.file);
        try {
            const contents = readFileSync(path);
            if (contents.byteLength > RUNNER_DIAGNOSTICS_MAX_BYTES)
                continue;
            const value = JSON.parse(contents.toString('utf8'));
            if (value.schema === 'rn-dev-agent/runner-diagnostics/1' &&
                value.context?.sessionId === sessionId) {
                return path;
            }
        }
        catch { }
    }
    return null;
}
export function exportLatestRunnerDiagnosticsBundle(outputPath, sessionId, directory = configuredExperienceDirectory()) {
    const source = latestRunnerDiagnosticsPath(sessionId, directory);
    if (!source)
        throw new Error('No runner diagnostics bundle is available for the exact session.');
    writeFileSync(outputPath, readFileSync(source), { flag: 'wx', mode: 0o600 });
    chmodSync(outputPath, 0o600);
    return outputPath;
}
