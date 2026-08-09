import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform as hostPlatform, release } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ToolObserverInput } from '../observability/instrumentation.js';

export const UNKNOWN_CLASSIFICATION = 'UNKNOWN';
export const DEFAULT_MAX_RECORDS = 500;
export const DEFAULT_RETENTION_DAYS = 14;
export const MAX_EVIDENCE_POINTERS = 3;
export const EXPERIENCE_DIRECTORY = join(homedir(), '.claude', 'rn-agent', 'experience');
export const EXPERIENCE_STORE_NAME = 'patterns.jsonl';

const DAY_MS = 24 * 60 * 60 * 1000;
const REDACTION_FAILED = '[REDACTION_FAILED]';

// Keep this list aligned with scripts/collect-feedback.sh. That collector is the
// public sanitization contract; this in-process form exists so private tool
// payloads never have to cross a process boundary.
const REDACTION_RULES: ReadonlyArray<[RegExp, string]> = [
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

export type RedactString = (value: string) => string;

export function sanitizeString(value: string, redact: RedactString = applyRedactionRules): string {
  try {
    return redact(value);
  } catch {
    return REDACTION_FAILED;
  }
}

export function sanitizeForEvidence(value: unknown, redact?: RedactString): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (typeof value === 'string') return sanitizeString(value, redact);
  if (Array.isArray(value)) return value.map((item) => sanitizeForEvidence(item, redact));
  if (typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeForEvidence(nested, redact);
    }
    return sanitized;
  }
  return REDACTION_FAILED;
}

