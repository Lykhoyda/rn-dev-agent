#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/learned-actions.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// packages/rn-dev-agent-core/dist/domain/action-store.js
import { existsSync as existsSync3, lstatSync as lstatSync2, readFileSync as readFileSync2, realpathSync as realpathSync2, statSync as statSync2, unlinkSync as unlinkSync2 } from "node:fs";
import { basename, dirname as dirname2, join as join3 } from "node:path";

// packages/rn-dev-agent-core/dist/domain/atomic-writer.js
var ORPHAN_MAX_AGE_MS = 5 * 60 * 1e3;
var lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

// packages/rn-dev-agent-core/dist/domain/path-safety.js
import { resolve, sep } from "node:path";
var PathTraversalError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "PathTraversalError";
  }
};
var ACTION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
var ACTION_ID_MAX_LEN = 64;
function isValidActionId(s) {
  if (typeof s !== "string")
    return false;
  if (s.length === 0 || s.length > ACTION_ID_MAX_LEN)
    return false;
  if (s.includes(".."))
    return false;
  return ACTION_ID_RE.test(s);
}
function assertValidActionId(s, context) {
  if (!isValidActionId(s)) {
    const preview = JSON.stringify(s).slice(0, 80);
    throw new PathTraversalError(`Invalid action ID for ${context}: ${preview}`);
  }
}
function assertWithinDir(child, baseDir) {
  const resolvedBase = resolve(baseDir);
  const resolvedChild = resolve(baseDir, child);
  if (resolvedChild === resolvedBase)
    return;
  const baseWithSep = resolvedBase.endsWith(sep) ? resolvedBase : resolvedBase + sep;
  if (!resolvedChild.startsWith(baseWithSep)) {
    throw new PathTraversalError(`Path "${child}" escapes containment dir "${baseDir}" (resolved to ${resolvedChild})`);
  }
}

// packages/rn-dev-agent-core/dist/logger.js
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
var configuredLevel = process.env.LOG_LEVEL ?? process.env.RN_DEV_AGENT_LOG_LEVEL ?? "warn";
function resolveLogPath() {
  if (process.argv.includes("--diagnostic-contract-probe"))
    return null;
  if (configuredLevel !== "debug" && configuredLevel !== "info")
    return null;
  const pluginData = process.env.CLAUDE_PLUGIN_DATA;
  if (pluginData) {
    try {
      if (!existsSync(pluginData))
        mkdirSync(pluginData, { recursive: true });
      return join(pluginData, "cdp-bridge.log");
    } catch {
    }
  }
  const fallbackDir = join(homedir(), ".claude", "logs");
  try {
    if (!existsSync(fallbackDir))
      mkdirSync(fallbackDir, { recursive: true });
    return join(fallbackDir, "rn-dev-agent-cdp-bridge.log");
  } catch {
  }
  return join(tmpdir(), "rn-dev-agent-cdp-bridge.log");
}
var logFilePath = resolveLogPath();

// packages/rn-dev-agent-core/dist/domain/action-db.js
import { createRequire } from "node:module";
var _require = createRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
import { spawnSync } from "node:child_process";
import { closeSync, existsSync as existsSync2, fstatSync, lstatSync, mkdirSync as mkdirSync2, openSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join as join2, relative, resolve as resolve2, sep as sep2 } from "node:path";

