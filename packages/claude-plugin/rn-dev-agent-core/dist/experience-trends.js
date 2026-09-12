#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/experience/trends.js
import { join as join2 } from "node:path";

// packages/rn-dev-agent-core/dist/experience/authority-refusal.js
import { createHash } from "node:crypto";
var AUTHORITY_REFUSAL_CODES = [
  "SESSION_AUTHORITY_REQUIRED",
  "METRO_ORIGIN_MISMATCH",
  "RUNNER_OWNERSHIP_MISMATCH",
  "HANDOFF_NOT_AUTHORIZED",
  "NON_GIT_MANIFEST_REQUIRED",
  "BUNDLE_HANDSHAKE_UNAVAILABLE"
];
var AUTHORITY_AXES = ["C", "S", "I", "M", "A", "B", "D", "R", "P"];
var REFUSAL_CAUSES = {
  SESSION_AUTHORITY_REQUIRED: [],
  METRO_ORIGIN_MISMATCH: [],
  RUNNER_OWNERSHIP_MISMATCH: [],
  HANDOFF_NOT_AUTHORIZED: [],
  NON_GIT_MANIFEST_REQUIRED: [],
  BUNDLE_HANDSHAKE_UNAVAILABLE: []
};
function isAuthorityRefusalCode(value) {
  return AUTHORITY_REFUSAL_CODES.some((code) => code === value);
}
function authorityRefusalFamily(code) {
  return `FF_${code}`;
}
function authorityRefusalFacts(code, axis, cause) {
  if (!isAuthorityRefusalCode(code))
    return null;
  return {
    code,
    axis: AUTHORITY_AXES.find((candidate) => candidate === axis) ?? null,
    cause: REFUSAL_CAUSES[code].find((candidate) => candidate === cause) ?? null
  };
}
function authorityRefusalSystemicKey(facts, platform) {
  return createHash("sha256").update(JSON.stringify([
    "rn-dev-agent/authority-refusal/1",
    facts.code,
    facts.axis,
    facts.cause,
    platform
  ])).digest("hex");
}

// packages/rn-dev-agent-core/dist/experience/evidence.js
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform as hostPlatform, release } from "node:os";
import { dirname, join } from "node:path";

// packages/rn-dev-agent-core/dist/experience/runner-diagnostics.js
import { AsyncLocalStorage } from "node:async_hooks";
var storage = new AsyncLocalStorage();