function applyRedactionRules(value: string): string {
  let result = value.replaceAll(homedir(), '~').replace(KEYED_SECRET, '$1[REDACTED_SECRET]');
  for (const [pattern, replacement] of REDACTION_RULES) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

interface Candidate {
  pluginVersion: string | null;
  coreVersion: string;
}

interface Environment {
  os: string;
  node: string;
}

export interface ExperienceRecord {
  signature: string;
  candidate: Candidate;
  environment: Environment;
  platform: string | null;
  device: string | null;
  runtime: string | null;
  phase: 'tool';
  trigger: string;
  maskingCondition: string | null;
  symptom: string;
  recovery: string | null;
  cleanup: string | null;
  classification: string;
  evidencePointers: string[];
  tool: string;
  status: 'FAIL' | 'ERROR';
  normalizedSymptomShape: string;
  count: number;
  recoveryCount: number;
  firstSeen: string;
  lastSeen: string;
  lastRecoveredAt: string | null;
  unknownReasons: Record<string, string>;
}

export interface ExperienceStoreOptions {
  directory?: string;
  coreVersion: string;
  pluginVersion?: string | null;
  maxRecords?: number;
  retentionDays?: number;
  now?: () => Date;
  schedule?: (work: () => void) => void;
}

export class ExperienceRecorder {
  private readonly directory: string;
  private readonly path: string;
  private readonly candidate: Candidate;
  private readonly environment: Environment;
  private readonly maxRecords: number;
  private readonly retentionMs: number;
  private readonly now: () => Date;
  private readonly schedule: (work: () => void) => void;
  private previousFailure: { tool: string; signature: string } | null = null;

  constructor(options: ExperienceStoreOptions) {
    this.directory =
      options.directory ?? process.env.RN_DEV_AGENT_EXPERIENCE_DIR ?? EXPERIENCE_DIRECTORY;
    this.path = join(this.directory, EXPERIENCE_STORE_NAME);
    this.candidate = {
      pluginVersion: options.pluginVersion ?? null,
      coreVersion: options.coreVersion,
    };
    this.environment = { os: `${hostPlatform()} ${release()}`, node: process.version };
    this.maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    this.retentionMs = (options.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? ((work) => setImmediate(work));
  }

  /** Queue only: persistence never executes in the observed tool's call stack. */
  observe(event: ToolObserverInput): void {
    try {
      this.schedule(() => this.recordNonLoadBearing(event));
    } catch {
      /* experience evidence is non-load-bearing */
    }
  }

  /** Test and CLI support; returns a sanitized, deduplicated view. */
  read(): ExperienceRecord[] {
    return readExperienceStore(this.path);
  }

  private recordNonLoadBearing(event: ToolObserverInput): void {
    try {
      this.record(event);
    } catch {
      /* an unwritable/corrupt store must never affect tool behavior */
    }
  }

  private record(event: ToolObserverInput): void {
    if (!event || typeof event.tool !== 'string') {
      this.previousFailure = null;
      return;
    }

    if (event.status === 'PASS') {
      const recovery = this.previousFailure;
      this.previousFailure = null;
      if (recovery?.tool === event.tool) this.persistRecovery(recovery.signature, event.tool);
      return;
    }

    if (event.status !== 'FAIL' && event.status !== 'ERROR') {
      this.previousFailure = null;
      return;
    }

    const record = this.buildFailureRecord(event);
    this.persistFailure(record);
    this.previousFailure =
      event.status === 'FAIL' ? { tool: event.tool, signature: record.signature } : null;
  }

  private buildFailureRecord(event: ToolObserverInput): ExperienceRecord {
    const now = this.now().toISOString();
    const tool = sanitizeString(event.tool);
    const symptom = sanitizeString(extractSymptom(event));
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
    const unknownReasons: Record<string, string> = {};
    if (this.candidate.pluginVersion === null) {
      unknownReasons['candidate.pluginVersion'] =
        'plugin manifest was not available to the core runtime';
    }
    if (platform === null) unknownReasons.platform = 'tool event did not expose a platform';
    if (device === null)
      unknownReasons.device = 'tool event did not expose a device name or identifier';
    if (runtime === null) unknownReasons.runtime = 'tool event did not expose a runtime';
    unknownReasons.maskingCondition = 'not derivable from a single tool event';
    unknownReasons.recovery = 'no immediate successful retry has been observed';
    unknownReasons.cleanup = 'tool events do not report cleanup actions';

    const raw: ExperienceRecord = {
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
    };
    return sanitizeForEvidence(raw) as ExperienceRecord;
  }

  private persistFailure(incoming: ExperienceRecord): void {
    const records = readExperienceStore(this.path, true);
    const existing = records.find((record) => record.signature === incoming.signature);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = incoming.lastSeen;
      existing.status = incoming.status;
      existing.symptom = incoming.symptom;
      existing.candidate = incoming.candidate;
      existing.environment = incoming.environment;
      existing.evidencePointers = boundedPointers(
        existing.evidencePointers,
        incoming.evidencePointers,
      );
    } else {
      records.push(incoming);
    }
    this.write(pruneExperienceRecords(records, this.now(), this.maxRecords, this.retentionMs));
  }

  private persistRecovery(signature: string, tool: string): void {
    const records = readExperienceStore(this.path, true);
    const existing = records.find((record) => record.signature === signature);
    if (!existing) return;
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

  private write(records: ExperienceRecord[]): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temp = join(this.directory, `.${EXPERIENCE_STORE_NAME}.${process.pid}.${randomUUID()}`);
    try {
      const sanitized = records.map((record) => sanitizeForEvidence(record) as ExperienceRecord);
      const contents = sanitized.map((record) => JSON.stringify(record)).join('\n');
      writeFileSync(temp, contents.length > 0 ? `${contents}\n` : '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(temp, this.path);
      chmodSync(this.path, 0o600);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        /* nothing to clean */
      }
      throw error;
    }
  }
}

export function discoverPluginVersion(fromUrl: string = import.meta.url): string | null {
  if (process.env.RN_DEV_AGENT_PLUGIN_VERSION) return process.env.RN_DEV_AGENT_PLUGIN_VERSION;
  const start = dirname(fileURLToPath(fromUrl));
  const candidates = [
    join(start, '..', '..', '.claude-plugin', 'plugin.json'),
    join(start, '..', '..', '.codex-plugin', 'plugin.json'),
    join(start, '..', '..', '..', 'claude-plugin', '.claude-plugin', 'plugin.json'),
    join(start, '..', '..', '..', 'codex-plugin', '.codex-plugin', 'plugin.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string') return sanitizeString(parsed.version);
    } catch {
      /* try the next installed/source layout */
    }
  }
  return null;
}

