import { join } from 'node:path';
import { EXPERIENCE_DIRECTORY, EXPERIENCE_STORE_NAME, readExperienceStore, } from './evidence.js';
export function buildExperienceTrendReport(records, since, now = new Date()) {
    const families = new Map();
    for (const record of records) {
        const aggregate = families.get(record.classification) ?? { count: 0, patterns: 0 };
        aggregate.count += record.count;
        aggregate.patterns += 1;
        families.set(record.classification, aggregate);
    }
    const project = (record) => ({
        signature: record.signature,
        classification: record.classification,
        tool: record.tool,
        count: record.count,
        firstSeen: record.firstSeen,
        lastSeen: record.lastSeen,
    });
    const sortPatterns = (a, b) => b.count - a.count ||
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
export function readExperienceTrendReport(options) {
    const directory = options.directory ?? process.env.RN_DEV_AGENT_EXPERIENCE_DIR ?? EXPERIENCE_DIRECTORY;
    return buildExperienceTrendReport(readExperienceStore(join(directory, EXPERIENCE_STORE_NAME)), options.since);
}