// packages/rn-dev-agent-core/dist/session/worktree-repair-remedy.js
var WORKTREE_REPAIR_ENTRY = '"${CLAUDE_PLUGIN_ROOT:-${RN_DEV_AGENT_CODEX_PLUGIN_ROOT:-${CODEX_PLUGIN_ROOT:?set it to the installed rn-dev-agent plugin root, then re-run}}}/rn-dev-agent-core/dist/worktree-inheritance.js"';
var HEADLESS_WORKTREE_REPAIR_COMMAND = `node ${WORKTREE_REPAIR_ENTRY} repair --app-root "$PWD"`;

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
var GIT_ENV_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_NAMESPACE"
];
function gitEnvironment() {
  const env = { ...process.env };
  for (const key of GIT_ENV_OVERRIDES)
    delete env[key];
  return env;
}
function git(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.status !== 0)
    return { ok: false, stdout: "" };
  return { ok: true, stdout: (result.stdout ?? "").replace(/\n$/, "") };
}
function canonical(path2) {
  try {
    return realpathSync(path2);
  } catch {
    return null;
  }
}
function contained(parent, child) {
  if (parent === child)
    return true;
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep2}`) && rel !== ".." && !isAbsolute(rel);
}
function toPosix(path2) {
  return sep2 === "/" ? path2 : path2.split(sep2).join("/");
}
function isRnAppRoot(directory) {
  const manifest = join2(directory, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8"));
    const deps = { ...parsed.dependencies, ...parsed.devDependencies };
    return Boolean(deps["react-native"] || deps["expo"]);
  } catch {
    return false;
  }
}
function parseWorktreeRecords(porcelain) {
  const records = [];
  let current = null;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current)
        records.push(current);
      current = { path: line.slice("worktree ".length), bare: false, prunable: false };
      continue;
    }
    if (!current)
      continue;
    if (line === "bare")
      current.bare = true;
    if (line === "prunable" || line.startsWith("prunable "))
      current.prunable = true;
  }
  if (current)
    records.push(current);
  return records;
}
function verifiedPrimaries(worktreeRoot, commonDir) {
  const listing = git(worktreeRoot, ["worktree", "list", "--porcelain"]);
  if (!listing.ok)
    return [];
  const verified = /* @__PURE__ */ new Set();
  for (const record of parseWorktreeRecords(listing.stdout)) {
    if (record.bare || record.prunable)
      continue;
    const candidate = canonical(record.path);
    if (!candidate)
      continue;
    try {
      if (!statSync(candidate).isDirectory())
        continue;
    } catch {
      continue;
    }
    const top = git(candidate, ["rev-parse", "--show-toplevel"]);
    if (!top.ok || canonical(top.stdout) !== candidate)
      continue;
    const candidateGitDir = git(candidate, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    const candidateCommon = git(candidate, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir"
    ]);
    if (!candidateGitDir.ok || !candidateCommon.ok)
      continue;
    const resolvedGitDir = canonical(candidateGitDir.stdout);
    const resolvedCommon = canonical(candidateCommon.stdout);
    if (!resolvedGitDir || !resolvedCommon)
      continue;
    if (resolvedCommon !== commonDir || resolvedGitDir !== resolvedCommon)
      continue;
    verified.add(candidate);
  }
  return [...verified];
}
function resolveWorktreeLayout(input) {
  const cwd = canonical(input.cwd);
  if (!cwd)
    return { refusal: "NOT_GIT" };
  const insideWorkTree = git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree.ok) {
    const bare = git(cwd, ["rev-parse", "--is-bare-repository"]);
    if (bare.ok && bare.stdout === "true")
      return { refusal: "BARE" };
    return { refusal: "NOT_GIT" };
  }
  if (insideWorkTree.stdout !== "true")
    return { refusal: "BARE" };
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  const gitDirRaw = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const commonRaw = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!top.ok || !gitDirRaw.ok || !commonRaw.ok)
    return { refusal: "GIT_UNAVAILABLE" };
  const worktreeRoot = canonical(top.stdout);
  const gitDir = canonical(gitDirRaw.stdout);
  const commonDir = canonical(commonRaw.stdout);
  if (!worktreeRoot || !gitDir || !commonDir)
    return { refusal: "GIT_UNAVAILABLE" };
  const appRootInput = canonical(input.appRoot ? resolve2(input.appRoot) : cwd);
  if (!appRootInput)
    return { refusal: "NOT_RN_APP" };
  if (!contained(worktreeRoot, appRootInput))
    return { refusal: "APP_OUTSIDE_WORKTREE" };
  if (!input.allowNonRnApp && !isRnAppRoot(appRootInput))
    return { refusal: "NOT_RN_APP" };
  const appRelative = worktreeRoot === appRootInput ? "." : toPosix(relative(worktreeRoot, appRootInput));
  const base = {
    kind: gitDir === commonDir ? "primary" : "linked",
    worktreeRoot,
    commonDir,
    gitDir,
    appRoot: appRootInput,
    appRelative
  };
  if (base.kind === "primary")
    return base;
  const primaries = verifiedPrimaries(worktreeRoot, commonDir);
  if (primaries.length === 0)
    return { ...base, refusal: "NO_PRIMARY" };
  if (primaries.length > 1)
    return { ...base, refusal: "AMBIGUOUS" };
  const primaryRoot = primaries[0];
  const primaryAppRoot = appRelative === "." ? primaryRoot : join2(primaryRoot, appRelative);
  if (!contained(primaryRoot, primaryAppRoot))
    return { ...base, refusal: "PRIMARY_APP_MISSING" };
  let primaryAppReal = null;
  try {
    if (lstatSync(primaryAppRoot).isDirectory())
      primaryAppReal = canonical(primaryAppRoot);
  } catch {
    primaryAppReal = null;
  }
  if (!primaryAppReal || !contained(primaryRoot, primaryAppReal)) {
    return { ...base, refusal: "PRIMARY_APP_MISSING" };
  }
  return { ...base, primaryRoot, primaryAppRoot };
}

// packages/rn-dev-agent-core/dist/domain/action-store.js
function assertReadableActionCorpus(projectRoot) {
  const rnAgentDir = join3(projectRoot, ".rn-agent");
  const actionsDir = join3(rnAgentDir, "actions");
  const rnAgentStat = lstatIfPresent(rnAgentDir);
  if (rnAgentStat?.isSymbolicLink()) {
    throw new Error(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  const actionsStat = lstatIfPresent(actionsDir);
  if (!actionsStat?.isSymbolicLink())
    return;
  const target = realpathSync2(actionsDir);
  const layout = resolveWorktreeLayout({ cwd: projectRoot, appRoot: projectRoot });
  const primaryRnAgentDir = "primaryAppRoot" in layout && layout.primaryAppRoot ? join3(layout.primaryAppRoot, ".rn-agent") : null;
  const primaryActionsDir = primaryRnAgentDir ? join3(primaryRnAgentDir, "actions") : null;
  const expectedTarget = primaryRnAgentDir && primaryActionsDir && "kind" in layout && layout.kind === "linked" && !layout.refusal && isOwnedDirectory(primaryRnAgentDir) && isOwnedDirectory(primaryActionsDir) ? canonicalPath(primaryActionsDir) : null;
  if (!expectedTarget || target !== expectedTarget || !statSync2(target).isDirectory()) {
    throw new Error(`Refusing foreign learned-action corpus symlink at ${actionsDir}.`);
  }
}
function isOwnedDirectory(path2) {
  const stat = lstatIfPresent(path2);
  return Boolean(stat?.isDirectory() && !stat.isSymbolicLink());
}
function canonicalPath(path2) {
  try {
    return realpathSync2(path2);
  } catch {
    return null;
  }
}
function lstatIfPresent(path2) {
  try {
    return lstatSync2(path2);
  } catch (err) {
    if (err.code === "ENOENT")
      return null;
    throw err;
  }
}
function actionFileExists(path2) {
  const stat = lstatIfPresent(path2);
  if (!stat)
    return false;
  if (stat.isSymbolicLink()) {
    throw new Error(`Refusing inherited action symlink at ${path2}.`);
  }
  return true;
}
function resolveActionPath(projectRoot, actionId) {
  assertValidActionId(actionId, "resolveActionPath");
  assertReadableActionCorpus(projectRoot);
  const actionsDir = join3(projectRoot, ".rn-agent", "actions");
  const fileName = `${actionId}.yaml`;
  assertWithinDir(fileName, actionsDir);
  const yamlPath = join3(actionsDir, fileName);
  const ymlPath = yamlPath.replace(/\.yaml$/, ".yml");
  const yamlExists = actionFileExists(yamlPath);
  const ymlExists = actionFileExists(ymlPath);
  if (yamlExists && ymlExists) {
    throw new Error(`Action ${actionId} is ambiguous because both ${actionId}.yaml and ${actionId}.yml exist; keep exactly one file before replay.`);
  }
  if (yamlExists)
    return yamlPath;
  if (ymlExists)
    return ymlPath;
  return null;
}

// packages/rn-dev-agent-core/dist/learned-actions.js
var argv = process.argv.slice(2);
var flags = {
  json: false,
  filter: "",
  appId: "",
  memoryCwd: process.cwd(),
  workspaceRoot: process.cwd(),
  section: "all",
  max: 50
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json")
    flags.json = true;
  else if (a === "--filter")
    flags.filter = (argv[++i] || "").toLowerCase();
  else if (a === "--appId")
    flags.appId = argv[++i] || "";
  else if (a === "--memory-cwd")
    flags.memoryCwd = argv[++i] || process.cwd();
  else if (a === "--workspace-root")
    flags.workspaceRoot = argv[++i] || process.cwd();
  else if (a === "--section")
    flags.section = (argv[++i] || "all").toLowerCase();
  else if (a === "--max") {
    const m = parseInt(argv[++i] || "50", 10);
    flags.max = Number.isNaN(m) ? 50 : m;
  } else if (a === "--help" || a === "-h") {
    console.log(`Usage: learned-actions [--json] [--filter KW] [--appId ID]
                               [--memory-cwd PATH] [--workspace-root PATH]
                               [--section a|b|c|d|all] [--max N]`);
    process.exit(0);
  } else {
    process.stderr.write(`unknown flag: ${a}
