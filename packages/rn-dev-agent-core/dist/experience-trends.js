#!/usr/bin/env node
import { readExperienceTrendReport } from './experience/trends.js';
function usage() {
    process.stderr.write('Usage: rn-experience-trends [--since <ISO timestamp>] [--json]\n' +
        '  --since is the generated-at timestamp printed by the previous report (default: 24 hours ago).\n' +
        '  This command only reads ~/.claude/rn-agent/experience/patterns.jsonl.\n');
    process.exit(2);
}
let since = new Date(Date.now() - 24 * 60 * 60 * 1000);
let json = false;
for (let index = 2; index < process.argv.length; index += 1) {
    const argument = process.argv[index];
    if (argument === '--json') {
        json = true;
    }
    else if (argument === '--since') {
        const value = process.argv[++index];
        const parsed = value ? new Date(value) : new Date(Number.NaN);
        if (!Number.isFinite(parsed.getTime()))
            usage();
        since = parsed;
    }
    else if (argument === '--help' || argument === '-h') {
        usage();
    }
    else {
        usage();
    }
}
try {
    const report = readExperienceTrendReport({ since });
    if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
    else {
        process.stdout.write(`Experience trends (new since ${report.since})\n`);
        process.stdout.write(`Report generated at ${report.generatedAt}; pass this value to --since next time.\n`);
        process.stdout.write('\nFamilies by frequency\n');
        if (report.families.length === 0)
            process.stdout.write('  none\n');
        for (const family of report.families) {
            process.stdout.write(`  ${family.classification}: ${family.count} occurrence(s), ${family.patterns} pattern(s)\n`);
        }
        process.stdout.write('\nNew since previous report\n');
        if (report.newSincePreviousReport.length === 0)
            process.stdout.write('  none\n');
        for (const item of report.newSincePreviousReport) {
            process.stdout.write(`  ${item.classification} ${item.tool}: ${item.count} (${item.signature.slice(0, 12)})\n`);
        }
        process.stdout.write('\nRecurring\n');
        if (report.recurring.length === 0)
            process.stdout.write('  none\n');
        for (const item of report.recurring) {
            process.stdout.write(`  ${item.classification} ${item.tool}: ${item.count} (${item.signature.slice(0, 12)})\n`);
        }
    }
}
catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`rn-experience-trends: could not read the local evidence store: ${message}\n`);
    process.exitCode = 1;
}
