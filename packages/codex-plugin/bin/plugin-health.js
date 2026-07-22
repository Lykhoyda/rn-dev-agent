#!/usr/bin/env node

// packages/codex-plugin/src/plugin-health.ts
import { spawn, execFile } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
var LIVE_REFRESH_FLOOR = "0.145.0";
var PLUGIN_ID = "rn-dev-agent@rn-dev-agent";
var WORKFLOW_SKILLS = [
  "build-and-test",
  "check-env",
  "check-vercel-rules",
  "debug-screen",
  "doctor",
  "list-learned-actions",
  "lock-e2e",
  "nav-graph",
  "observe",
  "proof-capture",
  "rn-feature-dev",
  "run-action",
  "send-feedback",
  "setup",
  "test-feature"
];
var DOMAIN_SKILLS = [
  "capturing-proof",
  "creating-actions",
  "rn-best-practices",
  "rn-debugging",
  "rn-device-control",
  "rn-feature-development",
  "rn-setup",
  "rn-testing",
  "sending-feedback",
  "using-rn-dev-agent"
];
var EXPECTED_SKILLS = [...DOMAIN_SKILLS, ...WORKFLOW_SKILLS].map(
  (name) => `rn-dev-agent:${name}`
);
var MCP_CANARIES = ["cdp_status", "observe", "device_list", "proof_capture"];
var PROOF_ACTIONS = [
  "begin_rehearsal",
  "finish_rehearsal",
  "arm",
  "start_recording",
  "stop_recording",
  "validate",
  "finalize",
  "status",
  "discard",
  "contract"
];
function parseVersion(raw) {
  const match = raw.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|-)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function atLeast(actual, floor) {
  for (let i = 0; i < 3; i += 1) {
    if (actual[i] > floor[i]) return true;
    if (actual[i] < floor[i]) return false;
  }
  return true;
}
function runJson(command, args, timeout = 1e4) {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolveResult({ ok: false });
        try {
          resolveResult({ ok: true, value: JSON.parse(stdout) });
        } catch {
          resolveResult({ ok: false });
        }
      }
    );
  });
}
function runText(command, args, timeout = 1e4) {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout, maxBuffer: 256 * 1024 },
      (error, stdout) => resolveResult({ ok: !error, text: String(stdout).trim() })
    );
  });
}
function objectsIn(value) {
  const found = [];
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const object = item;
    found.push(object);
    for (const child of Object.values(object)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return found;
}
function exactPluginRows(value) {
  return objectsIn(value).filter((row) => row.pluginId === PLUGIN_ID);
}
function readManifest(packageRoot) {
  try {
    return JSON.parse(readFileSync(join(packageRoot, ".codex-plugin", "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}
function realPathUnder(packageRoot, path, kind) {
  try {
    const lexicalRoot = resolve(packageRoot);
    const lexicalPath = resolve(path);
    const lexicalRel = relative(lexicalRoot, lexicalPath);
    if (lexicalRel === "" || lexicalRel === ".." || lexicalRel.startsWith(`..${sep}`)) return false;
    let cursor = lexicalRoot;
    for (const segment of lexicalRel.split(sep)) {
      cursor = join(cursor, segment);
      if (lstatSync(cursor).isSymbolicLink()) return false;
    }
    const root = realpathSync(lexicalRoot);
    const real = realpathSync(lexicalPath);
    const rel = relative(root, real);
    if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`)) return false;
    const info = lstatSync(real);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}
function materializationFacts(packageRoot, pluginVersion) {
  const manifest = readManifest(packageRoot);
  const requiredFiles = [
    ".codex-plugin/plugin.json",
    ".mcp.json",
    "bin/cdp-supervisor.js",
    "bin/plugin-health.js",
    "rn-dev-agent-core/dist/supervisor.js",
    "rn-dev-agent-core/dist/learned-actions.js",
    "AGENTS-MD-TEMPLATE.md",
    "scripts/collect-feedback.sh",
    "scripts/record_proof.sh",
    "scripts/expo_ensure_running.sh",
    "scripts/eas_resolve_artifact.sh",
    "scripts/check-vercel-rules.mjs",
    "scripts/snapshot_state.sh",
    "scripts/rn-fast-runner/package.json",
    "scripts/rn-android-runner/package.json",
    "templates/rn-agent/.scaffold-version",
    ...WORKFLOW_SKILLS.map((name) => `commands/${name}.md`),
    ...DOMAIN_SKILLS.map((name) => `skills/${name}/SKILL.md`),
    ...WORKFLOW_SKILLS.flatMap((name) => [
      `skills/${name}/SKILL.md`,
      `skills/${name}/agents/openai.yaml`
    ])
  ];
  const requiredDirectories = ["templates/rn-agent", "skills", "commands", "scripts"];
  const missing = [
    ...requiredFiles.filter((path) => !realPathUnder(packageRoot, join(packageRoot, path), "file")),
    ...requiredDirectories.filter(
      (path) => !realPathUnder(packageRoot, join(packageRoot, path), "directory")
    )
  ];
  let status = "EXACT_HEALTHY";
  if (!manifest || manifest.name !== "rn-dev-agent" || missing.length > 0) status = "CORRUPT";
  else if (pluginVersion && manifest.version !== pluginVersion) status = "VERSION_MISMATCH";
  return { status, packageRoot, version: manifest?.version ?? null, missing };
}
function mcpRegistered(value) {
  let found = false;
  let enabled = true;
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child);
      return;
    }
    if (!item || typeof item !== "object") return;
    const object = item;
    if (object.name === "cdp" || object.server === "cdp" || object.id === "cdp") {
      found = true;
      if (object.enabled === false || object.disabled === true) enabled = false;
    }
    if (Object.prototype.hasOwnProperty.call(object, "cdp")) {
      found = true;
      const cdp = object.cdp;
      if (cdp && typeof cdp === "object") {
        const cdpObject = cdp;
        if (cdpObject.enabled === false || cdpObject.disabled === true) enabled = false;
      }
    }
    for (const child of Object.values(object)) {
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(value);
  return { found, enabled };
}
function cap(value, max = 16384) {
  return value.length <= max ? value : value.slice(value.length - max);
}
function redactDiagnostic(value, packageRoot) {
  let redacted = value;
  for (const [needle, replacement] of [
    [packageRoot, "<package-root>"],
    [process.env.HOME, "~"],
    [process.env.CODEX_HOME, "<codex-home>"]
  ]) {
    if (needle) redacted = redacted.split(needle).join(replacement);
  }
  return redacted.replace(/(authorization|token|secret|password)[=:][^\s]+/gi, "$1=[REDACTED]").replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]");
}
function redactValue(value, packageRoot, key = "") {
  if (/authorization|token|secret|password/i.test(key)) return "[REDACTED]";
  if (typeof value === "string") return redactDiagnostic(value, packageRoot);
  if (Array.isArray(value)) return value.map((child) => redactValue(child, packageRoot));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => [
      childKey,
      redactValue(child, packageRoot, childKey)
    ])
  );
}
function probeMcpContract(packageRoot, timeoutMs = 12e3) {
  return new Promise((resolveProbe) => {
    const launcher = join(packageRoot, "bin", "cdp-supervisor.js");
    let child;
    try {
      child = spawn(process.execPath, [launcher, "--diagnostic-contract-probe"], {
        cwd: packageRoot,
        env: {
          ...process.env,
          RN_DEV_AGENT_LOG_LEVEL: "warn",
          LOG_LEVEL: "warn",
          RN_AGENT_OBSERVE_AUTOSTART: "0",
          RN_CDP_AUTOCONNECT: "0"
        },
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      return resolveProbe({ ok: false, tools: [], stderr: "", error: String(error) });
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let initialized = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      const reap = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGTERM");
      }, 1e3);
      reap.unref();
      resolveProbe({ ...result, stderr: redactDiagnostic(cap(stderr), packageRoot) });
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}
`);
    const consume = () => {
      for (; ; ) {
        const newline = stdout.indexOf("\n");
        if (newline < 0) return;
        const line = stdout.slice(0, newline).trim();
        stdout = stdout.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1 && !initialized) {
          initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        } else if (message.id === 2) {
          const result = message.result;
          finish({ ok: Array.isArray(result?.tools), tools: result?.tools ?? [], stderr });
        }
      }
    };
    child.stdout.on("data", (chunk) => {
      stdout = cap(stdout + chunk.toString("utf8"), 2 * 1024 * 1024);
      consume();
    });
    child.stderr.on("data", (chunk) => {
      stderr = cap(stderr + chunk.toString("utf8"));
    });
    child.on("error", (error) => finish({ ok: false, tools: [], stderr, error: error.message }));
    child.on("exit", (code) => {
      if (!settled) finish({ ok: false, tools: [], stderr, error: `launcher exited ${code}` });
    });
    const timer = setTimeout(
      () => finish({ ok: false, tools: [], stderr, error: "contract probe timed out" }),
      timeoutMs
    );
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rn-dev-agent-plugin-health", version: "1" }
      }
    });
  });
}
function publishedProofContract(tool) {
  const schema = tool?.inputSchema;
  if (!schema || typeof schema !== "object") return { actions: [], usableShape: false };
  const object = schema;
  const properties = object.properties;
  const action = properties?.action;
  const actions = Array.isArray(action?.enum) ? action.enum.filter((value) => typeof value === "string") : [];
  const required = Array.isArray(object.required) ? object.required : [];
  return {
    actions,
    usableShape: object.type === "object" && required.includes("action")
  };
}
function classifyHealth(facts) {
  const findings = [];
  const add = (code, detail) => {
    if (!findings.some((finding) => finding.code === code)) findings.push({ code, detail });
  };
  if (facts.installation.status === "MISSING")
    add("MISSING_INSTALLATION", "Plugin is not installed.");
  else if (facts.installation.status === "DISABLED")
    add("PLUGIN_DISABLED", "Plugin is installed but disabled.");
  else if (facts.installation.status === "AMBIGUOUS")
    add("INSTALLATION_STATE_AMBIGUOUS", "Codex reported multiple exact plugin rows.");
  else if (facts.installation.status === "CLI_ERROR")
    add("INSTALLATION_STATE_UNKNOWN", "Codex plugin inventory failed.");
  if (facts.materialization.status === "CORRUPT")
    add(
      "CORRUPT_MATERIALIZATION",
      "Required package files are missing or escape the selected package."
    );
  else if (facts.materialization.status === "VERSION_MISMATCH")
    add("VERSION_MISMATCH", "Selected package manifest does not match the enabled plugin version.");
  if (facts.mcpRegistration.status === "MISSING")
    add("MCP_NOT_REGISTERED", "Effective Codex MCP config has no cdp server.");
  else if (facts.mcpRegistration.status === "DISABLED")
    add("MCP_DISABLED", "Effective cdp server is disabled.");
  else if (facts.mcpRegistration.status === "UNKNOWN")
    add("MCP_REGISTRATION_UNKNOWN", "Codex MCP inventory failed.");
  if (facts.mcpContractProbe.status === "FAILED")
    add(
      "MCP_CONTRACT_PROBE_FAILED",
      "The package launcher could not initialize and list its MCP contract."
    );
  const directHealthy = facts.materialization.status === "EXACT_HEALTHY" && facts.mcpRegistration.status === "REGISTERED" && facts.mcpContractProbe.status === "HEALTHY";
  const skillAbsent = facts.taskSkillInventory.complete && facts.taskSkillInventory.observed.length === 0;
  const mcpAbsent = facts.taskMcpInventory.complete && facts.taskMcpInventory.observed.length === 0;
  const skillIncomplete = facts.taskSkillInventory.complete && facts.taskSkillInventory.missing.length > 0;
  const mcpIncomplete = facts.taskMcpInventory.complete && facts.taskMcpInventory.missing.length > 0;
  if (directHealthy && skillAbsent && mcpAbsent)
    add(
      "STALE_ACTIVE_TASK_DISCOVERY",
      "Complete active-task inventories contain neither rn-dev-agent skills nor cdp tools."
    );
  else {
    if (directHealthy && skillIncomplete)
      add(
        "STALE_SKILL_DISCOVERY",
        "Complete active-task skill inventory is missing expected rn-dev-agent skills."
      );
    if (directHealthy && mcpIncomplete)
      add(
        "STALE_MCP_DISCOVERY",
        "Complete active-task MCP inventory is missing required cdp canaries."
      );
  }
  if (facts.observedTransport.status === "closed")
    add("ACTIVE_TRANSPORT_CLOSED", "A prior active-task MCP call returned transport closure.");
  if (facts.directProofSchema.status === "UNUSABLE")
    add(
      "SERVER_SCHEMA_EXPOSURE_FAILURE",
      "Direct MCP schema lacks the required proof_capture action contract."
    );
  else if (facts.hostProofSchema.status === "empty")
    add(
      "HOST_SCHEMA_EXPOSURE_FAILURE",
      "Direct schema is usable but the caller observed an empty host schema."
    );
  if (facts.observedAppStatus.status === "disconnected")
    add(
      "APP_NOT_CONNECTED",
      "A prior structured cdp_status observation reported no app connection."
    );
  if (facts.hostSupport.status === "LEGACY_HOST_RESTART_REQUIRED")
    add(
      "LEGACY_HOST_RESTART_REQUIRED",
      "This Codex version has restart-only plugin refresh semantics."
    );
  else if (facts.hostSupport.status === "HOST_VERSION_UNKNOWN")
    add("HOST_VERSION_UNKNOWN", "Codex version could not be classified.");
  const observationsUnknown = !facts.taskSkillInventory.complete || !facts.taskMcpInventory.complete || facts.observedTransport.status === "unknown" || facts.hostProofSchema.status === "unknown" || facts.observedAppStatus.status === "unknown";
  if (findings.length === 0 && observationsUnknown)
    add(
      "INDETERMINATE_TASK_STATE",
      "Disk, registration, and contract are healthy; one or more active-task observations are unknown."
    );
  if (findings.length === 0) add("HEALTHY", "All requested health axes are healthy.");
  const primaryFinding = findings[0].code;
  const nextActions = [];
  const codes = new Set(findings.map((finding) => finding.code));
  if (codes.has("MISSING_INSTALLATION") || codes.has("PLUGIN_DISABLED")) {
    nextActions.push(
      "Review `codex plugin list --json`, then user-confirm `codex plugin add rn-dev-agent@rn-dev-agent --json`."
    );
  }
  if (codes.has("INSTALLATION_STATE_AMBIGUOUS") || codes.has("INSTALLATION_STATE_UNKNOWN")) {
    nextActions.push(
      "Inspect `codex plugin list --json`; do not mutate plugin state until exactly one rn-dev-agent@rn-dev-agent row is authoritative."
    );
  }
  if (codes.has("CORRUPT_MATERIALIZATION") || codes.has("VERSION_MISMATCH") || codes.has("MCP_NOT_REGISTERED") || codes.has("MCP_DISABLED") || codes.has("MCP_CONTRACT_PROBE_FAILED")) {
    nextActions.push(
      "User-confirm `codex plugin marketplace upgrade rn-dev-agent`, then `codex plugin add rn-dev-agent@rn-dev-agent --json`."
    );
  }
  if ([...codes].some((code) => code.startsWith("STALE_")) || codes.has("ACTIVE_TRANSPORT_CLOSED") || codes.has("LEGACY_HOST_RESTART_REQUIRED")) {
    nextActions.push(
      "Exit and relaunch Codex; external mutations and legacy hosts cannot refresh this process."
    );
  }
  if (codes.has("SERVER_SCHEMA_EXPOSURE_FAILURE"))
    nextActions.push(
      "Install a plugin release containing the proof_capture publication fix, then relaunch Codex."
    );
  if (codes.has("HOST_SCHEMA_EXPOSURE_FAILURE"))
    nextActions.push(
      "Record the Codex/host version and projected schema; report the host conversion defect."
    );
  if (codes.has("APP_NOT_CONNECTED"))
    nextActions.push(
      "After discovery recovery, run the active `$rn-dev-agent:check-env` or setup workflow to attach the intended app."
    );
  if (nextActions.length === 0 && primaryFinding === "INDETERMINATE_TASK_STATE")
    nextActions.push(
      "Run `/mcp verbose`, inspect the skill inventory, and rerun with complete observation flags."
    );
  if (nextActions.length === 0) nextActions.push("No recovery action required.");
  const overall = primaryFinding === "HEALTHY" ? "healthy" : primaryFinding === "INDETERMINATE_TASK_STATE" ? "indeterminate" : "unhealthy";
  return { findings, primaryFinding, nextActions, overall };
}
function parseArgs(argv) {
  const result = {
    taskSkills: [],
    taskSkillsComplete: false,
    taskMcpTools: [],
    taskMcpComplete: false,
    observedTransport: "unknown",
    hostProofSchema: "unknown",
    observedAppStatus: "unknown",
    json: false
  };
  const singleton = /* @__PURE__ */ new Set();
  const readValue = (index, flag) => {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--task-skill") result.taskSkills.push(readValue(i++, arg));
    else if (arg === "--task-mcp-tool") result.taskMcpTools.push(readValue(i++, arg));
    else if (arg === "--task-skills-complete") result.taskSkillsComplete = true;
    else if (arg === "--task-mcp-complete") result.taskMcpComplete = true;
    else if (arg === "--json") result.json = true;
    else if (arg === "--observed-transport" || arg === "--host-proof-schema" || arg === "--observed-app-status") {
      if (singleton.has(arg)) throw new Error(`${arg} may be passed only once`);
      singleton.add(arg);
      const value = readValue(i++, arg);
      if (arg === "--observed-transport" && ["healthy", "closed", "unknown"].includes(value))
        result.observedTransport = value;
      else if (arg === "--host-proof-schema" && ["usable", "empty", "unknown"].includes(value))
        result.hostProofSchema = value;
      else if (arg === "--observed-app-status" && ["connected", "disconnected", "unknown"].includes(value))
        result.observedAppStatus = value;
      else throw new Error(`invalid value for ${arg}: ${value}`);
    } else if (arg === "--help" || arg === "-h") throw new Error("help");
    else throw new Error(`unknown argument: ${arg}`);
  }
  const skillPattern = /^rn-dev-agent:[a-z0-9-]+$/;
  const toolPattern = /^(?:mcp__cdp__)?[a-z][a-z0-9_]*$/;
  if (result.taskSkills.some((name) => !skillPattern.test(name)))
    throw new Error("invalid --task-skill name");
  if (result.taskMcpTools.some((name) => !toolPattern.test(name)))
    throw new Error("invalid --task-mcp-tool name");
  result.taskSkills = [...new Set(result.taskSkills)].sort();
  result.taskMcpTools = [...new Set(result.taskMcpTools)].sort();
  return result;
}
function usage() {
  return `Usage: plugin-health [--json] [observations]

Observations (caller supplied; default unknown):
  --task-skill <rn-dev-agent:name>   repeatable
  --task-skills-complete
  --task-mcp-tool <name>             repeatable
  --task-mcp-complete
  --observed-transport healthy|closed|unknown
  --host-proof-schema usable|empty|unknown
  --observed-app-status connected|disconnected|unknown`;
}
async function collectHealth(input) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const host = await runText("codex", ["--version"]);
  const hostTuple = host.ok ? parseVersion(host.text) : null;
  const floorTuple = parseVersion(LIVE_REFRESH_FLOOR);
  const hostSupport = {
    status: hostTuple ? atLeast(hostTuple, floorTuple) ? "LIVE_REFRESH_SUPPORTED" : "LEGACY_HOST_RESTART_REQUIRED" : "HOST_VERSION_UNKNOWN",
    version: host.ok ? host.text : null,
    floor: LIVE_REFRESH_FLOOR
  };
  const pluginList = await runJson("codex", ["plugin", "list", "--json"]);
  const pluginRows = pluginList.ok ? exactPluginRows(pluginList.value) : [];
  const row = pluginRows.length === 1 ? pluginRows[0] : null;
  const rowVersion = typeof row?.version === "string" ? row.version : null;
  const disabled = row?.enabled === false || row?.disabled === true || row?.state === "disabled";
  const installation = {
    status: !pluginList.ok ? "CLI_ERROR" : pluginRows.length > 1 ? "AMBIGUOUS" : !row ? "MISSING" : disabled ? "DISABLED" : "ENABLED",
    pluginId: PLUGIN_ID,
    version: rowVersion,
    matches: pluginRows.map((match) => redactValue(match, packageRoot))
  };
  const materialization = materializationFacts(packageRoot, rowVersion);
  const mcpList = await runJson("codex", ["mcp", "list", "--json"]);
  const registration = mcpList.ok ? mcpRegistered(mcpList.value) : { found: false, enabled: false };
  const mcpRegistration = {
    status: !mcpList.ok ? "UNKNOWN" : !registration.found ? "MISSING" : registration.enabled ? "REGISTERED" : "DISABLED",
    server: "cdp"
  };
  const probe = await probeMcpContract(packageRoot);
  const toolNames = new Set(
    probe.tools.map((tool) => tool.name).filter((name) => Boolean(name))
  );
  const canaries = Object.fromEntries(MCP_CANARIES.map((name) => [name, toolNames.has(name)]));
  const canariesHealthy = MCP_CANARIES.every((name) => toolNames.has(name));
  const mcpContractProbe = {
    status: probe.ok && canariesHealthy ? "HEALTHY" : "FAILED",
    toolCount: probe.ok ? probe.tools.length : null,
    canaries,
    ...probe.stderr ? { stderr: probe.stderr } : {}
  };
  const proofTool = probe.tools.find((tool) => tool.name === "proof_capture");
  const publishedProof = publishedProofContract(proofTool);
  const schemaActions = new Set(publishedProof.actions);
  const directProofSchema = {
    status: publishedProof.usableShape && PROOF_ACTIONS.every((action) => schemaActions.has(action)) ? "USABLE" : "UNUSABLE",
    actions: publishedProof.actions.sort()
  };
  const observedSkillSet = new Set(input.taskSkills);
  const observedToolSet = new Set(
    input.taskMcpTools.map((name) => name.replace(/^mcp__cdp__/, ""))
  );
  const taskSkillInventory = {
    status: !input.taskSkillsComplete ? "PARTIAL_OR_UNKNOWN" : EXPECTED_SKILLS.every((name) => observedSkillSet.has(name)) ? "COMPLETE" : input.taskSkills.length === 0 ? "ABSENT" : "INCOMPLETE",
    complete: input.taskSkillsComplete,
    observed: input.taskSkills,
    missing: EXPECTED_SKILLS.filter((name) => !observedSkillSet.has(name))
  };
  const taskMcpInventory = {
    status: !input.taskMcpComplete ? "PARTIAL_OR_UNKNOWN" : MCP_CANARIES.every((name) => observedToolSet.has(name)) ? "COMPLETE" : input.taskMcpTools.length === 0 ? "ABSENT" : "INCOMPLETE",
    complete: input.taskMcpComplete,
    observed: input.taskMcpTools,
    missing: MCP_CANARIES.filter((name) => !observedToolSet.has(name))
  };
  const facts = {
    hostSupport,
    installation,
    materialization,
    mcpRegistration,
    mcpContractProbe,
    directProofSchema,
    taskSkillInventory,
    taskMcpInventory,
    observedTransport: { status: input.observedTransport, provenance: "caller" },
    hostProofSchema: { status: input.hostProofSchema, provenance: "caller" },
    observedAppStatus: { status: input.observedAppStatus, provenance: "caller" }
  };
  return { ...facts, ...classifyHealth(facts) };
}
async function main() {
  let input;
  try {
    input = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(usage());
    if (error instanceof Error && error.message !== "help")
      console.error(`
error: ${error.message}`);
    process.exitCode = error instanceof Error && error.message === "help" ? 0 : 64;
    return;
  }
  try {
    const report = await collectHealth(input);
    if (input.json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`rn-dev-agent Codex health: ${report.primaryFinding}`);
      for (const finding of report.findings) console.log(`- ${finding.code}: ${finding.detail}`);
      console.log("Next actions:");
      for (const action of report.nextActions) console.log(`- ${action}`);
    }
    process.exitCode = report.overall === "healthy" ? 0 : report.overall === "indeterminate" ? 3 : 2;
  } catch (error) {
    console.error(
      `plugin-health internal error: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 70;
  }
}
var entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) await main();
export {
  DOMAIN_SKILLS,
  EXPECTED_SKILLS,
  LIVE_REFRESH_FLOOR,
  MCP_CANARIES,
  PLUGIN_ID,
  PROOF_ACTIONS,
  WORKFLOW_SKILLS,
  classifyHealth,
  collectHealth,
  parseArgs,
  probeMcpContract
};
