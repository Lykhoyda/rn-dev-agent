import { join } from 'node:path';
import {
  authorityRefusalFacts,
  authorityRefusalFamily,
  authorityRefusalSystemicKey,
  decodeLegacyAuthorityRefusal,
  type AuthorityAxis,
  type AuthorityRefusalCause,
  type AuthorityRefusalCode,
  type AuthorityRefusalFacts,
} from './authority-refusal.js';
import {
  EXPERIENCE_DIRECTORY,
  EXPERIENCE_STORE_NAME,
  readExperienceStore,
  type ExperienceRecord,
} from './evidence.js';

export interface FamilyTrend {
  classification: string;
  count: number;
  patterns: number;
}

export interface RecurringTrend {
  signature: string;
  classification: string;
  tool: string;
  count: number;
  firstSeen: string;
  lastSeen: string;
}

export interface SystemicRefusalTrend {
  systemicKey: string;
  classification: string;
  code: AuthorityRefusalCode;
  axis: AuthorityAxis | null;
  cause: AuthorityRefusalCause | null;
  platform: string | null;
  count: number;
  tools: string[];
  memberSignatures: string[];
  firstSeen: string;
  lastSeen: string;
  recurring: boolean;
  recoveryEvidence: 'not-verified';
  currentAuthorityState: 'unknown';
  scope: 'retained-local-history';
  provenance: Array<'recorded' | 'legacy-derived'>;
}

export interface ExperienceTrendReport {
  generatedAt: string;
  since: string;
  families: FamilyTrend[];
  newSincePreviousReport: RecurringTrend[];
  recurring: RecurringTrend[];
  systemicRefusals: SystemicRefusalTrend[];
}

export function buildExperienceTrendReport(
  records: ExperienceRecord[],
  since: Date,
  now: Date = new Date(),
): ExperienceTrendReport {
  const families = new Map<string, { count: number; patterns: number }>();
  for (const record of records) {
    const aggregate = families.get(record.classification) ?? { count: 0, patterns: 0 };
    aggregate.count += record.count;
    aggregate.patterns += 1;
    families.set(record.classification, aggregate);
  }

  const project = (record: ExperienceRecord): RecurringTrend => ({
    signature: record.signature,
    classification: record.classification,
    tool: record.tool,
    count: record.count,
    firstSeen: record.firstSeen,
    lastSeen: record.lastSeen,
  });
  const sortPatterns = (a: RecurringTrend, b: RecurringTrend) =>
    b.count - a.count ||
    a.classification.localeCompare(b.classification) ||
    a.signature.localeCompare(b.signature);

  return {
    generatedAt: now.toISOString(),
    since: since.toISOString(),
    families: [...families.entries()]
      .map(([classification, value]) => ({ classification, ...value }))
      .sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification)),
    newSincePreviousReport: records
      .filter((record) => Date.parse(record.firstSeen) >= since.getTime())
      .map(project)
      .sort(sortPatterns),
    recurring: records
      .filter((record) => record.count > 1)
      .map(project)
      .sort(sortPatterns),
    systemicRefusals: buildSystemicRefusalTrends(records),
  };
}

function buildSystemicRefusalTrends(records: ExperienceRecord[]): SystemicRefusalTrend[] {
  const groups = new Map<string, SystemicRefusalTrend>();
  for (const record of records) {
    const provenance = Object.hasOwn(record, 'authorityRefusal') ? 'recorded' : 'legacy-derived';
    const facts =
      provenance === 'recorded'
        ? recordedRefusalFacts(record.authorityRefusal)
        : decodeLegacyAuthorityRefusal(record.symptom);
    if (!facts) continue;
    const platform =
      typeof record.platform === 'string' && record.platform.length > 0 ? record.platform : null;
    const systemicKey = authorityRefusalSystemicKey(facts, platform);
    const aggregate = groups.get(systemicKey);
    if (aggregate) {
      aggregate.count += record.count;
      aggregate.tools.push(record.tool);
      aggregate.memberSignatures.push(record.signature);
      aggregate.provenance.push(provenance);
      if (compareTimestamps(record.firstSeen, aggregate.firstSeen) < 0)
        aggregate.firstSeen = record.firstSeen;
      if (compareTimestamps(record.lastSeen, aggregate.lastSeen) > 0)
        aggregate.lastSeen = record.lastSeen;
    } else {
      groups.set(systemicKey, {
        systemicKey,
        classification: authorityRefusalFamily(facts.code),
        ...facts,
        platform,
        count: record.count,
        tools: [record.tool],
        memberSignatures: [record.signature],
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
        recurring: false,
        recoveryEvidence: 'not-verified',
        currentAuthorityState: 'unknown',
        scope: 'retained-local-history',
        provenance: [provenance],
      });
    }
  }
  return [...groups.values()]
    .map((aggregate) => ({
      ...aggregate,
      tools: [...new Set(aggregate.tools)].sort(),
      memberSignatures: [...new Set(aggregate.memberSignatures)].sort(),
      provenance: [...new Set(aggregate.provenance)].sort(),
      recurring: aggregate.count > 1,
    }))
    .sort((a, b) => b.count - a.count || a.systemicKey.localeCompare(b.systemicKey));
}

function recordedRefusalFacts(extension: unknown): AuthorityRefusalFacts | null {
  if (
    !extension ||
    typeof extension !== 'object' ||
    Array.isArray(extension) ||
    !('code' in extension)
  )
    return null;
  return authorityRefusalFacts(
    extension.code,
    'axis' in extension ? extension.axis : null,
    'cause' in extension ? extension.cause : null,
  );
}

function compareTimestamps(a: string, b: string): number {
  return Date.parse(a) - Date.parse(b) || a.localeCompare(b);
}

export function readExperienceTrendReport(options: {
  since: Date;
  directory?: string;
}): ExperienceTrendReport {
  const directory =
    options.directory ?? process.env.RN_DEV_AGENT_EXPERIENCE_DIR ?? EXPERIENCE_DIRECTORY;
  return buildExperienceTrendReport(
    readExperienceStore(join(directory, EXPERIENCE_STORE_NAME)),
    options.since,
  );
}