export function readExperienceStore(path: string, allowMissing = false): ExperienceRecord[] {
  if (!existsSync(path)) {
    if (allowMissing) return [];
    return [];
  }
  const contents = readFileSync(path, 'utf8');
  if (!contents.trim()) return [];
  return contents
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ExperienceRecord);
}

export function pruneExperienceRecords(
  records: ExperienceRecord[],
  now: Date,
  maxRecords = DEFAULT_MAX_RECORDS,
  retentionMs = DEFAULT_RETENTION_DAYS * DAY_MS,
): ExperienceRecord[] {
  const cutoff = now.getTime() - retentionMs;
  return records
    .filter((record) => {
      const lastSeen = Date.parse(record.lastSeen);
      return Number.isFinite(lastSeen) && lastSeen >= cutoff;
    })
    .sort(
      (a, b) =>
        Date.parse(b.lastSeen) - Date.parse(a.lastSeen) || a.signature.localeCompare(b.signature),
    )
    .slice(0, Math.max(0, maxRecords))
    .sort((a, b) => a.signature.localeCompare(b.signature));
}

export function experienceSignature(input: {
  classification: string;
  tool: string;
  normalizedSymptomShape: string;
  platform: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.classification,
        input.tool,
        input.normalizedSymptomShape,
        input.platform ?? 'unknown',
      ]),
    )
    .digest('hex');
}

export function normalizeSymptomShape(symptom: string): string {
  return symptom
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<id>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[a-z0-9_-]{12,}\b)(?=[a-z0-9_-]*\d)[a-z0-9_-]+\b/gi, '<id>')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function classifyExperience(symptom: string, tool: string, platform: string | null): string {
  const haystack = `${tool} ${platform ?? ''} ${symptom}`.toLowerCase();
  const rules: ReadonlyArray<[string, RegExp]> = [
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
    [
      'FF_DEV_CLIENT_PICKER',
      /no hermes target|development servers|devclientlauncher|server picker/,
    ],
    ['FF_KEYBOARD_OVERLAY', /keyboard.*(?:obscur|behind|cover)|element behind keyboard/],
    ['FF_MAESTRO_GRPC_ANDROID', /unavailable:\s*io exception|androiddriver.*grpc|maestro.*grpc/],
    [
      'FF_ANDROID_TEXT_INPUT_CRASH',
      /(?:text input|mobile_type_keys|adb.*input text).*(?:crash|anr|home screen|disappear)/,
    ],
    [
      'FF_AUTH_GATE',
      /(?:stuck|blocked|remains?).*(?:login|welcome|register|auth) (?:screen|route)/,
    ],
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
  return rules.find(([, pattern]) => pattern.test(haystack))?.[0] ?? UNKNOWN_CLASSIFICATION;
}

function extractSymptom(event: ToolObserverInput): string {
  if (typeof event.error === 'string' && event.error.length > 0) return event.error;
  if (event.result && typeof event.result === 'object') {
    const envelope = event.result as Record<string, unknown>;
    if (typeof envelope.error === 'string') return envelope.error;
    const content = envelope.content;
    if (Array.isArray(content)) {
      const first = content[0] as Record<string, unknown> | undefined;
      if (typeof first?.text === 'string') return first.text;
    }
  }
  return `${event.tool} reported ${event.status} without an error message`;
}

function extractScalar(event: ToolObserverInput, keys: string[]): string | null {
  const sources: unknown[] = [event.params, event.result];
  for (const source of sources) {
    const value = findScalar(source, keys, 0);
    if (value !== null) return value;
  }
  return null;
}

function findScalar(value: unknown, keys: string[], depth: number): string | null {
  if (!value || typeof value !== 'object' || depth > 3) return null;
  const object = value as Record<string, unknown>;
  for (const key of keys) {
    const candidate = object[key];
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  for (const nested of Object.values(object)) {
    if (nested && typeof nested === 'object') {
      const found = findScalar(nested, keys, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function sanitizeNullable(value: string | null): string | null {
  return value === null ? null : sanitizeString(value);
}

function boundedPointers(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])].slice(-MAX_EVIDENCE_POINTERS);
}
