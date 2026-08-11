import { join } from 'node:path';
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

export interface ExperienceTrendReport {
  generatedAt: string;
  since: string;
  families: FamilyTrend[];
  newSincePreviousReport: RecurringTrend[];
  recurring: RecurringTrend[];
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
  };
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