// packages/rn-dev-agent-core/dist/experience/evidence.js
var EXPERIENCE_DIRECTORY = join(homedir(), ".claude", "rn-agent", "experience");
var EXPERIENCE_STORE_NAME = "patterns.jsonl";
var MAX_AUTHORITY_ENVELOPE_BYTES = 16 * 1024;
var RUNNER_DIAGNOSTICS_MAX_BYTES = 256 * 1024;
var DAY_MS = 24 * 60 * 60 * 1e3;
function readExperienceStore(path) {
  if (!existsSync(path))
    return [];
  const contents = readFileSync(path, "utf8");
  if (!contents.trim())
    return [];
  const records = [];
  for (const line of contents.split("\n")) {
    if (line.trim().length === 0)
      continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    records.push(parsed);
  }
  return records;
}
var CLASSIFICATION_RULES = [
  ["FF_REDBOX", /redbox|logbox|error overlay|hasredbox/],
  ["FF_DEBUGGER_PAUSED", /debugger paused|ispaused\s*[=:]\s*true|execution (?:is )?halted/],
  [
    "FF_STALE_CDP",
    /websocket (?:close )?1006|target not found|cdp_status.*time(?:d)?out|not connected/
  ],
  ["FF_FAST_REFRESH_STALE", /fast refresh|ui unchanged|old exports|old module path/],
  ["FF_METRO_CACHE", /metro.*(?:stale|cache)|config change not reflected/],
  [
    "FF_BINARY_MISMATCH",
    /turbomoduleregistry|getenforcing|native module (?:cannot be null|mismatch|not found)/
  ],
  ["FF_EXPO_DIALOG", /open-in-app|system confirmation dialog/],
  ["FF_DEV_CLIENT_PICKER", /no hermes target|development servers|devclientlauncher|server picker/],
  ["FF_KEYBOARD_OVERLAY", /keyboard.*(?:obscur|behind|cover)|element behind keyboard/],
  ["FF_MAESTRO_GRPC_ANDROID", /unavailable:\s*io exception|androiddriver.*grpc|maestro.*grpc/],
  [
    "FF_ANDROID_TEXT_INPUT_CRASH",
    /(?:text input|mobile_type_keys|adb.*input text).*(?:crash|anr|home screen|disappear)/
  ],
  ["FF_AUTH_GATE", /(?:stuck|blocked|remains?).*(?:login|welcome|register|auth) (?:screen|route)/],
  [
    "FF_PERMISSION_ALREADY_GRANTED",
    /permission already granted|prompt (?:was )?not shown|flow completes instantly/
  ],
  ["EG_EXPO_GO_SDK_MISMATCH", /incompatible with this version of expo go|expo go sdk.*mismatch/],
  ["EG_NATIVEWIND_JSX_SOURCE", /nativewind.*jsximportsource|styles.*(?:unstyled|don.t apply)/],
  ["EG_EXPO_GO_NATIVE_MODULES", /expo go.*custom native module/],
  ["EG_DEV_CLIENT_CLEARSTATE", /clearstate.*(?:dev client|metro connection|launcher)/],
  ["EG_MSW_HERMES", /msw.*(?:hermes|react native|initialize)/],
  ["EG_EXPO_ROUTER_DEEP_LINK", /expo router.*deep link|deep link.*confirmation dialog/],
  ["EG_DEV_MENU_INTERFERENCE", /dev menu.*(?:overlay|recording|blocking)/],
  ["EG_NEW_ARCH_CDP_TARGET", /bridgeless.*(?:target|app\.dev)|new architecture.*cdp target/],
  ["PQ_IOS_RECORDVIDEO_CODEC", /simctl recordvideo.*codec.*fail|recordvideo.*h264/],
  ["PQ_ANDROID_SCREENRECORD_LIMIT", /screenrecord.*180|screenrecord.*3 minute/],
  ["PQ_ANDROID_BOOT_DELAY", /sys\.boot_completed|emulator.*grpc.*ready/],
  ["PQ_ANDROID_PLAY_PROTECT", /play protect.*(?:block|apk|install)/]
];
var EXPERIENCE_FAMILY_IDS = [
  ...CLASSIFICATION_RULES.map(([id]) => id),
  ...AUTHORITY_REFUSAL_CODES.map(authorityRefusalFamily)
];

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
    recurring: records.filter((record) => record.count > 1).map(project).sort(sortPatterns),
    systemicRefusals: buildSystemicRefusalTrends(records)
  };
}
function buildSystemicRefusalTrends(records) {
  const groups = /* @__PURE__ */ new Map();
  for (const record of records) {
    const extension = record.authorityRefusal;
    if (!extension || typeof extension !== "object" || Array.isArray(extension) || !("code" in extension))
      continue;
    const facts = authorityRefusalFacts(extension.code, "axis" in extension ? extension.axis : null, "cause" in extension ? extension.cause : null);
    if (!facts)
      continue;
    const platform = typeof record.platform === "string" && record.platform.length > 0 ? record.platform : null;
    const systemicKey = authorityRefusalSystemicKey(facts, platform);
    const aggregate = groups.get(systemicKey);
    if (aggregate) {
      aggregate.count += record.count;
      aggregate.tools.push(record.tool);
      aggregate.memberSignatures.push(record.signature);
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
        recoveryEvidence: "not-verified",
        currentAuthorityState: "unknown",
        scope: "retained-local-history",
        provenance: ["recorded"]
      });
    }
  }
  return [...groups.values()].map((aggregate) => ({
    ...aggregate,
    tools: [...new Set(aggregate.tools)].sort(),
    memberSignatures: [...new Set(aggregate.memberSignatures)].sort(),
    recurring: aggregate.count > 1
  })).sort((a, b) => b.count - a.count || a.systemicKey.localeCompare(b.systemicKey));
}
function compareTimestamps(a, b) {
  return Date.parse(a) - Date.parse(b) || a.localeCompare(b);
}
function readExperienceTrendReport(options) {
  const directory = options.directory ?? process.env.RN_DEV_AGENT_EXPERIENCE_DIR ?? EXPERIENCE_DIRECTORY;
  return buildExperienceTrendReport(readExperienceStore(join2(directory, EXPERIENCE_STORE_NAME)), options.since);
}

// packages/rn-dev-agent-core/dist/experience-trends.js
function usage() {
  process.stderr.write("Usage: rn-experience-trends [--since <ISO timestamp>] [--json]\n  --since is the generated-at timestamp printed by the previous report (default: 24 hours ago).\n  --since affects only new-pattern selection.\n  Systemic, family, and recurring totals cover retained local history, not exact time-window counts.\n  Current authority state is unknown; historical observations do not establish a currently blocked session.\n  This command only reads patterns.jsonl in RN_DEV_AGENT_EXPERIENCE_DIR (default: ~/.claude/rn-agent/experience).\n");
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
    process.stdout.write("Systemic, family, and recurring totals cover retained local history, not exact time-window counts.\n--since affects only new-pattern selection.\n");
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
    process.stdout.write("\nSystemic authority refusals (retained local history)\n");
    process.stdout.write("  Current authority state: unknown; historical observations do not establish a currently blocked session.\n");
    if (report.systemicRefusals.length === 0)
      process.stdout.write("  none\n");
    for (const item of report.systemicRefusals) {
      process.stdout.write(`  ${item.code} | axis: ${item.axis ?? "unknown"} | cause: ${item.cause ?? "unknown"} | platform: ${item.platform ?? "unknown"}
    ${item.count} occurrence(s) | tools: ${item.tools.join(", ")} | recurring: ${item.recurring ? "yes" : "no"} | recovery not verified
    first seen: ${item.firstSeen} | last seen: ${item.lastSeen}
`);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`rn-experience-trends: could not read the local evidence store: ${message}
`);
  process.exitCode = 1;
}
