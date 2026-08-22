#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/learned-actions.js
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// packages/rn-dev-agent-core/dist/domain/unfollowed-file.js
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
function readUnfollowedFile(path2) {
  let fd;
  try {
    fd = openSync(path2, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT")
      throw err;
    throw new Error(`Refusing inherited action symlink at ${path2}.`);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      throw new Error(`Refusing inherited action symlink at ${path2}.`);
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
import { spawnSync } from "node:child_process";
import { closeSync as closeSync2, constants as constants2, existsSync, fstatSync as fstatSync2, lstatSync, mkdirSync, openSync as openSync2, readFileSync as readFileSync2, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}
function toPosix(path2) {
  return sep === "/" ? path2 : path2.split(sep).join("/");
}
function isRnAppRoot(directory) {
  const manifest = join(directory, "package.json");
  try {
    const parsed = JSON.parse(readFileSync2(manifest, "utf8"));
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
  const appRootInput = canonical(input.appRoot ? resolve(input.appRoot) : cwd);
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
  const primaryAppRoot = appRelative === "." ? primaryRoot : join(primaryRoot, appRelative);
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
function classifySource(path2, type, boundary) {
  const rel = relative(boundary, path2);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { state: "WRONG_TYPE" };
  }
  const paths = [boundary];
  let cursor = boundary;
  for (const component of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, component);
    paths.push(cursor);
  }
  const inspect = () => {
    const evidence = [];
    for (let index = 0; index < paths.length; index += 1) {
      let node;
      try {
        node = lstatSync(paths[index], { bigint: true });
      } catch (error) {
        const code = error.code;
        if (code === "EACCES" || code === "EPERM")
          return { state: "PERMISSION_DENIED" };
        return { state: "MISSING" };
      }
      if (node.isSymbolicLink())
        return { state: "WRONG_TYPE" };
      const isLeaf = index === paths.length - 1;
      const typeOk = isLeaf ? type === "directory" ? node.isDirectory() : node.isFile() : node.isDirectory();
      if (!typeOk)
        return { state: "WRONG_TYPE" };
      evidence.push({ dev: String(node.dev), ino: String(node.ino) });
    }
    const resolved = canonical(path2);
    if (!resolved || !contained(boundary, resolved))
      return { state: "WRONG_TYPE" };
    return { state: "AVAILABLE", evidence };
  };
  const before = inspect();
  if (before.state !== "AVAILABLE")
    return before;
  const after = inspect();
  if (after.state !== "AVAILABLE" || !sameSourceEvidence(before.evidence, after.evidence)) {
    return { state: "WRONG_TYPE" };
  }
  return after;
}
function sameSourceEvidence(left, right) {
  if (!left || !right)
    return left === right;
  return left.length === right.length && left.every((identity, index) => {
    const candidate = right[index];
    return identity.dev === candidate.dev && identity.ino === candidate.ino;
  });
}
function classifyDestination(path2, sourcePath, type) {
  let link;
  try {
    link = lstatSync(path2, { bigint: true });
  } catch (error) {
    const code = error.code;
    if (code === "EACCES" || code === "EPERM")
      return { state: "PERMISSION_DENIED" };
    return { state: "MISSING" };
  }
  if (!link.isSymbolicLink()) {
    if (link.isDirectory())
      return { state: "DIRECTORY" };
    return { state: "FILE" };
  }
  const evidence = { dev: String(link.dev), ino: String(link.ino) };
  const resolved = canonical(path2);
  if (!resolved)
    return { state: "LINK_STALE", evidence };
  const expected = sourcePath ? canonical(sourcePath) : null;
  if (!expected || resolved !== expected)
    return { state: "LINK_FOREIGN", evidence };
  try {
    const stats = statSync(resolved);
    const typeOk = type === "directory" ? stats.isDirectory() : stats.isFile();
    return { state: typeOk ? "LINK_VALID" : "LINK_FOREIGN", evidence };
  } catch {
    return { state: "LINK_STALE", evidence };
  }
}
function identityOf(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function lstatIfPresent(path2) {
  try {
    return lstatSync(path2, { bigint: true });
  } catch (error) {
    if (error.code === "ENOENT")
      return null;
    throw error;
  }
}
function refuseCorpus(reason) {
  return { status: "refused", reason };
}
function refuseForeignActions(actionsDir) {
  return refuseCorpus(`Refusing foreign learned-action corpus symlink at ${actionsDir}.`);
}
function refuseReplacedActions(actionsDir) {
  return refuseCorpus(`Refusing replaced learned-action corpus symlink at ${actionsDir}.`);
}
function refuseDanglingActions(actionsDir) {
  return refuseCorpus(`Refusing dangling learned-action corpus symlink at ${actionsDir}.`);
}
function directoryIdentityUnchanged(path2, expected) {
  const current = lstatIfPresent(path2);
  return Boolean(current && !current.isSymbolicLink() && current.isDirectory() && String(current.dev) === expected.dev && String(current.ino) === expected.ino);
}
function openUnfollowedDirectory(path2, expected) {
  let fd;
  try {
    fd = openSync2(path2, constants2.O_RDONLY | constants2.O_NOFOLLOW | constants2.O_DIRECTORY);
  } catch {
    return false;
  }
  try {
    const opened = fstatSync2(fd, { bigint: true });
    return opened.isDirectory() && String(opened.dev) === expected.dev && String(opened.ino) === expected.ino;
  } finally {
    closeSync2(fd);
  }
}
function resolveReadableActionCorpus(projectRoot) {
  const root = canonical(projectRoot) ?? resolve(projectRoot);
  const rnAgentDir = join(root, ".rn-agent");
  const actionsDir = join(rnAgentDir, "actions");
  const rnAgentStat = lstatIfPresent(rnAgentDir);
  if (!rnAgentStat)
    return { status: "absent" };
  if (rnAgentStat.isSymbolicLink() || !rnAgentStat.isDirectory()) {
    return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  const rnAgentIdentity = identityOf(rnAgentStat);
  if (!openUnfollowedDirectory(rnAgentDir, rnAgentIdentity)) {
    return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  const actionsStat = lstatIfPresent(actionsDir);
  if (!directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
    return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
  }
  if (!actionsStat)
    return { status: "absent" };
  if (!actionsStat.isSymbolicLink()) {
    if (!actionsStat.isDirectory())
      return { status: "absent" };
    const identity = identityOf(actionsStat);
    if (!openUnfollowedDirectory(actionsDir, identity)) {
      return refuseReplacedActions(actionsDir);
    }
    if (!directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
      return refuseCorpus(`Refusing learned-action corpus symlink at ${rnAgentDir}.`);
    }
    if (!directoryIdentityUnchanged(actionsDir, identity)) {
      return refuseReplacedActions(actionsDir);
    }
    return {
      status: "owned-directory",
      projectRoot: root,
      rnAgentDir,
      actionsDir,
      identity
    };
  }
  const layout = resolveWorktreeLayout({ cwd: root, appRoot: root });
  if (!("kind" in layout) || layout.kind !== "linked" || layout.refusal || !layout.primaryRoot || !layout.primaryAppRoot) {
    return refuseForeignActions(actionsDir);
  }
  const primaryRnAgentDir = join(layout.primaryAppRoot, ".rn-agent");
  const primaryActionsDir = join(primaryRnAgentDir, "actions");
  const source = classifySource(primaryActionsDir, "directory", layout.primaryRoot);
  const destination = classifyDestination(actionsDir, primaryActionsDir, "directory");
  if (destination.state === "LINK_STALE")
    return refuseDanglingActions(actionsDir);
  if (source.state !== "AVAILABLE" || destination.state !== "LINK_VALID" || !destination.evidence) {
    return refuseForeignActions(actionsDir);
  }
  const targetDir = canonical(primaryActionsDir);
  if (!targetDir)
    return refuseForeignActions(actionsDir);
  const targetStat = lstatIfPresent(targetDir);
  if (!targetStat || targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    return refuseForeignActions(actionsDir);
  }
  const targetIdentity = identityOf(targetStat);
  if (!openUnfollowedDirectory(targetDir, targetIdentity)) {
    return refuseReplacedActions(actionsDir);
  }
  const destinationAfter = classifyDestination(actionsDir, primaryActionsDir, "directory");
  const sourceAfter = classifySource(primaryActionsDir, "directory", layout.primaryRoot);
  if (destinationAfter.state !== "LINK_VALID" || !destinationAfter.evidence || destinationAfter.evidence.dev !== destination.evidence.dev || destinationAfter.evidence.ino !== destination.evidence.ino || sourceAfter.state !== "AVAILABLE" || !sameSourceEvidence(source.evidence, sourceAfter.evidence) || !directoryIdentityUnchanged(rnAgentDir, rnAgentIdentity)) {
    return refuseReplacedActions(actionsDir);
  }
  return {
    status: "approved-inherited",
    projectRoot: root,
    rnAgentDir,
    actionsDir,
    targetDir,
    linkIdentity: destination.evidence,
    targetIdentity
  };
}
function sameReadableActionCorpus(left, right) {
  if (left.status !== right.status)
    return false;
  if (left.status === "absent")
    return true;
  if (left.status === "refused") {
    return right.status === "refused" && left.reason === right.reason;
  }
  if (left.status === "owned-directory" && right.status === "owned-directory") {
    return left.actionsDir === right.actionsDir && left.identity.dev === right.identity.dev && left.identity.ino === right.identity.ino;
  }
  return left.status === "approved-inherited" && right.status === "approved-inherited" && left.actionsDir === right.actionsDir && left.targetDir === right.targetDir && left.linkIdentity.dev === right.linkIdentity.dev && left.linkIdentity.ino === right.linkIdentity.ino && left.targetIdentity.dev === right.targetIdentity.dev && left.targetIdentity.ino === right.targetIdentity.ino;
}
function readableActionsDirectory(corpus) {
  if (corpus.status === "owned-directory")
    return corpus.actionsDir;
  if (corpus.status === "approved-inherited")
    return corpus.targetDir;
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
function isDirectNode(target, kind) {
  try {
    const stat = fs.lstatSync(target);
    return !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile());
  } catch {
    return false;
  }
}
function resolveFlowFile(actionsDir, id) {
  const yamlPath = path.join(actionsDir, `${id}.yaml`);
  const ymlPath = path.join(actionsDir, `${id}.yml`);
  const yamlExists = isDirectNode(yamlPath, "file");
  const ymlExists = isDirectNode(ymlPath, "file");
  if (yamlExists && ymlExists)
    return null;
  if (yamlExists)
    return yamlPath;
  if (ymlExists)
    return ymlPath;
  return null;
}
function classifyFlowRoot(actionsDir) {
  if (path.basename(actionsDir) !== "actions" || path.basename(path.dirname(actionsDir)) !== ".rn-agent") {
    return null;
  }
  const corpus = resolveReadableActionCorpus(path.dirname(path.dirname(actionsDir)));
  if (corpus.status !== "owned-directory" && corpus.status !== "approved-inherited")
    return null;
  return corpus;
}
function scanFlows() {
  const roots = collectFlowRoots(flags.workspaceRoot);
  const items = [];
  for (const root of roots) {
    const corpus = classifyFlowRoot(root);
    if (!corpus)
      continue;
    const readable = readableActionsDirectory(corpus);
    if (!readable)
      continue;
    let files;
    try {
      files = fs.readdirSync(readable);
    } catch {
      continue;
    }
    const afterRead = classifyFlowRoot(root);
    if (!afterRead || !sameReadableActionCorpus(corpus, afterRead))
      continue;
    const ids = [
      ...new Set(files.filter((file) => /\.ya?ml$/.test(file)).map((file) => file.replace(/\.ya?ml$/, "")))
    ];
    const rootItems = [];
    for (const id of ids) {
      const fp = resolveFlowFile(readable, id);
      if (!fp)
        continue;
      const f = path.basename(fp);
      const reportedPath = path.join(root, f);
      let text;
      try {
        text = readUnfollowedFile(fp);
      } catch {
        continue;
      }
      const afterFile = classifyFlowRoot(root);
      if (!afterFile || !sameReadableActionCorpus(corpus, afterFile)) {
        rootItems.length = 0;
        break;
      }
      const meta = parseFlowMeta(text);
      if (flags.appId && meta.appId !== flags.appId)
        continue;
      const tagsStr = (meta.tags || []).join(",");
      if (!matchKw(meta.purpose, meta.appId, meta.intent, tagsStr, f, reportedPath))
        continue;
      const params = (text.match(/\$\{([A-Z_][A-Z0-9_]*)\}/g) || []).map((s) => s.slice(2, -1));
      const uniqParams = Array.from(new Set(params));
      const replay = replayHint(meta.id, reportedPath, uniqParams);
      rootItems.push({
        flow: f.replace(/\.ya?ml$/, ""),
        path: reportedPath,
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
    const finalCorpus = classifyFlowRoot(root);
    if (finalCorpus && sameReadableActionCorpus(corpus, finalCorpus))
      items.push(...rootItems);
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