`);
    process.exit(2);
  }
}
var matchKw = (...fields) => !flags.filter || fields.some((f) => (f || "").toString().toLowerCase().includes(flags.filter));
function scanMemories() {
  const encoded = flags.memoryCwd.replace(/[^a-zA-Z0-9]/g, "-");
  const memDir = path.join(os.homedir(), ".claude", "projects", encoded, "memory");
  if (!fs.existsSync(memDir))
    return { exists: false, dir: memDir, items: [] };
  const items = [];
  for (const f of fs.readdirSync(memDir)) {
    if (!f.startsWith("feedback_") || !f.endsWith(".md"))
      continue;
    const fp = path.join(memDir, f);
    const text = fs.readFileSync(fp, "utf8");
    const fm = parseFrontmatter(text);
    if (!matchKw(fm["name"], fm["description"], f))
      continue;
    items.push({
      file: f,
      path: fp,
      name: fm["name"] || f.replace(/\.md$/, ""),
      description: truncate(fm["description"] || firstParagraph(stripFrontmatter(text)), 160),
      type: fm["type"] || "feedback"
    });
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, dir: memDir, items: items.slice(0, flags.max) };
}
function scanFlows() {
  const roots = collectFlowRoots(flags.workspaceRoot);
  const items = [];
  for (const root of roots) {
    if (!fs.existsSync(root))
      continue;
    const projectRoot = path.dirname(path.dirname(root));
    assertReadableActionCorpus(projectRoot);
    const ids = [
      ...new Set(fs.readdirSync(root).filter((file) => /\.ya?ml$/.test(file)).map((file) => file.replace(/\.ya?ml$/, "")))
    ];
    for (const id of ids) {
      const fp = resolveActionPath(projectRoot, id);
      if (!fp)
        continue;
      const f = path.basename(fp);
      const text = fs.readFileSync(fp, "utf8");
      const meta = parseFlowMeta(text);
      if (flags.appId && meta.appId !== flags.appId)
        continue;
      const tagsStr = (meta.tags || []).join(",");
      if (!matchKw(meta.purpose, meta.appId, meta.intent, tagsStr, f, fp))
        continue;
      const params = (text.match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []).map((s) => s.slice(2, -1));
      const uniqParams = Array.from(new Set(params));
      const replay = replayHint(meta.id, fp, uniqParams);
      items.push({
        flow: f.replace(/\.ya?ml$/, ""),
        path: fp,
        appId: meta.appId,
        purpose: truncate(meta.purpose, 140),
        id: meta.id,
        intent: meta.intent,
        tags: meta.tags,
        mutates: meta.mutates,
        status: meta.status,
        params: uniqParams,
        produces: meta.produces,
        metaFormat: meta.metaFormat,
        metaInvalid: meta.metaInvalid,
        replay
      });
    }
  }
  items.sort((a, b) => a.flow.localeCompare(b.flow));
  return { items: items.slice(0, flags.max), roots };
}
function replayHint(id, flowPath, params) {
  const paramObj = params.length > 0 ? `, params: { ${params.map((p) => `${p}: "..."`).join(", ")} }` : "";
  const actionsDir = path.dirname(flowPath);
  const canonicalYaml = id !== null && path.basename(flowPath).replace(/\.ya?ml$/, "") === id && path.basename(actionsDir) === "actions" && path.basename(path.dirname(actionsDir)) === ".rn-agent";
  if (canonicalYaml) {
    const projectRoot = path.dirname(path.dirname(actionsDir));
    return `cdp_run_action({ actionId: "${id}", projectRoot: "${projectRoot}", blindProbeMode: "forbid"${paramObj} })`;
  }
  return `maestro_run({ flowPath: "${flowPath}"${paramObj} })`;
}
function collectFlowRoots(start) {
  const candidates = /* @__PURE__ */ new Set();
  const own = path.join(start, ".rn-agent", "actions");
  candidates.add(own);
  const parent = path.dirname(start);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      const ta = path.join(parent, sib, "test-app", ".rn-agent", "actions");
      if (fs.existsSync(ta))
        candidates.add(ta);
    }
  }
  const ta2 = path.join(start, "test-app", ".rn-agent", "actions");
  if (fs.existsSync(ta2))
    candidates.add(ta2);
  return Array.from(candidates);
}
function parseFlowMeta(text) {
  const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
  const lines = text.split("\n");
  const purposeLines = [];
  const meta = {
    id: null,
    intent: null,
    tags: null,
    mutates: null,
    status: null,
    produces: null
  };
  const META_KEYS = /* @__PURE__ */ new Set(["id", "intent", "tags", "mutates", "status", "produces"]);
  const presentKeys = /* @__PURE__ */ new Set();
  const invalidKeys = [];
  let inComment = false;
  for (const line of lines) {
    if (line.startsWith("#")) {
      inComment = true;
      const stripped = line.replace(/^#\s?/, "").trim();
      if (!stripped)
        continue;
      const kv = stripped.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)$/);
      if (kv && META_KEYS.has(kv[1])) {
        const key = kv[1];
        const raw = kv[2].trim();
        presentKeys.add(key);
        if (key === "tags") {
          meta.tags = raw.replace(/^\[|\]$/g, "").split(",").map((t) => t.trim()).filter(Boolean);
        } else if (key === "mutates") {
          if (/^(true|false)$/i.test(raw)) {
            meta.mutates = /^true$/i.test(raw);
          } else {
            invalidKeys.push("mutates");
          }
        } else if (key === "produces") {
          meta.produces = parseProducesMap(raw);
          if (meta.produces === null)
            invalidKeys.push("produces");
        } else {
          meta[key] = raw;
        }
        continue;
      }
      purposeLines.push(stripped);
    } else if (inComment && line.trim() === "") {
      if (purposeLines.length)
        break;
    } else if (inComment) {
      break;
    }
  }
  const fallbackPurpose = purposeLines.length ? purposeLines.join(" ") : "(no description comment)";
  const purpose = meta.intent || fallbackPurpose;
  return {
    appId: appIdMatch ? appIdMatch[1] : null,
    purpose,
    id: meta.id,
    intent: meta.intent,
    tags: meta.tags,
    mutates: meta.mutates,
    status: meta.status,
    produces: meta.produces,
    metaFormat: presentKeys.size > 0 ? "m7" : "pre-m7",
    metaInvalid: invalidKeys
  };
}
function parseProducesMap(raw) {
  const trimmed = raw.trim();
  if (/^\{\s*\}$/.test(trimmed))
    return {};
  const inner = trimmed.replace(/^\{|\}$/g, "").trim();
  if (!inner)
    return null;
  const result = {};
  for (const part of inner.split(",")) {
    const kv = part.match(/^\s*([a-zA-Z_][\w.-]*)\s*:\s*(.+?)\s*$/);
    if (!kv)
      return null;
    const key = kv[1];
    const valueRaw = kv[2].trim();
    if (/^(true|false)$/i.test(valueRaw)) {
      result[key] = /^true$/i.test(valueRaw);
    } else if (/^-?\d+(\.\d+)?$/.test(valueRaw)) {
      result[key] = Number(valueRaw);
    } else {
      result[key] = valueRaw.replace(/^['"]|['"]$/g, "");
    }
  }
  return result;
}
function scanSkeletons() {
  const candidates = [
    path.join(flags.workspaceRoot, ".rn-agent", "skeleton.yaml"),
    path.join(flags.workspaceRoot, "test-app", ".rn-agent", "skeleton.yaml")
  ];
  const parent = path.dirname(flags.workspaceRoot);
  if (fs.existsSync(parent)) {
    for (const sib of safeReaddir(parent)) {
      candidates.push(path.join(parent, sib, "test-app", ".rn-agent", "skeleton.yaml"));
    }
  }
  const items = [];
  const seen = /* @__PURE__ */ new Set();
  for (const fp of candidates) {
    if (!fs.existsSync(fp))
      continue;
    const real = fs.realpathSync(fp);
    if (seen.has(real))
      continue;
    seen.add(real);
    const text = fs.readFileSync(fp, "utf8");
    const appIdMatch = text.match(/^appId:\s*([^\s#]+)/m);
    const screenKeys = (text.match(/^  [a-z][^:]*:\s*$/gm) || []).map((s) => s.trim().replace(/:$/, "")).filter((k) => !["screens", "navigation"].includes(k));
    const testIdCount = (text.match(/^[ \t]+[a-z][^:]*:\s+[a-z][^\s#]+/gim) || []).length;
    if (!matchKw(fp, appIdMatch ? appIdMatch[1] : ""))
      continue;
    items.push({
      path: fp,
      appId: appIdMatch ? appIdMatch[1] : null,
      screens: screenKeys.length,
      testIds: testIdCount
    });
  }
  return { items };
}
function scanPluginCommands() {
  const dir = path.join(flags.workspaceRoot, "commands");
  if (!fs.existsSync(dir))
    return { items: [] };
  const items = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".md"))
      continue;
    const fp = path.join(dir, f);
    const text = fs.readFileSync(fp, "utf8");
    const fm = parseFrontmatter(text);
    if (!fm["command"] && !fm["description"])
      continue;
    const name = fm["command"] || f.replace(/\.md$/, "");
    if (!matchKw(name, fm["description"], f))
      continue;
    items.push({
      command: `/rn-dev-agent:${name}`,
      description: truncate(fm["description"] || "(no description)", 160),
      path: fp
    });
  }
  items.sort((a, b) => a.command.localeCompare(b.command));
  return { items: items.slice(0, flags.max) };
}
function parseFrontmatter(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m)
    return {};
  const out = {};
  for (const line of m[1].split("\n")) {
    const km = line.match(/^([a-zA-Z][\w-]*):\s*(.*)$/);
    if (km) {
      let v = km[2].trim();
      if (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'")) {
        v = v.slice(1, -1);
      }
      out[km[1]] = v;
    }
  }
  return out;
}
function stripFrontmatter(text) {
  return text.replace(/^---\s*\n[\s\S]*?\n---\n?/, "");
}
function firstParagraph(text) {
  const trimmed = text.trim();
  const idx = trimmed.indexOf("\n\n");
  return (idx === -1 ? trimmed : trimmed.slice(0, idx)).replace(/\s+/g, " ").trim();
}
function truncate(s, n) {
  if (!s)
    return "";
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "\u2026";
}
function safeReaddir(p) {
  try {
    return fs.readdirSync(p);
  } catch {
    return [];
  }
}
var want = (s) => flags.section === "all" || flags.section === s;
var memories = want("a") ? scanMemories() : { items: [], exists: false, dir: void 0 };
var flows = want("b") ? scanFlows() : { items: [], roots: [] };
var skeletons = want("c") ? scanSkeletons() : { items: [] };
var commands = want("d") ? scanPluginCommands() : { items: [] };
var total = memories.items.length + flows.items.length + skeletons.items.length + commands.items.length;
if (flags.json) {
  process.stdout.write(JSON.stringify({
    cwd: process.cwd(),
    memoryCwd: flags.memoryCwd,
    filter: flags.filter || null,
    sections: {
      memories: { count: memories.items.length, dir: memories.dir, items: memories.items },
      flows: { count: flows.items.length, roots: flows.roots, items: flows.items },
      skeletons: { count: skeletons.items.length, items: skeletons.items },
      commands: { count: commands.items.length, items: commands.items }
    },
    total
  }, null, 2) + "\n");
  process.exit(total === 0 ? 3 : 0);
}
var parts = [];
parts.push(`# Learned actions${flags.filter ? ` (filter: "${flags.filter}")` : ""}`);
parts.push("");
if (want("a")) {
  parts.push(`## A. Feedback memories (${memories.items.length})`);
  if (!memories.exists) {
    parts.push(`_No memory directory at ${memories.dir}_`);
  } else if (memories.items.length === 0) {
    parts.push("_None match._");
  } else {
    parts.push("| Name | Description | File |");
    parts.push("|---|---|---|");
    for (const m of memories.items) {
      parts.push(`| ${escapeMarkdownTableCell(m.name)} | ${escapeMarkdownTableCell(m.description)} | \`${m.file}\` |`);
    }
  }
  parts.push("");
}
if (want("b")) {
  parts.push(`## B. Reusable Maestro flows (${flows.items.length})`);
  parts.push("_Source: `.rn-agent/actions/`._");
  if (flows.items.length === 0) {
    parts.push("_None match._");
    if (flows.roots.length) {
      parts.push(`_Searched: ${flows.roots.map((r) => "`" + r + "`").join(", ")}_`);
    }
  } else {
    parts.push("| Flow | Purpose | App ID | Mutates | Status | Tags | Produces | Replay |");
    parts.push("|---|---|---|---|---|---|---|---|");
    for (const f of flows.items) {
      const absent = f.metaFormat === "pre-m7" ? "pre-M7" : "-";
      const mut = f.mutates === null || f.mutates === void 0 ? f.metaInvalid.includes("mutates") ? "?" : absent : f.mutates ? "yes" : "no";
      const status = f.status || absent;
      const tags = f.tags ? f.tags.length ? f.tags.join(", ") : "-" : absent;
      const produces = f.produces ? Object.keys(f.produces).length ? formatProducesCell(f.produces) : "-" : f.metaInvalid.includes("produces") ? "?" : absent;
      parts.push(`| \`${f.flow}\` | ${escapeMarkdownTableCell(f.purpose)} | \`${f.appId || "?"}\` | ${mut} | ${status} | ${escapeMarkdownTableCell(tags)} | ${escapeMarkdownTableCell(produces)} | \`${f.replay}\` |`);
    }
  }
  parts.push("");
}
if (want("c")) {
  parts.push(`## C. UI skeletons (${skeletons.items.length})`);
  if (skeletons.items.length === 0) {
    parts.push("_None found._");
  } else {
    parts.push("| Path | App ID | Screens | testIDs |");
    parts.push("|---|---|---|---|");
    for (const s of skeletons.items) {
      parts.push(`| \`${s.path}\` | \`${s.appId || "?"}\` | ${s.screens} | ${s.testIds} |`);
    }
  }
  parts.push("");
}
if (want("d")) {
  parts.push(`## D. Plugin commands (${commands.items.length})`);
  if (commands.items.length === 0) {
    parts.push("_Not running inside the plugin repo._");
  } else {
    for (const c of commands.items) {
      parts.push(`- \`${c.command}\` \u2014 ${escapeMarkdownTableCell(c.description)}`);
    }
  }
  parts.push("");
}
parts.push("---");
parts.push("**Reminder:** For any UI flow, replay a compatible owned action from section B through `cdp_run_action` before composing `device_*` primitives. Missing or incompatible owned automation is terminal; manual walks are not an authorized fallback.");
process.stdout.write(parts.join("\n") + "\n");
process.exit(total === 0 ? 3 : 0);
function escapeMarkdownTableCell(s) {
  return (s || "").toString().replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
function formatProducesCell(produces) {
  const keys = Object.keys(produces).sort();
  return keys.map((k) => `${k}=${produces[k]}`).join(", ");
}
