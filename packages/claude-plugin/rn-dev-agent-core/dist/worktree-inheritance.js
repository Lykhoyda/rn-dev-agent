#!/usr/bin/env node
import { createRequire as __rnCreateRequire } from "node:module"; const require = __rnCreateRequire(import.meta.url);

// packages/rn-dev-agent-core/dist/worktree-inheritance.js
import { spawnSync as spawnSync2 } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, rmSync as rmSync2, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join as join2, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";

// packages/rn-dev-agent-core/dist/session/worktree-inheritance.js
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
var SHAREABLE_RESOURCES = [
  {
    id: "rn-agent-actions",
    label: "learned action corpus (.rn-agent/actions)",
    type: "directory",
    anchor: "app",
    path: ".rn-agent/actions",
    parent: ".rn-agent",
    hosts: ["claude", "codex"]
  }
];
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
function canonical(path) {
  try {
    return realpathSync(path);
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
function toPosix(path) {
  return sep === "/" ? path : path.split(sep).join("/");
}
function isRnAppRoot(directory) {
  const manifest = join(directory, "package.json");
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
function classifySource(path, type) {
  let link;
  try {
    link = lstatSync(path);
  } catch (error) {
    const code = error.code;
    if (code === "EACCES" || code === "EPERM")
      return "PERMISSION_DENIED";
    return "MISSING";
  }
  if (link.isSymbolicLink()) {
    const target = canonical(path);
    if (!target)
      return "MISSING";
    try {
      const resolved = statSync(target);
      return (type === "directory" ? resolved.isDirectory() : resolved.isFile()) ? "AVAILABLE" : "WRONG_TYPE";
    } catch {
      return "MISSING";
    }
  }
  if (type === "directory")
    return link.isDirectory() ? "AVAILABLE" : "WRONG_TYPE";
  return link.isFile() ? "AVAILABLE" : "WRONG_TYPE";
}
function classifyDestination(path, sourcePath, type) {
  let link;
  try {
    link = lstatSync(path, { bigint: true });
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
  const resolved = canonical(path);
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
function isTracked(worktreeRoot, relativePath) {
  const listed = git(worktreeRoot, ["ls-files", "--", relativePath]);
  return listed.ok && listed.stdout.trim().length > 0;
}
function isIgnoreSafe(worktreeRoot, relativePath) {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-q", "--", relativePath], {
    cwd: worktreeRoot,
    encoding: "utf8",
    env: gitEnvironment(),
    stdio: "ignore"
  });
  return !result.error && result.status === 0;
}
function resourcesForHost(host) {
  return SHAREABLE_RESOURCES.filter((resource) => resource.hosts.includes(host));
}
function anchorFor(layout, resource) {
  if (resource.anchor === "worktree-root") {
    return { local: layout.worktreeRoot, source: layout.primaryRoot ?? "" };
  }
  return { local: layout.appRoot, source: layout.primaryAppRoot ?? "" };
}
function destinationRelative(layout, resource) {
  if (resource.anchor === "worktree-root")
    return resource.path;
  return layout.appRelative === "." ? resource.path : `${layout.appRelative}/${resource.path}`;
}
function planInheritance(input) {
  const rootOnly = input.rootResourcesOnly === true && SHAREABLE_RESOURCES.filter((r) => !input.resources || input.resources.includes(r.id)).every((r) => r.anchor === "worktree-root");
  const layout = resolveWorktreeLayout({
    cwd: input.cwd,
    appRoot: input.appRoot,
    allowNonRnApp: rootOnly
  });
  if (!("worktreeRoot" in layout)) {
    return {
      layout: {
        kind: "primary",
        worktreeRoot: "",
        commonDir: "",
        gitDir: "",
        appRoot: "",
        appRelative: "."
      },
      host: input.host,
      resources: [],
      refusal: layout.refusal
    };
  }
  if (layout.refusal || layout.kind === "primary") {
    return { layout, host: input.host, resources: [], refusal: layout.refusal };
  }
  const selected = resourcesForHost(input.host).filter((resource) => !input.resources || input.resources.includes(resource.id));
  const resources = selected.map((resource) => planResource(layout, resource));
  return { layout, host: input.host, resources };
}
function planResource(layout, resource) {
  const anchor = anchorFor(layout, resource);
  const destination = join(anchor.local, resource.path);
  const destinationRel = destinationRelative(layout, resource);
  const source = anchor.source ? join(anchor.source, resource.path) : void 0;
  const sourceState = source ? classifySource(source, resource.type) : "MISSING";
  const { state: destinationState, evidence } = classifyDestination(destination, source, resource.type);
  const linkedParent = resource.parent !== void 0 ? classifyLegacyParent(layout, anchor.local, resource.parent) : null;
  const parentRelative = resource.parent === void 0 ? void 0 : toPosix(layout.appRelative === "." ? resource.parent : `${layout.appRelative}/${resource.parent}`);
  const ignoreSafe = isIgnoreSafe(layout.worktreeRoot, destinationRel) || linkedParent !== null && parentRelative !== void 0 && (isIgnoreSafe(layout.worktreeRoot, parentRelative) || isIgnoreSafe(layout.worktreeRoot, `${parentRelative}/`));
  const base = {
    id: resource.id,
    label: resource.label,
    destination: toPosix(destinationRel),
    sourceState,
    destinationState,
    ignoreSafe,
    evidence
  };
  const gitManaged = isTracked(layout.worktreeRoot, destinationRel) || resource.parent !== void 0 && isTracked(layout.worktreeRoot, toPosix(layout.appRelative === "." ? resource.parent : `${layout.appRelative}/${resource.parent}`));
  if (gitManaged) {
    return {
      ...base,
      regime: "GIT_MANAGED",
      state: "TRACKED",
      action: "none",
      remediation: "Git owns this path; the tracked/team regime is never replaced or inherited."
    };
  }
  const regime = sourceState === "AVAILABLE" ? "PRIVATE_SOURCE_AVAILABLE" : "NO_SOURCE";
  if (linkedParent) {
    if (linkedParent !== "expected") {
      return {
        ...base,
        regime,
        state: "LINK_FOREIGN",
        action: "none",
        remediation: `The whole "${resource.parent}" directory is a foreign symlink. Nothing is read from or written through it.`
      };
    }
    if (sourceState !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: sourceState === "WRONG_TYPE" ? "SOURCE_WRONG_TYPE" : "SOURCE_MISSING",
        action: "none",
        remediation: "The legacy root link is recognized, but the canonical actions source is unavailable."
      };
    }
    return {
      ...base,
      regime,
      state: "LEGACY_ROOT_LINK",
      action: "migrate",
      remediation: "Replace the legacy whole-root link with a real local .rn-agent directory containing only the inherited actions link. Mutable integration, state, recordings, and runtime data are not copied."
    };
  }
  if (destinationState === "PERMISSION_DENIED" || sourceState === "PERMISSION_DENIED") {
    return {
      ...base,
      regime,
      state: "PERMISSION_DENIED",
      action: "none",
      remediation: "Permission denied while inspecting this path; fix permissions and re-run."
    };
  }
  if (destinationState === "FILE") {
    return { ...base, regime, state: "COLLISION_FILE", action: "none", remediation: LOCAL_CONTENT };
  }
  if (destinationState === "DIRECTORY") {
    return {
      ...base,
      regime,
      state: "COLLISION_DIRECTORY",
      action: "none",
      remediation: LOCAL_CONTENT
    };
  }
  if (destinationState === "LINK_VALID") {
    return {
      ...base,
      regime,
      state: ignoreSafe ? "LINK_VALID_SAFE" : "LINK_VALID_GIT_VISIBLE",
      action: "none",
      remediation: ignoreSafe ? void 0 : ignoreRemediation(base.destination)
    };
  }
  if (destinationState === "LINK_FOREIGN") {
    return {
      ...base,
      regime,
      state: "LINK_FOREIGN",
      action: "none",
      remediation: "Destination is a symlink to something else; /rn-dev-agent:setup can re-point it after explicit confirmation."
    };
  }
  if (destinationState === "LINK_STALE") {
    if (sourceState !== "AVAILABLE") {
      return {
        ...base,
        regime,
        state: "LINK_STALE_SOURCE_MISSING",
        action: "none",
        remediation: "Destination is a broken symlink and no canonical source is available; restore the source first."
      };
    }
    return {
      ...base,
      regime,
      state: "LINK_STALE_SOURCE_AVAILABLE",
      action: "repair",
      remediation: "Run /rn-dev-agent:setup to repair the broken link after confirmation."
    };
  }
  if (sourceState === "MISSING") {
    return {
      ...base,
      regime,
      state: "SOURCE_MISSING",
      action: "none",
      remediation: "No canonical source in the primary worktree; nothing to inherit."
    };
  }
  if (sourceState === "WRONG_TYPE") {
    return {
      ...base,
      regime,
      state: "SOURCE_WRONG_TYPE",
      action: "none",
      remediation: `Canonical source is not a ${resource.type}; refusing to link.`
    };
  }
  if (!ignoreSafe) {
    return {
      ...base,
      regime,
      state: "IGNORE_UNSAFE",
      action: "none",
      remediation: ignoreRemediation(base.destination)
    };
  }
  return { ...base, regime, state: "DEST_MISSING", action: "link" };
}
var LOCAL_CONTENT = "Local real content is present; it is never overwritten and is not shared.";
function ignoreRemediation(destination) {
  return `Git would see this path. Add the file-form rule "/${destination}" (no trailing slash) to your own local ignore policy, then re-run.`;
}
function classifyLegacyParent(layout, localAnchor, parent) {
  const localParent = join(localAnchor, parent);
  let stats;
  try {
    stats = lstatSync(localParent);
  } catch {
    return null;
  }
  if (!stats.isSymbolicLink())
    return null;
  const resolved = canonical(localParent);
  const expected = layout.primaryAppRoot ? canonical(join(layout.primaryAppRoot, parent)) : null;
  return resolved && expected && resolved === expected ? "expected" : "foreign";
}
function bindLinkParent(destination, anchor) {
  const parent = destination.slice(0, destination.lastIndexOf(sep));
  if (!parent)
    return null;
  if (!existsSync(parent))
    mkdirSync(parent, { recursive: true, mode: 448 });
  try {
    const stats = lstatSync(parent, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory())
      return null;
    const real = canonical(parent);
    if (!real || !contained(anchor, real))
      return null;
    return { dev: String(stats.dev), ino: String(stats.ino) };
  } catch {
    return null;
  }
}
function sameDirectoryIdentity(path, expected) {
  try {
    const stats = lstatSync(path, { bigint: true });
    return !stats.isSymbolicLink() && stats.isDirectory() && String(stats.dev) === expected.dev && String(stats.ino) === expected.ino;
  } catch {
    return false;
  }
}
function applyInheritance(input) {
  const plan = planInheritance(input);
  const outcomes = [];
  let applied = 0;
  for (const resourcePlan of plan.resources) {
    const spec = SHAREABLE_RESOURCES.find((entry) => entry.id === resourcePlan.id);
    const anchor = anchorFor(plan.layout, spec);
    const destination = join(anchor.local, spec.path);
    const source = anchor.source ? join(anchor.source, spec.path) : void 0;
    if (resourcePlan.action === "none") {
      outcomes.push({
        id: resourcePlan.id,
        applied: false,
        state: resourcePlan.state,
        result: resourcePlan.state === "LINK_VALID_SAFE" ? "converged" : "skipped",
        reason: resourcePlan.remediation
      });
      continue;
    }
    if ((resourcePlan.action === "repair" || resourcePlan.action === "migrate") && !input.allowRepair) {
      outcomes.push({
        id: resourcePlan.id,
        applied: false,
        state: resourcePlan.state,
        result: "skipped",
        reason: `${resourcePlan.action} requires explicit confirmation`
      });
      continue;
    }
    const revalidated = planResource(plan.layout, spec);
    if (revalidated.state !== resourcePlan.state || revalidated.action !== resourcePlan.action) {
      outcomes.push({
        id: resourcePlan.id,
        applied: false,
        state: revalidated.state,
        result: "refused",
        reason: "state changed between plan and apply; re-plan and retry"
      });
      continue;
    }
    if (revalidated.action === "migrate") {
      const outcome2 = migrateLegacyRoot(source, destination, plan.layout, spec);
      if (outcome2.result === "repaired")
        applied += 1;
      outcomes.push({ ...outcome2, id: resourcePlan.id });
      continue;
    }
    if (revalidated.action === "repair") {
      if (!removeStaleLink(destination, revalidated.evidence)) {
        outcomes.push({
          id: resourcePlan.id,
          applied: false,
          state: revalidated.state,
          result: "refused",
          reason: "stale link changed between plan and apply"
        });
        continue;
      }
    }
    const outcome = createLink(source, destination, plan.layout, spec, revalidated.action);
    if (outcome.result === "linked" || outcome.result === "repaired")
      applied += 1;
    outcomes.push({ ...outcome, id: resourcePlan.id });
  }
  return { outcomes, applied, requested: plan.resources.length, refusal: plan.refusal };
}
function migrateLegacyRoot(source, destination, layout, spec) {
  const root = join(layout.appRoot, spec.parent);
  const staged = `${root}.local.${process.pid}.${probeCounter++}`;
  const backup = `${root}.legacy.${process.pid}.${probeCounter++}`;
  let original = null;
  try {
    const rootStats = lstatSync(root, { bigint: true });
    if (!rootStats.isSymbolicLink()) {
      return {
        applied: false,
        state: "COLLISION_DIRECTORY",
        result: "refused",
        reason: "legacy root changed before migration"
      };
    }
    original = { dev: String(rootStats.dev), ino: String(rootStats.ino) };
    const expectedRoot = layout.primaryAppRoot ? canonical(join(layout.primaryAppRoot, spec.parent)) : null;
    if (!expectedRoot || canonical(root) !== expectedRoot) {
      return {
        applied: false,
        state: "LINK_FOREIGN",
        result: "refused",
        reason: "legacy root no longer points to the verified primary worktree"
      };
    }
    mkdirSync(staged, { mode: 448 });
    symlinkSync(source, join(staged, spec.path.slice(`${spec.parent}/`.length)), "dir");
    const stagedAction = join(staged, spec.path.slice(`${spec.parent}/`.length));
    if (canonical(stagedAction) !== canonical(source)) {
      throw new Error("staged actions link did not resolve to the canonical source");
    }
    const current = lstatSync(root, { bigint: true });
    if (!current.isSymbolicLink() || String(current.dev) !== original.dev || String(current.ino) !== original.ino) {
      throw new Error("legacy root changed during migration");
    }
    renameSync(root, backup);
    try {
      renameSync(staged, root);
    } catch (error) {
      renameSync(backup, root);
      throw error;
    }
    const settled = planResource(layout, spec);
    if (settled.state !== "LINK_VALID_SAFE") {
      rmSync(root, { force: true, recursive: true });
      renameSync(backup, root);
      return {
        applied: false,
        state: settled.state,
        result: "refused",
        reason: "the split layout would be Git-visible; the legacy link was restored"
      };
    }
    unlinkSync(backup);
    return {
      applied: true,
      state: "LINK_VALID_SAFE",
      result: "repaired",
      reason: "legacy whole-root link migrated without copying mutable data"
    };
  } catch (error) {
    try {
      if (!existsSync(root) && existsSync(backup))
        renameSync(backup, root);
    } catch {
      return {
        applied: false,
        state: "LEGACY_ROOT_LINK",
        result: "refused",
        reason: "migration failed and the legacy root could not be restored"
      };
    }
    return {
      applied: false,
      state: "LEGACY_ROOT_LINK",
      result: "refused",
      reason: error instanceof Error ? error.message : "legacy migration failed"
    };
  } finally {
    rmSync(staged, { force: true, recursive: true });
  }
}
function removeStaleLink(destination, evidence) {
  try {
    const current = lstatSync(destination, { bigint: true });
    if (!current.isSymbolicLink())
      return false;
    if (!evidence)
      return false;
    if (String(current.dev) !== evidence.dev || String(current.ino) !== evidence.ino)
      return false;
    unlinkSync(destination);
    return true;
  } catch {
    return false;
  }
}
function probeLinkTarget(parentIdentity, destination, source, spec) {
  const parent = destination.slice(0, destination.lastIndexOf(sep));
  const probe = join(parent, `.rn-dev-agent-probe.${process.pid}.${probeCounter++}`);
  const refuse = (state, reason) => ({
    applied: false,
    state,
    result: "refused",
    reason
  });
  try {
    symlinkSync(source, probe, spec.type === "directory" ? "dir" : "file");
  } catch {
    return refuse("PERMISSION_DENIED", "could not verify the link target before creating it");
  }
  try {
    const resolved = canonical(probe);
    if (!resolved || resolved !== canonical(source)) {
      return refuse("SOURCE_MISSING", "the canonical source disappeared before the link was created");
    }
    const stats = statSync(resolved);
    const typeOk = spec.type === "directory" ? stats.isDirectory() : stats.isFile();
    if (!typeOk)
      return refuse("SOURCE_WRONG_TYPE", `the canonical source is not a ${spec.type}`);
    if (!sameDirectoryIdentity(parent, parentIdentity)) {
      return refuse("COLLISION_DIRECTORY", "the destination parent changed during apply");
    }
    return null;
  } catch {
    return refuse("SOURCE_MISSING", "the canonical source could not be verified");
  } finally {
    try {
      unlinkSync(probe);
    } catch {
    }
  }
}
var probeCounter = 0;
function createLink(source, destination, layout, spec, action) {
  const anchor = anchorFor(layout, spec).local;
  const parentIdentity = bindLinkParent(destination, anchor);
  if (!parentIdentity) {
    return {
      applied: false,
      state: "COLLISION_DIRECTORY",
      result: "refused",
      reason: "destination parent is not a real directory inside this worktree"
    };
  }
  const probe = probeLinkTarget(parentIdentity, destination, source, spec);
  if (probe)
    return probe;
  try {
    symlinkSync(source, destination, spec.type === "directory" ? "dir" : "file");
  } catch (error) {
    const code = error.code;
    if (code === "EEXIST") {
      const settled2 = planResource(layout, spec);
      if (settled2.state === "LINK_VALID_SAFE") {
        return { applied: false, state: settled2.state, result: "converged" };
      }
      return {
        applied: false,
        state: settled2.state,
        result: "refused",
        reason: "destination appeared during apply; nothing was overwritten"
      };
    }
    if (code === "EACCES" || code === "EPERM") {
      return {
        applied: false,
        state: "PERMISSION_DENIED",
        result: "refused",
        reason: "permission denied creating the link"
      };
    }
    return {
      applied: false,
      state: "DEST_MISSING",
      result: "refused",
      reason: "link creation failed"
    };
  }
  const createdIdentity = linkIdentity(destination);
  const parentDirectory = destination.slice(0, destination.lastIndexOf(sep));
  const settled = planResource(layout, spec);
  if (!sameDirectoryIdentity(parentDirectory, parentIdentity) || settled.state !== "LINK_VALID_SAFE") {
    const removed = rollbackLink(destination, source, createdIdentity);
    return {
      applied: false,
      state: settled.state,
      result: "refused",
      reason: removed ? "the link did not settle valid and safe; it was removed" : "the link did not settle valid and safe and could not be removed \u2014 inspect it manually"
    };
  }
  return {
    applied: true,
    state: "LINK_VALID_SAFE",
    result: action === "repair" ? "repaired" : "linked"
  };
}
function linkIdentity(path) {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (!stats.isSymbolicLink())
      return null;
    return { dev: String(stats.dev), ino: String(stats.ino) };
  } catch {
    return null;
  }
}
function rollbackLink(destination, source, created) {
  if (!created)
    return false;
  try {
    const current = linkIdentity(destination);
    if (!current || current.dev !== created.dev || current.ino !== created.ino)
      return false;
    if (readlinkSync(destination) !== source)
      return false;
    unlinkSync(destination);
    lstatSync(destination);
    return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

// packages/rn-dev-agent-core/dist/worktree-inheritance.js
var HOOK_MARKER = "# rn-dev-agent:worktree-inheritance";
var HOOK_STATE_DIR = "rn-dev-agent";
var HOOK_HELPER = "worktree-inheritance.js";
var HOOK_CONFIG = "worktree-inheritance.json";
var LAST_RUN = "worktree-inheritance-last-run.json";
var COMMANDS = ["plan", "report", "apply", "hook", "post-checkout"];
var HOOK_SUBCOMMANDS = ["status", "install", "uninstall"];
function parseFlags(argv) {
  try {
    return parseFlagsStrict(argv);
  } catch {
    return null;
  }
}
function parseFlagsStrict(argv) {
  const positional = [];
  let hostGiven = false;
  const flags = {
    command: "plan",
    subcommand: "",
    cwd: process.cwd(),
    host: "claude",
    json: false,
    allowRepair: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const next = () => {
      const value = argv[++i];
      if (value === void 0 || value.startsWith("--"))
        throw new RangeError(arg);
      return value;
    };
    switch (arg) {
      case "--json":
        flags.json = true;
        break;
      case "--allow-repair":
        flags.allowRepair = true;
        break;
      case "--app-root":
        flags.appRoot = next();
        break;
      case "--cwd":
        flags.cwd = next();
        break;
      case "--config":
        flags.config = next();
        break;
      case "--host": {
        const host = next();
        if (host !== "claude" && host !== "codex")
          return null;
        flags.host = host;
        hostGiven = true;
        break;
      }
      case "--resource": {
        const id = next();
        if (id !== "rn-agent-actions")
          return null;
        flags.resources = [...flags.resources ?? [], id];
        break;
      }
      default:
        return null;
    }
  }
  if (positional.length > 2)
    return null;
  if (positional[0])
    flags.command = positional[0];
  if (positional[1])
    flags.subcommand = positional[1];
  if (!COMMANDS.includes(flags.command))
    return null;
  if (flags.command === "hook") {
    if (flags.subcommand === "")
      flags.subcommand = "status";
    if (!HOOK_SUBCOMMANDS.includes(flags.subcommand))
      return null;
  } else if (flags.subcommand !== "") {
    return null;
  }
  const supported = resourcesForHost(flags.host).map((resource) => resource.id);
  if (flags.resources?.some((id) => !supported.includes(id)))
    return null;
  const mutating = flags.command === "apply" || flags.subcommand === "install";
  if (mutating && !hostGiven)
    return null;
  return flags;
}
var REFUSAL_TEXT = {
  NOT_GIT: "not a Git working tree",
  BARE: "bare repository \u2014 no checkout to inherit from",
  GIT_UNAVAILABLE: "Git could not resolve this repository",
  NOT_RN_APP: "no React Native app manifest at the given app root",
  APP_OUTSIDE_WORKTREE: "the given app root is outside this worktree",
  NO_PRIMARY: "no verified primary worktree for this repository",
  AMBIGUOUS: "multiple verified primary worktrees \u2014 refusing to guess",
  PRIMARY_APP_MISSING: "the primary worktree has no directory at this app-relative path"
};
function redactPlan(plan) {
  return {
    kind: plan.refusal ? "refused" : plan.layout.kind,
    appRelative: plan.layout.appRelative,
    host: plan.host,
    refusal: plan.refusal,
    resources: plan.resources.map((resource) => ({
      id: resource.id,
      destination: resource.destination,
      regime: resource.regime,
      state: resource.state,
      action: resource.action,
      ignoreSafe: resource.ignoreSafe,
      sourcePresent: resource.sourceState === "AVAILABLE",
      remediation: resource.remediation
    }))
  };
}
function planLines(plan) {
  if (plan.refusal)
    return [`rn-dev-agent worktree inheritance: ${REFUSAL_TEXT[plan.refusal]}`];
  if (plan.layout.kind === "primary")
    return [];
  return plan.resources.map((resource) => {
    const suffix = resource.remediation ? ` \u2014 ${resource.remediation}` : "";
    return `${resource.destination}: ${resource.state}${suffix}`;
  });
}
var SILENT_REFUSALS = /* @__PURE__ */ new Set(["NOT_GIT", "BARE", "NOT_RN_APP", "APP_OUTSIDE_WORKTREE"]);
function actionableLines(plan) {
  if (plan.refusal) {
    return SILENT_REFUSALS.has(plan.refusal) ? [] : [`rn-dev-agent: ${REFUSAL_TEXT[plan.refusal]}; private context is not inherited here.`];
  }
  if (plan.layout.kind === "primary")
    return [];
  const notable = plan.resources.filter((resource) => resource.state !== "LINK_VALID_SAFE" && resource.state !== "TRACKED");
  if (notable.length === 0)
    return [];
  return [
    "rn-dev-agent linked worktree: the learned-action corpus is not fully inherited here.",
    ...notable.map((resource) => {
      const suffix = resource.remediation ? ` \u2014 ${resource.remediation}` : "";
      return `  ${resource.destination}: ${resource.state}${suffix}`;
    }),
    "  Run /rn-dev-agent:setup to review and apply before using learned actions."
  ];
}
function hookPaths(commonDir) {
  const stateDir = join2(commonDir, HOOK_STATE_DIR);
  return {
    stateDir,
    helper: join2(stateDir, HOOK_HELPER),
    config: join2(stateDir, HOOK_CONFIG),
    hooksDir: join2(commonDir, "hooks"),
    hook: join2(commonDir, "hooks", "post-checkout")
  };
}
function hookScript() {
  return `#!/bin/bash
${HOOK_MARKER}
# Local, untracked, idempotent. Runs only on branch checkout (flag 1), never
# blocks the checkout, and performs no network or install work.
[ "$3" = "1" ] || exit 0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_NAMESPACE
COMMON=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || exit 0
STATE="$COMMON/${HOOK_STATE_DIR}"
[ -f "$STATE/${HOOK_HELPER}" ] || exit 0
[ -f "$STATE/${HOOK_CONFIG}" ] || exit 0
if command -v node >/dev/null 2>&1; then
  node "$STATE/${HOOK_HELPER}" post-checkout --config "$STATE/${HOOK_CONFIG}" >/dev/null 2>&1
else
  printf '{\\n  "refusal": "NODE_UNAVAILABLE"\\n}\\n' > "$STATE/${LAST_RUN}" 2>/dev/null
fi
exit 0
`;
}
function configuredHooksPath(cwd) {
  const env = { ...process.env };
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_NAMESPACE"
  ]) {
    delete env[key];
  }
  const result = spawnSync2("git", ["config", "--get", "core.hooksPath"], {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0)
    return null;
  const value = (result.stdout ?? "").trim();
  return value.length > 0 ? value : null;
}
function selfPath() {
  try {
    return fileURLToPath(import.meta.url);
  } catch {
    return resolve2(process.argv[1] ?? "");
  }
}
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}
function readHookConfig(path) {
  try {
    const parsed = JSON.parse(readFileSync2(path, "utf8"));
    if (parsed.version !== 1)
      return null;
    if (parsed.host !== "claude" && parsed.host !== "codex")
      return null;
    if (typeof parsed.hookSha256 !== "string" || !/^[0-9a-f]{64}$/.test(parsed.hookSha256)) {
      return null;
    }
    if (typeof parsed.appRelative !== "string" || parsed.appRelative.length === 0)
      return null;
    if (parsed.appRelative !== ".") {
      const segments = parsed.appRelative.split("/");
      if (parsed.appRelative.startsWith("/") || segments.some((part) => part === ".." || part === "")) {
        return null;
      }
    }
    const supported = resourcesForHost(parsed.host).map((resource) => resource.id);
    if (!Array.isArray(parsed.resources))
      return null;
    if (parsed.resources.some((id) => !supported.includes(id)))
      return null;
    return parsed;
  } catch {
    return null;
  }
}
function hookState(commonDir, cwd) {
  if (configuredHooksPath(cwd)) {
    return {
      status: "hooks-path-configured",
      detail: "core.hooksPath is managed by another tool. rn-dev-agent will not redirect it; add the composition line manually to that tool's post-checkout hook."
    };
  }
  const paths = hookPaths(commonDir);
  if (!existsSync2(paths.hook))
    return { status: "absent" };
  let body = "";
  try {
    body = readFileSync2(paths.hook, "utf8");
  } catch {
    return { status: "foreign-hook", detail: "existing post-checkout hook is unreadable" };
  }
  const owned = readHookConfig(paths.config)?.hookSha256;
  if (owned && owned === sha256(body))
    return { status: "installed" };
  if (body.includes(HOOK_MARKER)) {
    return {
      status: "composed-hook",
      detail: "a post-checkout hook references rn-dev-agent but is not byte-owned by this install; it is never replaced or removed automatically"
    };
  }
  return {
    status: "foreign-hook",
    detail: "another post-checkout hook is installed and is never overwritten"
  };
}
function helperRuns(helper, cwd) {
  const probe = spawnSync2(process.execPath, [helper, "plan", "--cwd", cwd], {
    encoding: "utf8",
    timeout: 3e4
  });
  return !probe.error && probe.status === 0;
}
function writeHookBody(paths, body, status, ownedSha) {
  if (status === "absent") {
    try {
      writeFileSync(paths.hook, body, { flag: "wx", mode: 493 });
      chmodSync(paths.hook, 493);
      return true;
    } catch {
      return false;
    }
  }
  const staged = `${paths.hook}.${process.pid}.tmp`;
  try {
    if (!ownedSha || sha256(readFileSync2(paths.hook, "utf8")) !== ownedSha)
      return false;
    writeFileSync(staged, body, { flag: "wx", mode: 493 });
    chmodSync(staged, 493);
    if (sha256(readFileSync2(paths.hook, "utf8")) !== ownedSha) {
      rmSync2(staged, { force: true });
      return false;
    }
    renameSync2(staged, paths.hook);
    return true;
  } catch {
    rmSync2(staged, { force: true });
    return false;
  }
}
function manualComposition() {
  return [
    "Manual composition (add to your existing post-checkout hook, before its exit):",
    '  [ "$3" = "1" ] && {',
    "    unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_COMMON_DIR GIT_OBJECT_DIRECTORY GIT_NAMESPACE",
    "    C=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)",
    `    [ -f "$C/${HOOK_STATE_DIR}/${HOOK_HELPER}" ] && node "$C/${HOOK_STATE_DIR}/${HOOK_HELPER}" \\`,
    `      post-checkout --config "$C/${HOOK_STATE_DIR}/${HOOK_CONFIG}" >/dev/null 2>&1`,
    "  }"
  ].join("\n");
}
function installHook(flags) {
  const layout = resolveWorktreeLayout({ cwd: flags.cwd, appRoot: flags.appRoot });
  if (!("worktreeRoot" in layout) || layout.refusal) {
    const refusal = "refusal" in layout ? layout.refusal : "GIT_UNAVAILABLE";
    console.error(`refused: ${REFUSAL_TEXT[refusal]}`);
    return 3;
  }
  const state = hookState(layout.commonDir, flags.cwd);
  const paths = hookPaths(layout.commonDir);
  const requested = flags.resources ?? resourcesForHost(flags.host).map((r) => r.id);
  const previousConfig = readHookConfig(paths.config);
  const ownedSha = previousConfig?.hookSha256;
  const resources = [...new Set(requested)];
  const body = hookScript();
  const config = {
    version: 1,
    appRelative: layout.appRelative,
    host: flags.host,
    resources,
    hookSha256: sha256(body)
  };
  mkdirSync2(paths.stateDir, { recursive: true, mode: 448 });
  const stagedHelper = join2(paths.stateDir, `worktree-inheritance.${process.pid}.staged.js`);
  const stagedConfig = `${paths.config}.${process.pid}.tmp`;
  copyFileSync(selfPath(), stagedHelper);
  if (!helperRuns(stagedHelper, flags.cwd)) {
    rmSync2(stagedHelper, { force: true });
    console.error("refused: the packaged helper copy is not self-contained; install from the host plugin package.");
    return 3;
  }
  writeFileSync(stagedConfig, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
  renameSync2(stagedHelper, paths.helper);
  renameSync2(stagedConfig, paths.config);
  if (state.status !== "absent" && state.status !== "installed") {
    console.error(`refused: ${state.detail}`);
    console.error("the helper is provisioned, so the composition below works as written.");
    console.error(manualComposition());
    return 3;
  }
  mkdirSync2(paths.hooksDir, { recursive: true });
  if (!writeHookBody(paths, body, state.status, ownedSha)) {
    console.error("refused: another post-checkout hook appeared during install; no hook was created or replaced.");
    console.error(manualComposition());
    return 3;
  }
  console.log("installed: local post-checkout integration for this repository only.");
  console.log(`  app-relative: ${layout.appRelative}`);
  console.log(`  resources: ${resources.join(", ")}`);
  console.log("  note: `git worktree add --no-checkout` and tools that bypass Git hooks do not run it \u2014 use /rn-dev-agent:setup before launching an agent there.");
  return 0;
}
function uninstallHook(flags) {
  const layout = resolveWorktreeLayout({ cwd: flags.cwd, appRoot: flags.appRoot });
  if (!("worktreeRoot" in layout)) {
    console.error(`refused: ${REFUSAL_TEXT[layout.refusal]}`);
    return 3;
  }
  const state = hookState(layout.commonDir, flags.cwd);
  if (state.status !== "installed") {
    console.log(`nothing to remove: ${state.status}`);
    return 0;
  }
  const paths = hookPaths(layout.commonDir);
  if (hookState(layout.commonDir, flags.cwd).status !== "installed") {
    console.error("refused: the post-checkout hook changed during removal; nothing was deleted.");
    return 3;
  }
  rmSync2(paths.hook, { force: true });
  for (const owned of [paths.helper, paths.config, join2(paths.stateDir, LAST_RUN)]) {
    rmSync2(owned, { force: true });
  }
  try {
    rmdirSync(paths.stateDir);
  } catch {
  }
  console.log("removed: local post-checkout integration.");
  return 0;
}
function reportHook(flags) {
  const layout = resolveWorktreeLayout({ cwd: flags.cwd, appRoot: flags.appRoot });
  if (!("worktreeRoot" in layout)) {
    console.log(`hook: unavailable (${REFUSAL_TEXT[layout.refusal]})`);
    return 0;
  }
  const state = hookState(layout.commonDir, flags.cwd);
  const paths = hookPaths(layout.commonDir);
  const config = readHookConfig(paths.config);
  if (flags.json) {
    console.log(JSON.stringify({ status: state.status, detail: state.detail, config }, null, 2));
    return 0;
  }
  console.log(`hook: ${state.status}${state.detail ? ` \u2014 ${state.detail}` : ""}`);
  if (config)
    console.log(`  app-relative: ${config.appRelative}; resources: ${config.resources.join(", ")}`);
  if (state.status === "foreign-hook" || state.status === "hooks-path-configured") {
    console.log(manualComposition());
  }
  return 0;
}
function runPostCheckout(flags) {
  if (!flags.config)
    return 2;
  const config = readHookConfig(flags.config);
  if (!config)
    return 3;
  const layout = resolveWorktreeLayout({ cwd: flags.cwd });
  const worktreeRoot = "worktreeRoot" in layout && layout.worktreeRoot ? layout.worktreeRoot : flags.cwd;
  const appRoot = config.appRelative === "." ? worktreeRoot : join2(worktreeRoot, config.appRelative);
  const appPresent = existsSync2(appRoot);
  const resources = appPresent ? config.resources : [];
  if (resources.length === 0) {
    recordLastRun(dirname(flags.config), {
      appRelative: config.appRelative,
      refusal: "PRIMARY_APP_MISSING",
      outcomes: []
    });
    return 0;
  }
  const report = applyInheritance({
    cwd: flags.cwd,
    appRoot: appPresent ? appRoot : worktreeRoot,
    host: config.host,
    resources
  });
  const failed = report.refusal !== void 0 || report.outcomes.some((o) => o.result === "refused");
  recordLastRun(dirname(flags.config), {
    appRelative: config.appRelative,
    refusal: report.refusal,
    outcomes: report.outcomes.map((outcome) => ({
      id: outcome.id,
      state: outcome.state,
      result: outcome.result
    }))
  });
  return failed ? 3 : 0;
}
function recordLastRun(stateDir, payload) {
  try {
    writeFileSync(join2(stateDir, LAST_RUN), `${JSON.stringify(payload, null, 2)}
`, {
      mode: 384
    });
  } catch {
  }
}
function main() {
  const flags = parseFlags(process.argv.slice(2));
  if (!flags) {
    console.error("worktree-inheritance: invalid arguments");
    return 2;
  }
  if (flags.command === "hook") {
    if (flags.subcommand === "install")
      return installHook(flags);
    if (flags.subcommand === "uninstall")
      return uninstallHook(flags);
    if (flags.subcommand === "status" || flags.subcommand === "")
      return reportHook(flags);
    return 2;
  }
  if (flags.command === "post-checkout")
    return runPostCheckout(flags);
  if (flags.command === "apply") {
    const report = applyInheritance({
      cwd: flags.cwd,
      appRoot: flags.appRoot,
      host: flags.host,
      resources: flags.resources,
      allowRepair: flags.allowRepair
    });
    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      if (report.refusal)
        console.log(`refused: ${REFUSAL_TEXT[report.refusal]}`);
      for (const outcome of report.outcomes) {
        console.log(`${outcome.id}: ${outcome.result} (${outcome.state})${outcome.reason ? ` \u2014 ${outcome.reason}` : ""}`);
      }
      console.log(`applied ${report.applied}/${report.requested}`);
    }
    if (report.refusal && !SILENT_REFUSALS.has(report.refusal))
      return 3;
    return report.outcomes.some((outcome) => outcome.result === "refused") ? 3 : 0;
  }
  const plan = planInheritance({
    cwd: flags.cwd,
    appRoot: flags.appRoot,
    host: flags.host,
    resources: flags.resources
  });
  if (flags.json) {
    console.log(JSON.stringify(redactPlan(plan), null, 2));
  } else {
    const lines = flags.command === "report" ? actionableLines(plan) : planLines(plan);
    for (const line of lines)
      console.log(line);
  }
  if (flags.command === "plan" && plan.refusal && !SILENT_REFUSALS.has(plan.refusal))
    return 3;
  return 0;
}
process.exitCode = main();
