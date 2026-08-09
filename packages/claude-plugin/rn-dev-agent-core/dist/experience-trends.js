#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/experience/trends.js
import { join as join2 } from "node:path";

// packages/rn-dev-agent-core/dist/experience/evidence.js
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform as hostPlatform, release } from "node:os";
import { dirname, join } from "node:path";
var EXPERIENCE_DIRECTORY = join(homedir(), ".claude", "rn-agent", "experience");
var EXPERIENCE_STORE_NAME = "patterns.jsonl";
var DAY_MS = 24 * 60 * 60 * 1e3;
function readExperienceStore(path, allowMissing = false) {
  if (!existsSync(path)) {
    if (allowMissing)
      return [];
    return [];
  }
  const contents = readFileSync(path, "utf8");
  if (!contents.trim())
    return [];
  return contents.split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
}

// packages/rn-dev-agent-core/dist/experience/trends.js
function buildExperienceTrendReport(records, since2, now = /* @__PURE__ */ new Date()) {
  const families = /* @__PURE__ */ new Map();
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
    lastSeen: record.lastSeen
  });
  const sortPatterns = (a, b) => b.count - a.count || a.classification.localeCompare(b.classification) || a.signature.localeCompare(b.signature);
  return {
    generatedAt: now.toISOString(),
    since: since2.toISOString(),
    families: [...families.entries()].map(([classification, value]) => ({ classification, ...value })).sort((a, b) => b.count - a.count || a.classification.localeCompare(b.classification)),
    newSincePreviousReport: records.filter((record) => Date.parse(record.firstSeen) >= since2.getTime()).map(project).sort(sortPatterns),
    recurring: records.filter((record) => record.count > 1).map(project).sort(sortPatterns)
  };
}
function readExperienceTrendReport(options) {
  const directory = options.directory ?? process.env.RN_DEV_AGENT_EXPERIENCE_DIR ?? EXPERIENCE_DIRECTORY;
  return buildExperienceTrendReport(readExperienceStore(join2(directory, EXPERIENCE_STORE_NAME)), options.since);
}

// packages/rn-dev-agent-core/dist/experience-trends.js
function usage() {
  process.stderr.write("Usage: rn-experience-trends [--since <ISO timestamp>] [--json]\n  --since is the generated-at timestamp printed by the previous report (default: 24 hours ago).\n  This command only reads ~/.claude/rn-agent/experience/patterns.jsonl.\n");
  process.exit(2);
}
var since = new Date(Date.now() - 24 * 60 * 60 * 1e3);
var json = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === "--json") {
    json = true;
  } else if (argument === "--since") {
    const value = process.argv[++index];
    const parsed = value ? new Date(value) : new Date(Number.NaN);
    if (!Number.isFinite(parsed.getTime()))
      usage();
    since = parsed;
  } else if (argument === "--help" || argument === "-h") {
    usage();
  } else {
    usage();
  }
}
try {
  const report = readExperienceTrendReport({ since });
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}
`);
  } else {
    process.stdout.write(`Experience trends (new since ${report.since})
`);
    process.stdout.write(`Report generated at ${report.generatedAt}; pass this value to --since next time.
`);
    process.stdout.write("\nFamilies by frequency\n");
    if (report.families.length === 0)
      process.stdout.write("  none\n");
    for (const family of report.families) {
      process.stdout.write(`  ${family.classification}: ${family.count} occurrence(s), ${family.patterns} pattern(s)
`);
    }
    process.stdout.write("\nNew since previous report\n");
    if (report.newSincePreviousReport.length === 0)
      process.stdout.write("  none\n");
    for (const item of report.newSincePreviousReport) {
      process.stdout.write(`  ${item.classification} ${item.tool}: ${item.count} (${item.signature.slice(0, 12)})
`);
    }
    process.stdout.write("\nRecurring\n");
    if (report.recurring.length === 0)
      process.stdout.write("  none\n");
    for (const item of report.recurring) {
      process.stdout.write(`  ${item.classification} ${item.tool}: ${item.count} (${item.signature.slice(0, 12)})
`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`rn-experience-trends: could not read the local evidence store: ${message}
`);
  process.exitCode = 1;
}
